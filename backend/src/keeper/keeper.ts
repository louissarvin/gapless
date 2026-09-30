import type { Address, Hex } from 'viem';
import { multicall } from 'viem/actions';
import { ICoverManagerAbi, IPerplMinAbi } from '../abi/index.ts';
import { PERPL_EXCHANGE } from '../lib/addresses.ts';
import { ConditionLog } from '../lib/conditionLog.ts';
import type { Database } from '../lib/db.ts';
import { billedPriceWei, feeQuote, GAS, MAX_MATCHES_CLOSE_SUPPORTED, triggerGasFor } from '../lib/gas.ts';
import type { Logger } from '../lib/log.ts';
import type { AcceptDecision, ChainClient, ContractSend, SendOutcome, SendQueue, SkipReason } from '../lib/sendQueue.ts';
import type { SpendGovernor } from '../lib/spendGovernor.ts';
import type { MarketStore } from '../relay/perpl/store.ts';
import {
  BlockBackoff,
  COVER_STATUS,
  MAX_LOW_PRIORITY_PER_BLOCK,
  STEP_MAX_GAP_BLOCKS,
  actionKey,
  armAllowed,
  bookFromPerpInfo,
  closePays,
  coverEvents,
  coverFilledLots,
  fastPath,
  inExclusiveWindow,
  landingBlock,
  landsInTime,
  lastWalkStep,
  pastWarmup,
  selectActions,
  triggerDedupeKey,
  venueOk,
  zeroPaidTriggerCloses,
  MAX_NO_FILL_STEPS_PER_TOUCH,
  type CoverView,
  type MarkInfo,
  type PerpBook,
  type PerpWatch,
  type PlannedAction,
  type RefRead,
  type TriggerCover,
  type ZeroPaidDecision
} from './actions.ts';
import type { Head } from './heads.ts';
import { decideSigmaPost, deviationBps, SIGMA_POLICY, type MarkHistory, type SigmaDecision } from './sigma.ts';
import { TouchLedger } from './touches.ts';

/** watchList and housekeeping page size per perp (spec §4.1). */
export const WATCH_PAGE = 16n;
const CYCLE_ERROR_LOG_MS = 30_000;
/** marketParams change only by admin tx; re-read this often. */
const PARAMS_REFRESH_BLOCKS = 1_000n;
/** A head this far past the RPC poll and our last head is bogus (L-2); real heads move one at a time. */
export const MAX_HEAD_AHEAD_BLOCKS = 50n;

/**
 * Triggers that do not pay (H-1): N-01 no-fill steps and zero-gap closes, booked outside the hot-path reserve.
 * Per cover: a touch (walk start at step 0) is admitted only with room and balance for its whole walk and fills
 * (SE2-M1, SE3-L2), at most `touchesPerCoverPerDay` landed walk starts and `perCoverPerDay` attempts per UTC day
 * (SE3-I2). KEEPER_ZERO_PAID_CAP_WEI is the global backstop. A close the mirror expects to pay (the walk's final close
 * included) is a `trigger` on the hot path, never this.
 */
export const ZERO_PAID_TRIGGER = { label: 'trigger_zero', touchesPerCoverPerDay: 2, perCoverPerDay: 2 * MAX_NO_FILL_STEPS_PER_TOUCH } as const;
/**
 * Zero-paid remainder closes that fill (zero-gap lots, L-07): exempt like the trigger they finish, bounded per cover
 * per day by the contract's own bound ceil(lots / maxMatchesClose) plus one.
 */
export const REMAINDER_TRIGGER_LABEL = 'trigger_remainder';
/** Re-arms of a cover already armed today (lazy TTL lapse in chop): booked outside the hot reserve. */
export const REPEAT_ARM_LABEL = 'arm_repeat';
/** SE2-H1: blocks between consecutive attempts of one touch above this are an alert (the contract allows 10). */
export const CHAIN_GAP_ALERT_BLOCKS = 6n;
/** Chain gap samples kept for the read-only console. */
const CONSOLE_GAP_SAMPLES = 200;
/** Lane attempts per fast-lane run: a 5-step walk and ceil(lots / 8) fills for a few covers taking turns. */
export const FAST_LANE_MAX_ATTEMPTS = 24;
/** SE3-M2: projected lane gap allowed for an arm, an early observe or a first trigger joining the lane (no alert). */
export const LANE_SIDE_GAP_BLOCKS = CHAIN_GAP_ALERT_BLOCKS;
/** SE3-M2: an observe this close to its window end is due and may push lane gaps to one block under the contract's 10. */
export const OBSERVE_DUE_BLOCKS = 15n;
const LANE_DUE_GAP_BLOCKS = STEP_MAX_GAP_BLOCKS - 1n;
/** SE3-M2: side sends per lane run; at most one between two lane attempts. */
export const LANE_SIDE_MAX_SENDS = 8;
/** SE3-M1: a lane read at the receipt block fails on a node that has not imported it yet; retry briefly. */
const LANE_READ_RETRIES = 2;
const LANE_READ_RETRY_MS = 100;

/** Decoded custom error names (ConditionNotMet, NotArmer, ...); anything else is an undecoded revert. */
const CUSTOM_ERROR = /^[A-Z][A-Za-z0-9_]*$/;

// Nothing else can be sent at this head once one of these comes back.
const STOP_REASONS: ReadonlySet<SkipReason> = new Set(['reserve_window', 'reserve_budget', 'blocked', 'busy', 'insufficient_balance', 'rpc_error', 'halted']);

interface ParamsView {
  /** SA4-01: maxMatchesClose within what GAS.trigger covers; false refuses arm and trigger on this market. */
  supported: boolean;
  exclusiveBlocks: number;
  refTolBps: number;
  armTtlBlocks: number;
  sigmaMaxAgeBlocks: number;
  refFreshSec: number;
  maxMatchesClose: number;
  readAt: bigint;
}

interface CoverRead extends CoverView, TriggerCover {
  startBlock: bigint;
  /** L-03 snapshots: warm-up gates the fast path, window bounds remainders, observe and finalize. */
  warmupBlocks: number;
  windowBlocks: number;
  lots: bigint;
  owedCNS: bigint;
  paidCNS: bigint;
  capCNS: bigint;
  triggerBlock: bigint;
}

type TriggerBase = Pick<ContractSend, 'ref' | 'dedupeKey' | 'address' | 'abi' | 'functionName' | 'args'>;

type PerpInfo = MarkInfo & { basePricePNS: bigint; maxBidPriceONS: bigint; minAskPriceONS: bigint };

interface PerpRead {
  info: PerpInfo;
  halted: boolean;
}

/** How a mirror verdict is sent: a close on GAS.trigger under `decision`, a step at `gas`, or not at all. */
type Booking = { kind: 'close'; decision: AcceptDecision } | { kind: 'step'; gas: bigint } | { kind: 'skip'; why: string };

/** A cover whose close is in progress: its next attempt goes from the receipt, not the next head. */
interface LaneEntry {
  id: Hex;
  perpId: number;
  isLong: boolean;
  /** Block of the cover's latest landed attempt (the chain gap counts from it). */
  lastLanded: bigint;
  /** A first trigger admitted from the side queue: no attempt of this touch has landed yet. */
  fresh?: boolean;
}

/** SE3-M2: time-critical work for covers outside the lane, served between lane attempts. */
interface SideItem {
  action: PlannedAction;
  /** Observe: the last block it can land in. */
  deadline: bigint | null;
  /** Not tried before this landing block (an observe whose reference was not ready yet). */
  notBefore: bigint;
}

/** An admitted walk still running: what it may still spend, so the next admission leaves room for it (SE3-M2). */
interface Walk {
  steps: number;
  fills: number;
  /** Block of its latest attempt; the contract chain dies STEP_MAX_GAP_BLOCKS after it. */
  lastAt: bigint;
}

/** Blocks per send in a lane run, from consecutive receipt blocks; the max of the last three is the estimate. */
class LanePace {
  private readonly deltas: bigint[] = [];

  constructor(private last: bigint) {}

  tip(): bigint {
    return this.last;
  }

  landed(block: bigint): void {
    if (block > this.last) {
      this.deltas.push(block - this.last);
      this.last = block;
    }
  }

  blocksPerSend(): bigint | null {
    const recent = this.deltas.slice(-3);
    return recent.length === 0 ? null : recent.reduce((m, d) => (d > m ? d : m), 1n);
  }
}

export interface KeeperOptions {
  client: ChainClient;
  queue: SendQueue;
  /** Same governor as the queue: per-cover and per-action daily counts. */
  governor: SpendGovernor;
  /** Keeper db (migrated): walk starts per cover per UTC day persist here (F-7). */
  db: Database;
  manager: Address;
  keeper: Address;
  perps: readonly number[];
  store: MarketStore;
  marks: MarkHistory;
  log: Logger;
  /** False when the key lacks SIGMA_ROLE: arm and trigger still run. */
  sigmaEnabled: boolean;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export interface KeeperSnapshot {
  proposed: string | null;
  finalized: string | null;
  headAgeMs: number | null;
  rpcHead: string | null;
  lagBlocks: number | null;
  lastCycle: { head: string; ms: number; planned: number; sent: number } | null;
  cycles: number;
  errors: number;
  rejectedHeads: number;
  backoffs: number;
  sigma: Record<string, { estimateE2: number | null; decision: string; atMs: number }>;
}

/**
 * Spec §4.1 loop. Proposed heads drive one cycle at a time (newer heads coalesce while one runs);
 * Finalized heads reconcile the send queue. Chain state decides every action: the relay feed only
 * gates sigma posts, so a feed outage never blocks arm or trigger.
 */
export class Keeper {
  private proposed: Head | null = null;
  private proposedAt: number | null = null;
  private finalized: bigint | null = null;
  private pendingHead: Head | null = null;
  private running: Promise<void> | null = null;
  private rpcHead: bigint | null = null;
  private readonly params = new Map<number, ParamsView>();
  private readonly sigmaRequests = new Map<number, number>();
  private readonly sigmaState = new Map<number, { estimateE2: number | null; decision: string; atMs: number }>();
  private lastCycle: KeeperSnapshot['lastCycle'] = null;
  private cycles = 0;
  private errors = 0;
  private lastErrorLogAt = Number.NEGATIVE_INFINITY;
  private rejectedHeads = 0;
  private lastRejectLogAt = Number.NEGATIVE_INFINITY;
  private readonly backoff = new BlockBackoff();
  /** Covers whose in-flight trigger is an N-01 step: its TriggerNoFill extends the chain, so it is progress. */
  private readonly steps = new Set<Hex>();
  /** Set when a step simulation runs out of GAS.triggerStep; steps then go at GAS.trigger. */
  private stepGasLow = false;
  /** Deferred finalizes sent only to release the reservation above paid + owed (L-05). */
  private readonly releases = new Set<Hex>();
  /** SE2-L4: covers whose close landed as TriggerNoFill against a book top the mirror said fills. */
  private readonly phantom = new Set<Hex>();
  /** SE3-I2: walk starts per cover per UTC day, counted from receipts (the contract ran the attempt at step 0); F-7: in sqlite. */
  private readonly touches: TouchLedger;
  /** Step attempts awaiting their receipt: the chain they meant to extend and the step the mirror chose. */
  private readonly pendingSteps = new Map<Hex, { from: bigint; step: number }>();
  /** Covers whose latest step was planned as a continuation but landed past the gap (a restart): the cadence is too slow. */
  private readonly restartMiss = new Set<Hex>();
  /** Admitted walks. F-7: memory only; a continuation with no entry (restart mid-walk) is adopted from chain state. */
  private readonly walks = new Map<Hex, Walk>();
  /** F-2: mark history fetch running outside the head loop; null when idle. */
  private marksFetch: Promise<void> | null = null;
  /** Console only (read-only): the last chain gaps as logged by logGap. Nothing reads it to decide a send. */
  private readonly gapSamples: { gapBlocks: number; path: 'lane' | 'cycle' }[] = [];
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  /** F-5: conditions re-checked every head log at warn on transitions, not per head. */
  private readonly markMismatch: ConditionLog;
  private readonly touchBudget: ConditionLog;

  constructor(private readonly o: KeeperOptions) {
    this.now = o.now ?? Date.now;
    this.sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.touches = new TouchLedger(o.db, o.keeper, this.now);
    this.markMismatch = new ConditionLog(o.log, 'sigma.skip_mark_mismatch', this.now);
    this.touchBudget = new ConditionLog(o.log, 'keeper.touch_budget', this.now);
  }

  /** Boot: reads market params, so an unsupported maxMatchesClose is reported before the first head (SA4-01). */
  async init(head: bigint): Promise<number[]> {
    await this.ensureParams(head);
    return this.o.perps.filter((p) => this.params.get(p)?.supported === false);
  }

  /** False when the head is rejected as implausible; the caller must not use it as the send head. */
  onHead(h: Head): boolean {
    if (!this.plausible(h.number)) {
      this.rejectedHeads++;
      if (this.now() - this.lastRejectLogAt >= CYCLE_ERROR_LOG_MS) {
        this.lastRejectLogAt = this.now();
        this.o.log.error({ head: h.number.toString(), rpcHead: this.rpcHead?.toString() ?? null, rejected: this.rejectedHeads }, 'keeper.head_rejected');
      }
      return false;
    }
    // Plain newHeads (local node) carries no commit state: act and reconcile on the same head.
    if (h.commitState === 'Finalized' || h.commitState === null) this.onFinalized(h.number);
    if (h.commitState === 'Proposed' || h.commitState === null) this.schedule(h);
    return true;
  }

  /** Independent RPC head for the lag metric and the head plausibility bound. */
  observeRpcHead(n: bigint): void {
    this.rpcHead = n;
    // A bogus head accepted before the first poll would block every real one (heads at or below it are ignored).
    if (this.proposed && this.proposed.number > n + MAX_HEAD_AHEAD_BLOCKS) {
      this.o.log.error({ proposed: this.proposed.number.toString(), rpcHead: n.toString() }, 'keeper.head_reset');
      this.proposed = null;
    }
    if (this.finalized !== null && this.finalized > n + MAX_HEAD_AHEAD_BLOCKS) this.finalized = null;
  }

  private plausible(n: bigint): boolean {
    let ref: bigint | null = this.rpcHead;
    for (const r of [this.proposed?.number ?? null, this.finalized]) if (r !== null && (ref === null || r > ref)) ref = r;
    return ref === null || n <= ref + MAX_HEAD_AHEAD_BLOCKS;
  }

  /** Internal /sigma-refresh. False for perps this keeper does not watch. */
  requestSigma(perpId: number): boolean {
    if (!this.o.perps.includes(perpId)) return false;
    this.sigmaRequests.set(perpId, this.now());
    return true;
  }

  /** Resolves when no cycle is running (shutdown). */
  async idle(): Promise<void> {
    while (this.running) await this.running;
  }

  /** Resolves when no mark history fetch is running. */
  async marksIdle(): Promise<void> {
    while (this.marksFetch) await this.marksFetch;
  }

  snapshot(): KeeperSnapshot {
    const lag = this.rpcHead !== null && this.proposed ? Number(this.rpcHead - this.proposed.number) : null;
    return {
      proposed: this.proposed?.number.toString() ?? null,
      finalized: this.finalized?.toString() ?? null,
      headAgeMs: this.proposedAt === null ? null : this.now() - this.proposedAt,
      rpcHead: this.rpcHead?.toString() ?? null,
      lagBlocks: lag,
      lastCycle: this.lastCycle,
      cycles: this.cycles,
      errors: this.errors,
      rejectedHeads: this.rejectedHeads,
      backoffs: this.backoff.size(),
      sigma: Object.fromEntries([...this.sigmaState].map(([k, v]) => [String(k), v]))
    };
  }

  /** Console view (read-only copies): market gate state from the last params read and recent chain gaps. */
  consoleView(): { markets: { perpId: number; gated: boolean; maxMatchesClose: number | null }[]; gaps: { gapBlocks: number; path: 'lane' | 'cycle' }[] } {
    return {
      markets: this.o.perps.map((perpId) => {
        const p = this.params.get(perpId);
        return { perpId, gated: p?.supported === false, maxMatchesClose: p?.maxMatchesClose ?? null };
      }),
      gaps: this.gapSamples.map((g) => ({ ...g }))
    };
  }

  private onFinalized(n: bigint): void {
    if (this.finalized !== null && n <= this.finalized) return;
    this.finalized = n;
    this.o.queue.reconcile(n).catch((err: unknown) => this.o.log.error({ err, finalized: n.toString() }, 'keeper.reconcile_failed'));
  }

  private schedule(h: Head): void {
    if (this.proposed && h.number <= this.proposed.number) return;
    this.proposed = h;
    this.proposedAt = this.now();
    this.o.store.observeChainHead(Number(h.number), this.proposedAt);
    if (this.running) {
      this.pendingHead = h;
      return;
    }
    this.running = this.loop(h);
  }

  private async loop(first: Head): Promise<void> {
    let next: Head | null = first;
    while (next) {
      this.pendingHead = null;
      try {
        await this.cycle(next);
      } catch (err) {
        this.errors++;
        // An RPC outage fails every head (about 3 per second); log it at error level once per window.
        const loud = this.now() - this.lastErrorLogAt >= CYCLE_ERROR_LOG_MS;
        if (loud) this.lastErrorLogAt = this.now();
        this.o.log[loud ? 'error' : 'debug']({ err, head: next.number.toString(), errors: this.errors }, 'keeper.cycle_failed');
      }
      next = this.pendingHead;
    }
    this.running = null;
  }

  /** One head: read, plan, simulate and send in priority order, then sigma if nothing went out. */
  async cycle(head: Head): Promise<void> {
    const started = this.now();
    this.cycles++;
    await this.ensureParams(head.number);
    // SA4-01: no arm or trigger where a close could need more than GAS.trigger.
    const watches = (await this.readWatch()).map((w) => (this.params.get(w.perpId)?.supported === false ? { ...w, toArm: [], toTrigger: [] } : w));
    const ids = [...new Set(watches.flatMap((w) => [...w.toTrigger, ...w.toArm, ...w.toObserve, ...w.toFinalize]))];
    const covers = ids.length > 0 ? await this.readCovers(ids) : new Map<Hex, CoverRead>();
    const fast = await this.fastInWindow(watches, covers, head);
    const plan = selectActions({
      head: head.number,
      keeper: this.o.keeper,
      perps: watches,
      covers,
      fast,
      // A finalize in backoff is not planned, so it does not take a low-priority slot.
      inflight: (k) => this.o.queue.isInflight(k, head.number) || (k.startsWith('finalize:') && this.backoff.blocked(k, head.number)),
      maxLowPriority: MAX_LOW_PRIORITY_PER_BLOCK
    });
    let sent = 0;
    for (const action of plan) {
      const out = await this.execute(action, covers, head);
      const step = action.kind === 'trigger' && this.steps.has(action.coverId);
      this.afterSend(action, out, head.number);
      this.logOutcome(action, out);
      if (out.status !== 'skipped') sent++;
      else if (STOP_REASONS.has(out.reason)) break;
      if (action.kind !== 'trigger' || out.status !== 'confirmed') continue;
      const c = covers.get(action.coverId);
      if (c && chainLive(c, head.number)) this.logGap(action.coverId, out.blockNumber - maxBig(c.shortBlock, c.triggerBlock), 'cycle');
      if (!c || !this.closeContinues(action.coverId, c, out, step)) continue;
      // SE2-H1: the rest of this close goes now, from the receipt. SE3-M2: other covers' triggers, arms and
      // observes are served between lane attempts while the lane gaps allow; low-priority sends wait for the next head.
      const lane: LaneEntry[] = [{ id: action.coverId, perpId: action.perpId, isLong: c.isLong, lastLanded: out.blockNumber }];
      const side: SideItem[] = [];
      if (coverEvents(out.logs, this.o.manager, action.coverId).has('Triggered') && c.status !== COVER_STATUS.Triggered) side.push(observeItem(action, out.blockNumber, c.windowBlocks));
      for (const other of plan.slice(plan.indexOf(action) + 1)) {
        const oc = covers.get(other.coverId);
        if (other.coverId === action.coverId) continue;
        if (other.kind === 'trigger' && oc && midClose(oc)) {
          // F-3: a dead chain's shortBlock is not a previous attempt of this touch.
          const fresh = chainLive(oc, head.number) ? undefined : true;
          lane.push({ id: other.coverId, perpId: other.perpId, isLong: oc.isLong, lastLanded: maxBig(oc.shortBlock, oc.triggerBlock), fresh });
        } else if (other.kind === 'trigger' || other.kind === 'arm') {
          side.push({ action: other, deadline: null, notBefore: 0n });
        } else if (other.kind === 'observe') {
          side.push({ action: other, deadline: oc ? oc.triggerBlock + BigInt(oc.windowBlocks) : null, notBefore: 0n });
        }
      }
      sent += await this.fastLane(lane, head, side, covers);
      break;
    }
    if (sent === 0) await this.maybeSigma(head);
    this.lastCycle = { head: head.number.toString(), ms: this.now() - started, planned: plan.length, sent };
  }

  /**
   * L-02: a trigger blocked only by another armer's window goes anyway when the fast path holds. Perp state is
   * read only when such a cover exists.
   */
  private async fastInWindow(watches: readonly PerpWatch[], covers: ReadonlyMap<Hex, CoverRead>, head: Head): Promise<Set<Hex>> {
    const fast = new Set<Hex>();
    const blocked = watches.flatMap((w) =>
      w.toTrigger.filter((id) => {
        const c = covers.get(id);
        return c !== undefined && inExclusiveWindow(c, head.number, this.o.keeper, w.exclusiveBlocks);
      }).map((id) => ({ id, perpId: w.perpId }))
    );
    if (blocked.length === 0) return fast;
    const perps = await this.readPerps([...new Set(blocked.map((b) => b.perpId))]);
    for (const { id, perpId } of blocked) {
      const p = perps.get(perpId);
      const c = covers.get(id)!;
      const fresh = this.params.get(perpId)?.refFreshSec;
      if (p && fresh !== undefined && pastWarmup(c, head.number + 1n) && fastPath(c, p.info, p.halted, fresh, head.timestamp)) fast.add(id);
    }
    return fast;
  }

  private execute(a: PlannedAction, covers: ReadonlyMap<Hex, CoverRead>, headInfo: Head): Promise<SendOutcome> {
    const head = headInfo.number;
    const base = {
      ref: a.coverId,
      dedupeKey: a.dedupeKey,
      address: this.o.manager,
      abi: ICoverManagerAbi,
      functionName: a.kind,
      args: [a.coverId]
    } satisfies Partial<ContractSend>;
    switch (a.kind) {
      case 'trigger':
        return this.sendTrigger(a, base, covers.get(a.coverId), headInfo);
      case 'arm':
        return this.o.queue.send({
          ...base,
          label: 'arm',
          gas: GAS.arm,
          exempt: true,
          // Only the first arm per cover per day may use the hot reserve, so chop cannot spend the trigger's headroom.
          accept: (r): AcceptDecision => {
            if (r !== true) return false;
            const armed = this.o.governor.countToday('arm', a.coverId) + this.o.governor.countToday(REPEAT_ARM_LABEL, a.coverId);
            return armed === 0 ? true : { label: REPEAT_ARM_LABEL, exempt: false };
          }
        });
      case 'observe':
        // SE2-M2: the payout input has a 40-block window, so it may use the hot reserve (one per cover).
        return this.o.queue.send({ ...base, label: 'observe', gas: GAS.observe, exempt: true, accept: (r) => r === true });
      case 'finalize':
        return this.o.queue.send({
          ...base,
          label: 'finalize',
          gas: GAS.finalize,
          // M-4: owed > 0 and nothing payable now means the payout stays deferred; the cover stays Triggered.
          accept: (r) => {
            const c = covers.get(a.coverId);
            if ((r as bigint) > 0n || !c || c.owedCNS === 0n) return true;
            // L-05: past the window a deferred finalize still shrinks Cap to paid + owed and frees the vault, once.
            if (c.capCNS > c.paidCNS + c.owedCNS && head + 1n > c.triggerBlock + BigInt(c.windowBlocks)) {
              this.releases.add(a.coverId);
              this.o.log.info({ coverId: a.coverId, owedCNS: c.owedCNS.toString(), releaseCNS: (c.capCNS - c.paidCNS - c.owedCNS).toString() }, 'keeper.finalize_release');
              return true;
            }
            const until = this.backoff.bump(actionKey('finalize', a.coverId), head);
            this.o.log.info({ coverId: a.coverId, owedCNS: c.owedCNS.toString(), until: until.toString() }, 'keeper.finalize_deferred');
            return false;
          }
        });
      case 'expire':
        return this.o.queue.send({ ...base, label: 'expire', gas: GAS.expire });
      case 'voidCover':
        return this.o.queue.send({ ...base, label: 'voidCover', gas: GAS.voidCover });
    }
  }

  /**
   * paidNow > 0 always goes at GAS.trigger (hot path). 0 is also a disarm, a no-fill or a zero-gap close: see
   * zeroPaidTrigger. A no-fill step is re-simulated and sent at GAS.triggerStep, since Monad bills the gas limit.
   */
  private async sendTrigger(a: PlannedAction, base: TriggerBase, cover: CoverRead | undefined, head: Head): Promise<SendOutcome> {
    let step: ZeroPaidDecision | null = null;
    const out = await this.sendWithCeiling({
      ...base,
      label: 'trigger',
      gas: GAS.trigger,
      exempt: true,
      accept: async (r): Promise<AcceptDecision> => {
        if ((r as bigint) > 0n) return true;
        const z = await this.zeroPaidTrigger(a, cover, head);
        step = z.step;
        return z.decision;
      }
    });
    if (step === null || out.status !== 'skipped' || out.reason !== 'not_needed') return out;
    const first = await this.sendStep(a, base, step, GAS.triggerStep);
    if (first.status !== 'skipped' || first.reason !== 'simulation_reverted' || CUSTOM_ERROR.test(first.detail ?? '')) return first;
    // Perpl's no-fill path needs more than GAS.triggerStep: walk at the full limit from now on, and say so loudly.
    this.stepGasLow = true;
    this.o.log.error({ coverId: a.coverId, gas: GAS.triggerStep.toString() }, 'keeper.step_gas_low');
    return this.sendStep(a, base, step, GAS.trigger);
  }

  /**
   * SA4-01: a trigger simulation that reverts without a decoded error (likely out of gas on a fragmented book) is
   * retried once at GAS.triggerCeiling and sent at that limit if it passes.
   */
  private async sendWithCeiling(req: ContractSend): Promise<SendOutcome> {
    const out = await this.o.queue.send(req);
    if (!undecodedRevert(out) || req.gas >= GAS.triggerCeiling) return out;
    this.o.log.warn({ coverId: req.ref, gas: req.gas.toString(), ceiling: GAS.triggerCeiling.toString() }, 'keeper.trigger_gas_ceiling');
    return this.o.queue.send({ ...req, gas: GAS.triggerCeiling });
  }

  private async sendStep(a: PlannedAction, base: TriggerBase, step: ZeroPaidDecision, gas: bigint): Promise<SendOutcome> {
    // A retry against a top that did not fill (SE2-L4) is not a walk step: its TriggerNoFill is no progress.
    if (step.verdict === 'step') this.steps.add(a.coverId);
    this.o.log.info({ coverId: a.coverId, step: step.step, limitPNS: step.limitPNS.toString(), gas: gas.toString() }, step.verdict === 'step' ? 'keeper.trigger_step' : 'keeper.phantom_retry');
    return this.o.queue.send({
      ...base,
      label: ZERO_PAID_TRIGGER.label,
      gas,
      accept: (r) => {
        if ((r as bigint) === 0n) return true;
        // The book moved between the two simulations; the next head sends it as a paying trigger at full gas.
        this.o.log.info({ coverId: a.coverId }, 'keeper.step_now_pays');
        return false;
      }
    });
  }

  /**
   * H-1 and N-01: a zero-paid trigger goes only if it closes lots at the contract's step, or is a no-fill step
   * that extends the chain toward a step the book fills, outside any no-op backoff and within its daily counts.
   * Returns `step` when the attempt should be re-sent at the step gas limit.
   */
  private async zeroPaidTrigger(a: PlannedAction, cover: CoverRead | undefined, head: Head): Promise<{ decision: AcceptDecision; step: ZeroPaidDecision | null }> {
    const key = actionKey('trigger', a.coverId);
    const skip = (why: string) => {
      this.o.log.debug({ coverId: a.coverId, why }, 'keeper.zero_paid_skip');
      return { decision: false, step: null };
    };
    if (this.backoff.blocked(key, head.number)) return skip('backoff');
    try {
      const c = cover ?? (await this.readCovers([a.coverId])).get(a.coverId);
      const p = this.params.get(a.perpId);
      if (!c || !p) return skip('no_cover');
      const [info, halted, [refPNS, nFresh]] = await multicall(this.o.client, {
        allowFailure: false,
        blockTag: 'latest',
        contracts: [
          { address: PERPL_EXCHANGE, abi: IPerplMinAbi, functionName: 'getPerpetualInfo', args: [BigInt(a.perpId)] },
          { address: PERPL_EXCHANGE, abi: IPerplMinAbi, functionName: 'isHalted' },
          { address: this.o.manager, abi: ICoverManagerAbi, functionName: 'referencePrice', args: [BigInt(a.perpId), c.isLong, 0n] }
        ]
      });
      const landing = landingBlock(head.number, c);
      const book = bookFromPerpInfo(info);
      const d = zeroPaidTriggerCloses({
        cover: c,
        book,
        fast: pastWarmup(c, landing) && fastPath(c, info, halted, p.refFreshSec, head.timestamp),
        venueOk: venueOk(info, halted),
        ref: { refPNS, nFresh },
        params: p,
        landing
      });
      const b = await this.booking(a.coverId, c, d, book, p, head.number, head.baseFeePerGas);
      if (b.kind === 'skip') return skip(b.why);
      if (b.kind === 'close') return { decision: b.decision, step: null };
      if (this.stepGasLow) {
        if (d.verdict === 'step') this.steps.add(a.coverId);
        this.o.log.info({ coverId: a.coverId, step: d.step, limitPNS: d.limitPNS.toString(), gas: GAS.trigger.toString() }, 'keeper.trigger_step');
        return { decision: { label: ZERO_PAID_TRIGGER.label, exempt: false }, step: null };
      }
      return { decision: false, step: d };
    } catch (err) {
      this.o.log.warn({ err, coverId: a.coverId }, 'keeper.fill_check_failed');
      return { decision: false, step: null };
    }
  }

  /** Backoff from receipts: a landed trigger or finalize that made no progress waits before the next try. */
  private afterSend(a: PlannedAction, out: SendOutcome, head: bigint): void {
    if (a.kind !== 'trigger' && a.kind !== 'finalize') return;
    const step = a.kind === 'trigger' && this.steps.delete(a.coverId);
    const release = a.kind === 'finalize' && this.releases.delete(a.coverId);
    const planned = a.kind === 'trigger' ? this.pendingSteps.get(a.coverId) : undefined;
    if (planned) this.pendingSteps.delete(a.coverId);
    if (out.status !== 'confirmed' && out.status !== 'reverted') return;
    if (a.kind === 'trigger') this.walkLanded(a.coverId, out, step);
    // SA4-03: a step that met a bid at landing ran out of gas and changed nothing: retry at once, no backoff.
    if (step && out.status === 'reverted') {
      this.o.queue.releaseKey(a.dedupeKey);
      this.o.log.warn({ coverId: a.coverId }, 'keeper.step_reverted');
      return;
    }
    if (planned && out.status === 'confirmed') {
      const restart = planned.from === 0n || out.blockNumber - planned.from > STEP_MAX_GAP_BLOCKS;
      if (restart) this.touches.countStart(a.coverId);
      if (restart && planned.step > 0) this.restartMiss.add(a.coverId);
      else this.restartMiss.delete(a.coverId);
    }
    const key = actionKey(a.kind, a.coverId);
    const events = out.status === 'confirmed' ? coverEvents(out.logs, this.o.manager, a.coverId) : new Set<string>();
    // A step's TriggerNoFill extends the chain (the next block widens); a release finalize leaves the cover Triggered.
    const progress =
      a.kind === 'trigger'
        ? events.has('Triggered') || events.has('CoverEnded') || (step && events.has('TriggerNoFill'))
        : events.has('Finalized') || (release && out.status === 'confirmed');
    if (progress) {
      this.backoff.clear(key);
      if (events.has('Triggered') || events.has('CoverEnded')) this.phantom.delete(a.coverId);
      return;
    }
    // SE2-L4: a close (not a step) that found nothing to fill; later tries for this cover go at the step limit.
    if (a.kind === 'trigger' && events.has('TriggerNoFill') && !this.phantom.has(a.coverId)) {
      this.phantom.add(a.coverId);
      this.o.log.warn({ coverId: a.coverId }, 'keeper.phantom_top');
    }
    // A paying trigger always closes; only zero-paid or reverted sends land here, and backoff gates only those.
    if (a.kind === 'trigger' && out.status === 'confirmed' && (out.result as bigint) > 0n) return;
    const until = this.backoff.bump(key, head);
    this.o.log.warn({ kind: a.kind, coverId: a.coverId, status: out.status, events: [...events], until: until.toString() }, 'keeper.noop_receipt');
  }

  /**
   * How a mirror verdict goes out (H-1, SE2-M1, SE2-L4). A close the mirror expects to pay is a hot-path trigger;
   * a zero-gap remainder is exempt and counted; anything else books as trigger_zero within the cover's touch budget.
   */
  private async booking(id: Hex, c: CoverRead, d: ZeroPaidDecision, book: PerpBook, p: ParamsView, head: bigint, baseFee: bigint | null): Promise<Booking> {
    const zeroToday = () => this.o.governor.countToday(ZERO_PAID_TRIGGER.label, id);
    if (d.verdict === 'closes' && !this.phantom.has(id)) {
      if (closePays(c, book)) return { kind: 'close', decision: { label: 'trigger', exempt: true } };
      if (c.status === COVER_STATUS.Triggered) {
        const max = Math.ceil(Number(c.lots) / Math.max(1, p.maxMatchesClose)) + 1;
        if (this.o.governor.countToday(REMAINDER_TRIGGER_LABEL, id) >= max) return { kind: 'skip', why: 'remainder_cap' };
        return { kind: 'close', decision: { label: REMAINDER_TRIGGER_LABEL, exempt: true } };
      }
      if (zeroToday() >= ZERO_PAID_TRIGGER.perCoverPerDay) return { kind: 'skip', why: 'per_cover_cap' };
      return { kind: 'close', decision: { label: ZERO_PAID_TRIGGER.label, exempt: false } };
    }
    // A step, or a close against a top that did not fill last time (sent at the step limit).
    if (d.verdict !== 'closes' && d.verdict !== 'step') return { kind: 'skip', why: d.verdict };
    if (zeroToday() >= ZERO_PAID_TRIGGER.perCoverPerDay) return { kind: 'skip', why: 'per_cover_cap' };
    if (d.verdict === 'step') {
      // SE3-I2: after two walk starts today, no new start, and no "continuation" that keeps landing as a restart.
      if (this.touches.startsToday(id) >= ZERO_PAID_TRIGGER.touchesPerCoverPerDay && (d.step === 0 || this.restartMiss.has(id))) return { kind: 'skip', why: 'touch_cap' };
      if (d.step === 0 && !(await this.touchAffordable(id, c, p, head, baseFee))) return { kind: 'skip', why: 'touch_budget' };
      // F-7: a walk the keeper did not admit in this process (restart mid-walk) still reserves the rest of its walk.
      if (d.step > 0 && !this.walks.has(id)) this.walks.set(id, { ...walkLeft(c, p, d.step), lastAt: c.shortBlock });
      this.pendingSteps.set(id, { from: c.shortBlock, step: d.step });
    }
    return { kind: 'step', gas: this.stepGasLow ? GAS.trigger : GAS.triggerStep };
  }

  /**
   * SE2-M1, SE3-L2: a walk starts only if today's budget and the key's balance (cached, re-read once when short)
   * still hold all its steps and the fill calls after them.
   */
  private async touchAffordable(id: Hex, c: CoverRead, p: ParamsView, head: bigint, baseFee: bigint | null): Promise<boolean> {
    const billed = billedPriceWei(baseFee);
    const peak = feeQuote(baseFee).maxFeePerGas - billed;
    const stepGas = this.stepGasLow ? GAS.trigger : GAS.triggerStep;
    const own = walkLeft(c, p, 0);
    // SE3-M2: walks interleave in the lane, so every running walk's remainder is part of this admission.
    const others = this.outstanding(id, head, stepGas);
    const steps = BigInt(own.steps) * stepGas + others.steps;
    const fills = BigInt(own.fills) * GAS.trigger + others.fills;
    const stepWei = steps * billed + stepGas * peak;
    const touchWei = (steps + fills) * billed + GAS.trigger * peak;
    if (this.o.governor.room(false, ZERO_PAID_TRIGGER.label) < stepWei || this.o.governor.room(true) < touchWei) {
      this.touchBudget.hold(id, { coverId: id, touchWei: touchWei.toString(), running: this.walks.size });
      return false;
    }
    this.touchBudget.clear(id, { coverId: id });
    try {
      let balance = await this.o.queue.balanceAt(head);
      if (balance < touchWei) balance = await this.o.queue.balanceAt(head, true);
      if (balance >= touchWei) {
        this.walks.set(id, { ...own, lastAt: head });
        return true;
      }
      this.o.log.error({ coverId: id, balanceWei: balance.toString(), touchWei: touchWei.toString() }, 'keeper.touch_unfunded');
    } catch (err) {
      this.o.log.warn({ err, coverId: id }, 'keeper.touch_balance_failed');
    }
    return false;
  }

  /** Keeps a running walk's remaining steps and fill calls current from its receipts. */
  private walkLanded(id: Hex, out: Extract<SendOutcome, { status: 'confirmed' | 'reverted' }>, step: boolean): void {
    const w = this.walks.get(id);
    if (!w) return;
    w.lastAt = out.blockNumber;
    if (out.status !== 'confirmed') return;
    const events = coverEvents(out.logs, this.o.manager, id);
    if (events.has('CoverEnded')) w.steps = w.fills = 0;
    else if (events.has('Triggered')) {
      w.steps = 0;
      w.fills = Math.max(0, w.fills - 1);
    } else if (step && events.has('TriggerNoFill')) w.steps = Math.max(0, w.steps - 1);
    if (w.steps === 0 && w.fills === 0) this.walks.delete(id);
  }

  /** Gas other admitted walks may still use: steps and fill calls. A walk idle past the chain gap is over. */
  private outstanding(except: Hex, head: bigint, stepGas: bigint): { steps: bigint; fills: bigint } {
    let steps = 0n;
    let fills = 0n;
    for (const [id, w] of this.walks) {
      if (head > w.lastAt + STEP_MAX_GAP_BLOCKS + 2n) this.walks.delete(id);
      else if (id !== except) {
        steps += BigInt(w.steps) * stepGas;
        fills += BigInt(w.fills) * GAS.trigger;
      }
    }
    return { steps, fills };
  }

  /** A landed trigger leaves work for the same touch: a step's TriggerNoFill, or a fill short of the cover's lots. */
  private closeContinues(id: Hex, before: CoverRead, out: Extract<SendOutcome, { status: 'confirmed' }>, step: boolean): boolean {
    const events = coverEvents(out.logs, this.o.manager, id);
    if (events.has('CoverEnded')) return false;
    if (events.has('Triggered')) {
      const filled = coverFilledLots(out.logs, this.o.manager, id);
      return filled === null || before.filledLots + filled < before.lots;
    }
    return step && events.has('TriggerNoFill');
  }

  /**
   * SE2-H1: the next attempt of an active close goes as soon as the previous one lands: one multicall read at the
   * receipt block (SE3-M1), the contract mirror at the landing block decides (no paying-first simulation; the queue's
   * simulation is only a revert and gas check). Covers take turns, the one that landed longest ago first. SE3-M2:
   * between two lane attempts one side send (another cover's first trigger, an arm or an observe) may go while every
   * lane cover's projected gap stays in budget. Returns the number of sends.
   */
  private async fastLane(entries: LaneEntry[], head: Head, side: SideItem[] = [], covers: ReadonlyMap<Hex, CoverRead> = new Map()): Promise<number> {
    const lane = new Map(entries.map((e) => [e.id, e]));
    const pace = new LanePace(entries.reduce((m, e) => maxBig(m, e.lastLanded), head.number));
    let sent = 0;
    let sideSends = 0;
    let sideTurn = true;
    for (let n = 0; n < FAST_LANE_MAX_ATTEMPTS && lane.size > 0; ) {
      let admitted: LaneEntry | null = null;
      const pick = sideTurn && sideSends < LANE_SIDE_MAX_SENDS ? this.pickSide(side, lane, pace) : null;
      sideTurn = true;
      if (pick) {
        side.splice(side.indexOf(pick), 1);
        const c = covers.get(pick.action.coverId);
        if (pick.action.kind === 'trigger' && c) {
          admitted = { id: pick.action.coverId, perpId: pick.action.perpId, isLong: c.isLong, lastLanded: pace.tip(), fresh: true };
          lane.set(admitted.id, admitted);
        } else if (pick.action.kind !== 'trigger') {
          sideSends++;
          sideTurn = false;
          sent += await this.sendSide(pick, side, head, pace, covers);
          continue;
        }
      }
      n++;
      let reads: Map<Hex, { c: CoverRead; info: PerpInfo; halted: boolean; ref: RefRead }> | null = null;
      for (let i = 0; reads === null; i++) {
        try {
          reads = await this.readLane([...lane.values()], pace.tip());
        } catch (err) {
          if (i >= LANE_READ_RETRIES) {
            this.o.log.warn({ err, block: pace.tip().toString() }, 'keeper.lane_read_failed');
            break;
          }
          await this.sleep(LANE_READ_RETRY_MS);
        }
      }
      if (reads === null) break;
      const e = admitted ?? [...lane.values()].reduce((a, b) => (laneOrder(b) < laneOrder(a) ? b : a));
      const r = reads.get(e.id);
      const p = this.params.get(e.perpId);
      const tip = maxBig(pace.tip(), head.number);
      const now = this.proposed && this.proposed.number > tip ? this.proposed : null;
      const landing = (now?.number ?? tip) + 1n;
      if (!r || !p || !p.supported || !landsInTime(r.c, landing) || !midCloseOrLive(r.c)) {
        lane.delete(e.id);
        continue;
      }
      const book = bookFromPerpInfo(r.info);
      // Fast-path freshness at the landing block: the newest head's time, else about 3 blocks per second since `head`.
      const nowSec = now?.timestamp ?? head.timestamp + (landing - head.number - 1n) / 3n;
      const d = zeroPaidTriggerCloses({
        cover: r.c,
        book,
        fast: pastWarmup(r.c, landing) && fastPath(r.c, r.info, r.halted, p.refFreshSec, nowSec),
        venueOk: venueOk(r.info, r.halted),
        ref: r.ref,
        params: p,
        landing
      });
      const b = this.phantom.has(e.id) ? ({ kind: 'skip', why: 'phantom_top' } as const) : await this.booking(e.id, r.c, d, book, p, landing - 1n, (now ?? head).baseFeePerGas);
      if (b.kind === 'skip') {
        this.o.log.debug({ coverId: e.id, why: b.why, step: d.step }, 'keeper.lane_stop');
        lane.delete(e.id);
        continue;
      }
      const action: PlannedAction = { kind: 'trigger', coverId: e.id, perpId: e.perpId, dedupeKey: triggerDedupeKey(e.id, r.c) };
      const base = { ref: e.id, dedupeKey: action.dedupeKey, address: this.o.manager, abi: ICoverManagerAbi, functionName: 'trigger', args: [e.id] } satisfies TriggerBase;
      let nowPays = false;
      let out: SendOutcome;
      if (b.kind === 'close') {
        out = await this.sendWithCeiling({ ...base, label: 'trigger', gas: GAS.trigger, exempt: true, accept: () => b.decision });
      } else {
        this.steps.add(e.id);
        this.o.log.info({ coverId: e.id, step: d.step, limitPNS: d.limitPNS.toString(), gas: b.gas.toString(), lane: true }, 'keeper.trigger_step');
        out = await this.o.queue.send({
          ...base,
          label: ZERO_PAID_TRIGGER.label,
          gas: b.gas,
          // It fills even at head (narrower step): the landing step fills too, so it goes as a close at full gas.
          accept: (res) => (res as bigint) === 0n || ((nowPays = true), false)
        });
      }
      const step = this.steps.has(e.id);
      this.afterSend(action, out, landing - 1n);
      this.logOutcome(action, out);
      if (out.status === 'skipped') {
        if (STOP_REASONS.has(out.reason)) break;
        if (b.kind === 'step' && out.reason === 'simulation_reverted' && !CUSTOM_ERROR.test(out.detail ?? '') && !this.stepGasLow) {
          this.stepGasLow = true;
          this.o.log.error({ coverId: e.id, gas: GAS.triggerStep.toString() }, 'keeper.step_gas_low');
        } else if (!nowPays) {
          lane.delete(e.id);
        }
        continue;
      }
      sent++;
      if (out.status === 'pending') break;
      pace.landed(out.blockNumber);
      // SA4-03: a reverted step did not move the chain; the cover stays in the lane and tries again from here.
      if (out.status === 'reverted') {
        if (!step) lane.delete(e.id);
        continue;
      }
      if (!e.fresh) this.logGap(e.id, out.blockNumber - e.lastLanded, 'lane', d.step);
      e.lastLanded = out.blockNumber;
      e.fresh = false;
      const ev = coverEvents(out.logs, this.o.manager, e.id);
      if (ev.has('Triggered') && r.c.status !== COVER_STATUS.Triggered) side.push(observeItem(action, out.blockNumber, r.c.windowBlocks));
      if (!this.closeContinues(e.id, r.c, out, step)) lane.delete(e.id);
    }
    return sent;
  }

  /**
   * SE3-M2: the side item worth one send before the next lane attempt, or null. Every lane cover's gap is projected
   * with one more send first at the measured blocks per send: arms, early observes and first triggers (which join the
   * lane) need it within LANE_SIDE_GAP_BLOCKS, an observe due within OBSERVE_DUE_BLOCKS within one block under the
   * contract's 10, and an observe on its last chance goes regardless (a walk can restart, a missed observe cannot).
   */
  private pickSide(side: SideItem[], lane: ReadonlyMap<Hex, LaneEntry>, pace: LanePace): SideItem | null {
    const bps = pace.blocksPerSend();
    if (bps === null || side.length === 0) return null;
    const landing = pace.tip() + bps;
    const waiting = [...lane.values()].filter((e) => !e.fresh).sort((a, b) => (a.lastLanded < b.lastLanded ? -1 : a.lastLanded > b.lastLanded ? 1 : 0));
    let gap = 0n;
    waiting.forEach((e, i) => {
      const g = pace.tip() + bps * BigInt(2 + i) - e.lastLanded;
      if (g > gap) gap = g;
    });
    const soft = gap <= LANE_SIDE_GAP_BLOCKS;
    let best: SideItem | null = null;
    let rank = 0;
    for (const s of [...side]) {
      let r = 0;
      if (s.action.kind === 'observe' && s.deadline !== null) {
        if (landing > s.deadline) {
          side.splice(side.indexOf(s), 1);
          continue;
        }
        const left = s.deadline - landing;
        if (s.notBefore > landing && left >= 2n * bps) continue;
        if (left < 2n * bps) r = 5;
        else if (left < OBSERVE_DUE_BLOCKS && gap <= LANE_DUE_GAP_BLOCKS) r = 4;
        else if (soft) r = 1;
      } else if (s.action.kind === 'trigger') {
        if (soft && bps * BigInt(waiting.length + 1) <= LANE_SIDE_GAP_BLOCKS) r = 3;
      } else if (s.action.kind === 'arm') {
        if (soft) r = 2;
      }
      if (r > rank) {
        best = s;
        rank = r;
      }
    }
    return best;
  }

  /** One arm or observe between lane attempts; an observe that is not ready yet goes back in the queue. */
  private async sendSide(item: SideItem, side: SideItem[], head: Head, pace: LanePace, covers: ReadonlyMap<Hex, CoverRead>): Promise<number> {
    const tip = maxBig(pace.tip(), head.number);
    const h: Head = this.proposed && this.proposed.number >= tip ? this.proposed : { ...head, number: tip, timestamp: head.timestamp + (tip - head.number) / 3n };
    const c = covers.get(item.action.coverId);
    if (item.action.kind === 'arm' && !armAllowed(c, h.number)) return 0;
    const out = await this.execute(item.action, covers, h);
    this.logOutcome(item.action, out);
    if (out.status === 'confirmed' || out.status === 'reverted') pace.landed(out.blockNumber);
    const notReady = out.status === 'skipped' && (out.reason === 'not_needed' || (out.reason === 'simulation_reverted' && out.detail === 'TooEarly'));
    if (item.action.kind === 'observe' && notReady) side.push({ ...item, notBefore: tip + 3n });
    return out.status === 'skipped' ? 0 : 1;
  }

  /** One multicall for every lane cover at `block` (our latest receipt, SE3-M1): getCover, perp state, halt, reference. */
  private async readLane(entries: readonly LaneEntry[], block: bigint): Promise<Map<Hex, { c: CoverRead; info: PerpInfo; halted: boolean; ref: RefRead }>> {
    const perps = [...new Set(entries.map((e) => e.perpId))];
    const contracts = [
      { address: PERPL_EXCHANGE, abi: IPerplMinAbi, functionName: 'isHalted' },
      ...perps.map((perp) => ({ address: PERPL_EXCHANGE, abi: IPerplMinAbi, functionName: 'getPerpetualInfo', args: [BigInt(perp)] })),
      ...entries.flatMap((e) => [
        { address: this.o.manager, abi: ICoverManagerAbi, functionName: 'getCover', args: [e.id] },
        { address: this.o.manager, abi: ICoverManagerAbi, functionName: 'referencePrice', args: [BigInt(e.perpId), e.isLong, 0n] }
      ])
    ];
    // A node behind our receipt errors (unknown block) instead of answering with the pre-attempt state. The explicit
    // Multicall3 address skips viem's deploy-block guard, which only matters for historical reads.
    const multicallAddress = this.o.client.chain.contracts?.multicall3?.address;
    const res = (await multicall(this.o.client, { allowFailure: false, blockNumber: block, multicallAddress, contracts } as never)) as unknown as unknown[];
    const halted = res[0] as boolean;
    const infos = new Map(perps.map((perp, i) => [perp, res[1 + i] as PerpInfo]));
    const out = new Map<Hex, { c: CoverRead; info: PerpInfo; halted: boolean; ref: RefRead }>();
    entries.forEach((e, i) => {
      const at = 1 + perps.length + 2 * i;
      const [refPNS, nFresh] = res[at + 1] as readonly [bigint, number];
      out.set(e.id, { c: toCoverRead(res[at] as RawCover), info: infos.get(e.perpId)!, halted, ref: { refPNS, nFresh } });
    });
    return out;
  }

  /** SE2-H1: blocks between consecutive landed attempts of one touch; above CHAIN_GAP_ALERT_BLOCKS is an alert. */
  private logGap(coverId: Hex, gap: bigint, path: 'lane' | 'cycle', step?: number): void {
    const fields = { coverId, gapBlocks: Number(gap), path, step };
    this.gapSamples.push({ gapBlocks: Number(gap), path });
    if (this.gapSamples.length > CONSOLE_GAP_SAMPLES) this.gapSamples.shift();
    if (gap > CHAIN_GAP_ALERT_BLOCKS) this.o.log.error(fields, 'keeper.chain_gap_high');
    else this.o.log.info(fields, 'keeper.chain_gap');
  }

  private async ensureParams(head: bigint): Promise<void> {
    const stale = this.o.perps.filter((p) => {
      const v = this.params.get(p);
      return !v || head - v.readAt >= PARAMS_REFRESH_BLOCKS;
    });
    if (stale.length === 0) return;
    const res = await multicall(this.o.client, {
      allowFailure: false,
      contracts: stale.map((p) => ({ address: this.o.manager, abi: ICoverManagerAbi, functionName: 'marketParams' as const, args: [BigInt(p)] as const }))
    });
    res.forEach((mp, i) => {
      const perp = stale[i]!;
      const supported = mp.maxMatchesClose <= MAX_MATCHES_CLOSE_SUPPORTED;
      if (!supported) {
        this.o.log.error(
          { perp, maxMatchesClose: mp.maxMatchesClose, supported: MAX_MATCHES_CLOSE_SUPPORTED, triggerGas: GAS.trigger.toString(), needsGas: triggerGasFor(mp.maxMatchesClose).toString() },
          'keeper.max_matches_unsupported: no arm or trigger on this market until maxMatchesClose <= supported or GAS.trigger and the budgets are raised'
        );
      }
      this.params.set(perp, {
        supported,
        exclusiveBlocks: mp.exclusiveBlocks,
        refTolBps: mp.refTolBps,
        armTtlBlocks: mp.armTtlBlocks,
        sigmaMaxAgeBlocks: mp.sigmaMaxAgeBlocks,
        refFreshSec: mp.refFreshSec,
        maxMatchesClose: mp.maxMatchesClose,
        readAt: head
      });
    });
  }

  private async readWatch(): Promise<PerpWatch[]> {
    const contracts = this.o.perps.flatMap((p) => [
      { address: this.o.manager, abi: ICoverManagerAbi, functionName: 'watchList' as const, args: [BigInt(p), WATCH_PAGE] as const },
      { address: this.o.manager, abi: ICoverManagerAbi, functionName: 'housekeeping' as const, args: [BigInt(p), WATCH_PAGE] as const }
    ]);
    const res = await multicall(this.o.client, { allowFailure: false, contracts, blockTag: 'latest' });
    return this.o.perps.map((perpId, i) => {
      const [toArm, toTrigger] = res[2 * i] as readonly [readonly Hex[], readonly Hex[]];
      const [toObserve, toFinalize, toExpire, toVoid] = res[2 * i + 1] as readonly [readonly Hex[], readonly Hex[], readonly Hex[], readonly Hex[]];
      return {
        perpId,
        toArm,
        toTrigger,
        toObserve,
        toFinalize,
        toExpire,
        toVoid,
        exclusiveBlocks: this.params.get(perpId)?.exclusiveBlocks ?? 0
      };
    });
  }

  private async readCovers(ids: readonly Hex[]): Promise<Map<Hex, CoverRead>> {
    const res = await multicall(this.o.client, {
      allowFailure: true,
      contracts: ids.map((id) => ({ address: this.o.manager, abi: ICoverManagerAbi, functionName: 'getCover' as const, args: [id] as const }))
    });
    const out = new Map<Hex, CoverRead>();
    res.forEach((r, i) => {
      if (r.status === 'success') out.set(ids[i]!, toCoverRead(r.result));
    });
    return out;
  }

  private async readPerps(perpIds: readonly number[]): Promise<Map<number, PerpRead>> {
    const [halted, ...infos] = (await multicall(this.o.client, {
      allowFailure: false,
      blockTag: 'latest',
      contracts: [
        { address: PERPL_EXCHANGE, abi: IPerplMinAbi, functionName: 'isHalted' },
        ...perpIds.map((p) => ({ address: PERPL_EXCHANGE, abi: IPerplMinAbi, functionName: 'getPerpetualInfo', args: [BigInt(p)] }))
      ]
    } as never)) as unknown as [boolean, ...PerpRead['info'][]];
    return new Map(perpIds.map((p, i) => [p, { info: infos[i]!, halted }]));
  }

  /** SE2-M3: sigma is read only by quote, so a post needs a pending /sigma-refresh (a quote about to be made). */
  private async maybeSigma(head: Head): Promise<void> {
    if (!this.o.sigmaEnabled) return;
    const now = this.now();
    for (const [perp, at] of this.sigmaRequests) if (now - at > SIGMA_POLICY.requestTtlMs) this.sigmaRequests.delete(perp);
    if (this.sigmaRequests.size === 0) return;
    const finalized = this.finalized ?? head.number - 2n;

    for (const perp of this.o.perps) {
      if (!this.sigmaRequests.has(perp)) continue;
      const quote = this.o.store.getQuote(perp);
      if (!quote || quote.stale) {
        // Feed loss: no sigma action until the relay feed is fresh again.
        this.recordSigma(perp, null, 'feed_stale');
        continue;
      }
      const covered = this.marksReady(finalized);
      if (covered === null) {
        this.recordSigma(perp, null, 'history_loading');
        continue;
      }
      const estimateE2 = this.o.marks.sigmaE2(perp, covered + 1n);
      if (estimateE2 === null) {
        this.recordSigma(perp, null, 'warming_up');
        continue;
      }
      const last = this.o.marks.lastMark(perp);
      if (last && deviationBps(quote.mark, last.price) > SIGMA_POLICY.maxMarkDeviationBps) {
        this.markMismatch.hold(String(perp), { perp, feedMark: quote.mark, chainMark: last.price });
        this.recordSigma(perp, estimateE2, 'mark_mismatch');
        continue;
      }
      if (last) this.markMismatch.clear(String(perp), { perp, feedMark: quote.mark, chainMark: last.price });
      const { decision, buysPaused } = await this.sigmaDecision(perp, estimateE2, head.number);
      this.recordSigma(perp, estimateE2, decision.reason);
      if (!decision.post) {
        this.sigmaRequests.delete(perp);
        continue;
      }
      // I-02: quotes revert while buys are paused, so the post is moot.
      if (buysPaused) {
        this.recordSigma(perp, estimateE2, 'buys_paused');
        this.sigmaRequests.delete(perp);
        continue;
      }
      const postsToday = this.o.governor.countToday(SIGMA_POLICY.postLabel) + this.o.governor.countToday(SIGMA_POLICY.legacyRefreshLabel);
      if (postsToday >= SIGMA_POLICY.maxPostsPerDay) {
        this.o.log.warn({ perp, cap: SIGMA_POLICY.maxPostsPerDay }, 'sigma.daily_cap');
        this.recordSigma(perp, estimateE2, 'daily_cap');
        this.sigmaRequests.delete(perp);
        continue;
      }
      const out = await this.o.queue.send({
        label: SIGMA_POLICY.postLabel,
        ref: String(perp),
        dedupeKey: `postSigma:${perp}`,
        address: this.o.manager,
        abi: ICoverManagerAbi,
        functionName: 'postSigma',
        args: [BigInt(perp), estimateE2],
        gas: GAS.postSigma
      });
      this.o.log.info({ perp, estimateE2, reason: decision.reason, status: out.status, skip: out.status === 'skipped' ? out.reason : undefined }, 'sigma.post');
      if (out.status === 'confirmed') this.sigmaRequests.delete(perp);
      if (out.status !== 'skipped' || STOP_REASONS.has(out.reason)) return;
    }
  }

  /**
   * F-2: the mark history fetch (48,000 blocks on the first refresh after boot) runs in the background, never inside
   * a cycle. Returns the block the history covers once it is within maxHistoryLagBlocks of `finalized`, else null.
   */
  private marksReady(finalized: bigint): bigint | null {
    const covered = this.o.marks.coveredTo;
    if ((covered === null || covered < finalized) && this.marksFetch === null) {
      const started = this.now();
      this.marksFetch = this.o.marks
        .catchUp(finalized)
        .then(() => this.o.log.debug({ to: finalized.toString(), ms: this.now() - started }, 'sigma.marks_fetched'))
        .catch((err: unknown) => this.o.log.warn({ err }, 'sigma.marks_fetch_failed'))
        .finally(() => {
          this.marksFetch = null;
        });
    }
    return covered !== null && finalized - covered <= SIGMA_POLICY.maxHistoryLagBlocks ? covered : null;
  }

  private async sigmaDecision(perp: number, estimateE2: number, head: bigint): Promise<{ decision: SigmaDecision; buysPaused: boolean }> {
    const [[onchainE2, postedBlock], paused, marketPaused] = await multicall(this.o.client, {
      allowFailure: false,
      contracts: [
        { address: this.o.manager, abi: ICoverManagerAbi, functionName: 'sigmaOf', args: [BigInt(perp)] },
        { address: this.o.manager, abi: ICoverManagerAbi, functionName: 'paused' },
        { address: this.o.manager, abi: ICoverManagerAbi, functionName: 'marketPaused', args: [BigInt(perp)] }
      ]
    });
    const decision = decideSigmaPost({
      estimateE2,
      onchainE2,
      postedBlock: BigInt(postedBlock),
      head,
      maxAgeBlocks: this.params.get(perp)?.sigmaMaxAgeBlocks ?? 0,
      quoteRequested: this.sigmaRequests.has(perp)
    });
    return { decision, buysPaused: paused || marketPaused };
  }

  private recordSigma(perp: number, estimateE2: number | null, decision: string): void {
    this.sigmaState.set(perp, { estimateE2, decision, atMs: this.now() });
  }

  private logOutcome(a: PlannedAction, out: SendOutcome): void {
    const fields = { kind: a.kind, coverId: a.coverId, perpId: a.perpId, status: out.status, reason: out.status === 'skipped' ? out.reason : undefined };
    // Not a manager custom error even at the ceiling: out of gas beyond 3.5M, or a Perpl revert.
    if (a.kind === 'trigger' && undecodedRevert(out)) {
      this.o.log.error({ ...fields, gas: GAS.triggerCeiling.toString() }, 'keeper.trigger_undecoded_revert');
    } else if (out.status === 'skipped' && (out.reason === 'not_needed' || out.reason === 'inflight' || out.reason === 'simulation_reverted')) {
      this.o.log.debug(fields, 'keeper.action');
    } else {
      this.o.log.info(fields, 'keeper.action');
    }
  }
}

type RawCover = Parameters<typeof toCoverRead>[0];

function toCoverRead(c: {
  status: number;
  armer: Address;
  armedBlock: bigint | number;
  expiryBlock: bigint | number;
  isLong: boolean;
  stopPNS: bigint | number;
  maxGapBps: number;
  slipAllowanceBps: number;
  floorSlackBps: number;
  shortBlock: bigint | number;
  shortSteps: number;
  startBlock: bigint | number;
  warmupBlocks: number;
  windowBlocks: number;
  refTrigPNS: bigint | number;
  lots: bigint | number;
  filledLots: bigint | number;
  triggerBlock: bigint | number;
  owedCNS: bigint | number;
  paidCNS: bigint | number;
  capCNS: bigint | number;
}): CoverRead {
  return {
    status: c.status,
    armer: c.armer,
    armedBlock: BigInt(c.armedBlock),
    expiryBlock: BigInt(c.expiryBlock),
    isLong: c.isLong,
    stopPNS: BigInt(c.stopPNS),
    maxGapBps: c.maxGapBps,
    // L-03: per-cover snapshot; market params may have moved since purchase.
    slipAllowanceBps: c.slipAllowanceBps,
    floorSlackBps: c.floorSlackBps,
    shortBlock: BigInt(c.shortBlock),
    shortSteps: c.shortSteps,
    startBlock: BigInt(c.startBlock),
    warmupBlocks: c.warmupBlocks,
    windowBlocks: c.windowBlocks,
    refTrigPNS: BigInt(c.refTrigPNS),
    lots: BigInt(c.lots),
    filledLots: BigInt(c.filledLots),
    triggerBlock: BigInt(c.triggerBlock),
    owedCNS: BigInt(c.owedCNS),
    paidCNS: BigInt(c.paidCNS),
    capCNS: BigInt(c.capCNS)
  };
}

const maxBig = (a: bigint, b: bigint) => (a > b ? a : b);

/** Lane turn order: a cover with no landed attempt first, then the one that landed longest ago. */
const laneOrder = (e: LaneEntry) => (e.fresh ? -1n : e.lastLanded);

function undecodedRevert(out: SendOutcome): boolean {
  return out.status === 'skipped' && out.reason === 'simulation_reverted' && !CUSTOM_ERROR.test(out.detail ?? '');
}

/** The observe a first fill opens: it can land from the next block to triggerBlock + windowBlocks. */
function observeItem(a: Pick<PlannedAction, 'coverId' | 'perpId'>, triggerBlock: bigint, windowBlocks: number): SideItem {
  return {
    action: { kind: 'observe', coverId: a.coverId, perpId: a.perpId, dedupeKey: actionKey('observe', a.coverId) },
    deadline: triggerBlock + BigInt(windowBlocks),
    notBefore: triggerBlock + 1n
  };
}

/** What a walk at `step` may still send: its no-fill steps from `step` on and the fill calls after them. */
function walkLeft(c: CoverRead, p: ParamsView, step: number): { steps: number; fills: number } {
  return { steps: Math.max(0, lastWalkStep(c) - step), fills: Math.ceil(Number(c.lots - c.filledLots) / Math.max(1, p.maxMatchesClose)) };
}

/** A walk under way (a short attempt on record) or a Triggered cover with lots still open. */
function midClose(c: CoverRead): boolean {
  return c.status === COVER_STATUS.Triggered ? c.filledLots < c.lots : c.shortBlock !== 0n;
}

/**
 * F-3: the attempt continues a close, so its gap is a chain gap: a Triggered remainder, or a chain the contract would
 * still extend when the attempt was planned. A shortBlock from a dead touch makes this a new touch with no gap.
 */
function chainLive(c: CoverRead, head: bigint): boolean {
  if (c.status === COVER_STATUS.Triggered) return true;
  return c.shortBlock !== 0n && head + 1n - c.shortBlock <= STEP_MAX_GAP_BLOCKS;
}

function midCloseOrLive(c: CoverRead): boolean {
  if (c.status === COVER_STATUS.Triggered) return c.filledLots < c.lots;
  return c.status === COVER_STATUS.Live || c.status === COVER_STATUS.Armed;
}
