import { describe, expect, test } from 'bun:test';
import { decodeFunctionData, parseEther, type Address } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { ICoverManagerAbi } from '../src/abi/index.ts';
import { computeSigmaSeries, latestSigma, toSigmaE2 } from '../src/jobs/sigma.ts';
import { migrate, openDb } from '../src/lib/db.ts';
import { SendQueue } from '../src/lib/sendQueue.ts';
import { SpendGovernor } from '../src/lib/spendGovernor.ts';
import { KEEPER_MIGRATIONS } from '../src/keeper/migrations.ts';
import { MarketStore } from '../src/relay/perpl/store.ts';
import {
  allowanceBps,
  BlockBackoff,
  bookFromPerpInfo,
  closeLimitPNS,
  closeStep,
  COVER_STATUS,
  coverEvents,
  fastPath,
  fillsAt,
  landingBlock,
  lastWalkStep,
  pastWarmup,
  PERPL_MAX_PRICE_PNS,
  selectActions,
  STEP_MAX_GAP_BLOCKS,
  stillArmed,
  triggerAllowed,
  triggerDedupeKey,
  zeroPaidTriggerCloses,
  type PerpWatch,
  type TriggerCover,
  type ZeroPaidInput
} from '../src/keeper/actions.ts';
import { billedPriceWei, feeQuote, GAS } from '../src/lib/gas.ts';
import { FEED_DEFAULTS, RelayFeedClient } from '../src/keeper/feed.ts';
import { HEAD_DEFAULTS, HeadSubscriber, type Head } from '../src/keeper/heads.ts';
import { Keeper, MAX_HEAD_AHEAD_BLOCKS, REMAINDER_TRIGGER_LABEL, REPEAT_ARM_LABEL, ZERO_PAID_TRIGGER } from '../src/keeper/keeper.ts';
import { keeperHandler } from '../src/keeper/server.ts';
import { decideSigmaPost, MarkHistory, SIGMA_POLICY } from '../src/keeper/sigma.ts';
import { captureLogger, FakeChain, TEST_KEYS } from './fakeChain.ts';
import { coverId, FakeManager, MANAGER, managerLog, markLog, triggeredLog } from './fakeGapless.ts';
import { FakeSocket, ManualClock } from './manualClock.ts';

const keeperAccount = privateKeyToAccount(TEST_KEYS.keeper);
const KEEPER = keeperAccount.address;
const OTHER: Address = '0x000000000000000000000000000000000000beef';
const A = coverId(1);
const B = coverId(2);

const watch = (over: Partial<PerpWatch> = {}): PerpWatch => ({
  perpId: 1,
  toArm: [],
  toTrigger: [],
  toObserve: [],
  toFinalize: [],
  toExpire: [],
  toVoid: [],
  exclusiveBlocks: 3,
  ...over
});

const liveView = { status: COVER_STATUS.Live, armer: OTHER, armedBlock: 0n, expiryBlock: 10_000n, filledLots: 0n, shortBlock: 0n };
const LIVE_B = { status: COVER_STATUS.Live, isLong: true, stopPNS: 860_000, armer: OTHER, armedBlock: 0, lots: 10 };

describe('action selection (spec §4.1)', () => {
  test('priority: trigger, arm, observe, then low priority', () => {
    const plan = selectActions({
      head: 100n,
      keeper: KEEPER,
      perps: [watch({ toArm: [B], toTrigger: [A], toObserve: [coverId(3)], toFinalize: [coverId(4)] })],
      covers: new Map([[B, liveView]]),
      inflight: () => false,
      maxLowPriority: 4
    });
    expect(plan.map((p) => p.kind)).toEqual(['trigger', 'arm', 'observe', 'finalize']);
  });

  test('exclusive window: another armer blocks us until armedBlock + exclusiveBlocks has passed', () => {
    const c = { status: COVER_STATUS.Armed, armer: OTHER, armedBlock: 100n, expiryBlock: 10_000n, filledLots: 0n, shortBlock: 0n };
    expect(triggerAllowed(c, 102n, KEEPER, 3)).toBe(false); // lands at 103, not > 103
    expect(triggerAllowed(c, 103n, KEEPER, 3)).toBe(true);
    expect(triggerAllowed({ ...c, armer: KEEPER }, 100n, KEEPER, 3)).toBe(true);
    // Live fast path and Triggered remainders are open to anyone.
    expect(triggerAllowed({ ...c, status: COVER_STATUS.Live }, 100n, KEEPER, 3)).toBe(true);
    // L-02: the fast path is open to anyone inside the window, and a window reaching expiryBlock never applies.
    expect(triggerAllowed(c, 101n, KEEPER, 3, true)).toBe(true);
    expect(triggerAllowed({ ...c, expiryBlock: 103n }, 101n, KEEPER, 3)).toBe(true);
    expect(triggerAllowed({ ...c, expiryBlock: 104n }, 101n, KEEPER, 3)).toBe(false);
    const plan = selectActions({
      head: 101n,
      keeper: KEEPER,
      perps: [watch({ toTrigger: [A] })],
      covers: new Map([[A, c]]),
      inflight: () => false,
      maxLowPriority: 4
    });
    expect(plan).toEqual([]);
  });

  test('at most 4 finalize, expire and void per block, rotating kinds; inflight and duplicate ids are skipped', () => {
    const ids = Array.from({ length: 6 }, (_, i) => coverId(10 + i));
    const plan = selectActions({
      head: 100n,
      keeper: KEEPER,
      perps: [watch({ toFinalize: ids.slice(0, 3), toExpire: ids.slice(3), toArm: [A, A] })],
      covers: new Map([[A, liveView]]),
      inflight: (k) => k === `finalize:${ids[0]}`,
      maxLowPriority: 4
    });
    expect(plan.filter((p) => p.kind === 'arm')).toHaveLength(1);
    const low = plan.filter((p) => p.kind !== 'arm');
    expect(low.map((p) => `${p.kind}:${p.coverId}`)).toEqual([`finalize:${ids[1]}`, `expire:${ids[3]}`, `finalize:${ids[2]}`, `expire:${ids[4]}`]);
  });

  test('SA3-01: no arm that could land in or after the expiry block, and none without a cover read', () => {
    const plan = (expiryBlock: bigint | null) =>
      selectActions({
        head: 100n,
        keeper: KEEPER,
        perps: [watch({ toArm: [A] })],
        covers: expiryBlock === null ? new Map() : new Map([[A, { ...liveView, expiryBlock }]]),
        inflight: () => false,
        maxLowPriority: 4
      }).map((p) => p.kind);
    // Lands at 101 or 102; a trigger needs a later block that is still <= expiryBlock.
    expect(plan(103n)).toEqual(['arm']);
    expect(plan(102n)).toEqual([]);
    expect(plan(101n)).toEqual([]);
    expect(plan(null)).toEqual([]);
  });

  test('SA2 go-condition 3: a finalize backlog never starves expire, so every expire goes within a few heads', () => {
    const fin = Array.from({ length: 16 }, (_, i) => coverId(40 + i));
    const exp = [coverId(70), coverId(71)];
    const plan = selectActions({
      head: 100n,
      keeper: KEEPER,
      perps: [watch({ toFinalize: fin, toExpire: exp, toVoid: [coverId(80)] })],
      covers: new Map(),
      inflight: () => false,
      maxLowPriority: 4
    });
    expect(plan.map((p) => p.kind)).toEqual(['finalize', 'expire', 'voidCover', 'finalize']);
    expect(plan[1]!.coverId).toBe(exp[0]!);
  });

  test('fill check: book at or inside the close limit; empty sides (0 or max uint) never fill', () => {
    const max = (1n << 256n) - 1n;
    expect(bookFromPerpInfo({ basePricePNS: 800_000n, maxBidPriceONS: 0n, minAskPriceONS: max })).toEqual({ bestBidPNS: null, bestAskPNS: null });
    const book = bookFromPerpInfo({ basePricePNS: 800_000n, maxBidPriceONS: 55_000n, minAskPriceONS: 60_000n });
    expect(book).toEqual({ bestBidPNS: 855_000n, bestAskPNS: 860_000n });
    expect(fillsAt({ isLong: true }, book, 855_000n)).toBe(true);
    expect(fillsAt({ isLong: true }, book, 855_001n)).toBe(false);
    expect(fillsAt({ isLong: false }, book, 860_000n)).toBe(true);
    expect(fillsAt({ isLong: false }, book, 859_999n)).toBe(false);
    expect(fillsAt({ isLong: true }, { bestBidPNS: null, bestAskPNS: null }, 1n)).toBe(false);
  });

  test('close limit mirrors CoverManager._closeLimit (C5 steps, D49, L-06 clamp, per-cover A and slack)', () => {
    const long = { isLong: true, stopPNS: 860_000n, maxGapBps: 200, slipAllowanceBps: 5, floorSlackBps: 100 };
    const short = { ...long, isLong: false };
    // Step 0: floor(859,000 x 0.9995) = 858,570; short ceil(861,000 x 1.0005) = 861,431 (861,430.5 up).
    expect(closeLimitPNS(long, 859_000n, 0)).toBe(858_570n);
    expect(closeLimitPNS(short, 861_000n, 0)).toBe(861_431n);
    // Steps 1 to 6 widen min(stop, R) by 10, 20, 40, 80, 100, 100 bps (A x 2^k capped at floorSlack).
    expect([1, 2, 3, 4, 5, 6].map((k) => allowanceBps(long, k))).toEqual([10, 20, 40, 80, 100, 100]);
    expect([1, 2, 3, 4, 5, 6].map((k) => closeLimitPNS(long, 859_000n, k))).toEqual([858_141n, 857_282n, 855_564n, 852_128n, 850_410n, 850_410n]);
    expect(closeLimitPNS(long, 870_000n, 1)).toBe(859_140n);
    expect(closeLimitPNS(long, 870_000n, 5)).toBe(851_400n);
    expect(closeLimitPNS(short, 861_000n, 1)).toBe(861_861n);
    expect(closeLimitPNS(short, 861_000n, 5)).toBe(869_610n);
    // D49 (R = 0) at any step: stop x (1 - maxGap) x (1 - slack) = 842,800 x 0.99 = 834,372; short ceil(877,200 x 1.01) = 885,972.
    expect(closeLimitPNS(long, 0n, 0)).toBe(834_372n);
    expect(closeLimitPNS(long, 0n, 3)).toBe(834_372n);
    expect(closeLimitPNS(short, 0n, 0)).toBe(885_972n);
    // L-03: the cover's own A (50) and slack (300), not the market's; slack 300 needs step 6 (5 x 64 = 320).
    expect(closeLimitPNS({ ...long, slipAllowanceBps: 50 }, 859_000n, 0)).toBe(854_705n);
    expect(closeLimitPNS({ ...long, floorSlackBps: 300 }, 859_000n, 6)).toBe(833_230n);
    expect(closeLimitPNS({ ...long, floorSlackBps: 300 }, 859_000n, 5)).toBe(845_256n);
    // L-06: clamped to Perpl's [1, 16,777,215].
    expect(closeLimitPNS({ ...short, stopPNS: 16_700_000n }, 16_700_000n, 5)).toBe(PERPL_MAX_PRICE_PNS);
    expect(closeLimitPNS({ ...long, stopPNS: 1n }, 1n, 0)).toBe(1n);
  });

  test('N-01 chain: step from shortBlock and shortSteps, 10-block gap (C7), same-block reuse, walk length per cover', () => {
    const chain = { shortBlock: 100n, shortSteps: 2 };
    expect(STEP_MAX_GAP_BLOCKS).toBe(10n);
    expect(closeStep(chain, true, 101n)).toBe(2);
    expect(closeStep(chain, true, 110n)).toBe(2);
    // More than STEP_MAX_GAP_BLOCKS after the touch's latest attempt: back to step 0.
    expect(closeStep(chain, true, 111n)).toBe(0);
    // A retry in the same block reuses that block's step (a third party cannot reset it by double-calling).
    expect(closeStep(chain, true, 100n)).toBe(1);
    // R above the stop (or no fresh R) runs at step 0 and ends the chain.
    expect(closeStep(chain, false, 101n)).toBe(0);
    expect(closeStep({ shortBlock: 0n, shortSteps: 0 }, true, 101n)).toBe(0);
    // Defaults reach floorSlack at step 5; slack 300 would need 6 but the per-touch budget stops the walk at 5.
    expect(lastWalkStep({ slipAllowanceBps: 5, floorSlackBps: 100 })).toBe(5);
    expect(lastWalkStep({ slipAllowanceBps: 5, floorSlackBps: 300 })).toBe(5);
    expect(lastWalkStep({ slipAllowanceBps: 50, floorSlackBps: 100 })).toBe(1);
    // We never land in a block whose state we already read.
    expect(landingBlock(100n, { shortBlock: 0n, shortSteps: 0 })).toBe(101n);
    expect(landingBlock(100n, { shortBlock: 101n, shortSteps: 1 })).toBe(102n);
    expect(pastWarmup({ startBlock: 1_000n, warmupBlocks: 200 }, 1_199n)).toBe(false);
    expect(pastWarmup({ startBlock: 1_000n, warmupBlocks: 200 }, 1_200n)).toBe(true);
  });

  test('trigger dedupe is keyed by close progress, so remainders and widened retries are not held 3 blocks', () => {
    expect(triggerDedupeKey(A)).toBe(`trigger:${A}`);
    expect(triggerDedupeKey(A, { filledLots: 16n, shortBlock: 0n })).not.toBe(triggerDedupeKey(A, { filledLots: 32n, shortBlock: 0n }));
    expect(triggerDedupeKey(A, { filledLots: 0n, shortBlock: 0n })).not.toBe(triggerDedupeKey(A, { filledLots: 0n, shortBlock: 101n }));
  });

  test('fast path: venue up and a fresh mark (refFreshSec + 2 s) at or through the stop', () => {
    const c = { isLong: true, stopPNS: 860_000n };
    const info = { markPNS: 859_000n, markTimestamp: 1_000n, status: 4 };
    expect(fastPath(c, info, false, 60, 1_062n)).toBe(true);
    expect(fastPath(c, info, false, 60, 1_063n)).toBe(false);
    expect(fastPath(c, { ...info, markPNS: 860_001n }, false, 60, 1_000n)).toBe(false);
    expect(fastPath(c, { ...info, markPNS: 0n }, false, 60, 1_000n)).toBe(false);
    expect(fastPath(c, info, true, 60, 1_000n)).toBe(false);
    expect(fastPath(c, { ...info, status: 2 }, false, 60, 1_000n)).toBe(false);
    expect(fastPath({ isLong: false, stopPNS: 858_000n }, info, false, 60, 1_000n)).toBe(true);
  });
});

describe('sigma on demand', () => {
  const base = { estimateE2: 29, onchainE2: 27, postedBlock: 10_000n, head: 11_000n, maxAgeBlocks: 6_000, quoteRequested: true };

  test('posts only with demand, never inside 600 blocks, when stale (5,400 of 6,000) or off by > 10%', () => {
    expect(decideSigmaPost({ ...base, quoteRequested: false })).toEqual({ post: false, reason: 'no_demand' });
    expect(decideSigmaPost({ ...base, head: 10_599n, estimateE2: 200 })).toEqual({ post: false, reason: 'rate_limited' });
    // 29 vs 27 moves 7%; 30 vs 27 moves 11%.
    expect(decideSigmaPost({ ...base })).toEqual({ post: false, reason: 'fresh' });
    expect(decideSigmaPost({ ...base, estimateE2: 30 })).toEqual({ post: true, reason: 'changed' });
    expect(decideSigmaPost({ ...base, estimateE2: 24 })).toEqual({ post: true, reason: 'changed' });
    expect(decideSigmaPost({ ...base, head: 15_400n })).toEqual({ post: true, reason: 'stale' });
    expect(decideSigmaPost({ ...base, postedBlock: 0n })).toEqual({ post: true, reason: 'stale' });
  });

  test('keeper estimate equals the jobs estimator on the same onchain mark series, however it is paged', async () => {
    const chain = new FakeChain();
    const { series, logs } = syntheticMarks(52_000n, 99_990n);
    chain.logs = logs;
    const { log } = captureLogger();
    const paged = new MarkHistory({ client: chain.client(), perpIds: [1], chunkBlocks: 1_000, log });
    const oneShot = new MarkHistory({ client: chain.client(), perpIds: [1], chunkBlocks: 10_000, log });
    await paged.catchUp(80_000n);
    await paged.catchUp(100_000n);
    await oneShot.catchUp(100_000n);
    // Jobs side: the same function on the same logs inside the keeper window.
    const from = 100_000 - Number(SIGMA_POLICY.historyBlocks) + 1;
    const inWindow = { block: series.block.filter((b) => b >= from), price: series.price.filter((_, i) => series.block[i]! >= from) };
    const expected = toSigmaE2(latestSigma(computeSigmaSeries(inWindow, 100_001))!);
    expect(paged.sigmaE2(1, 100_001n)).toBe(expected);
    expect(oneShot.sigmaE2(1, 100_001n)).toBe(expected);
    expect(paged.lastMark(1)).toEqual({ block: series.block.at(-1)!, price: series.price.at(-1)! });
  });

  test('null during warm-up', async () => {
    const chain = new FakeChain();
    chain.logs = syntheticMarks(95_000n, 99_990n).logs;
    const m = new MarkHistory({ client: chain.client(), perpIds: [1], chunkBlocks: 10_000, log: captureLogger().log });
    await m.catchUp(100_000n);
    expect(m.sigmaE2(1, 100_001n)).toBeNull();
  });
});

/** Random walk of onchain marks every 50 blocks (fixed seed). */
function syntheticMarks(from: bigint, to: bigint) {
  let seed = 7;
  const rand = () => ((seed = (seed * 16_807) % 2_147_483_647) / 2_147_483_647);
  const series = { block: [] as number[], price: [] as number[] };
  const logs: Record<string, unknown>[] = [];
  let price = 860_000;
  for (let b = from; b <= to; b += 50n) {
    price = Math.max(1, Math.round(price * (1 + (rand() - 0.5) * 0.001)));
    series.block.push(Number(b));
    series.price.push(price);
    logs.push(markLog(b, 0, 1, price));
    logs.push(markLog(b, 1, 10, 32_000)); // another perp in the same logs
  }
  return { series, logs };
}

function freshStore(now: () => number, mark: number): MarketStore {
  const store = new MarketStore({ now });
  store.apply({ mt: 9000, status: 'up', t: 0 });
  store.apply({ mt: 6, subs: [{ stream: 'heartbeat@143', sid: 5000, status: { code: 0 } }, { stream: 'market-state@143', sid: 3000, status: { code: 0 } }] });
  store.apply({ mt: 100, sid: 5000, sn: 99_999, h: 99_999 });
  store.apply({
    mt: 9,
    sid: 3000,
    sn: 99_999,
    d: { '1': { at: { b: 99_999, t: 1 }, orl: mark, mrk: mark, lst: mark, mid: mark, bid: mark, ask: mark, prv: 0, dv: 0, dva: '0', oi: 0, tvl: '0' } }
  });
  return store;
}

function keeperSetup(
  opts: { balance?: bigint; capWei?: bigint; zeroPaidCapWei?: bigint; strict?: boolean; store?: MarketStore; logs?: Record<string, unknown>[]; clock?: { t: number } } = {}
) {
  const chain = new FakeChain();
  chain.setHead(100_000n);
  chain.balance(KEEPER, opts.balance ?? parseEther('1.5'));
  if (opts.logs) chain.logs = opts.logs;
  const mgr = new FakeManager();
  mgr.install(chain);
  const { log, events, lines } = captureLogger();
  const db = openDb(':memory:');
  migrate(db, KEEPER_MIGRATIONS);
  const capWei = opts.capWei ?? parseEther('1');
  const client = chain.client();
  const clock = opts.clock ?? { t: 1_000_000 };
  const store = opts.store ?? new MarketStore({ now: () => clock.t });
  // A process: governor, queue and keeper over the shared db and chain. restart() builds a new one (F-7).
  const boot = () => {
    const governor = new SpendGovernor(
      db,
      KEEPER,
      // Hot reserve: one 2.2M trigger at max fee (0.4444 MON at the floor).
      { capWei, hotReserveWei: parseEther('0.45'), alertWei: capWei, actionCapsWei: { [ZERO_PAID_TRIGGER.label]: opts.zeroPaidCapWei ?? parseEther('1.4') } },
      log
    );
    const queue = new SendQueue({
      client,
      account: keeperAccount,
      governor,
      log,
      strictReserveSpacing: opts.strict,
      head: async () => ({ number: chain.head, baseFeePerGas: chain.baseFee })
    });
    const marks = new MarkHistory({ client, perpIds: [1], chunkBlocks: 10_000, log });
    const keeper = new Keeper({ client, queue, governor, db, manager: MANAGER, keeper: KEEPER, perps: [1], store, marks, log, sigmaEnabled: true, now: () => clock.t });
    return { governor, queue, keeper };
  };
  const { governor, queue, keeper } = boot();
  const head = (n: bigint): Head => ({ number: n, hash: `0x${'11'.repeat(32)}`, blockId: String(n), commitState: 'Proposed', timestamp: 0n, baseFeePerGas: chain.baseFee });
  const sentFns = () => chain.sent.map((t) => decodeFunctionData({ abi: ICoverManagerAbi, data: t.data! }).functionName);
  // F-2: the first sigma check starts the history fetch in the background; the next head decides.
  const sigmaCycle = async (h: Head) => {
    await keeper.cycle(h);
    await keeper.marksIdle();
    await keeper.cycle(h);
  };
  return { chain, mgr, queue, keeper, store, head, sentFns, sigmaCycle, events, lines, clock, governor, db, restart: boot };
}

describe('keeper cycle (fake chain)', () => {
  test('trigger goes first; below 10 MON gas-only sends still go in the same head (M-2)', async () => {
    const { chain, mgr, keeper, head, sentFns } = keeperSetup();
    mgr.watch.set(1, { toArm: [B], toTrigger: [A] });
    mgr.covers.set(A, { status: COVER_STATUS.Armed, isLong: true, stopPNS: 860_000, armer: KEEPER, armedBlock: 99_999, lots: 10 });
    mgr.trigger.set(A, 5_000n);
    mgr.arm.set(B, true);
    mgr.covers.set(B, LIVE_B);
    await keeper.cycle(head(chain.head));
    expect(sentFns()).toEqual(['trigger', 'arm']);
  });

  test('STRICT_RESERVE_SPACING: below 10 MON the arm waits for the reserve window', async () => {
    const { chain, mgr, keeper, head, sentFns } = keeperSetup({ strict: true });
    mgr.watch.set(1, { toArm: [B], toTrigger: [A] });
    mgr.covers.set(A, { status: COVER_STATUS.Armed, isLong: true, stopPNS: 860_000, armer: KEEPER, armedBlock: 99_999, lots: 10 });
    mgr.trigger.set(A, 5_000n);
    mgr.arm.set(B, true);
    mgr.covers.set(B, LIVE_B);
    await keeper.cycle(head(chain.head));
    expect(sentFns()).toEqual(['trigger']);

    // Included at head + 1; the next send may go once head - included >= 3.
    const included = chain.head + 1n;
    mgr.watch.set(1, { toArm: [B], toTrigger: [] });
    for (const h of [included, included + 2n]) {
      chain.setHead(h);
      await keeper.cycle(head(chain.head));
      expect(sentFns()).toEqual(['trigger']);
    }
    chain.setHead(included + 3n);
    await keeper.cycle(head(chain.head));
    expect(sentFns()).toEqual(['trigger', 'arm']);
  });

  test('with 10+ MON both go out in one head', async () => {
    const { chain, mgr, keeper, head, sentFns } = keeperSetup({ balance: parseEther('40') });
    mgr.watch.set(1, { toArm: [B], toTrigger: [A] });
    mgr.trigger.set(A, 1n);
    mgr.arm.set(B, true);
    mgr.covers.set(B, LIVE_B);
    await keeper.cycle(head(chain.head));
    expect(sentFns()).toEqual(['trigger', 'arm']);
  });

  test('never triggers inside another armer exclusive window', async () => {
    const { chain, mgr, keeper, head, sentFns } = keeperSetup();
    mgr.watch.set(1, { toArm: [], toTrigger: [A] });
    mgr.covers.set(A, { status: COVER_STATUS.Armed, isLong: true, stopPNS: 860_000, armer: OTHER, armedBlock: Number(chain.head) - 1, lots: 10 });
    mgr.trigger.set(A, 5_000n);
    await keeper.cycle(head(chain.head));
    expect(sentFns()).toEqual([]);
    expect(mgr.calls).not.toContain('trigger');
  });

  test('a trigger simulating to 0 is sent only when the book fills the close', async () => {
    const { chain, mgr, keeper, head, sentFns } = keeperSetup();
    mgr.watch.set(1, { toArm: [], toTrigger: [A] });
    mgr.covers.set(A, { status: COVER_STATUS.Live, isLong: true, stopPNS: 860_000, armer: OTHER, armedBlock: 0, lots: 10 });
    mgr.trigger.set(A, 0n);
    // Live fast path in an oracle outage (no fresh reference): the D49 floor 834,372 applies.
    mgr.markPNS = 859_000n;
    mgr.book = { basePricePNS: 0n, maxBidPriceONS: 800_000n, minAskPriceONS: 0n };
    await keeper.cycle(head(chain.head));
    expect(sentFns()).toEqual([]);
    mgr.book = { basePricePNS: 0n, maxBidPriceONS: 855_000n, minAskPriceONS: 0n };
    chain.setHead(chain.head + 1n);
    await keeper.cycle(head(chain.head));
    expect(sentFns()).toEqual(['trigger']);
  });

  test('feed loss: no sigma post on a stale or missing feed, posts once fresh', async () => {
    const { series, logs } = syntheticMarks(52_000n, 99_990n);
    const s1 = keeperSetup({ logs });
    s1.keeper.requestSigma(1);
    await s1.keeper.cycle(s1.head(s1.chain.head));
    expect(s1.sentFns()).toEqual([]);
    expect(s1.keeper.snapshot().sigma['1']?.decision).toBe('feed_stale');
    expect(s1.chain.methods).not.toContain('eth_getLogs');

    const clock2 = { t: 1_000_000 };
    const s2 = keeperSetup({ store: freshStore(() => clock2.t, series.price.at(-1)!), logs, clock: clock2 });
    s2.keeper.requestSigma(1);
    await s2.sigmaCycle(s2.head(s2.chain.head));
    expect(s2.sentFns()).toEqual(['postSigma']);
    const { args } = decodeFunctionData({ abi: ICoverManagerAbi, data: s2.chain.sent[0]!.data! });
    expect(args?.[0]).toBe(1n);
    expect(args?.[1]).toBe(s2.keeper.snapshot().sigma['1']!.estimateE2!);

    // The relay drops: status down marks the store unsynced, so the next check posts nothing.
    s2.store.apply({ mt: 9000, status: 'down', t: 1 });
    expect(s2.store.getQuote(1)).toBeNull();
    s2.keeper.requestSigma(1);
    s2.chain.setHead(s2.chain.head + 700n);
    await s2.keeper.cycle(s2.head(s2.chain.head));
    expect(s2.sentFns()).toEqual(['postSigma']);
  });

  test('a feed mark far from the onchain mark blocks the post', async () => {
    const { series, logs } = syntheticMarks(52_000n, 99_990n);
    const clock = { t: 1_000_000 };
    const s = keeperSetup({ store: freshStore(() => clock.t, Math.round(series.price.at(-1)! * 1.05)), logs, clock });
    s.keeper.requestSigma(1);
    await s.sigmaCycle(s.head(s.chain.head));
    expect(s.sentFns()).toEqual([]);
    expect(s.events()).toContain('sigma.skip_mark_mismatch');
  });
});

describe('F-2: sigma history fetch runs off the head loop', () => {
  test('a pending trigger goes while the first 48,000-block mark fetch is still running (was: every cycle waited, 84 s on the fork)', async () => {
    const { series, logs } = syntheticMarks(52_000n, 99_990n);
    const clock = { t: 1_000_000 };
    const s = keeperSetup({ store: freshStore(() => clock.t, series.price.at(-1)!), logs, clock });
    // Slow log source: every eth_getLogs chunk waits until the test releases it.
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let fetchStarted!: () => void;
    const started = new Promise<void>((r) => (fetchStarted = r));
    let released = false;
    // Old code would block idle() on the gate: fail the assertions instead of hanging the suite.
    const failsafe = setTimeout(() => {
      released = true;
      release();
    }, 2_000);
    let logCalls = 0;
    const request = s.chain.request.bind(s.chain);
    s.chain.request = async (a) => {
      if (a.method === 'eth_getLogs') {
        logCalls++;
        fetchStarted();
        await gate;
      }
      return request(a);
    };

    // First /sigma-refresh after boot: a quiet head starts the fetch.
    const h0 = s.chain.head;
    s.keeper.requestSigma(1);
    expect(s.keeper.onHead(s.head(h0))).toBe(true);
    await started;
    // A cover reaches its stop while the fetch is stuck on its first chunk.
    s.mgr.watch.set(1, { toArm: [], toTrigger: [A] });
    s.mgr.covers.set(A, { status: COVER_STATUS.Armed, isLong: true, stopPNS: 860_000, armer: KEEPER, armedBlock: Number(h0) - 1, lots: 10 });
    s.mgr.trigger.set(A, 5_000n);
    s.chain.setHead(h0 + 1n);
    s.keeper.onHead(s.head(h0 + 1n));
    await s.keeper.idle();
    expect(released).toBe(false);
    expect(s.sentFns()).toEqual(['trigger']);
    expect(s.keeper.snapshot().lastCycle?.head).toBe(String(h0 + 1n));
    expect(s.keeper.snapshot().sigma['1']?.decision).toBe('history_loading');
    expect(logCalls).toBe(1);

    // The fetch completes in the background; the next quiet head posts.
    clearTimeout(failsafe);
    release();
    await s.keeper.marksIdle();
    s.mgr.watch.set(1, { toArm: [], toTrigger: [] });
    s.chain.setHead(h0 + 2n);
    s.keeper.onHead(s.head(h0 + 2n));
    await s.keeper.idle();
    await s.keeper.marksIdle();
    expect(s.sentFns()).toEqual(['trigger', 'postSigma']);
  });
});

describe('F-3: a new touch on a dead chain is not a chain gap', () => {
  test('first attempt on a fresh touch (cycle path): no chain_gap_high, console gap stats untouched (was 2239 blocks on the fork)', async () => {
    const s = keeperSetup();
    const h = s.chain.head;
    // Cover B4 after the restart: shortBlock left by a touch 2,238 blocks earlier, long past the 10-block rule.
    s.mgr.watch.set(1, { toArm: [], toTrigger: [A] });
    s.mgr.covers.set(A, { status: COVER_STATUS.Armed, isLong: true, stopPNS: 860_000, armer: KEEPER, armedBlock: Number(h) - 1, lots: 10, shortBlock: Number(h) - 2_238, shortSteps: 3 });
    s.mgr.trigger.set(A, 5_000n);
    await s.keeper.cycle(s.head(h));
    expect(s.sentFns()).toEqual(['trigger']);
    expect(s.events()).not.toContain('keeper.chain_gap_high');
    expect(s.events()).not.toContain('keeper.chain_gap');
    expect(s.keeper.consoleView().gaps).toEqual([]);

    // Control: a chain still alive when planned is a real gap and is still recorded.
    const s2 = keeperSetup();
    s2.mgr.watch.set(1, { toArm: [], toTrigger: [A] });
    s2.mgr.covers.set(A, { status: COVER_STATUS.Armed, isLong: true, stopPNS: 860_000, armer: KEEPER, armedBlock: Number(h) - 1, lots: 10, shortBlock: Number(h) - 3, shortSteps: 3 });
    s2.mgr.trigger.set(A, 5_000n);
    await s2.keeper.cycle(s2.head(h));
    expect(s2.keeper.consoleView().gaps).toEqual([{ gapBlocks: 4, path: 'cycle' }]);
  });

  test('a dead-chain cover joining the fast lane behind another close is a first attempt there too', async () => {
    const s = keeperSetup({ balance: parseEther('40'), capWei: parseEther('5') });
    const h = s.chain.head;
    s.mgr.watch.set(1, { toArm: [], toTrigger: [A, B] });
    s.mgr.covers.set(A, { status: COVER_STATUS.Armed, isLong: true, stopPNS: 860_000, armer: KEEPER, armedBlock: Number(h) - 1, lots: 10 });
    s.mgr.covers.set(B, { status: COVER_STATUS.Live, isLong: true, stopPNS: 860_000, armer: OTHER, armedBlock: 0, lots: 10, shortBlock: Number(h) - 2_238, shortSteps: 3 });
    s.mgr.trigger.set(A, 5_000n);
    s.mgr.trigger.set(B, 0n);
    // A fills 4 of 10 lots, so the close continues in the lane; B rides along (it has a shortBlock on record).
    s.chain.logsFor = (tx) => (decodeFunctionData({ abi: ICoverManagerAbi, data: tx.data! }).args?.[0] === A ? [triggeredLog(A, 4n, 5_000n)] : []);
    // Live fast path in an oracle outage: the book fills B's step-0 close at the D49 floor.
    s.mgr.markPNS = 859_000n;
    s.mgr.book = { basePricePNS: 0n, maxBidPriceONS: 855_000n, minAskPriceONS: 0n };
    await s.keeper.cycle(s.head(h));
    expect(s.sentFns()).toEqual(['trigger', 'trigger']);
    expect(s.events()).not.toContain('keeper.chain_gap_high');
    expect(s.keeper.consoleView().gaps).toEqual([]);
  });
});

describe('F-5: a condition that holds across heads warns on transitions, not on every head', () => {
  const at = (lines: Record<string, unknown>[], msg: string, level: number) => lines.filter((l) => l.msg === msg && l.level === level);
  const WARN = 40;
  const INFO = 30;
  const DEBUG = 20;
  const HEADS = 700;

  test('sigma.skip_mark_mismatch: warn when it starts, again after 10 min, info when it clears (was one warn per head, 121 on the fork)', async () => {
    const { series, logs } = syntheticMarks(52_000n, 99_990n);
    const clock = new ManualClock();
    clock.t = 1_000_000;
    const chainMark = series.price.at(-1)!;
    // The fork's case: the live feed far from the fork's onchain mark.
    const store = freshStore(clock.now, Math.round(chainMark * 1.05));
    const s = keeperSetup({ store, logs, clock });
    let sn = 100_000;
    const quietHead = async () => {
      s.chain.setHead(s.chain.head + 1n);
      store.apply({ mt: 100, sid: 5000, sn: sn++, h: Number(s.chain.head) });
      await s.keeper.cycle(s.head(s.chain.head));
      await s.keeper.marksIdle();
      clock.advance(1_000);
    };
    // One head per second for about 11.7 min; the PWA asks for a quote every minute.
    for (let i = 0; i < HEADS; i++) {
      if (i % 60 === 0) s.keeper.requestSigma(1);
      await quietHead();
    }
    const msg = 'sigma.skip_mark_mismatch';
    const warns = at(s.lines, msg, WARN);
    expect(warns.map((l) => l.state)).toEqual(['start', 'persists']);
    expect(warns[1]!.heldMs).toBeGreaterThanOrEqual(600_000);
    expect(warns[1]!.suppressed).toBeGreaterThan(500);
    // Every head is still on record at debug.
    expect(at(s.lines, msg, DEBUG).length).toBe(HEADS - 1 - warns.length);
    expect(s.sentFns()).toEqual([]);

    // The feed agrees with the chain again: one info line, no more warns, and the post goes.
    store.apply({
      mt: 9,
      sid: 3000,
      sn: sn,
      d: { '1': { at: { b: Number(s.chain.head), t: 1 }, orl: chainMark, mrk: chainMark, lst: chainMark, mid: chainMark, bid: chainMark, ask: chainMark, prv: 0, dv: 0, dva: '0', oi: 0, tvl: '0' } }
    });
    s.keeper.requestSigma(1);
    for (let i = 0; i < 3; i++) await quietHead();
    const resolved = s.lines.filter((l) => l.msg === `${msg}_resolved`);
    expect(resolved).toHaveLength(1);
    expect(resolved[0]).toMatchObject({ level: INFO, how: 'cleared', perp: 1 });
    expect(Number(resolved[0]!.heldMs)).toBeGreaterThanOrEqual(HEADS * 1_000 - 2_000);
    expect(at(s.lines, msg, WARN)).toHaveLength(2);
    expect(s.sentFns()).toEqual(['postSigma']);
   }, 30_000);

  test('keeper.touch_budget: warn when a walk is refused, again after 10 min, info once admitted (was one warn per head, 173 on the fork)', async () => {
    const clock = new ManualClock();
    clock.t = 1_000_000;
    const s = keeperSetup({ capWei: parseEther('3'), balance: parseEther('5'), clock });
    s.mgr.ref = { refPNS: 859_000n, nFresh: 2 };
    // Fills only at floorSlack: a step-0 walk start that needs touch admission.
    s.mgr.book = { basePricePNS: 0n, maxBidPriceONS: 851_000n, minAskPriceONS: 0n };
    s.mgr.watch.set(1, { toArm: [], toTrigger: [A] });
    s.mgr.trigger.set(A, 0n);
    // Today's trigger_zero sub-cap mostly held by another walk (fork E3): 0.2 of 1.4 MON left, less than one walk.
    // Queue init first: it releases reserved rows left without a tx (crash leftovers).
    await s.queue.init();
    const held = s.governor.reserve({ action: ZERO_PAID_TRIGGER.label, amountWei: parseEther('1.2'), exempt: false });
    expect(held.ok).toBe(true);
    const nextHead = async () => {
      s.chain.setHead(s.chain.head + 1n);
      // Re-armed as it lapses: the cover stays Armed through the stop.
      s.mgr.covers.set(A, { status: COVER_STATUS.Armed, isLong: true, stopPNS: 860_000, armer: KEEPER, armedBlock: Number(s.chain.head) - 1, lots: 10 });
      await s.keeper.cycle(s.head(s.chain.head));
      clock.advance(1_000);
    };
    for (let i = 0; i < HEADS; i++) await nextHead();
    const msg = 'keeper.touch_budget';
    const warns = at(s.lines, msg, WARN);
    expect(warns.map((l) => l.state)).toEqual(['start', 'persists']);
    expect(warns[0]).toMatchObject({ coverId: A });
    expect(warns[1]!.heldMs).toBeGreaterThanOrEqual(600_000);
    expect(at(s.lines, msg, DEBUG).length).toBe(HEADS - warns.length);
    expect(s.sentFns()).toEqual([]);

    // The other walk ends and frees its reservation: admitted, one info line, the step goes.
    if (held.ok) s.governor.release(held.id);
    await nextHead();
    const resolved = s.lines.filter((l) => l.msg === `${msg}_resolved`);
    expect(resolved).toHaveLength(1);
    expect(resolved[0]).toMatchObject({ level: INFO, how: 'cleared', coverId: A });
    expect(s.sentFns()).toEqual(['trigger']);
    expect(at(s.lines, msg, WARN)).toHaveLength(2);
   }, 30_000);
});

describe('F-7: restart keeps the daily walk-start cap', () => {
  const STOP = 860_000;
  const cover = (h: bigint, over: Record<string, number> = {}) => ({ status: COVER_STATUS.Armed, isLong: true, stopPNS: STOP, armer: KEEPER, armedBlock: Number(h) - 1, lots: 10, ...over });

  test('two walk starts, then a restart: the third start is still refused that UTC day (was: allowed again by every new process)', async () => {
    const clock = new ManualClock();
    clock.t = Date.UTC(2026, 9, 6, 12);
    const s = keeperSetup({ capWei: parseEther('3'), balance: parseEther('5'), clock });
    s.mgr.book = { basePricePNS: 0n, maxBidPriceONS: 851_000n, minAskPriceONS: 0n };
    s.mgr.watch.set(1, { toArm: [], toTrigger: [A] });
    s.mgr.trigger.set(A, 0n);
    s.chain.logsFor = () => [managerLog('TriggerNoFill', { coverId: A })];
    // Each touch: R through the stop for one step-0 attempt, then the price bounces (the walk stops).
    s.chain.onSent = () => {
      s.mgr.covers.set(A, cover(s.chain.head, { shortBlock: Number(s.chain.head + 1n), shortSteps: 1 }));
      s.mgr.ref = { refPNS: 861_000n, nFresh: 2 };
    };
    let keeper = s.keeper;
    const touch = async () => {
      // More than STEP_MAX_GAP_BLOCKS later: the old chain is dead, so this is a new walk start.
      s.chain.setHead(s.chain.head + 20n);
      const prev = s.mgr.covers.get(A);
      s.mgr.covers.set(A, cover(s.chain.head, { shortBlock: prev?.shortBlock ?? 0, shortSteps: prev?.shortSteps ?? 0 }));
      s.mgr.ref = { refPNS: 859_000n, nFresh: 2 };
      await keeper.cycle(s.head(s.chain.head));
    };
    await touch();
    await touch();
    expect(s.chain.sent).toHaveLength(2);
    await touch();
    expect(s.chain.sent).toHaveLength(2);
    expect(s.lines.filter((l) => l.msg === 'keeper.zero_paid_skip').map((l) => l.why)).toContain('touch_cap');

    // Restart: a new governor, queue and keeper on the same db (what a SIGTERM or SIGKILL restart leaves).
    keeper = s.restart().keeper;
    await touch();
    expect(s.chain.sent).toHaveLength(2);
    const rows = s.db.query('SELECT day, cover_id, starts FROM keeper_touches').all();
    expect(rows).toEqual([{ day: '2026-10-06', cover_id: A.toLowerCase(), starts: 2 }]);
    // Not persisted by design: console gap samples and the recent ring (observability only), the phantom set (one
    // redundant close at most), walk reservations (re-derived from getCover, next test).
    expect(keeper.consoleView().gaps).toEqual([]);

    // The cap is per UTC day: the next day starts fresh.
    clock.advance(24 * 3_600_000);
    await touch();
    expect(s.chain.sent).toHaveLength(3);
  });

  test('a walk running across a restart reserves the rest of its walk from chain state, so admission still counts it', async () => {
    const s = keeperSetup({ capWei: parseEther('3'), balance: parseEther('5'), zeroPaidCapWei: parseEther('0.3') });
    const h = s.chain.head;
    s.mgr.ref = { refPNS: 859_000n, nFresh: 2 };
    s.mgr.book = { basePricePNS: 0n, maxBidPriceONS: 851_000n, minAskPriceONS: 0n };
    // A walk at step 2 that the previous process admitted; B gaps at the same time and needs admission.
    s.mgr.covers.set(A, cover(h, { shortBlock: Number(h) - 1, shortSteps: 2 }));
    s.mgr.covers.set(B, cover(h));
    s.mgr.watch.set(1, { toArm: [], toTrigger: [A, B] });
    s.mgr.trigger.set(A, 0n);
    s.mgr.trigger.set(B, 0n);
    s.chain.logsFor = () => [managerLog('TriggerNoFill', { coverId: A })];
    s.chain.onSent = () => s.mgr.covers.set(A, cover(h, { shortBlock: Number(s.chain.head + 1n), shortSteps: 3 }));
    const keeper = s.restart().keeper;
    // A's step 2 goes (a continuation needs no admission); its step 3 hits the 0.3 MON trigger_zero sub-cap.
    await keeper.cycle(s.head(h));
    s.chain.setHead(h + 1n);
    await keeper.cycle(s.head(h + 1n));
    expect(s.sentFns()).toEqual(['trigger']);
    // B's admission includes A's adopted walk: 2 steps left after the landed one, ceil(10 / 8) = 2 fills.
    const billed = billedPriceWei(s.chain.baseFee);
    const peak = feeQuote(s.chain.baseFee).maxFeePerGas - billed;
    const touchWei = ((5n + 2n) * GAS.triggerStep + (2n + 2n) * GAS.trigger) * billed + GAS.trigger * peak;
    const refused = s.lines.filter((l) => l.msg === 'keeper.touch_budget' && l.coverId === B);
    expect(refused.length).toBeGreaterThan(0);
    expect(refused[0]).toMatchObject({ touchWei: touchWei.toString(), running: 1 });
  });
});

describe('relay feed client', () => {
  function feedSetup() {
    const clock = new ManualClock();
    const sockets: { ws: FakeSocket; headers: Record<string, string> }[] = [];
    const store = new MarketStore({ now: clock.now });
    const { log, events } = captureLogger();
    const feed = new RelayFeedClient({
      url: 'ws://relay.internal:3701/ws/market',
      token: 'k'.repeat(40),
      store,
      log,
      timers: clock.timers,
      now: clock.now,
      random: () => 0,
      createSocket: (_url, headers) => {
        const ws = new FakeSocket();
        sockets.push({ ws, headers });
        return ws as unknown as WebSocket;
      }
    });
    return { clock, sockets, store, feed, events };
  }

  test('authenticates with the bearer token and pings well inside the 90 s idle limit', () => {
    const { clock, sockets, feed } = feedSetup();
    feed.start();
    expect(sockets[0]!.headers).toEqual({ Authorization: `Bearer ${'k'.repeat(40)}` });
    sockets[0]!.ws.open();
    // Heartbeats keep the watchdog quiet while the ping timer runs.
    for (let i = 1; i <= 31; i++) {
      sockets[0]!.ws.emit(JSON.stringify({ mt: 100, sn: i, h: i }));
      clock.advance(1_000);
    }
    expect(sockets[0]!.ws.sent.map((s) => JSON.parse(s).mt)).toEqual([1]);
    expect(FEED_DEFAULTS.pingIntervalMs).toBeLessThan(90_000);
    feed.stop();
  });

  test('status down unsyncs the store; a heartbeat gap reconnects for a fresh snapshot', () => {
    const { clock, sockets, store, feed, events } = feedSetup();
    feed.start();
    const ws = sockets[0]!.ws;
    ws.open();
    ws.emit(JSON.stringify({ mt: 9000, status: 'up', t: 0 }));
    ws.emit(JSON.stringify({ mt: 6, subs: [{ stream: 'heartbeat@143', sid: 5000, status: { code: 0 } }, { stream: 'market-state@143', sid: 3000, status: { code: 0 } }] }));
    ws.emit(JSON.stringify({ mt: 100, sid: 5000, sn: 10, h: 10 }));
    ws.emit(JSON.stringify({ mt: 9, sid: 3000, sn: 10, d: { '1': { at: { b: 10, t: 1 }, orl: 1, mrk: 1, lst: 1, mid: 1, bid: 1, ask: 1, prv: 0, dv: 0, dva: '0', oi: 0, tvl: '0' } } }));
    expect(store.getQuote(1)?.stale).toBe(false);
    ws.emit(JSON.stringify({ mt: 9000, status: 'down', t: 5 }));
    expect(store.getQuote(1)).toBeNull();

    ws.emit(JSON.stringify({ mt: 9000, status: 'up', t: 6 }));
    ws.emit(JSON.stringify({ mt: 100, sid: 5000, sn: 11, h: 11 }));
    ws.emit(JSON.stringify({ mt: 100, sid: 5000, sn: 13, h: 13 }));
    expect(events()).toContain('feed.heartbeat_gap');
    expect(ws.closedWith).not.toBeNull();
    clock.advance(1_000);
    expect(sockets).toHaveLength(2);
    feed.stop();
  });

  test('a silent socket is replaced after the stale window', () => {
    const { clock, sockets, feed } = feedSetup();
    feed.start();
    sockets[0]!.ws.open();
    clock.advance(FEED_DEFAULTS.staleAfterMs + 2_000);
    expect(sockets[0]!.ws.closedWith).not.toBeNull();
    expect(sockets.length).toBe(2);
    feed.stop();
  });
});

describe('head subscriber', () => {
  const header = (n: number, state: string, blockId = `id${n}`) =>
    JSON.stringify({
      jsonrpc: '2.0',
      method: 'eth_subscription',
      params: { subscription: '0xabc', result: { number: `0x${n.toString(16)}`, hash: `0x${'22'.repeat(32)}`, timestamp: '0x1', baseFeePerGas: '0x174876e800', blockId, commitState: state } }
    });

  test('subscribes to monadNewHeads, dedupes per (blockId, state), passes Proposed and Finalized', () => {
    const clock = new ManualClock();
    const sockets: FakeSocket[] = [];
    const heads: Head[] = [];
    const sub = new HeadSubscriber({
      url: 'wss://rpc.example/KEY',
      kind: 'monadNewHeads',
      log: captureLogger().log,
      onHead: (h) => heads.push(h),
      timers: clock.timers,
      now: clock.now,
      random: () => 0,
      createSocket: () => {
        const s = new FakeSocket();
        sockets.push(s);
        return s as unknown as WebSocket;
      }
    });
    sub.start();
    sockets[0]!.open();
    expect(JSON.parse(sockets[0]!.sent[0]!)).toMatchObject({ method: 'eth_subscribe', params: ['monadNewHeads'] });
    sockets[0]!.emit(JSON.stringify({ jsonrpc: '2.0', id: 1, result: '0xabc' }));
    sockets[0]!.emit(header(100, 'Proposed'));
    sockets[0]!.emit(header(100, 'Proposed'));
    sockets[0]!.emit(header(100, 'Voted'));
    sockets[0]!.emit(header(100, 'Finalized'));
    expect(heads.map((h) => `${h.number}:${h.commitState}`)).toEqual(['100:Proposed', '100:Voted', '100:Finalized']);
    expect(heads[0]!.baseFeePerGas).toBe(100_000_000_000n);

    // Stalled subscription: reconnect and resubscribe.
    clock.advance(HEAD_DEFAULTS.stallMs + 1_500);
    expect(sockets[0]!.closedWith).not.toBeNull();
    clock.advance(1_000);
    expect(sockets).toHaveLength(2);
    sockets[1]!.open();
    expect(JSON.parse(sockets[1]!.sent[0]!).method).toBe('eth_subscribe');
    sub.stop();
  });

  test('Proposed acts, Finalized reconciles; older proposals are ignored', async () => {
    const { chain, keeper, head } = keeperSetup();
    keeper.onHead(head(chain.head));
    keeper.onHead({ ...head(chain.head - 1n) });
    await keeper.idle();
    expect(keeper.snapshot().proposed).toBe(chain.head.toString());
    keeper.onHead({ ...head(chain.head), commitState: 'Finalized' });
    expect(keeper.snapshot().finalized).toBe(chain.head.toString());
  });
});

describe('keeper internal http', () => {
  const token = 't'.repeat(40);
  function handler(health: 'ok' | 'degraded' = 'ok') {
    const asked: number[] = [];
    let t = 0;
    const h = keeperHandler({
      token,
      log: captureLogger().log,
      health: () => ({ status: health }),
      requestSigma: (p) => (p === 1 ? (asked.push(p), true) : false),
      now: () => t
    });
    return { h, asked, tick: (ms: number) => (t += ms) };
  }
  const post = (body: unknown, auth?: string) =>
    new Request('http://127.0.0.1:3702/sigma-refresh', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(auth ? { authorization: auth } : {}) },
      body: JSON.stringify(body)
    });

  test('I-3: /healthz needs the bearer token; then 200 when ok and 503 when degraded', async () => {
    const get = (auth?: string) => new Request('http://x/healthz', { headers: auth ? { authorization: auth } : {} });
    const anon = await handler('ok').h(get());
    expect(anon.status).toBe(401);
    expect(await anon.text()).not.toContain('signer');
    expect((await handler('ok').h(get('Bearer wrong-token-wrong-token-wrong-token'))).status).toBe(401);
    expect((await handler('ok').h(get(`Bearer ${token}`))).status).toBe(200);
    expect((await handler('degraded').h(get(`Bearer ${token}`))).status).toBe(503);
  });

  test('the refresh limit is per perp, not global', async () => {
    let t = 0;
    const h = keeperHandler({ token, log: captureLogger().log, health: () => ({ status: 'ok' }), requestSigma: () => true, now: () => t });
    expect((await h(post({ perpId: 1 }, `Bearer ${token}`))).status).toBe(202);
    expect((await h(post({ perpId: 10 }, `Bearer ${token}`))).status).toBe(202);
    expect((await h(post({ perpId: 1 }, `Bearer ${token}`))).status).toBe(429);
    t += 5_000;
    expect((await h(post({ perpId: 1 }, `Bearer ${token}`))).status).toBe(202);
  });

  test('/sigma-refresh needs the bearer token, a listed perp and a valid body', async () => {
    const { h, asked, tick } = handler();
    expect((await h(post({ perpId: 1 }))).status).toBe(401);
    expect((await h(post({ perpId: 1 }, 'Bearer wrong-token-wrong-token-wrong-token'))).status).toBe(401);
    expect((await h(post({ perpId: 1, x: 1 }, `Bearer ${token}`))).status).toBe(400);
    expect((await h(post({ perpId: 1 }, `Bearer ${token}`))).status).toBe(202);
    expect((await h(post({ perpId: 1 }, `Bearer ${token}`))).status).toBe(429);
    tick(10_000);
    expect((await h(post({ perpId: 7 }, `Bearer ${token}`))).status).toBe(404);
    expect(asked).toEqual([1]);
  });
});

describe('H-1: zero-paid triggers (offchain re-check, budget, backoff)', () => {
  const STOP = 860_000;
  const params = { refTolBps: 50, armTtlBlocks: 20 };
  const armedLong: TriggerCover = {
    status: COVER_STATUS.Armed,
    isLong: true,
    stopPNS: BigInt(STOP),
    armedBlock: 100n,
    maxGapBps: 200,
    slipAllowanceBps: 5,
    floorSlackBps: 100,
    shortBlock: 0n,
    shortSteps: 0,
    refTrigPNS: 0n
  };
  const verdict = (i: ZeroPaidInput) => zeroPaidTriggerCloses(i).verdict;

  test('stillArmed mirrors the contract: book crossed (empty side counts) and the reference within tolerance', () => {
    const at = { bestBidPNS: BigInt(STOP - 100), bestAskPNS: null };
    const bounced = { bestBidPNS: BigInt(STOP + 500), bestAskPNS: null };
    const ref = (refPNS: number, nFresh = 2) => ({ refPNS: BigInt(refPNS), nFresh });
    expect(stillArmed(armedLong, at, ref(STOP), 50)).toBe(true);
    expect(stillArmed(armedLong, bounced, ref(STOP), 50)).toBe(false);
    expect(stillArmed(armedLong, { bestBidPNS: null, bestAskPNS: null }, ref(STOP), 50)).toBe(true);
    // floor(860,000 x 1.005) = 864,300: at the bound passes, one above fails; no fresh reference skips the check.
    expect(stillArmed(armedLong, at, ref(864_300), 50)).toBe(true);
    expect(stillArmed(armedLong, at, ref(864_301), 50)).toBe(false);
    expect(stillArmed(armedLong, at, ref(999_999, 0), 50)).toBe(true);
    // Short: ceil(860,000 x 0.995) = 855,700.
    const short = { isLong: false, stopPNS: BigInt(STOP) };
    expect(stillArmed(short, { bestBidPNS: null, bestAskPNS: BigInt(STOP + 1) }, ref(855_700), 50)).toBe(true);
    expect(stillArmed(short, { bestBidPNS: null, bestAskPNS: BigInt(STOP + 1) }, ref(855_699), 50)).toBe(false);
    expect(stillArmed(short, { bestBidPNS: null, bestAskPNS: BigInt(STOP - 1) }, ref(STOP), 50)).toBe(false);
  });

  test('zeroPaidTriggerCloses: disarm-only, no fill, or a close', () => {
    const base = { cover: armedLong, fast: false, venueOk: true, ref: { refPNS: BigInt(STOP), nFresh: 2 }, params, landing: 110n };
    expect(verdict({ ...base, book: { bestBidPNS: BigInt(STOP + 500), bestAskPNS: null } })).toBe('disarm_only');
    // Step 0 floor(860,000 x 0.9995) = 859,570.
    expect(zeroPaidTriggerCloses({ ...base, book: { bestBidPNS: 859_570n, bestAskPNS: null } })).toEqual({ verdict: 'closes', step: 0, limitPNS: 859_570n });
    // Below floorSlack (851,400) as well: no step can fill, so nothing is sent.
    expect(verdict({ ...base, book: { bestBidPNS: 800_000n, bestAskPNS: null } })).toBe('no_fill');
    // Venue down without the fast path: the contract disarms.
    expect(verdict({ ...base, venueOk: false, book: { bestBidPNS: 859_570n, bestAskPNS: null } })).toBe('disarm_only');
    // Arm TTL elapsed: the contract takes the fast path only with a fresh mark through the stop.
    const lazy = { ...base, landing: 121n, book: { bestBidPNS: 859_900n, bestAskPNS: null } };
    expect(verdict({ ...lazy, fast: false })).toBe('disarm_only');
    expect(verdict({ ...lazy, fast: true })).toBe('closes');
    // L-02: with the fast path the re-check is skipped, so a bounced book still closes.
    expect(verdict({ ...base, fast: true, ref: { refPNS: BigInt(STOP + 5_000), nFresh: 2 }, book: { bestBidPNS: 900_000n, bestAskPNS: null } })).toBe('closes');
  });

  test('N-01: a book between floorSlack and the step floor is walked one step per block, then closes', () => {
    const ref = { refPNS: 859_000n, nFresh: 2 };
    // 851,000 fills only at step 5 (850,410); steps 0 to 4 (858,570 ... 852,128) miss.
    const book = { bestBidPNS: 851_000n, bestAskPNS: null };
    const base = { cover: armedLong, fast: false, venueOk: true, ref, params, landing: 110n, book };
    const at = (shortBlock: bigint, shortSteps: number, landing = 110n) => zeroPaidTriggerCloses({ ...base, landing, cover: { ...armedLong, shortBlock, shortSteps } });
    expect(at(0n, 0)).toEqual({ verdict: 'step', step: 0, limitPNS: 858_570n });
    expect(at(109n, 1)).toEqual({ verdict: 'step', step: 1, limitPNS: 858_141n });
    expect(at(109n, 4)).toEqual({ verdict: 'step', step: 4, limitPNS: 852_128n });
    expect(at(109n, 5)).toEqual({ verdict: 'closes', step: 5, limitPNS: 850_410n });
    // The chain lapsed (more than 10 blocks, C7): the walk restarts at step 0.
    expect(at(100n, 4).step).toBe(4);
    expect(at(99n, 4).step).toBe(0);
    // At the last step a no-fill attempt cannot widen further: not sent.
    expect(zeroPaidTriggerCloses({ ...base, book: { bestBidPNS: 850_000n, bestAskPNS: null }, cover: { ...armedLong, shortBlock: 109n, shortSteps: 5 } }).verdict).toBe('no_fill');
    // Reference above the stop (armed within refTol): the attempt would end the chain, so no step.
    expect(verdict({ ...base, ref: { refPNS: 861_000n, nFresh: 2 } })).toBe('no_fill');
    // No fresh reference (D49): the outage floor applies at once.
    expect(verdict({ ...base, ref: { refPNS: 0n, nFresh: 0 } })).toBe('closes');
    // L-03: the cover's A decides. With A = 50 step 0 is 854,705 and a 855,000 book closes at once.
    expect(verdict({ ...base, book: { bestBidPNS: 855_000n, bestAskPNS: null }, cover: { ...armedLong, slipAllowanceBps: 50 } })).toBe('closes');
    // A lapsed arm on the fast path disarms first, which clears the chain: step 0, not 5.
    expect(zeroPaidTriggerCloses({ ...base, fast: true, landing: 121n, cover: { ...armedLong, shortBlock: 120n, shortSteps: 5 } }).step).toBe(0);
  });

  test('remainders use the stored R_trig and step only with both references through the stop', () => {
    const trig: TriggerCover = { ...armedLong, status: COVER_STATUS.Triggered, refTrigPNS: 859_000n, shortBlock: 108n, shortSteps: 5 };
    const base = { cover: trig, fast: false, venueOk: false, params, landing: 110n, book: { bestBidPNS: 855_000n, bestAskPNS: null } };
    // No re-check on a Triggered cover; step 5 from R_trig: 850,410.
    expect(zeroPaidTriggerCloses({ ...base, ref: { refPNS: 858_000n, nFresh: 2 } })).toEqual({ verdict: 'closes', step: 5, limitPNS: 850_410n });
    // Live reference back above the stop: step 0 from R_trig (858,570), the book misses and the chain would end.
    expect(verdict({ ...base, ref: { refPNS: 861_000n, nFresh: 2 } })).toBe('no_fill');
    // Chain lapsed (C7: more than 10 blocks): step 0 misses, both references through, so the remainder walks again.
    expect(verdict({ ...base, cover: { ...trig, shortBlock: 100n }, ref: { refPNS: 858_000n, nFresh: 2 } })).toBe('closes');
    expect(verdict({ ...base, cover: { ...trig, shortBlock: 99n }, ref: { refPNS: 858_000n, nFresh: 2 } })).toBe('step');
    // R_trig = 0 (outage trigger): D49 floor 834,372.
    expect(verdict({ ...base, cover: { ...trig, refTrigPNS: 0n }, ref: { refPNS: 0n, nFresh: 0 } })).toBe('closes');
  });

  test('PoC: 400 blocks of arm/bounce chop send no disarm-only trigger, and a real trigger still goes', async () => {
    const s = keeperSetup({ capWei: parseEther('1.5') });
    s.mgr.ref = { refPNS: BigInt(STOP), nFresh: 2 };
    let state: 'live' | 'armed' = 'live';
    let armedBlock = 0;
    s.chain.onSent = (tx) => {
      const fn = decodeFunctionData({ abi: ICoverManagerAbi, data: tx.data! }).functionName;
      if (fn === 'arm') {
        state = 'armed';
        armedBlock = Number(s.chain.head + 1n);
      }
      if (fn === 'trigger') state = 'live';
    };
    let disarmOnly = 0;
    for (let i = 0; i < 400; i++) {
      s.chain.setHead(s.chain.head + 1n);
      if (state === 'live') {
        s.mgr.book = { basePricePNS: 0n, maxBidPriceONS: BigInt(STOP - 100), minAskPriceONS: 0n };
        s.mgr.watch.set(1, { toArm: [A], toTrigger: [] });
        s.mgr.arm.set(A, true);
      } else {
        // Bounced above the stop: the contract would only disarm (returns 0).
        s.mgr.book = { basePricePNS: 0n, maxBidPriceONS: BigInt(STOP + 500), minAskPriceONS: 0n };
        s.mgr.covers.set(A, { status: COVER_STATUS.Armed, isLong: true, stopPNS: STOP, armer: KEEPER, armedBlock, lots: 10 });
        s.mgr.watch.set(1, { toArm: [], toTrigger: [A] });
        s.mgr.trigger.set(A, 0n);
      }
      const before = s.chain.sent.length;
      await s.keeper.cycle(s.head(s.chain.head));
      if (s.chain.sent.length > before && s.sentFns().at(-1) === 'trigger') disarmOnly++;
    }
    expect(disarmOnly).toBe(0);
    // Before the fix: 7 disarm-only triggers and 1.3158 of 1.5 MON committed; the real trigger was skipped (governor_cap).
    expect(s.governor.usage().committedWei).toBeLessThan(parseEther('0.1'));
    s.chain.setHead(s.chain.head + 10n);
    s.mgr.watch.set(1, { toArm: [], toTrigger: [B] });
    s.mgr.covers.set(B, { status: COVER_STATUS.Live, isLong: true, stopPNS: STOP, armer: KEEPER, armedBlock: 0, lots: 10 });
    s.mgr.trigger.set(B, 5_000_000n);
    const before = s.chain.sent.length;
    await s.keeper.cycle(s.head(s.chain.head));
    expect(s.chain.sent.length).toBe(before + 1);
    expect(s.sentFns().at(-1)).toBe('trigger');
  });

  test('zero-gap closes are booked outside the hot reserve, at most 10 per cover per day', async () => {
    // 10 closes bill 1.53 MON: the key must hold more than that.
    const s = keeperSetup({ capWei: parseEther('5'), zeroPaidCapWei: parseEther('3'), balance: parseEther('5') });
    s.mgr.ref = { refPNS: BigInt(STOP), nFresh: 2 };
    // Bid at the stop: the close fills with no gap, so it pays nothing.
    s.mgr.book = { basePricePNS: 0n, maxBidPriceONS: BigInt(STOP), minAskPriceONS: 0n };
    s.mgr.trigger.set(A, 0n);
    // Each landed zero-paid trigger with a Triggered event clears the backoff; the per-cover count still binds.
    s.chain.logsFor = () => [triggeredLog(A, 10n)];
    for (let i = 0; i < 12; i++) {
      s.chain.setHead(s.chain.head + 10n);
      s.mgr.covers.set(A, { status: COVER_STATUS.Armed, isLong: true, stopPNS: STOP, armer: KEEPER, armedBlock: Number(s.chain.head) - 1, lots: 10 });
      s.mgr.watch.set(1, { toArm: [], toTrigger: [A] });
      await s.keeper.cycle(s.head(s.chain.head));
    }
    expect(s.sentFns()).toEqual(Array(10).fill('trigger'));
    expect(s.governor.countToday(ZERO_PAID_TRIGGER.label, A)).toBe(10);
    expect(s.governor.countToday('trigger')).toBe(0);
  });

  test('the zero-paid sub-cap never eats the hot reserve: a paying trigger goes after it is spent', async () => {
    // Cap 1.5 MON, hot reserve 0.45, zero-paid sub-cap 0.45: one zero-paid trigger (0.4444 at max fee) fits, the next does not.
    const s = keeperSetup({ capWei: parseEther('1.5'), zeroPaidCapWei: parseEther('0.45') });
    s.mgr.ref = { refPNS: BigInt(STOP), nFresh: 2 };
    s.mgr.book = { basePricePNS: 0n, maxBidPriceONS: BigInt(STOP), minAskPriceONS: 0n };
    s.chain.logsFor = (tx) => [triggeredLog(decodeFunctionData({ abi: ICoverManagerAbi, data: tx.data! }).args![0] as `0x${string}`, 10n)];
    const ids = [coverId(30), coverId(31)];
    for (const id of ids) {
      s.mgr.trigger.set(id, 0n);
      s.mgr.covers.set(id, { status: COVER_STATUS.Armed, isLong: true, stopPNS: STOP, armer: KEEPER, armedBlock: Number(s.chain.head) - 1, lots: 10 });
    }
    s.mgr.watch.set(1, { toArm: [], toTrigger: ids });
    await s.keeper.cycle(s.head(s.chain.head));
    expect(s.sentFns()).toEqual(['trigger']);
    s.chain.setHead(s.chain.head + 5n);
    s.mgr.trigger.set(B, 5_000_000n);
    s.mgr.covers.set(B, { status: COVER_STATUS.Live, isLong: true, stopPNS: STOP, armer: KEEPER, armedBlock: 0, lots: 10 });
    s.mgr.watch.set(1, { toArm: [], toTrigger: [ids[1]!, B] });
    await s.keeper.cycle(s.head(s.chain.head));
    expect(s.sentFns()).toEqual(['trigger', 'trigger']);
    expect(decodeFunctionData({ abi: ICoverManagerAbi, data: s.chain.sent[1]!.data! }).args![0]).toBe(B);
  });

  test('a landed zero-paid trigger with no Triggered event backs the cover off exponentially', async () => {
    const s = keeperSetup({ capWei: parseEther('3'), zeroPaidCapWei: parseEther('2') });
    s.mgr.ref = { refPNS: BigInt(STOP), nFresh: 2 };
    s.mgr.book = { basePricePNS: 0n, maxBidPriceONS: BigInt(STOP - 100), minAskPriceONS: 0n };
    s.mgr.trigger.set(A, 0n);
    s.chain.logsFor = () => [managerLog('TriggerNoFill', { coverId: A })];
    const sentAt: bigint[] = [];
    for (let i = 0; i < 40; i++) {
      s.chain.setHead(s.chain.head + 1n);
      s.mgr.covers.set(A, { status: COVER_STATUS.Armed, isLong: true, stopPNS: STOP, armer: KEEPER, armedBlock: Number(s.chain.head) - 1, lots: 10 });
      s.mgr.watch.set(1, { toArm: [], toTrigger: [A] });
      const before = s.chain.sent.length;
      await s.keeper.cycle(s.head(s.chain.head));
      if (s.chain.sent.length > before) sentAt.push(s.chain.head);
    }
    // A close that lands as TriggerNoFill is not a step, so it backs off 8, then 16 blocks; after the first
    // (SE2-L4) the retries go at the step limit and are not walk steps.
    expect(sentAt).toHaveLength(3);
    expect(s.events()).toContain('keeper.noop_receipt');
    expect(s.events()).toContain('keeper.phantom_top');
    expect(sentAt[1]! - sentAt[0]!).toBeGreaterThanOrEqual(8n);
    expect(sentAt[2]! - sentAt[1]!).toBeGreaterThanOrEqual(16n);
    expect(s.chain.sent.map((t) => t.gas)).toEqual([GAS.trigger, GAS.triggerStep, GAS.triggerStep]);
  });

  test('re-arms of the same cover in a day are booked outside the hot reserve', async () => {
    // Cap 0.55 MON, hot reserve 0.43: non-exempt sends stop at 0.12 MON (two 0.06 arms at max fee).
    const s = keeperSetup({ capWei: parseEther('0.55'), zeroPaidCapWei: 0n });
    s.mgr.arm.set(A, true);
    s.mgr.covers.set(A, LIVE_B);
    for (let i = 0; i < 6; i++) {
      s.chain.setHead(s.chain.head + 210n);
      s.mgr.watch.set(1, { toArm: [A], toTrigger: [] });
      await s.keeper.cycle(s.head(s.chain.head));
    }
    expect(s.governor.countToday('arm', A)).toBe(1);
    expect(s.governor.countToday(REPEAT_ARM_LABEL, A)).toBeLessThanOrEqual(2);
    // The hot reserve is intact for a paying trigger.
    s.chain.setHead(s.chain.head + 5n);
    s.mgr.watch.set(1, { toArm: [], toTrigger: [B] });
    s.mgr.covers.set(B, { status: COVER_STATUS.Live, isLong: true, stopPNS: STOP, armer: KEEPER, armedBlock: 0, lots: 10 });
    s.mgr.trigger.set(B, 5_000_000n);
    await s.keeper.cycle(s.head(s.chain.head));
    expect(s.sentFns().at(-1)).toBe('trigger');
  });

  test('coverEvents decodes manager logs for one cover only', () => {
    const logs = [managerLog('Disarmed', { coverId: A }), managerLog('Triggered', { coverId: B, perpId: 1n })];
    const typed = logs.map((l) => ({ address: l.address as `0x${string}`, topics: l.topics as `0x${string}`[], data: l.data as `0x${string}` }));
    expect([...coverEvents(typed, MANAGER, A)]).toEqual(['Disarmed']);
    expect([...coverEvents(typed, MANAGER, B)]).toEqual(['Triggered']);
  });

  test('BlockBackoff doubles from 8 blocks up to the cap and clears', () => {
    const b = new BlockBackoff(8n, 600n);
    expect(b.bump('k', 100n)).toBe(108n);
    expect(b.blocked('k', 107n)).toBe(true);
    expect(b.blocked('k', 108n)).toBe(false);
    expect(b.bump('k', 108n)).toBe(124n);
    for (let i = 0; i < 10; i++) b.bump('k', 200n);
    expect(b.bump('k', 1_000n)).toBe(1_600n);
    b.clear('k');
    expect(b.blocked('k', 1_000n)).toBe(false);
  });
});

describe('M-2: many gapped covers below 10 MON', () => {
  test('PoC: 8 paying triggers from the 5 MON canary key go out within a few blocks (was 29)', async () => {
    const s = keeperSetup({ capWei: parseEther('5'), balance: parseEther('5') });
    const ids = Array.from({ length: 8 }, (_, i) => coverId(100 + i));
    for (const id of ids) {
      s.mgr.covers.set(id, { status: COVER_STATUS.Live, isLong: true, stopPNS: 860_000, armer: KEEPER, armedBlock: 0, lots: 10 });
      s.mgr.trigger.set(id, 1_000n);
    }
    const done = new Set<string>();
    s.chain.onSent = (tx) => done.add(String(decodeFunctionData({ abi: ICoverManagerAbi, data: tx.data! }).args![0]));
    let blocks = 0;
    while (done.size < ids.length && blocks < 200) {
      s.chain.setHead(s.chain.head + 1n);
      blocks++;
      s.mgr.watch.set(1, { toArm: [], toTrigger: ids.filter((id) => !done.has(id)) });
      await s.keeper.cycle(s.head(s.chain.head));
    }
    // 0.4242 MON reserved per trigger against min(10 MON, balance), the balance falling 0.2142 per landed trigger.
    expect(done.size).toBe(8);
    expect(blocks).toBeLessThanOrEqual(10);
  });
});

describe('M-4: deferred finalize', () => {
  test('PoC: owed > 0 and a simulation of 0 is never sent (was 18 sends, 1.1 MON in 200 blocks)', async () => {
    const s = keeperSetup({ capWei: parseEther('1.5') });
    const F = coverId(9);
    s.mgr.covers.set(F, { status: COVER_STATUS.Triggered, isLong: true, stopPNS: 860_000, armer: KEEPER, armedBlock: 0, lots: 10, owedCNS: 5_000 });
    s.mgr.finalize.set(F, 0n);
    for (let i = 0; i < 200; i++) {
      s.chain.setHead(s.chain.head + 1n);
      s.mgr.hk.set(1, { toObserve: [], toFinalize: [F], toExpire: [], toVoid: [] });
      await s.keeper.cycle(s.head(s.chain.head));
    }
    expect(s.chain.sent).toHaveLength(0);
    expect(s.governor.usage().committedWei).toBe(0n);
    // Backoff also spares the simulations: far fewer than one per block.
    expect(s.mgr.calls.filter((c) => c === 'finalize').length).toBeLessThan(15);
  });

  test('a finalize with nothing owed goes; one that lands without Finalized backs off', async () => {
    const s = keeperSetup({ capWei: parseEther('1.5') });
    const F = coverId(9);
    s.mgr.covers.set(F, { status: COVER_STATUS.Triggered, isLong: true, stopPNS: 860_000, armer: KEEPER, armedBlock: 0, lots: 10 });
    s.mgr.hk.set(1, { toObserve: [], toFinalize: [F], toExpire: [], toVoid: [] });
    await s.keeper.cycle(s.head(s.chain.head));
    expect(s.sentFns()).toEqual(['finalize']);
    for (let i = 0; i < 6; i++) {
      s.chain.setHead(s.chain.head + 1n);
      await s.keeper.cycle(s.head(s.chain.head));
    }
    expect(s.sentFns()).toEqual(['finalize']);
    expect(s.events()).toContain('keeper.noop_receipt');
    // With the Finalized event the backoff clears.
    s.chain.logsFor = () => [managerLog('Finalized', { coverId: F })];
    s.chain.setHead(s.chain.head + 20n);
    await s.keeper.cycle(s.head(s.chain.head));
    expect(s.sentFns()).toEqual(['finalize', 'finalize']);
  });
});

describe('L-2: implausible heads', () => {
  test('PoC: a far-future head is rejected and later real heads still cycle', async () => {
    const { keeper, head, events } = keeperSetup();
    keeper.observeRpcHead(100_000n);
    expect(keeper.onHead(head(2n ** 60n))).toBe(false);
    await keeper.idle();
    const before = keeper.snapshot().cycles;
    for (let i = 1n; i <= 50n; i++) expect(keeper.onHead(head(100_000n + i))).toBe(true);
    await keeper.idle();
    expect(keeper.snapshot().cycles - before).toBeGreaterThan(0);
    expect(keeper.snapshot().proposed).toBe('100050');
    expect(keeper.snapshot().rejectedHeads).toBe(1);
    expect(events()).toContain('keeper.head_rejected');
    // Finalized heads get the same bound.
    expect(keeper.onHead({ ...head(2n ** 59n), commitState: 'Finalized' })).toBe(false);
  });

  test('a bogus head accepted before the first RPC poll is dropped once the poll arrives', async () => {
    const { keeper, head } = keeperSetup();
    keeper.onHead(head(2n ** 60n));
    await keeper.idle();
    keeper.observeRpcHead(100_000n);
    expect(keeper.onHead(head(100_001n))).toBe(true);
    await keeper.idle();
    expect(keeper.snapshot().proposed).toBe('100001');
  });

  test('a normal jump after an outage within the bound is accepted', () => {
    const { keeper, head } = keeperSetup();
    keeper.observeRpcHead(100_000n);
    expect(keeper.onHead(head(100_000n + MAX_HEAD_AHEAD_BLOCKS))).toBe(true);
  });
});

describe('M-5 and SE2-M3: sigma posts follow quote demand only', () => {
  test('posts stop at the daily cap, legacy refresh-only rows included', async () => {
    const { series, logs } = syntheticMarks(52_000n, 99_990n);
    const clock = { t: 1_000_000 };
    const s = keeperSetup({ store: freshStore(() => clock.t, series.price.at(-1)!), logs, clock });
    for (let i = 0; i < SIGMA_POLICY.maxPostsPerDay; i++) {
      const r = s.governor.reserve({ action: i % 2 === 0 ? SIGMA_POLICY.postLabel : SIGMA_POLICY.legacyRefreshLabel, amountWei: 1n, exempt: false });
      if (r.ok) s.governor.settle(r.id, 1n);
    }
    s.keeper.requestSigma(1);
    await s.sigmaCycle(s.head(s.chain.head));
    expect(s.sentFns()).toEqual([]);
    expect(s.keeper.snapshot().sigma['1']?.decision).toBe('daily_cap');
  });

  test('PoC: a cover live all day with no quote requests posts nothing (was 55 posts, 0.45 MON)', async () => {
    const blocksPerDay = (86_400n * 1000n) / 294n;
    let posted = 0n;
    let n = 0;
    for (let head = 1n; head <= blocksPerDay; head += 100n) {
      const d = decideSigmaPost({ estimateE2: 30, onchainE2: 30, postedBlock: posted, head, maxAgeBlocks: 6_000, quoteRequested: false });
      if (d.post) {
        posted = head;
        n++;
      }
    }
    expect(n).toBe(0);
    // Keeper cycle: live covers and a stale onchain sigma, no request: no read, no post.
    const { series, logs } = syntheticMarks(52_000n, 99_990n);
    const clock = { t: 1_000_000 };
    const s = keeperSetup({ store: freshStore(() => clock.t, series.price.at(-1)!), logs, clock });
    s.mgr.live = 3n;
    for (let i = 0; i < 300; i++) {
      s.chain.setHead(s.chain.head + 100n);
      await s.keeper.cycle(s.head(s.chain.head));
    }
    expect(s.sentFns()).toEqual([]);
    expect(s.mgr.calls).not.toContain('sigmaOf');
    // A quote request then posts once, under the capped label.
    s.keeper.requestSigma(1);
    await s.sigmaCycle(s.head(s.chain.head));
    expect(s.sentFns()).toEqual(['postSigma']);
    expect(s.governor.countToday(SIGMA_POLICY.postLabel)).toBe(1);
  });
});

describe('C4 contract changes (keeper cycle)', () => {
  const STOP = 860_000;

  test('L-02: a fast-path trigger goes inside another armer window; a window reaching expiry never binds', async () => {
    const s = keeperSetup();
    s.mgr.watch.set(1, { toArm: [], toTrigger: [A] });
    s.mgr.covers.set(A, { status: COVER_STATUS.Armed, isLong: true, stopPNS: STOP, armer: OTHER, armedBlock: Number(s.chain.head) - 1, lots: 10 });
    s.mgr.trigger.set(A, 5_000n);
    s.mgr.markPNS = BigInt(STOP + 1);
    await s.keeper.cycle(s.head(s.chain.head));
    expect(s.sentFns()).toEqual([]);
    // Fresh mark at the stop: open to anyone.
    s.mgr.markPNS = BigInt(STOP);
    await s.keeper.cycle(s.head(s.chain.head));
    expect(s.sentFns()).toEqual(['trigger']);

    const t = keeperSetup();
    const armedBlock = Number(t.chain.head) - 1;
    t.mgr.watch.set(1, { toArm: [], toTrigger: [B] });
    t.mgr.covers.set(B, { status: COVER_STATUS.Armed, isLong: true, stopPNS: STOP, armer: OTHER, armedBlock, lots: 10, expiryBlock: armedBlock + 3 });
    t.mgr.trigger.set(B, 5_000n);
    await t.keeper.cycle(t.head(t.chain.head));
    expect(t.sentFns()).toEqual(['trigger']);
  });

  test('N-01: the keeper walks 5 no-fill steps at the step gas, each from the previous receipt, then the step-5 close pays', async () => {
    const s = keeperSetup({ capWei: parseEther('3') });
    s.chain.advanceOnSend = true;
    s.mgr.ref = { refPNS: 859_000n, nFresh: 2 };
    // Fills only at floorSlack (850,410).
    s.mgr.book = { basePricePNS: 0n, maxBidPriceONS: 851_000n, minAskPriceONS: 0n };
    const cover = { status: COVER_STATUS.Armed, isLong: true, stopPNS: STOP, armer: KEEPER, armedBlock: Number(s.chain.head) - 1, lots: 10 };
    let chain = { shortBlock: 0, shortSteps: 0 };
    s.mgr.covers.set(A, cover);
    s.mgr.watch.set(1, { toArm: [], toTrigger: [A] });
    s.mgr.trigger.set(A, 0n);
    s.chain.logsFor = () => [managerLog('TriggerNoFill', { coverId: A })];
    // Contract _chain: a short attempt with R through extends the chain by one step per block.
    s.chain.onSent = () => {
      chain = { shortBlock: Number(s.chain.head + 1n), shortSteps: Math.min(chain.shortSteps + 1, 6) };
      s.mgr.covers.set(A, { ...cover, ...chain });
      if (chain.shortSteps === 5) {
        s.mgr.trigger.set(A, 40_000n);
        s.chain.logsFor = () => [triggeredLog(A, 10n, 40_000n)];
      }
    };
    for (let i = 0; i < 8; i++) {
      await s.keeper.cycle(s.head(s.chain.head));
      s.chain.setHead(s.chain.head + 1n);
      if (s.mgr.trigger.get(A) === 40_000n && s.chain.sent.length === 6) s.mgr.watch.set(1, { toArm: [], toTrigger: [] });
    }
    expect(s.sentFns()).toEqual(Array(6).fill('trigger'));
    expect(s.chain.sent.map((t) => t.gas)).toEqual([...Array(5).fill(GAS.triggerStep), GAS.trigger]);
    expect(s.events().filter((e) => e === 'keeper.trigger_step')).toHaveLength(5);
    expect(s.events()).not.toContain('keeper.noop_receipt');
    expect(s.governor.countToday(ZERO_PAID_TRIGGER.label, A)).toBe(5);
    expect(s.governor.countToday('trigger', A)).toBe(1);
  });

  test('N-01: a step that runs out of the step gas falls back to the full trigger limit, loudly and from then on', async () => {
    const s = keeperSetup({ capWei: parseEther('3'), zeroPaidCapWei: parseEther('1') });
    // Between GAS.triggerStep (1.1M) and GAS.trigger (2.2M).
    s.mgr.triggerMinGas = 1_500_000n;
    s.mgr.ref = { refPNS: 859_000n, nFresh: 2 };
    s.mgr.book = { basePricePNS: 0n, maxBidPriceONS: 851_000n, minAskPriceONS: 0n };
    const cover = { status: COVER_STATUS.Armed, isLong: true, stopPNS: STOP, armer: KEEPER, armedBlock: Number(s.chain.head) - 1, lots: 10 };
    let steps = 0;
    s.mgr.covers.set(A, cover);
    s.mgr.watch.set(1, { toArm: [], toTrigger: [A] });
    s.mgr.trigger.set(A, 0n);
    s.chain.logsFor = () => [managerLog('TriggerNoFill', { coverId: A })];
    s.chain.onSent = () => {
      steps++;
      s.mgr.covers.set(A, { ...cover, shortBlock: Number(s.chain.head + 1n), shortSteps: steps });
    };
    await s.keeper.cycle(s.head(s.chain.head));
    s.chain.setHead(s.chain.head + 1n);
    await s.keeper.cycle(s.head(s.chain.head));
    expect(s.chain.sent.map((t) => t.gas)).toEqual([GAS.trigger, GAS.trigger]);
    expect(s.events().filter((e) => e === 'keeper.step_gas_low')).toHaveLength(1);
  });

  test('N-01: no step while the reference is above the stop or the per-cover count is spent', async () => {
    const s = keeperSetup({ capWei: parseEther('3') });
    s.mgr.ref = { refPNS: 861_000n, nFresh: 2 };
    s.mgr.book = { basePricePNS: 0n, maxBidPriceONS: 851_000n, minAskPriceONS: 0n };
    s.mgr.covers.set(A, { status: COVER_STATUS.Armed, isLong: true, stopPNS: STOP, armer: KEEPER, armedBlock: Number(s.chain.head) - 1, lots: 10 });
    s.mgr.watch.set(1, { toArm: [], toTrigger: [A] });
    s.mgr.trigger.set(A, 0n);
    await s.keeper.cycle(s.head(s.chain.head));
    expect(s.sentFns()).toEqual([]);
  });

  test('L-07: zero-paid remainder closes go back to back as trigger_remainder, up to ceil(lots / maxMatchesClose) + 1', async () => {
    const s = keeperSetup({ capWei: parseEther('3'), balance: parseEther('5') });
    s.chain.advanceOnSend = true;
    const lots = 30;
    let filled = 8;
    const head0 = Number(s.chain.head);
    const cover = () => ({
      status: COVER_STATUS.Triggered,
      isLong: true,
      stopPNS: STOP,
      armer: KEEPER,
      armedBlock: head0 - 2,
      lots,
      filledLots: filled,
      triggerBlock: head0 - 1,
      refTrigPNS: 859_000,
      shortBlock: head0 - 1
    });
    s.mgr.ref = { refPNS: 858_000n, nFresh: 2 };
    // Dust bids at the stop: each call fills 8 lots (maxMatchesClose) at zero gap, so paidNow is 0.
    s.mgr.book = { basePricePNS: 0n, maxBidPriceONS: BigInt(STOP), minAskPriceONS: 0n };
    s.mgr.trigger.set(A, 0n);
    s.chain.logsFor = () => [triggeredLog(A, BigInt(Math.min(8, lots - filled)))];
    s.chain.onSent = () => {
      filled = Math.min(lots, filled + 8);
      s.mgr.covers.set(A, { ...cover(), shortBlock: Number(s.chain.head + 1n) });
    };
    const cycles: number[] = [];
    for (let i = 0; i < 8; i++) {
      s.mgr.covers.set(A, { ...cover(), shortBlock: s.mgr.covers.get(A)?.shortBlock ?? head0 - 1 });
      s.mgr.watch.set(1, { toArm: [], toTrigger: filled < lots ? [A] : [] });
      const before = s.chain.sent.length;
      await s.keeper.cycle(s.head(s.chain.head));
      cycles.push(s.chain.sent.length - before);
      s.chain.setHead(s.chain.head + 1n);
    }
    expect(filled).toBe(lots);
    // SE2-H1: the first head sends all three, each from the previous receipt (consecutive blocks).
    expect(cycles[0]).toBe(3);
    expect(s.chain.sent.map((t) => t.sentAtHead)).toEqual([BigInt(head0), BigInt(head0 + 1), BigInt(head0 + 2)]);
    expect(s.governor.countToday(REMAINDER_TRIGGER_LABEL, A)).toBe(3);
  });

  test('L-07: the remainder count binds when fills stop making progress', async () => {
    const s = keeperSetup({ capWei: parseEther('5') });
    s.mgr.ref = { refPNS: 858_000n, nFresh: 2 };
    s.mgr.book = { basePricePNS: 0n, maxBidPriceONS: BigInt(STOP), minAskPriceONS: 0n };
    s.mgr.trigger.set(A, 0n);
    s.chain.advanceOnSend = true;
    s.chain.logsFor = () => [triggeredLog(A, 0n)];
    let short = Number(s.chain.head) - 1;
    const triggerBlock = short;
    s.chain.onSent = () => (short = Number(s.chain.head + 1n));
    for (let i = 0; i < 40; i++) {
      s.mgr.covers.set(A, { status: COVER_STATUS.Triggered, isLong: true, stopPNS: STOP, armer: KEEPER, armedBlock: 1, lots: 32, filledLots: 16, refTrigPNS: 859_000, shortBlock: short, triggerBlock });
      s.mgr.watch.set(1, { toArm: [], toTrigger: [A] });
      await s.keeper.cycle(s.head(s.chain.head));
      s.chain.setHead(s.chain.head + 1n);
    }
    // ceil(32 / 8) + 1 = 5 per cover per day.
    expect(s.governor.countToday(REMAINDER_TRIGGER_LABEL, A)).toBe(5);
  });

  test('L-05: a deferred finalize past the window goes once to release the reservation above paid + owed', async () => {
    const s = keeperSetup({ capWei: parseEther('1.5') });
    const F = coverId(9);
    const base = { status: COVER_STATUS.Triggered, isLong: true, stopPNS: STOP, armer: KEEPER, armedBlock: 0, lots: 10, filledLots: 10, owedCNS: 5_000, paidCNS: 20_000 };
    s.mgr.covers.set(F, { ...base, capCNS: 100_000, triggerBlock: Number(s.chain.head) - 100 });
    s.mgr.finalize.set(F, 0n);
    s.chain.onSent = () => s.mgr.covers.set(F, { ...base, capCNS: 25_000, triggerBlock: Number(s.chain.head) - 100 });
    for (let i = 0; i < 30; i++) {
      s.mgr.hk.set(1, { toObserve: [], toFinalize: [F], toExpire: [], toVoid: [] });
      await s.keeper.cycle(s.head(s.chain.head));
      s.chain.setHead(s.chain.head + 1n);
    }
    expect(s.sentFns()).toEqual(['finalize']);
    expect(s.events()).toContain('keeper.finalize_release');
    expect(s.events()).not.toContain('keeper.noop_receipt');
  });

  test('L-05: inside the window a deferred finalize waits even with excess reserved', async () => {
    const s = keeperSetup({ capWei: parseEther('1.5') });
    const F = coverId(9);
    s.mgr.covers.set(F, { status: COVER_STATUS.Triggered, isLong: true, stopPNS: STOP, armer: KEEPER, armedBlock: 0, lots: 10, owedCNS: 5_000, capCNS: 100_000, triggerBlock: Number(s.chain.head) - 5 });
    s.mgr.finalize.set(F, 0n);
    s.mgr.hk.set(1, { toObserve: [], toFinalize: [F], toExpire: [], toVoid: [] });
    await s.keeper.cycle(s.head(s.chain.head));
    expect(s.sentFns()).toEqual([]);
  });

  test('I-02: a paused market drops sigma posts but keeps every cover lifecycle call', async () => {
    const { series, logs } = syntheticMarks(52_000n, 99_990n);
    const clock = { t: 1_000_000 };
    const s = keeperSetup({ store: freshStore(() => clock.t, series.price.at(-1)!), logs, clock });
    s.mgr.live = 0n;
    s.mgr.marketPaused.add(1);
    s.keeper.requestSigma(1);
    await s.sigmaCycle(s.head(s.chain.head));
    expect(s.sentFns()).toEqual([]);
    expect(s.keeper.snapshot().sigma['1']?.decision).toBe('buys_paused');

    // Global pause with live covers: no quote can read sigma (SE2-M3), so no post; triggers still go.
    s.mgr.marketPaused.clear();
    s.mgr.paused = true;
    s.mgr.live = 1n;
    s.keeper.requestSigma(1);
    s.chain.setHead(s.chain.head + 1n);
    await s.keeper.cycle(s.head(s.chain.head));
    expect(s.sentFns()).toEqual([]);
    expect(s.keeper.snapshot().sigma['1']?.decision).toBe('buys_paused');
    s.mgr.paused = false;
    s.keeper.requestSigma(1);
    s.chain.setHead(s.chain.head + 1n);
    await s.keeper.cycle(s.head(s.chain.head));
    expect(s.sentFns()).toEqual(['postSigma']);
    s.mgr.paused = true;
    s.mgr.marketPaused.add(1);
    s.mgr.covers.set(A, { status: COVER_STATUS.Live, isLong: true, stopPNS: STOP, armer: KEEPER, armedBlock: 0, lots: 10 });
    s.mgr.watch.set(1, { toArm: [], toTrigger: [A] });
    s.mgr.trigger.set(A, 5_000n);
    s.chain.setHead(s.chain.head + 1n);
    await s.keeper.cycle(s.head(s.chain.head));
    expect(s.sentFns()).toEqual(['postSigma', 'trigger']);
  });

  test('a trigger reverting without a decoded error (possible out of gas) is logged loudly', async () => {
    const s = keeperSetup();
    s.mgr.watch.set(1, { toArm: [], toTrigger: [A] });
    s.mgr.covers.set(A, { status: COVER_STATUS.Live, isLong: true, stopPNS: STOP, armer: KEEPER, armedBlock: 0, lots: 10 });
    s.mgr.trigger.set(A, 'revert_raw');
    await s.keeper.cycle(s.head(s.chain.head));
    expect(s.sentFns()).toEqual([]);
    expect(s.events()).toContain('keeper.trigger_undecoded_revert');
  });
});

describe('C5 contract changes (keeper cycle)', () => {
  const STOP = 860_000;

  test('L-03: the deferred-finalize release uses the cover window, not the market window', async () => {
    const s = keeperSetup({ capWei: parseEther('1.5') });
    const F = coverId(9);
    // Market window 40 would still be open at triggerBlock + 15; the cover bought with window 10 is past it.
    const c = { status: COVER_STATUS.Triggered, isLong: true, stopPNS: STOP, armer: KEEPER, armedBlock: 0, lots: 10, filledLots: 10, owedCNS: 5_000, paidCNS: 20_000, capCNS: 100_000, windowBlocks: 10 };
    s.mgr.covers.set(F, { ...c, triggerBlock: Number(s.chain.head) - 15 });
    s.mgr.finalize.set(F, 0n);
    s.mgr.hk.set(1, { toObserve: [], toFinalize: [F], toExpire: [], toVoid: [] });
    await s.keeper.cycle(s.head(s.chain.head));
    expect(s.sentFns()).toEqual(['finalize']);
    expect(s.events()).toContain('keeper.finalize_release');
  });

  test('SA2 go-condition 3: expire goes in the first head it is listed, even behind a finalize backlog', async () => {
    const s = keeperSetup({ capWei: parseEther('1.5') });
    const fin = Array.from({ length: 6 }, (_, i) => coverId(40 + i));
    for (const id of fin) {
      s.mgr.covers.set(id, { status: COVER_STATUS.Triggered, isLong: true, stopPNS: STOP, armer: KEEPER, armedBlock: 0, lots: 10, filledLots: 10, triggerBlock: Number(s.chain.head) - 100 });
      s.mgr.finalize.set(id, 1n);
    }
    const E = coverId(70);
    s.mgr.hk.set(1, { toObserve: [], toFinalize: fin, toExpire: [E], toVoid: [] });
    await s.keeper.cycle(s.head(s.chain.head));
    expect(s.sentFns()).toEqual(['finalize', 'expire', 'finalize', 'finalize']);
    expect(decodeFunctionData({ abi: ICoverManagerAbi, data: s.chain.sent[1]!.data! }).args![0]).toBe(E);
  });

  test('L-03: the fast path inside another armer window needs the cover warm-up to have passed', async () => {
    const s = keeperSetup();
    const head = Number(s.chain.head);
    s.mgr.watch.set(1, { toArm: [], toTrigger: [A] });
    s.mgr.covers.set(A, { status: COVER_STATUS.Armed, isLong: true, stopPNS: STOP, armer: OTHER, armedBlock: head - 1, lots: 10, startBlock: head - 100, warmupBlocks: 500 });
    s.mgr.trigger.set(A, 5_000n);
    s.mgr.markPNS = BigInt(STOP);
    await s.keeper.cycle(s.head(s.chain.head));
    expect(s.sentFns()).toEqual([]);
    s.mgr.covers.set(A, { status: COVER_STATUS.Armed, isLong: true, stopPNS: STOP, armer: OTHER, armedBlock: head - 1, lots: 10, startBlock: head - 100, warmupBlocks: 100 });
    await s.keeper.cycle(s.head(s.chain.head));
    expect(s.sentFns()).toEqual(['trigger']);
  });
});
