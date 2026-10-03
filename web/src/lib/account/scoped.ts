import { toViemAccount } from '@category-labs/mera/viem'
import { encodeFunctionData } from 'viem'
import {
  assertDomainMatches,
  buildCreateAccountTypedData,
  buildSetOperatorTypedData,
} from './typedData'
import type { Address, Hex } from 'viem'
import type { Secp256k1SigningSession } from '@category-labs/mera'
import type {
  CreateAccountMessage,
  Eip712Domain,
  SetOperatorMessage,
} from './typedData'
import { IGaplessAccountAbi } from '@/abi/IGaplessAccount'
import { ICoverVaultAbi } from '@/abi/ICoverVault'
import { IAUSDAbi } from '@/abi/IAUSD'
import { ADDRESSES, CHAIN_ID } from '@/config/addresses.143'

/**
 * Operator and owner scope wrappers (ARCHITECTURE 8.3). These are an accident
 * and UX boundary, not the security boundary (the onchain grant is): they
 * exist so a bug in the rest of the app cannot sign something the UI never
 * intended to ask for.
 *
 * P2 addition (ARCHITECTURE 8.3): the operator may also act directly against
 * CoverVault (`deposit`, `requestRedeem`, `claimRedeem`) and AUSD (`approve`,
 * spender hardcoded to the vault). Every destination below is resolved from
 * `ADDRESSES`, never from caller input, so a bug upstream cannot redirect a
 * signed transaction to an attacker-controlled address or spender.
 */

const CLONE_ALLOWED_FUNCTIONS = [
  'trade',
  'tradeAndCover',
  'buyCover',
  'cancelCover',
  'withdrawWithSig',
  'setOperatorWithSig',
] as const

const VAULT_ALLOWED_FUNCTIONS = [
  'deposit',
  'requestRedeem',
  'claimRedeem',
] as const

export type CloneFunctionName = (typeof CLONE_ALLOWED_FUNCTIONS)[number]
export type VaultFunctionName = (typeof VAULT_ALLOWED_FUNCTIONS)[number]
/** Kept for callers that only need the name union (ADR-W12 call sites predate the vault split). */
export type OperatorFunctionName = CloneFunctionName

export type OperatorCall =
  | {
      /** Default target: the caller's own GaplessAccount clone. */
      target?: 'clone'
      functionName: CloneFunctionName
      args: ReadonlyArray<unknown>
    }
  | {
      target: 'vault'
      functionName: VaultFunctionName
      args: ReadonlyArray<unknown>
    }
  | {
      /** AUSD `approve`. Spender is always `ADDRESSES.CoverVault`: there is no
       * spender field on this call, so one can never be supplied by a caller. */
      target: 'approveVault'
      amountCNS: bigint
    }

function isAllowedCloneFunction(name: string): name is CloneFunctionName {
  return (CLONE_ALLOWED_FUNCTIONS as ReadonlyArray<string>).includes(name)
}

function isAllowedVaultFunction(name: string): name is VaultFunctionName {
  return (VAULT_ALLOWED_FUNCTIONS as ReadonlyArray<string>).includes(name)
}

/** The fixed destination for a call, resolved only from `ADDRESSES` and the caller's own clone. */
export function operatorCallDestination(
  call: OperatorCall,
  accountClone: Address,
): Address {
  if (call.target === 'vault') return ADDRESSES.CoverVault
  if (call.target === 'approveVault') return ADDRESSES.AUSD
  return accountClone
}

/** Encodes calldata for an allowed operator call. Throws on anything else. */
export function encodeOperatorCall(call: OperatorCall): Hex {
  if (call.target === 'vault') {
    if (!isAllowedVaultFunction(call.functionName)) {
      throw new Error(
        `OperatorScope: "${call.functionName}" is not an allowed vault call`,
      )
    }
    return encodeFunctionData({
      abi: ICoverVaultAbi,
      functionName: call.functionName,
      args: call.args,
    } as Parameters<typeof encodeFunctionData>[0])
  }
  if (call.target === 'approveVault') {
    return encodeFunctionData({
      abi: IAUSDAbi,
      functionName: 'approve',
      args: [ADDRESSES.CoverVault, call.amountCNS],
    })
  }
  if (!isAllowedCloneFunction(call.functionName)) {
    throw new Error(
      `OperatorScope: "${call.functionName}" is not an allowed operator call`,
    )
  }
  return encodeFunctionData({
    abi: IGaplessAccountAbi,
    functionName: call.functionName,
    args: call.args,
  } as Parameters<typeof encodeFunctionData>[0])
}

export interface OperatorTxOverrides {
  gas: bigint
  maxFeePerGas: bigint
  maxPriorityFeePerGas: bigint
  nonce: number
}

/**
 * Operator scope: chain 143 only, value 0 only, no EIP-7702 authorization, no
 * `signMessage`, `signTypedData` or raw `sign` (they are simply not exposed
 * here). Transactions only to the caller's own GaplessAccount clone (six
 * selectors) or, since P2, directly to CoverVault or AUSD for the fixed
 * vault selectors above (`operatorCallDestination` resolves the destination;
 * it is never taken from the caller).
 */
export class OperatorScope {
  private readonly accountClone: Address

  constructor(
    private readonly session: Secp256k1SigningSession,
    accountClone: Address,
  ) {
    this.accountClone = accountClone
  }

  get address(): Address {
    return toViemAccount(this.session).address
  }

  async signTransaction(
    call: OperatorCall,
    overrides: OperatorTxOverrides,
  ): Promise<Hex> {
    const data = encodeOperatorCall(call)
    const to = operatorCallDestination(call, this.accountClone)
    const account = toViemAccount(this.session)
    return account.signTransaction({
      to,
      data,
      value: 0n,
      chainId: CHAIN_ID,
      type: 'eip1559',
      gas: overrides.gas,
      maxFeePerGas: overrides.maxFeePerGas,
      maxPriorityFeePerGas: overrides.maxPriorityFeePerGas,
      nonce: overrides.nonce,
    })
  }
}

/**
 * Owner scope: `signTypedData` only, only for `CreateAccount` (domain = the
 * generated factory) and `SetOperator` (domain = the caller's clone). Every
 * call requires the onchain domain read and fails closed on a mismatch
 * (ARCHITECTURE ADR-W9, DESIGN 9.2: no continue button on a domain mismatch).
 */
export class OwnerScope {
  constructor(private readonly session: Secp256k1SigningSession) {}

  get address(): Address {
    return toViemAccount(this.session).address
  }

  async signCreateAccount(
    onchainDomain: Eip712Domain,
    expectedDomain: Eip712Domain,
    message: CreateAccountMessage,
  ): Promise<Hex> {
    assertDomainMatches(onchainDomain, expectedDomain)
    const account = toViemAccount(this.session)
    return account.signTypedData(
      buildCreateAccountTypedData(onchainDomain, message),
    )
  }

  async signSetOperator(
    onchainDomain: Eip712Domain,
    expectedDomain: Eip712Domain,
    message: SetOperatorMessage,
  ): Promise<Hex> {
    assertDomainMatches(onchainDomain, expectedDomain)
    const account = toViemAccount(this.session)
    return account.signTypedData(
      buildSetOperatorTypedData(onchainDomain, message),
    )
  }
}
