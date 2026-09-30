import { TransactionReceiptNotFoundError, getAddress, type Address, type Hex } from 'viem';
import { getBalance, getBlock, getBlockNumber, getCode, getTransactionCount, getTransactionReceipt, multicall, readContract } from 'viem/actions';
import { IAUSDAbi, IGaplessAccountAbi, IGaplessFactoryAbi, IPerplMinAbi } from '../../abi/index.ts';
import { perpIdsFromBitmap } from '../../jobs/perpl.ts';
import { AUSD, PERPL_EXCHANGE } from '../../lib/addresses.ts';
import type { RelayEnv } from '../../lib/env.ts';
import { GAS } from '../../lib/gas.ts';
import { HttpError } from '../../lib/http.ts';
import type { Logger } from '../../lib/log.ts';
import type { ChainClient, SendOutcome, SendQueue } from '../../lib/sendQueue.ts';
import { verifyCreateAccountSig, type OperatorGrant } from './eip712.ts';
import { RETRYABLE_DRIP_SKIPS, type ActivationRow, type CreateRow, type SponsorLedger } from './ledger.ts';

export const SPONSOR_LIMITS = {
  // The deadline must outlive the queue wait and the send.
  minDeadlineMarginS: 60,
  // The relay only sponsors signatures meant for now, not standing authorizations.
  maxDeadlineAheadS: 86_400,
  // Reserve-balance window wait per send (the relay key is under 10 MON, one tx per 4 blocks).
  windowWaitMs: 12_000,
  // A sponsored operator key must outlive activation and the drip (skipped once expired).
  minGrantTtlS: 600,
  // 02 #9: a newly funded account cannot send until the funding tx is 3 blocks old.
  fundedWaitBlocks: 3n,
  // A create row stored without a block is judged vanished only after this long (Monad finality is about 1 s).
  vanishSettleMs: 60_000,
  blockWaitMs: 6_000,
  pollMs: 150
} as const;

/** Relay policy on the operator grant it sponsors (SA2 N-03 go-condition: small budget, short expiry). */
export interface GrantPolicy {
  maxPerTradeCNS: bigint;
  maxPerDayCNS: bigint;
  maxTtlS: number;
}

export function sponsorGrantPolicy(env: Pick<RelayEnv, 'SPONSOR_GRANT_MAX_PER_TRADE_CNS' | 'SPONSOR_GRANT_MAX_PER_DAY_CNS' | 'SPONSOR_GRANT_MAX_TTL_S'>): GrantPolicy {
  return { maxPerTradeCNS: env.SPONSOR_GRANT_MAX_PER_TRADE_CNS, maxPerDayCNS: env.SPONSOR_GRANT_MAX_PER_DAY_CNS, maxTtlS: env.SPONSOR_GRANT_MAX_TTL_S };
}

/**
 * The contract accepts any uint grant; the relay only sponsors grants a leaked operator key cannot drain far.
 * A zero key grants nothing (initialize skips it), so it is always within policy.
 */
export function grantPolicyViolation(g: OperatorGrant, nowS: bigint, p: GrantPolicy): string | null {
  if (/^0x0{40}$/i.test(g.key)) return null;
  if (g.expiry < nowS + BigInt(SPONSOR_LIMITS.minGrantTtlS)) return 'expiry_too_close';
  if (g.expiry > nowS + BigInt(p.maxTtlS)) return 'expiry_too_far';
  // 0 blocks every operator order and buy (N-03): the drip would fund a key that cannot trade.
  if (g.maxNotionalPerTradeCNS === 0n || g.maxNotionalPerDayCNS === 0n) return 'zero_budget';
  if (g.maxNotionalPerTradeCNS > p.maxPerTradeCNS) return 'per_trade_above_policy';
  if (g.maxNotionalPerDayCNS > p.maxPerDayCNS) return 'per_day_above_policy';
  return null;
}

export interface CreateRequest {
  owner: Address;
  grant: OperatorGrant;
  deadline: bigint;
  sig: Hex;
}

export interface CreateResult {
  owner: Address;
  account: Address;
  status: 'created' | 'pending';
  txHash: Hex | null;
  blockNumber: string | null;
}

export interface ActivationResult {
  account: Address;
  perplAccountId: string | null;
  sweepTx: string | null;
  drip: { to: string; wei: string; txHash: string; blockNumber: string } | null;
  dripSkipped: string | null;
}

export interface SponsorServiceOptions {
  client: ChainClient;
  queue: SendQueue;
  ledger: SponsorLedger;
  factory: Address;
  dripWei: bigint;
  /** Lowercased operator keys that may receive the drip (BUILD_PLAN §0: demo operator only). */
  dripAllowlist: ReadonlySet<string>;
  /** SPONSOR_ALLOWLIST_ONLY: only owners in `ownerAllowlist` (and the ledger's demo owner) are sponsored. */
  ownerAllowlistOnly: boolean;
  /** Lowercased SPONSOR_OWNER_ALLOWLIST. */
  ownerAllowlist: ReadonlySet<string>;
  grantPolicy: GrantPolicy;
  log: Logger;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * /sponsor/create and /activate. Every check that can fail runs before money moves: offchain sig,
 * onchain registry reads, ledger caps, simulation. The relay key goes through the shared SendQueue.
 */
export class SponsorService {
  private readonly now: () => number;

  constructor(private readonly o: SponsorServiceOptions) {
    this.now = o.now ?? Date.now;
  }

  /**
   * H-2: sponsored only for allowlisted owners (or the demo owner) whose predicted account already holds the
   * Perpl minimum (fund first), with a plain EOA owner. A create that would find the account already
   * deployed (front-run, or the signature already used) is not sent and frees its slot.
   */
  async create(req: CreateRequest, ipKey: string): Promise<CreateResult> {
    const existing = this.o.ledger.getCreate(req.owner);
    // L-3: a receipt from an abandoned proposal is not final; the stored row is returned only while the account exists.
    if (existing?.status === 'sent' && (await this.isAccount(getAddress(existing.account)))) return createResult(req.owner, existing);

    const nowS = BigInt(Math.floor(this.now() / 1000));
    if (req.deadline < nowS + BigInt(SPONSOR_LIMITS.minDeadlineMarginS)) throw new HttpError(400, 'SIG_EXPIRED', 'Signature deadline is too close or passed');
    if (req.deadline > nowS + BigInt(SPONSOR_LIMITS.maxDeadlineAheadS)) throw new HttpError(400, 'DEADLINE_TOO_FAR', 'Signature deadline is too far ahead');
    const violation = grantPolicyViolation(req.grant, nowS, this.o.grantPolicy);
    if (violation) {
      this.o.log.info({ owner: req.owner, violation }, 'sponsor.grant_out_of_policy');
      throw new HttpError(400, 'GRANT_OUT_OF_POLICY', 'Operator grant is outside the sponsored limits');
    }
    const valid = await verifyCreateAccountSig({ factory: this.o.factory, owner: req.owner, grant: req.grant, deadline: req.deadline, sig: req.sig });
    if (!valid) throw new HttpError(400, 'BAD_SIGNATURE', 'Signature does not match the owner');
    // SE-W4 L-1: only a valid signature for this owner can drop its row, and only on finalized state.
    if (existing?.status === 'sent') {
      const state = await this.storedCreateState(existing);
      if (state === 'live') return createResult(req.owner, existing);
      if (state === 'unsettled') throw new HttpError(409, 'IN_PROGRESS', 'Account creation is still settling, retry shortly');
      this.o.log.error({ owner: req.owner, account: existing.account, hash: existing.tx_hash }, 'sponsor.create_vanished');
      this.o.ledger.settleCreate(req.owner, { status: 'rejected', code: 'VANISHED' });
    }
    if (!this.ownerAllowed(req.owner)) throw new HttpError(403, 'NOT_ALLOWLISTED', 'Sponsoring is limited to invited owners');

    const account = await readContract(this.o.client, { address: this.o.factory, abi: IGaplessFactoryAbi, functionName: 'accountOf', args: [req.owner] });
    const [[deployed, funded, minOpen], ownerCode] = await Promise.all([
      multicall(this.o.client, {
        allowFailure: false,
        contracts: [
          { address: this.o.factory, abi: IGaplessFactoryAbi, functionName: 'isAccount', args: [account] },
          { address: AUSD, abi: IAUSDAbi, functionName: 'balanceOf', args: [account] },
          { address: PERPL_EXCHANGE, abi: IPerplMinAbi, functionName: 'getMinAccountOpenCNS' }
        ]
      }),
      getCode(this.o.client, { address: req.owner })
    ]);
    // A delegated (EIP-7702) owner sends the factory down the ERC-1271 path; the offchain EOA check no longer holds.
    if (ownerCode !== undefined && ownerCode !== '0x') throw new HttpError(400, 'OWNER_NOT_EOA', 'The owner must be a plain wallet address');
    if (!deployed && funded < minOpen) {
      throw new HttpError(409, 'NOT_FUNDED', 'Send at least the Perpl minimum to your account address first');
    }
    const claim = this.o.ledger.claimCreate(req.owner, account, ipKey);
    switch (claim.kind) {
      case 'existing':
        return createResult(req.owner, claim.row);
      case 'in_progress':
        throw new HttpError(409, 'IN_PROGRESS', 'Account creation is already in progress');
      case 'failed':
        // SE2-L2: a front-run recorded before adoption existed is recovered the same way.
        if (claim.row.error_code === 'FRONT_RUN' && (await this.adoptable(req, account))) return this.adopt(req, account, null);
        throw new HttpError(409, 'CREATE_FAILED', 'A sponsored creation for this owner already failed');
      case 'cap':
        throw new HttpError(429, 'SPONSOR_CAP', 'Sponsoring limit reached, try again later');
    }
    if (deployed) {
      // A resumed crash or a create made elsewhere: chain state wins, nothing to send.
      if (claim.resumed) {
        this.o.ledger.settleCreate(req.owner, { status: 'sent', txHash: null, block: null });
        return { owner: req.owner, account, status: 'created', txHash: null, blockNumber: null };
      }
      if (await this.adoptable(req, account)) return this.adopt(req, account, null);
      this.o.ledger.settleCreate(req.owner, { status: 'rejected', code: 'ACCOUNT_EXISTS' });
      throw new HttpError(409, 'ACCOUNT_EXISTS', 'Account already exists');
    }

    const out = await this.o.queue.send({
      label: 'createAccountFor',
      ref: req.owner,
      dedupeKey: `create:${req.owner.toLowerCase()}`,
      address: this.o.factory,
      abi: IGaplessFactoryAbi,
      functionName: 'createAccountFor',
      args: [req.owner, req.grant, req.deadline, req.sig],
      gas: GAS.createAccountFor,
      waitForWindowMs: SPONSOR_LIMITS.windowWaitMs
    });
    switch (out.status) {
      case 'confirmed':
        this.o.ledger.settleCreate(req.owner, { status: 'sent', txHash: out.hash, block: out.blockNumber });
        this.o.log.info({ owner: req.owner, account, hash: out.hash }, 'sponsor.created');
        return { owner: req.owner, account, status: 'created', txHash: out.hash, blockNumber: out.blockNumber.toString() };
      case 'pending':
        this.o.ledger.settleCreate(req.owner, { status: 'pending', txHash: out.hash });
        return { owner: req.owner, account, status: 'pending', txHash: out.hash, blockNumber: null };
      case 'reverted': {
        // Landed after our simulation: someone created the account first. Gas is spent, so the slot stays used.
        const frontRun = await this.isAccount(account).catch(() => false);
        if (frontRun && (await this.adoptable(req, account).catch(() => false))) return this.adopt(req, account, out.hash);
        this.o.ledger.settleCreate(req.owner, { status: 'failed', code: frontRun ? 'FRONT_RUN' : 'REVERTED', txHash: out.hash });
        this.o.log.error({ owner: req.owner, hash: out.hash, frontRun }, 'sponsor.create_reverted');
        throw new HttpError(502, 'CREATE_FAILED', 'Account creation failed');
      }
      case 'skipped':
        // The copy can also land between our checks and our simulation.
        if (out.reason === 'simulation_reverted' && (await this.isAccount(account).catch(() => false)) && (await this.adoptable(req, account).catch(() => false))) {
          return this.adopt(req, account, null);
        }
        this.o.ledger.settleCreate(req.owner, { status: 'rejected', code: (out.detail ?? out.reason).slice(0, 64) });
        throw skippedError(out);
    }
  }

  /**
   * SE2-L2: a copier can land the owner's own signed createAccountFor first (it needs the payload from our tx). For an
   * invited owner (demo or allowlisted) an account with exactly that owner and grant is what the owner authorized, so
   * it counts as sponsored and /activate works. Uninvited owners never get this (no sweep or drip for self-made accounts).
   */
  private async adoptable(req: CreateRequest, account: Address): Promise<boolean> {
    if (!this.o.ledger.isDemoOwner(req.owner) && !this.o.ownerAllowlist.has(req.owner.toLowerCase())) return false;
    const [owner, op] = await multicall(this.o.client, {
      allowFailure: false,
      contracts: [
        { address: account, abi: IGaplessAccountAbi, functionName: 'owner' },
        { address: account, abi: IGaplessAccountAbi, functionName: 'operator' }
      ]
    });
    const g = req.grant;
    return (
      owner.toLowerCase() === req.owner.toLowerCase() &&
      op.key.toLowerCase() === g.key.toLowerCase() &&
      op.expiry === g.expiry &&
      op.maxNotionalPerTradeCNS === g.maxNotionalPerTradeCNS &&
      op.maxNotionalPerDayCNS === g.maxNotionalPerDayCNS
    );
  }

  private adopt(req: CreateRequest, account: Address, hash: Hex | null): CreateResult {
    this.o.ledger.settleCreate(req.owner, { status: 'sent', txHash: null, block: null });
    this.o.log.warn({ owner: req.owner, account, revertedHash: hash }, 'sponsor.create_front_run_adopted');
    return { owner: req.owner, account, status: 'created', txHash: null, blockNumber: null };
  }

  /** M-1: only accounts this relay created are swept and dripped. */
  async activate(account: Address, ipKey: string): Promise<ActivationResult> {
    const prior = this.o.ledger.getActivation(account);
    if (prior?.status === 'done' && !reopenable(prior)) return activationResult(account, prior);
    if (!(await this.isAccount(account))) throw new HttpError(404, 'NOT_AN_ACCOUNT', 'Not a Gapless account');
    await this.requireSponsored(account);

    const claim = this.o.ledger.claimActivation(account, ipKey);
    switch (claim.kind) {
      case 'existing':
        return activationResult(account, claim.row);
      case 'in_progress':
        throw new HttpError(409, 'IN_PROGRESS', 'Activation is already in progress');
      case 'failed':
        throw new HttpError(409, 'ACTIVATION_FAILED', 'Activation for this account already failed');
      case 'cap':
        throw new HttpError(429, 'SPONSOR_CAP', 'Activation limit reached, try again later');
    }

    try {
      const perplId = await this.ensurePerplAccount(account);
      await this.requireFunded(perplId);
      await this.drip(account);
      this.o.ledger.finishActivation(account, 'done');
      return activationResult(account, this.o.ledger.getActivation(account)!);
    } catch (err) {
      const final = err instanceof ActivationFailed;
      this.o.ledger.finishActivation(account, final ? 'failed' : 'rejected', err instanceof HttpError ? err.code : final ? err.code : 'ERROR');
      if (err instanceof ActivationFailed) throw new HttpError(502, 'ACTIVATION_FAILED', 'Activation failed');
      throw err;
    }
  }

  private async ensurePerplAccount(account: Address): Promise<bigint> {
    const [perplId, wallet, minOpen] = await multicall(this.o.client, {
      allowFailure: false,
      contracts: [
        { address: account, abi: IGaplessAccountAbi, functionName: 'perplAccountId' },
        { address: AUSD, abi: IAUSDAbi, functionName: 'balanceOf', args: [account] },
        { address: PERPL_EXCHANGE, abi: IPerplMinAbi, functionName: 'getMinAccountOpenCNS' }
      ]
    });
    if (perplId !== 0n) {
      this.o.ledger.updateActivation(account, { perpl_account_id: perplId.toString() });
      return perplId;
    }
    if (wallet < minOpen) throw new HttpError(409, 'NOT_FUNDED', 'Deposit at least the Perpl minimum first');

    const out = await this.o.queue.send({
      label: 'sweep',
      ref: account,
      dedupeKey: `sweep:${account.toLowerCase()}`,
      address: account,
      abi: IGaplessAccountAbi,
      functionName: 'sweep',
      gas: GAS.sweep,
      waitForWindowMs: SPONSOR_LIMITS.windowWaitMs
    });
    if (out.status === 'skipped') throw skippedError(out);
    this.o.ledger.updateActivation(account, { sweep_tx: out.hash });
    if (out.status === 'reverted') throw new ActivationFailed('SWEEP_REVERTED');
    if (out.status === 'pending') throw new HttpError(503, 'RELAY_BUSY', 'Activation is still settling, retry shortly');
    const opened = await readContract(this.o.client, { address: account, abi: IGaplessAccountAbi, functionName: 'perplAccountId' });
    if (opened === 0n) throw new ActivationFailed('SWEEP_DID_NOT_OPEN');
    this.o.ledger.updateActivation(account, { perpl_account_id: opened.toString() });
    return opened;
  }

  /** Spec §4.2: Perpl balance plus position deposits >= the Perpl account minimum. */
  private async requireFunded(perplId: bigint): Promise<void> {
    const [info, minOpen] = await multicall(this.o.client, {
      allowFailure: false,
      contracts: [
        { address: PERPL_EXCHANGE, abi: IPerplMinAbi, functionName: 'getAccountById', args: [perplId] },
        { address: PERPL_EXCHANGE, abi: IPerplMinAbi, functionName: 'getMinAccountOpenCNS' }
      ]
    });
    const p = info.positions;
    const perps = perpIdsFromBitmap([p.bank1, p.bank2, p.bank3, p.bank4]);
    let deposits = 0n;
    if (perps.length > 0) {
      const positions = await multicall(this.o.client, {
        allowFailure: false,
        contracts: perps.map((id) => ({ address: PERPL_EXCHANGE, abi: IPerplMinAbi, functionName: 'getPosition' as const, args: [BigInt(id), perplId] as const }))
      });
      for (const [pos] of positions) deposits += pos.depositCNS;
    }
    if (info.balanceCNS + deposits < minOpen) throw new HttpError(409, 'NOT_FUNDED', 'Deposit at least the Perpl minimum first');
  }

  private ownerAllowed(owner: Address): boolean {
    return this.o.ledger.isDemoOwner(owner) || !this.o.ownerAllowlistOnly || this.o.ownerAllowlist.has(owner.toLowerCase());
  }

  private async requireSponsored(account: Address): Promise<void> {
    const owner = await readContract(this.o.client, { address: account, abi: IGaplessAccountAbi, functionName: 'owner' });
    const row = this.o.ledger.getCreate(owner);
    const ours = row !== null && row.account === account.toLowerCase() && (row.status === 'sent' || row.status === 'pending');
    if (!ours) throw new HttpError(403, 'NOT_SPONSORED', 'Only accounts created through Gapless onboarding can be activated');
    // A timed-out create that landed (isAccount was just checked) is ours.
    if (row.status === 'pending') this.o.ledger.settleCreate(owner, { status: 'sent', txHash: row.tx_hash as Hex | null, block: null });
  }

  /**
   * 0.5 MON to the onchain operator (D50), allowlisted keys only, once per account and per key.
   * M-3: the hash and nonce are stored before broadcast; a retry resolves them and never re-sends a drip
   * that may still land.
   */
  private async drip(account: Address): Promise<void> {
    const row = this.o.ledger.getActivation(account);
    if (row?.drip_tx) {
      // Rows before migration 3 have no state and were only written after a receipt.
      if (row.drip_state === null || row.drip_state === 'confirmed') return;
      const state = await this.resolveDrip(account, row);
      if (state === 'pending') throw new HttpError(503, 'RELAY_BUSY', 'Activation is still settling, retry shortly');
      if (state !== 'dropped') return;
    }
    const op = await readContract(this.o.client, { address: account, abi: IGaplessAccountAbi, functionName: 'operator' });
    const key = op.key;
    const skip = async (): Promise<string | null> => {
      if (this.o.dripWei === 0n) return 'disabled';
      if (/^0x0{40}$/i.test(key)) return 'no_operator';
      if (op.expiry <= BigInt(Math.floor(this.now() / 1000))) return 'operator_expired';
      // N-03: a zero daily budget blocks every operator order, so MON there is wasted (the owner can re-grant).
      if (op.maxNotionalPerDayCNS === 0n) return 'operator_no_budget';
      if (!this.o.dripAllowlist.has(key.toLowerCase())) return 'not_allowlisted';
      if (this.o.ledger.operatorDripped(key)) return 'already_dripped';
      if ((await getBalance(this.o.client, { address: key })) >= this.o.dripWei) return 'already_funded';
      return null;
    };
    const reason = await skip();
    this.o.ledger.updateActivation(account, { operator: key.toLowerCase(), drip_skipped: reason });
    if (reason) return;

    // Standalone emptying tx: the queue waits until the relay key sent nothing in the last 3 blocks.
    let signed = false;
    const out = await this.o.queue.send({
      label: 'drip',
      ref: account,
      dedupeKey: `drip:${key.toLowerCase()}`,
      to: key,
      value: this.o.dripWei,
      waitForWindowMs: SPONSOR_LIMITS.windowWaitMs,
      onSigned: (tx) => {
        this.o.ledger.recordDripSigned(account, key, tx.hash, tx.nonce, this.o.dripWei);
        signed = true;
      }
    });
    if (out.status === 'skipped') {
      // Signed but refused by the node: nothing was broadcast.
      if (signed) this.o.ledger.settleDrip(account, { state: 'rejected' });
      throw skippedError(out);
    }
    if (out.status === 'pending') throw new HttpError(503, 'RELAY_BUSY', 'Activation is still settling, retry shortly');
    if (out.status === 'reverted') {
      this.o.log.error({ account, operator: key, hash: out.hash }, 'drip.reverted');
      this.o.ledger.settleDrip(account, { state: 'reverted' });
      return;
    }
    this.o.ledger.settleDrip(account, { state: 'confirmed', block: out.blockNumber });
    this.o.log.info({ account, operator: key, hash: out.hash, wei: this.o.dripWei.toString() }, 'drip.sent');
    await this.waitForBlock(out.blockNumber + SPONSOR_LIMITS.fundedWaitBlocks);
  }

  /** Receipt first; with none, a finalized relay nonce past the drip's nonce proves it can never land. */
  private async resolveDrip(account: Address, row: ActivationRow): Promise<'confirmed' | 'reverted' | 'dropped' | 'pending'> {
    const hash = row.drip_tx as Hex;
    const receipt = await getTransactionReceipt(this.o.client, { hash }).catch((err: unknown) => {
      if (err instanceof TransactionReceiptNotFoundError) return null;
      throw err;
    });
    if (receipt) {
      if (receipt.status === 'success') {
        this.o.ledger.settleDrip(account, { state: 'confirmed', block: receipt.blockNumber });
        this.o.log.info({ account, hash, block: receipt.blockNumber.toString() }, 'drip.resolved_confirmed');
        return 'confirmed';
      }
      this.o.ledger.settleDrip(account, { state: 'reverted' });
      this.o.log.error({ account, hash }, 'drip.reverted');
      return 'reverted';
    }
    const finalizedNonce = await getTransactionCount(this.o.client, { address: this.o.queue.address, blockTag: 'finalized' });
    if (row.drip_nonce !== null && finalizedNonce > row.drip_nonce) {
      this.o.ledger.settleDrip(account, { state: 'dropped' });
      this.o.log.warn({ account, hash, nonce: row.drip_nonce }, 'drip.dropped');
      return 'dropped';
    }
    return 'pending';
  }

  /**
   * A `sent` row whose account `latest` does not show. Vanished only once finality covers the row (its block, or
   * SPONSOR_LIMITS.vanishSettleMs for rows stored without one) and the account is absent there; else read lag.
   */
  private async storedCreateState(row: CreateRow): Promise<'live' | 'vanished' | 'unsettled'> {
    const fin = await getBlock(this.o.client, { blockTag: 'finalized' });
    const covered = row.block_number !== null ? fin.number >= BigInt(row.block_number) : this.now() - Date.parse(row.updated_at) >= SPONSOR_LIMITS.vanishSettleMs;
    if (!covered) return 'unsettled';
    // Pinned to the height just compared; a node without it errors and the row stays.
    const live = await readContract(this.o.client, { address: this.o.factory, abi: IGaplessFactoryAbi, functionName: 'isAccount', args: [getAddress(row.account)], blockNumber: fin.number });
    return live ? 'live' : 'vanished';
  }

  private async isAccount(account: Address): Promise<boolean> {
    return readContract(this.o.client, { address: this.o.factory, abi: IGaplessFactoryAbi, functionName: 'isAccount', args: [account] });
  }

  private async waitForBlock(target: bigint): Promise<void> {
    const deadline = this.now() + SPONSOR_LIMITS.blockWaitMs;
    while (this.now() < deadline) {
      if ((await getBlockNumber(this.o.client, { cacheTime: 0 })) >= target) return;
      await (this.o.sleep ?? Bun.sleep)(SPONSOR_LIMITS.pollMs);
    }
    this.o.log.warn({ target: target.toString() }, 'drip.wait_timeout');
  }
}

/** A step that spent gas and cannot be retried as is. */
class ActivationFailed extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

function reopenable(row: ActivationRow): boolean {
  return row.drip_tx === null && row.drip_skipped !== null && RETRYABLE_DRIP_SKIPS.has(row.drip_skipped);
}

function skippedError(out: Extract<SendOutcome, { status: 'skipped' }>): HttpError {
  if (out.reason === 'governor_cap') return new HttpError(503, 'BUDGET_EXHAUSTED', 'Daily sponsoring budget is used up');
  if (out.reason === 'insufficient_balance') return new HttpError(503, 'BUDGET_EXHAUSTED', 'Sponsoring is out of funds');
  if (out.reason === 'simulation_reverted') return new HttpError(400, 'WOULD_REVERT', 'The transaction would revert');
  return new HttpError(503, 'RELAY_BUSY', 'Relay is busy, retry shortly');
}

function createResult(owner: Address, row: CreateRow): CreateResult {
  return {
    owner,
    account: getAddress(row.account),
    status: row.status === 'sent' ? 'created' : 'pending',
    txHash: (row.tx_hash as Hex | null) ?? null,
    blockNumber: row.block_number
  };
}

function activationResult(account: Address, row: ActivationRow): ActivationResult {
  return {
    account,
    perplAccountId: row.perpl_account_id,
    sweepTx: row.sweep_tx,
    drip: row.drip_tx && row.drip_block ? { to: getAddress(row.operator!), wei: row.drip_wei!, txHash: row.drip_tx, blockNumber: row.drip_block } : null,
    dripSkipped: row.drip_skipped
  };
}
