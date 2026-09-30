// CoverManager.trigger model for long covers, ported from the SE2 PoC (/tmp/se2/model.ts, C6) and moved to C7:
// a 10-block gap measured from the touch's latest attempt, a match-limited partial refreshes it and keeps its step.
// SE3-L3: _step, _advance, _hold and _resetChain are line-for-line C7 (with _heldBlock as `held`).
import { decodeFunctionData, parseEther, parseGwei, parseTransaction, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { ICoverManagerAbi } from '../src/abi/index.ts';
import { COVER_STATUS, STEP_MAX_GAP_BLOCKS } from '../src/keeper/actions.ts';
import { Keeper, REPEAT_ARM_LABEL, ZERO_PAID_TRIGGER } from '../src/keeper/keeper.ts';
import { KEEPER_MIGRATIONS } from '../src/keeper/migrations.ts';
import { MarkHistory } from '../src/keeper/sigma.ts';
import { migrate, openDb } from '../src/lib/db.ts';
import { SendQueue } from '../src/lib/sendQueue.ts';
import { SpendGovernor } from '../src/lib/spendGovernor.ts';
import { MarketStore } from '../src/relay/perpl/store.ts';
import { captureLogger, FakeChain, TEST_KEYS } from './fakeChain.ts';
import { FakeManager, MANAGER, managerLog, triggeredLog } from './fakeGapless.ts';

export const keeperAccount = privateKeyToAccount(TEST_KEYS.keeper);
export const KEEPER = keeperAccount.address;

const BPS = 10_000n;

export interface Level {
  price: bigint;
  lots: bigint;
  /** false: consumes a match and fills nothing (expired order, self-match). */
  fillable: boolean;
}

export interface MCover {
  id: Hex;
  status: number;
  stop: bigint;
  lots: bigint;
  filled: bigint;
  armedBlock: bigint;
  armer: Hex;
  expiry: bigint;
  /** Block of the touch's latest attempt (getCover.shortBlock). */
  sb: bigint;
  /** Step an attempt in a later block runs at (getCover.shortSteps). */
  steps: number;
  /** CoverManager._heldBlock: block of a match-limited attempt that held the step (0 = none). */
  held: bigint;
  refTrig: bigint;
  triggerBlock: bigint;
  window: bigint;
  observed: boolean;
}

export interface Attempt {
  id: Hex;
  block: bigint;
  k: number;
  limit: bigint;
  filled: bigint;
}

type TriggerResult = { paid: bigint; events: Record<string, unknown>[] } | { revert: string };

export class CoverModel {
  A = 5n;
  slack = 100n;
  refTol = 50n;
  ttl = 200n;
  /** Canary listing (SA4-01). */
  maxMatches = 8;
  gap = STEP_MAX_GAP_BLOCKS;
  R = 0n;
  nFresh = 2;
  bids: Level[] = [];
  covers = new Map<Hex, MCover>();
  attempts: Attempt[] = [];

  best(bids = this.bids): bigint | null {
    let b: bigint | null = null;
    for (const l of bids) if (l.lots > 0n && (b === null || l.price > b)) b = l.price;
    return b;
  }

  eff(c: MCover, n: bigint): number {
    return c.status === COVER_STATUS.Armed && n > c.armedBlock + this.ttl ? COVER_STATUS.Live : c.status;
  }

  /** CoverManager._step. */
  step(c: MCover, through: boolean, n: bigint): number {
    if (!through || c.sb === 0n || n - c.sb > this.gap) return 0;
    if (n !== c.sb) return c.steps;
    return c.held === c.sb ? c.steps : c.steps - 1;
  }

  limit(c: MCover, ref: bigint, k: number): bigint {
    if (k === 0) return (ref * (BPS - this.A)) / BPS;
    const allow = this.slack < this.A << BigInt(k) ? this.slack : this.A << BigInt(k);
    return ((ref < c.stop ? ref : c.stop) * (BPS - allow)) / BPS;
  }

  /** trigger(id) at block n; `mutate` false runs it on copies (eth_call). */
  trigger(id: Hex, n: bigint, mutate: boolean): TriggerResult {
    const c0 = this.covers.get(id)!;
    const c = mutate ? c0 : { ...c0 };
    const bids = mutate ? this.bids : this.bids.map((b) => ({ ...b }));
    const thru = (r: bigint) => r !== 0n && r <= c.stop;
    if (c.status === COVER_STATUS.Triggered) {
      if (c.filled >= c.lots || n > c.triggerBlock + c.window) return { revert: 'ConditionNotMet' };
      return this.close(c, bids, c.refTrig, thru(this.R) && thru(c.refTrig), false, n, mutate);
    }
    if (c.status !== COVER_STATUS.Live && c.status !== COVER_STATUS.Armed) return { revert: 'BadStatus' };
    if (n > c.expiry) return { revert: 'CoverExpired' };
    const disarm = (): TriggerResult => {
      c.status = COVER_STATUS.Live;
      resetChain(c, n);
      return { paid: 0n, events: [managerLog('Disarmed', { coverId: id })] };
    };
    if (this.eff(c, n) === COVER_STATUS.Armed) {
      if (n <= c.armedBlock) return { revert: 'TooEarly' };
      const best = this.best(bids);
      const crossed = best === null || best <= c.stop;
      const tolOk = this.nFresh === 0 || this.R <= (c.stop * (BPS + this.refTol)) / BPS;
      if (!crossed || !tolOk) return disarm();
    } else if (c.status === COVER_STATUS.Armed) {
      return disarm();
    } else {
      return { revert: 'ConditionNotMet' };
    }
    const ref = this.nFresh > 0 ? this.R : 0n;
    return this.close(c, bids, ref, thru(ref), true, n, mutate);
  }

  private close(c: MCover, bids: Level[], ref: bigint, through: boolean, first: boolean, n: bigint, mutate: boolean): TriggerResult {
    const k = this.step(c, through, n);
    const limit = this.limit(c, ref, k);
    const want = c.lots - c.filled;
    let got = 0n;
    let matches = 0;
    let gReal = 0n;
    for (const b of [...bids].sort((x, y) => (y.price > x.price ? 1 : y.price < x.price ? -1 : 0))) {
      if (b.price < limit || got >= want || matches >= this.maxMatches || b.lots === 0n) continue;
      matches++;
      if (!b.fillable) continue;
      const q = b.lots < want - got ? b.lots : want - got;
      got += q;
      b.lots -= q;
      if (b.price < c.stop) gReal += (c.stop - b.price) * q;
    }
    const short = through && got < want;
    const best = this.best(bids);
    const thin = best === null || best < limit;
    // C7 _close: _resetChain, _advance (one step per block unless this block's earlier attempt held), _hold.
    if (!short) resetChain(c, n);
    else if (thin) {
      if (c.sb !== n || c.held === n) {
        c.held = 0n;
        c.sb = n;
        c.steps = Math.min(k + 1, 6);
      }
    } else if (k !== 0 && c.sb !== n) {
      c.sb = n;
      c.held = n;
    }
    if (mutate) this.attempts.push({ id: c.id, block: n, k, limit, filled: got });
    if (got === 0n) return { paid: 0n, events: [managerLog('TriggerNoFill', { coverId: c.id })] };
    if (first) {
      c.status = COVER_STATUS.Triggered;
      c.triggerBlock = n;
      c.refTrig = ref;
    }
    c.filled += got;
    return { paid: gReal, events: [triggeredLog(c.id, got, gReal)] };
  }
}

/** CoverManager._resetChain: a chain restarted in its own block must not read this block's hold. */
function resetChain(c: MCover, n: bigint): void {
  if (c.sb === 0n) return;
  if (c.sb === n) c.held = 0n;
  c.sb = 0n;
  c.steps = 0;
}

/** Gaps between consecutive landed attempts of one cover, in blocks. */
export function landingGaps(attempts: readonly Attempt[], id: Hex): bigint[] {
  const blocks = attempts.filter((a) => a.id === id).map((a) => a.block);
  return blocks.slice(1).map((b, i) => b - blocks[i]!);
}

/**
 * Network model from the SE2 audit: each RPC is one round trip; a sync send arrives half a round trip in, lands in
 * the next block and its receipt returns half a round trip after that block. Block time 294 ms (measured).
 */
export interface Rtt {
  rpcMs: number;
  blockMs?: number;
}

/** Canary keeper budgets (CLAUDE.md, SA4 limits, GAS.trigger 2.2M): 5.1 MON funding, cap 4.6, hot 2.65, trigger_zero 1.4, arm_repeat 0.2. */
export const CANARY_BUDGET = { balance: '5.1', cap: '4.6', hot: '2.65', zero: '1.4', armRepeat: '0.2', fillHeadroom: '0.4884' } as const;

export interface HarnessOptions {
  cap?: string;
  hot?: string;
  zero?: string;
  balance?: string;
  rtt?: Rtt;
  /** Base fee in gwei (default the 100 gwei floor). */
  baseFeeGwei?: number;
}

export function armedCover(id: Hex, n: bigint, over: Partial<MCover> = {}): MCover {
  return {
    id,
    status: COVER_STATUS.Armed,
    stop: 860_000n,
    lots: 22n,
    filled: 0n,
    armedBlock: n - 5n,
    armer: KEEPER,
    expiry: n + 10_000n,
    sb: 0n,
    steps: 0,
    held: 0n,
    refTrig: 0n,
    triggerBlock: 0n,
    window: 40n,
    observed: false,
    ...over
  };
}

/** Real Keeper, SendQueue and SpendGovernor on the fake chain, with the model as the contract (canary budgets). */
export function modelHarness(opts: HarnessOptions = {}) {
  const chain = new FakeChain();
  const blockMs = opts.rtt?.blockMs ?? 294;
  chain.setHead(200_000n);
  if (opts.baseFeeGwei !== undefined) chain.baseFee = parseGwei(String(opts.baseFeeGwei));
  let t = Number(chain.head) * blockMs;
  chain.balance(KEEPER, parseEther(opts.balance ?? CANARY_BUDGET.balance));
  const mgr = new FakeManager();
  mgr.install(chain);
  const model = new CoverModel();
  const { log, lines } = captureLogger();
  const db = openDb(':memory:');
  migrate(db, KEEPER_MIGRATIONS);
  const cap = parseEther(opts.cap ?? CANARY_BUDGET.cap);
  const governor = new SpendGovernor(
    db,
    KEEPER,
    {
      capWei: cap,
      hotReserveWei: parseEther(opts.hot ?? CANARY_BUDGET.hot),
      alertWei: cap,
      actionCapsWei: { [ZERO_PAID_TRIGGER.label]: parseEther(opts.zero ?? CANARY_BUDGET.zero), [REPEAT_ARM_LABEL]: parseEther(CANARY_BUDGET.armRepeat) },
      fillHeadroomWei: parseEther(CANARY_BUDGET.fillHeadroom) < cap ? parseEther(CANARY_BUDGET.fillHeadroom) : 0n
    },
    log
  );
  const client = chain.client();
  const queue = new SendQueue({ client, account: keeperAccount, governor, log, head: async () => ({ number: chain.head, baseFeePerGas: chain.baseFee }) });
  const marks = new MarkHistory({ client, perpIds: [1], chunkBlocks: 10_000, log });
  const at = (ms: number) => BigInt(Math.floor(ms / blockMs));
  // Keeper waits (lane read retries) pass model time.
  const sleep = async (ms: number) => {
    t += ms;
    if (opts.rtt) chain.setHead(at(t));
  };
  const keeper = new Keeper({ client, queue, governor, db, manager: MANAGER, keeper: KEEPER, perps: [1], store: new MarketStore(), marks, log, sigmaEnabled: false, now: () => t, sleep });
  const head = () => ({
    number: chain.head,
    hash: `0x${'11'.repeat(32)}` as Hex,
    blockId: String(chain.head),
    commitState: 'Proposed' as const,
    timestamp: 1_791_000_000n + chain.head / 3n,
    baseFeePerGas: chain.baseFee
  });

  /** watchList.toArm entries next to the model's triggers (covers the fake manager answers directly). */
  const arms: Hex[] = [];
  /** Model state into the fake manager's views at the current head (eth_call runs at block = head). */
  const sync = () => {
    // Tests that drive the fake manager directly keep their own views.
    if (model.covers.size === 0) return;
    const n = chain.head;
    const toTrigger: Hex[] = [];
    for (const c of model.covers.values()) {
      const st = model.eff(c, n);
      const listed = st === COVER_STATUS.Triggered ? c.filled < c.lots && n <= c.triggerBlock + c.window : n <= c.expiry && st === COVER_STATUS.Armed && n > c.armedBlock;
      if (listed) toTrigger.push(c.id);
      mgr.covers.set(c.id, {
        status: c.status,
        isLong: true,
        stopPNS: Number(c.stop),
        armer: c.armer,
        armedBlock: Number(c.armedBlock),
        lots: Number(c.lots),
        filledLots: Number(c.filled),
        expiryBlock: Number(c.expiry),
        shortBlock: Number(c.sb),
        shortSteps: c.steps,
        refTrigPNS: Number(c.refTrig),
        triggerBlock: Number(c.triggerBlock),
        windowBlocks: Number(c.window),
        startBlock: 0,
        warmupBlocks: 200,
        maxGapBps: 200
      });
      const sim = model.trigger(c.id, n, false);
      mgr.trigger.set(c.id, 'revert' in sim ? 'revert' : sim.paid);
    }
    mgr.watch.set(1, { toArm: [...arms], toTrigger });
    mgr.book = { basePricePNS: 0n, maxBidPriceONS: model.best() ?? 0n, minAskPriceONS: 0n };
    mgr.ref = { refPNS: model.R, nFresh: model.nFresh };
  };

  let logs: Record<string, unknown>[] = [];
  chain.logsFor = () => logs;
  const methods: string[] = [];
  const orig = chain.request.bind(chain);
  chain.request = async (a: { method: string; params?: unknown[] }) => {
    methods.push(a.method);
    if (a.method === 'eth_sendRawTransactionSync') {
      const arrive = t + (opts.rtt?.rpcMs ?? 0) / 2;
      // Lands in the block after arrival, and never before the block after our previous receipt.
      const landing = opts.rtt ? at(arrive) + 1n : chain.head + 1n;
      chain.setHead(landing - 1n);
      const tx = parseTransaction(a.params![0] as Hex);
      const { functionName, args } = decodeFunctionData({ abi: ICoverManagerAbi, data: tx.data! });
      logs = [];
      if (functionName === 'trigger' && model.covers.has(args![0] as Hex)) {
        const r = model.trigger(args![0] as Hex, landing, true);
        if ('revert' in r) chain.sendQueue.unshift({ kind: 'revert' });
        else logs = r.events;
      }
      const out = await orig(a);
      // Monad bills gasLimit x (base + tip): debit it so fresh balance reads match the queue's cache.
      const price = chain.baseFee + tx.maxPriorityFeePerGas! < tx.maxFeePerGas! ? chain.baseFee + tx.maxPriorityFeePerGas! : tx.maxFeePerGas!;
      chain.balance(KEEPER, (chain.balances.get(KEEPER.toLowerCase()) ?? 0n) - tx.gas! * price);
      chain.setHead(landing);
      if (opts.rtt) t = Number(landing) * blockMs + opts.rtt.rpcMs / 2;
      return out;
    }
    if (opts.rtt) chain.setHead(at(t + opts.rtt.rpcMs / 2));
    if (a.method === 'eth_call') sync();
    const out = await orig(a);
    if (opts.rtt) {
      t += opts.rtt.rpcMs;
      chain.setHead(at(t));
    }
    return out;
  };

  /** One head: by blocks (no RTT model), or the next Proposed head push after the keeper went idle. */
  const cycle = async (blocks = 1n) => {
    if (opts.rtt) {
      t = Math.max(t, Number(chain.head + 1n) * blockMs) + opts.rtt.rpcMs / 2;
      chain.setHead(at(t));
    } else {
      chain.setHead(chain.head + blocks);
    }
    sync();
    await keeper.cycle(head());
  };
  const sends = () =>
    chain.sent.map((s) => ({ fn: decodeFunctionData({ abi: ICoverManagerAbi, data: s.data! }).functionName, gas: s.gas, at: s.sentAtHead }));
  const labels = () =>
    (db.query('SELECT action, exempt FROM spend_ledger ORDER BY id').all() as { action: string; exempt: number }[]).map((r) => `${r.action}${r.exempt ? '*' : ''}`);
  return { chain, mgr, model, governor, keeper, queue, lines, cycle, sends, labels, head, methods, db, sync, arms, now: () => t, advance: sleep, blockMs };
}
