import { createPublicClient, http, keccak256, parseEventLogs } from 'viem'
import { monad } from 'viem/chains'
import { toViemAccount } from '@category-labs/mera/viem'
import type { Address, Hex, TransactionReceipt } from 'viem'
import type { Secp256k1SigningSession } from '@category-labs/mera'
import type { OperatorCall } from '@/lib/account/scoped'
import type { DecodedRevert } from '@/lib/chain'
import {
  OperatorScope,
  encodeOperatorCall,
  operatorCallDestination,
} from '@/lib/account/scoped'
import { decodeRevertFromError, publicClient } from '@/lib/chain'
import { ICoverManagerAbi } from '@/abi/ICoverManager'
import { ICoverVaultAbi } from '@/abi/ICoverVault'
import { IGaplessAccountAbi } from '@/abi/IGaplessAccount'
import { IGaplessFactoryAbi } from '@/abi/IGaplessFactory'
import { ADDRESSES, CHAIN_ID } from '@/config/addresses.143'
import { FEE_POLICY } from '@/config'
import { env } from '@/env'

/**
 * One send pipeline (ARCHITECTURE phase 2 ADR-W12): `/trade`, and later
 * `/vault` and `/settings/agent`, share this instead of each page calling
 * `writeContractSync`/a wallet client directly. Scoped signing only
 * (`OperatorScope`): no viem local account ever leaves `lib/account/`.
 *
 * Single-endpoint sync client, no fallback transport: a send's outcome is
 * always attributable to the one node that accepted it (ADR-W12, 5.5).
 *
 * `timeout` is explicit and longer than the 15s `sendRawTransactionSync`
 * timeout below: viem's http transport default (10s) would otherwise fire
 * first, so the app would think it timed out before its own timeout did.
 */
const sendClient = createPublicClient({
  chain: monad,
  transport: http(env.VITE_RPC_URLS[0], { timeout: 20_000 }),
})

export type TxLifecycle =
  | { status: 'idle' }
  | { status: 'simulating' }
  | { status: 'sending' }
  | { status: 'confirming'; hash: Hex }
  | { status: 'done'; receipt: TransactionReceipt }
  | { status: 'reverted'; decoded: DecodedRevert | null; hash: Hex | null }
  | { status: 'unknown'; hash: Hex }

export class SendRefusedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SendRefusedError'
  }
}

/** Thrown when `signal` is aborted before a transaction is signed. Signing
 * never starts after this, so closing the confirm sheet genuinely prevents
 * the send rather than hiding the UI while it still broadcasts. */
export class SendAbortedError extends Error {
  constructor() {
    super('sendOperatorCall: aborted before signing')
    this.name = 'SendAbortedError'
  }
}

export interface SendContext {
  session: Secp256k1SigningSession
  /** The owner this operator is meant to act for; re-verified against the
   * factory on every send (ADR-W12: "destination must equal accountOf(owner)"). */
  owner: Address
  /** The account the caller believes is `accountOf(owner)`. Never trusted
   * without the chain re-check below. */
  account: Address
}

export interface OperatorCallEstimate {
  gas: bigint
  maxFeePerGas: bigint
  maxPriorityFeePerGas: bigint
  operatorBalanceWei: bigint
  /** `gas * maxFeePerGas`: the worst-case MON cost of this transaction (DESIGN 9.1 "network cost"). */
  maxCostWei: bigint
}

/**
 * Estimates the real cost of sending `call`, from the exact encoded calldata
 * (DESIGN 9.1 "network cost": gas limit, max MON cost, trading key balance
 * after). Shared with `sendOperatorCall` below so a confirmation sheet shows
 * the same numbers the send pipeline itself will act on, never a guess.
 * Throws `SendRefusedError` if the gas cap or balance checks fail; callers
 * that only need the numbers for display should catch contract reverts
 * surfaced via `decodeRevertFromError` on the thrown error.
 */
export async function estimateOperatorCall(
  call: OperatorCall,
  ctx: SendContext,
): Promise<OperatorCallEstimate> {
  const operator = toViemAccount(ctx.session).address
  const to = operatorCallDestination(call, ctx.account)
  const data = encodeOperatorCall(call)

  const estimate = await sendClient.estimateGas({
    account: operator,
    to,
    data,
    value: 0n,
  })

  const gas = BigInt(
    Math.ceil(Number(estimate) * FEE_POLICY.gasLimitMultiplier),
  )
  if (gas > FEE_POLICY.gasLimitCap) {
    throw new SendRefusedError(
      `estimateOperatorCall: estimated gas ${gas} exceeds the ${FEE_POLICY.gasLimitCap} cap`,
    )
  }

  const block = await publicClient.getBlock()
  const baseFee = block.baseFeePerGas ?? 0n
  const maxPriorityFeePerGas = FEE_POLICY.priorityFeeWei
  const maxFeePerGas = baseFee * 2n + maxPriorityFeePerGas

  const operatorBalanceWei = await publicClient.getBalance({
    address: operator,
  })

  return {
    gas,
    maxFeePerGas,
    maxPriorityFeePerGas,
    operatorBalanceWei,
    maxCostWei: gas * maxFeePerGas,
  }
}

interface UnresolvedSend {
  hash: Hex
  operator: Address
}

// Module-level: at most one unresolved hash per operator (ADR-W12). A send
// for an operator with an unresolved hash never re-signs; it only checks
// whether that hash has since landed.
let unresolved: UnresolvedSend | null = null

function keyOf(address: Address): string {
  return address.toLowerCase()
}

async function resolveOutstanding(
  operator: Address,
): Promise<TxLifecycle | null> {
  if (!unresolved || keyOf(unresolved.operator) !== keyOf(operator)) {
    return null
  }
  const receipt = await publicClient
    .getTransactionReceipt({ hash: unresolved.hash })
    .catch(() => null)
  if (!receipt) {
    return { status: 'confirming', hash: unresolved.hash }
  }
  unresolved = null
  return receiptToLifecycle(receipt)
}

function decodeKnownLogs(receipt: TransactionReceipt) {
  const coverBought = parseEventLogs({
    abi: ICoverManagerAbi,
    eventName: 'CoverBought',
    logs: receipt.logs,
  })
  const traded = parseEventLogs({
    abi: IGaplessAccountAbi,
    eventName: 'Traded',
    logs: receipt.logs,
  })
  return { coverBought, traded }
}

/** `Deposit`'s `shares` field, when this receipt deposited into the vault. */
export function sharesFromDepositReceipt(
  receipt: TransactionReceipt,
): bigint | null {
  const deposits = parseEventLogs({
    abi: ICoverVaultAbi,
    eventName: 'Deposit',
    logs: receipt.logs,
  })
  return deposits[0]?.args.shares ?? null
}

/** `RedeemRequested`'s `requestId`, when this receipt requested a redemption. */
export function requestIdFromReceipt(
  receipt: TransactionReceipt,
): bigint | null {
  const requests = parseEventLogs({
    abi: ICoverVaultAbi,
    eventName: 'RedeemRequested',
    logs: receipt.logs,
  })
  return requests[0]?.args.requestId ?? null
}

/** `RedeemClaimed`'s `assets` field: the real payout, which may be less than requested. */
export function assetsFromClaimReceipt(
  receipt: TransactionReceipt,
): bigint | null {
  const claims = parseEventLogs({
    abi: ICoverVaultAbi,
    eventName: 'RedeemClaimed',
    logs: receipt.logs,
  })
  return claims[0]?.args.assets ?? null
}

function receiptToLifecycle(receipt: TransactionReceipt): TxLifecycle {
  if (receipt.status === 'reverted') {
    // A receipt carries no revert reason (the EVM does not store one); an
    // undecoded revert here is surfaced as `decoded: null`, never guessed at.
    return { status: 'reverted', decoded: null, hash: receipt.transactionHash }
  }
  return { status: 'done', receipt }
}

/** `CoverBought`'s `coverId` topic, when this receipt bought one. */
export function coverIdFromReceipt(receipt: TransactionReceipt): Hex | null {
  const { coverBought } = decodeKnownLogs(receipt)
  return coverBought[0]?.args.coverId ?? null
}

/**
 * Runs the ADR-W12 pipeline for one operator call: destination check,
 * `estimateGas`, `gas = ceil(estimate x 1.2)` capped at 5,000,000, fees from
 * the latest block, a MON balance check, `OperatorScope.signTransaction`,
 * then `sendRawTransactionSync` on the dedicated client.
 *
 * Signing only happens after a successful estimate: a revert at estimate
 * decodes the reason and nothing is signed.
 */
export async function sendOperatorCall(
  call: OperatorCall,
  ctx: SendContext,
  onStatus?: (status: TxLifecycle) => void,
  signal?: AbortSignal,
): Promise<TxLifecycle> {
  const operator = toViemAccount(ctx.session).address

  const outstanding = await resolveOutstanding(operator)
  if (outstanding?.status === 'confirming') {
    // Still unresolved: report it, never sign a second transaction.
    onStatus?.(outstanding)
    return outstanding
  }

  onStatus?.({ status: 'simulating' })

  // Only clone-targeted calls need the destination re-checked against
  // accountOf(owner): vault and AUSD calls go to fixed protocol addresses
  // resolved inside the scope wrapper itself (ADR-W12, ARCHITECTURE 8.3).
  if (!call.target || call.target === 'clone') {
    const realAccount = await publicClient.readContract({
      address: ADDRESSES.GaplessFactory,
      abi: IGaplessFactoryAbi,
      functionName: 'accountOf',
      args: [ctx.owner],
    })
    if (realAccount.toLowerCase() !== ctx.account.toLowerCase()) {
      throw new SendRefusedError(
        'sendOperatorCall: account does not match accountOf(owner)',
      )
    }
  }

  const to = operatorCallDestination(call, ctx.account)
  const data = encodeOperatorCall(call)

  let estimate: bigint
  try {
    estimate = await sendClient.estimateGas({
      account: operator,
      to,
      data,
      value: 0n,
    })
  } catch (err) {
    const decoded = decodeRevertFromError(err)
    const result: TxLifecycle = { status: 'reverted', decoded, hash: null }
    onStatus?.(result)
    return result
  }

  const gas = BigInt(
    Math.ceil(Number(estimate) * FEE_POLICY.gasLimitMultiplier),
  )
  if (gas > FEE_POLICY.gasLimitCap) {
    throw new SendRefusedError(
      `sendOperatorCall: estimated gas ${gas} exceeds the ${FEE_POLICY.gasLimitCap} cap`,
    )
  }

  const block = await publicClient.getBlock()
  const baseFee = block.baseFeePerGas ?? 0n
  const maxPriorityFeePerGas = FEE_POLICY.priorityFeeWei
  const maxFeePerGas = baseFee * 2n + maxPriorityFeePerGas

  const operatorBalance = await publicClient.getBalance({ address: operator })
  if (operatorBalance < gas * maxFeePerGas) {
    throw new SendRefusedError(
      'sendOperatorCall: trading key does not have enough MON for gas',
    )
  }

  const nonce = await publicClient.getTransactionCount({
    address: operator,
    blockTag: 'pending',
  })

  if (signal?.aborted) {
    throw new SendAbortedError()
  }

  const scope = new OperatorScope(ctx.session, ctx.account)
  const signed = await scope.signTransaction(call, {
    gas,
    maxFeePerGas,
    maxPriorityFeePerGas,
    nonce,
  })

  // Computed from the signed bytes, not read off a (possibly-missing) error
  // field: this is the one value that is always available before
  // broadcasting, so the unresolved-send guard below can always record it.
  const hash = keccak256(signed)

  onStatus?.({ status: 'sending' })

  try {
    const receipt = await sendClient.sendRawTransactionSync({
      serializedTransaction: signed,
      throwOnReceiptRevert: false,
      timeout: 15_000,
    })
    const result = receiptToLifecycle(receipt)
    onStatus?.(result)
    return result
  } catch (err) {
    // A transport failure or timeout after broadcast: the tx may still be
    // in the mempool. Hold its hash as the one unresolved send for this
    // operator rather than guessing at the outcome or re-signing (ADR-W12).
    unresolved = { hash, operator }
    const result: TxLifecycle = { status: 'unknown', hash }
    onStatus?.(result)
    return result
  }
}

/** `chainId` the signed transaction always carries (ADR-W12). Exported for tests/assertions only. */
export const SEND_CHAIN_ID = CHAIN_ID
