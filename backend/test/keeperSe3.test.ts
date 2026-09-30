// SE3 and SA4 keeper regressions, ported from the audit PoCs (/tmp/se3) onto the C7 model (real Keeper, SendQueue,
// SpendGovernor; canary listing maxMatchesClose 8).
import { describe, expect, test } from 'bun:test';
import { decodeFunctionData, formatEther, parseEther, parseGwei, parseTransaction, RpcRequestError, type Hex } from 'viem';
import { ICoverManagerAbi } from '../src/abi/index.ts';
import { COVER_STATUS, STEP_MAX_GAP_BLOCKS } from '../src/keeper/actions.ts';
import { CHAIN_GAP_ALERT_BLOCKS, REPEAT_ARM_LABEL, ZERO_PAID_TRIGGER } from '../src/keeper/keeper.ts';
import { KEEPER_MIGRATIONS } from '../src/keeper/migrations.ts';
import { migrate, openDb } from '../src/lib/db.ts';
import { DESIGN_BASE_FEE_WEI, feeQuote, GAS, MAX_MATCHES_CLOSE_SUPPORTED, triggerGasFor } from '../src/lib/gas.ts';
import { SpendGovernor } from '../src/lib/spendGovernor.ts';
import { captureLogger } from './fakeChain.ts';
import { armedCover, CANARY_BUDGET, KEEPER, landingGaps, modelHarness, type HarnessOptions, type Level, type MCover } from './coverModel.ts';
import { coverId } from './fakeGapless.ts';

const A = coverId(1);
const B = coverId(2);
const R = 859_000n;
// Liquidity only at 851,000: inside step 5 (850,410), outside step 4.
const oneLot = (n = 30): Level[] => Array.from({ length: n }, () => ({ price: 851_000n, lots: 1n, fillable: true }));
const deep = (): Level[] => [{ price: 851_000n, lots: 1_000n, fillable: true }];
type Harness = ReturnType<typeof modelHarness>;
type Hk = { toObserve: Hex[]; toFinalize: Hex[]; toExpire: Hex[]; toVoid: Hex[] };

/** Contract housekeeping and observe(): listed and true while block in (triggerBlock, triggerBlock + window]. */
function observeWindows(h: Harness, ids: readonly Hex[]) {
  const observedAt = new Map<Hex, bigint>();
  const due = () =>
    [...h.model.covers.values()]
      .filter((c) => c.status === COVER_STATUS.Triggered && !observedAt.has(c.id) && h.chain.head > c.triggerBlock && h.chain.head <= c.triggerBlock + c.window)
      .map((c) => c.id);
  h.mgr.hk = new (class extends Map<number, Hk> {
    override get(): Hk {
      return { toObserve: due(), toFinalize: [], toExpire: [], toVoid: [] };
    }
  })();
  const inner = h.chain.request.bind(h.chain);
  h.chain.request = async (a: { method: string; params?: unknown[] }) => {
    const open = due();
    for (const id of ids) h.mgr.observe.set(id, open.includes(id) ? true : 'revert');
    const out = await inner(a);
    if (a.method === 'eth_sendRawTransactionSync') {
      const { functionName, args } = decodeFunctionData({ abi: ICoverManagerAbi, data: parseTransaction(a.params![0] as Hex).data! });
      if (functionName === 'observe') observedAt.set(args![0] as Hex, h.chain.head);
    }
    return out;
  };
  return observedAt;
}

describe('SE3-M1: lane reads at the receipt block', () => {
  /** A read node that sees each block `lagMs` late: `latest` answers the pre-send state, a newer block number errors. */
  function lagging(h: Harness, rpcMs: number, lagMs: number) {
    let snap: { covers: Map<Hex, MCover>; bids: Level[] } | null = null;
    let landed = 0n;
    const counts = { stale: 0, refused: 0 };
    const inner = h.chain.request.bind(h.chain);
    h.chain.request = async (a: { method: string; params?: unknown[] }) => {
      if (a.method === 'eth_sendRawTransactionSync') {
        snap = { covers: new Map([...h.model.covers].map(([k, v]) => [k, { ...v }])), bids: h.model.bids.map((b) => ({ ...b })) };
        const out = await inner(a);
        landed = h.chain.head;
        return out;
      }
      if (a.method === 'eth_call' && snap) {
        const tip = BigInt(Math.floor((h.now() + rpcMs / 2 - lagMs) / h.blockMs));
        if (tip < landed) {
          const tag = a.params?.[1];
          if (typeof tag === 'string' && tag.startsWith('0x') && BigInt(tag) > tip) {
            counts.refused++;
            await h.advance(rpcMs);
            throw new RpcRequestError({ body: {}, error: { code: -32000, message: 'header not found' }, url: 'http://lag.local' });
          }
          counts.stale++;
          const live = { covers: h.model.covers, bids: h.model.bids };
          h.model.covers = snap.covers;
          h.model.bids = snap.bids;
          try {
            return await inner(a);
          } finally {
            h.model.covers = live.covers;
            h.model.bids = live.bids;
          }
        }
      }
      return inner(a);
    };
    return counts;
  }

  // PoC (one block of read lag): gaps 3/5/9 at 60/150/300 ms and every attempt fell back to the cycle path.
  for (const [rpcMs, maxGap] of [
    [60, 2n],
    [150, 3n],
    [300, 4n]
  ] as const) {
    test(`PoC ${rpcMs} ms per call, read node one block behind: the walk stays in the lane, gaps <= ${maxGap}`, async () => {
      const h = modelHarness({ rtt: { rpcMs } });
      h.model.R = R;
      h.model.bids = oneLot();
      h.model.covers.set(A, armedCover(A, h.chain.head));
      lagging(h, rpcMs, h.blockMs);
      for (let i = 0; i < 60 && h.model.covers.get(A)!.filled < 22n; i++) await h.cycle();
      expect(h.model.covers.get(A)!.filled).toBe(22n);
      expect(h.model.attempts.map((a) => a.k)).toEqual([0, 1, 2, 3, 4, 5, 5, 5]);
      expect(landingGaps(h.model.attempts, A).every((g) => g <= maxGap)).toBe(true);
      const paths = h.lines.filter((l) => String(l.msg).startsWith('keeper.chain_gap')).map((l) => l.path);
      expect(paths.length).toBe(7);
      expect(paths.every((p) => p === 'lane')).toBe(true);
      expect(h.lines.some((l) => l.msg === 'keeper.lane_read_failed')).toBe(false);
    });
  }
});

describe('SE3-M2: lane fairness (other covers served between lane attempts)', () => {
  // The PoC's budgets: three worst-case walks are more than the canary's two-close day.
  const opts = (rpcMs: number): HarnessOptions => ({ rtt: { rpcMs }, cap: '9', zero: '3', balance: '10' });

  async function starve(nCovers: number, rpcMs: number) {
    const h = modelHarness(opts(rpcMs));
    h.model.R = R;
    h.model.bids = deep();
    const ids = Array.from({ length: nCovers }, (_, i) => coverId(100 + i));
    for (const id of ids) h.model.covers.set(id, armedCover(id, h.chain.head));
    const observedAt = observeWindows(h, ids);
    for (let i = 0; i < 150; i++) await h.cycle();
    const first = h.model.attempts[0]!.block;
    return {
      h,
      covers: ids.map((id) => ({
        filled: h.model.covers.get(id)!.filled,
        delay: (h.model.attempts.find((a) => a.id === id)?.block ?? first + 1_000n) - first,
        observeLag: (observedAt.get(id) ?? 1_000_000n) - h.model.covers.get(id)!.triggerBlock,
        gaps: landingGaps(h.model.attempts, id)
      }))
    };
  }

  // PoC: observe lag [19,6], [34,21,8], [34,9], [MISSED,34,9]; first attempts [0,15], [0,15,30], [0,28], [0,28,56].
  for (const [n, rpcMs] of [
    [2, 150],
    [3, 150],
    [2, 300],
    [3, 300]
  ] as const) {
    test(`PoC ${n} covers at ${rpcMs} ms per call: every observe inside its 40-block window, every walk closes within the gap rule`, async () => {
      const { covers } = await starve(n, rpcMs);
      for (const c of covers) {
        expect(c.filled).toBe(22n);
        expect(c.observeLag).toBeGreaterThan(0n);
        expect(c.observeLag).toBeLessThanOrEqual(40n);
        expect(c.gaps.every((g) => g <= STEP_MAX_GAP_BLOCKS - 1n)).toBe(true);
      }
      if (rpcMs <= 150) {
        // Fast enough to interleave: later covers start within a few blocks, no lane gap above the alert.
        for (const c of covers) {
          expect(c.delay).toBeLessThanOrEqual(6n);
          expect(c.observeLag).toBeLessThanOrEqual(10n);
          expect(c.gaps.every((g) => g <= CHAIN_GAP_ALERT_BLOCKS)).toBe(true);
        }
      }
    }, 60_000);
  }

  test('an arm planned behind a walk goes between lane attempts, not after the lane', async () => {
    const h = modelHarness({ rtt: { rpcMs: 60 } });
    h.model.R = R;
    h.model.bids = oneLot();
    h.model.covers.set(A, armedCover(A, h.chain.head));
    h.mgr.arm.set(B, true);
    h.mgr.covers.set(B, { status: COVER_STATUS.Live, isLong: true, stopPNS: 900_000, armer: KEEPER, armedBlock: 0, lots: 10, expiryBlock: Number(h.chain.head) + 10_000 });
    h.arms.push(B);
    await h.cycle();
    const fns = h.sends().map((s) => s.fn);
    // Was: the arm waited for the whole walk (8 sends). Now it goes after the lane's first attempt.
    expect(fns.indexOf('arm')).toBeGreaterThan(0);
    expect(fns.indexOf('arm')).toBeLessThanOrEqual(3);
    expect(h.model.covers.get(A)!.filled).toBe(22n);
  });

  test('admission reserves the rest of every running walk: a third walk at canary budgets waits instead of stranding', async () => {
    const h = modelHarness({ rtt: { rpcMs: 150 } });
    h.model.R = R;
    h.model.bids = deep();
    const ids = [coverId(100), coverId(101), coverId(102)];
    for (const id of ids) h.model.covers.set(id, armedCover(id, h.chain.head));
    for (let i = 0; i < 150; i++) await h.cycle();
    // Two worst-case walks fit the canary trigger_zero budget; the third is refused at admission, never mid-walk.
    const started = ids.filter((id) => h.model.attempts.some((a) => a.id === id));
    for (const id of started) expect(h.model.covers.get(id)!.filled).toBe(22n);
    expect(started).toHaveLength(2);
    expect(h.lines.some((l) => l.msg === 'spend.cap_reached')).toBe(false);
    expect(h.lines.some((l) => l.msg === 'keeper.touch_budget')).toBe(true);
  }, 60_000);
});

describe('SE3-L1: hot reserve and arm_repeat', () => {
  const book = (g: SpendGovernor, action: string, reserve: bigint, exempt: boolean, settle = reserve / 2n) => {
    const r = g.reserve({ action, amountWei: reserve, exempt });
    if (r.ok) g.settle(r.id, settle);
    return r.ok;
  };
  const governor = (over: { fillHeadroomWei?: bigint } = {}) => {
    const db = openDb(':memory:');
    migrate(db, KEEPER_MIGRATIONS);
    const cap = parseEther(CANARY_BUDGET.cap);
    return new SpendGovernor(
      db,
      KEEPER,
      {
        capWei: cap,
        hotReserveWei: parseEther(CANARY_BUDGET.hot),
        alertWei: cap,
        actionCapsWei: { [REPEAT_ARM_LABEL]: parseEther(CANARY_BUDGET.armRepeat) },
        fillHeadroomWei: parseEther(CANARY_BUDGET.fillHeadroom),
        ...over
      },
      captureLogger().log
    );
  };
  const fee = feeQuote(DESIGN_BASE_FEE_WEI).maxFeePerGas;

  test('PoC: chop re-arms stop at their sub-cap, and the second fill still reserves (was refused governor_cap)', () => {
    const g = governor();
    book(g, 'arm', GAS.arm * fee, true);
    book(g, 'arm', GAS.arm * fee, true);
    book(g, 'trigger', GAS.trigger * fee, true);
    let rearms = 0;
    while (book(g, REPEAT_ARM_LABEL, GAS.arm * fee, false)) rearms++;
    // 0.2 MON at 110 gwei: re-arms settle 0.0333 and the last reserves 0.0666.
    expect(rearms).toBeGreaterThanOrEqual(5);
    expect(rearms).toBeLessThanOrEqual(6);
    expect(g.reserve({ action: 'trigger', amountWei: GAS.trigger * fee, exempt: true }).ok).toBe(true);
  });

  test('a non-exempt send never takes the last fill call: total stays under cap minus one fill at max fee', () => {
    const g = governor();
    // Exempt spend (fills) brings the day to 4.05 MON; non-exempt sits far below cap minus hot.
    book(g, 'trigger', parseEther('4.05'), true, parseEther('4.05'));
    expect(g.reserve({ action: 'finalize', amountWei: GAS.finalize * fee, exempt: false }).ok).toBe(false);
    expect(g.room(false)).toBeLessThan(GAS.finalize * fee);
    // The fill it protects still fits.
    expect(g.reserve({ action: 'trigger', amountWei: GAS.trigger * fee, exempt: true }).ok).toBe(true);
    // Without the headroom rule the finalize would have taken that room.
    const old = governor({ fillHeadroomWei: 0n });
    book(old, 'trigger', parseEther('4.05'), true, parseEther('4.05'));
    expect(old.reserve({ action: 'finalize', amountWei: GAS.finalize * fee, exempt: false }).ok).toBe(true);
  });
});

describe('SE3-L2: a walk starts only with the MON to finish it', () => {
  // 5 steps x 1.1M + 3 fills x 2.2M at 102 gwei, plus one fill's max-fee peak: 1.454 MON.
  for (const balance of ['0.8', '1.3']) {
    test(`PoC balance ${balance} MON: the touch is refused at admission, nothing is sent (was: stranded at step 3 to 5)`, async () => {
      const h = modelHarness({ balance });
      h.model.R = R;
      h.model.bids = oneLot();
      h.model.covers.set(A, armedCover(A, h.chain.head));
      for (let i = 0; i < 20; i++) await h.cycle();
      expect(h.model.attempts).toHaveLength(0);
      expect(h.lines.some((l) => l.msg === 'keeper.touch_unfunded')).toBe(true);
      expect(h.lines.some((l) => l.msg === 'send.insufficient_balance')).toBe(false);
    });
  }

  test('a refill is seen at once: the cached low balance is re-read before refusing', async () => {
    const h = modelHarness({ balance: '0.8' });
    h.model.R = R;
    h.model.bids = oneLot();
    h.model.covers.set(A, armedCover(A, h.chain.head));
    expect(await h.queue.balanceAt(h.chain.head)).toBe(parseEther('0.8'));
    h.chain.balance(KEEPER, parseEther('1.5'));
    for (let i = 0; i < 20 && h.model.covers.get(A)!.filled < 22n; i++) await h.cycle();
    expect(h.model.covers.get(A)!.filled).toBe(22n);
    expect(h.lines.some((l) => l.msg === 'keeper.touch_unfunded')).toBe(false);
  });
});

describe('SE3-I2: walk starts per cover per day', () => {
  test('gaps over 10 blocks: at most two step-0 touches per cover per day (was all 10 steps on one failing period)', async () => {
    const h = modelHarness({ rtt: { rpcMs: 1_000 } });
    h.model.R = R;
    h.model.bids = oneLot();
    h.model.covers.set(A, armedCover(A, h.chain.head));
    for (let i = 0; i < 60; i++) await h.cycle();
    expect(h.model.attempts.map((a) => a.k)).toEqual([0, 0]);
    expect(h.governor.countToday(ZERO_PAID_TRIGGER.label, A)).toBe(ZERO_PAID_TRIGGER.touchesPerCoverPerDay);
  }, 60_000);
});

describe('SA4-01: trigger gas on Perpl', () => {
  test('GAS.trigger covers maxMatchesClose 8 on the mainnet model; 9 does not; a 1-fill step fits GAS.triggerStep', () => {
    expect(MAX_MATCHES_CLOSE_SUPPORTED).toBe(8);
    // 1.15 x (550K + 266K + 7 x 141K); the fork rehearsal measured 1,728,490 (x 1.15 = 1,987,764).
    expect(triggerGasFor(8)).toBe(2_073_450n);
    expect(triggerGasFor(8)).toBeLessThanOrEqual(GAS.trigger);
    expect(triggerGasFor(9)).toBeGreaterThan(GAS.trigger);
    expect(triggerGasFor(1)).toBeLessThanOrEqual(GAS.triggerStep);
    // 1.15 x (550K + 266K + 15 x 141K) = 3.37M; the fork rehearsal's 16-match estimate is 3,287,862.
    expect(triggerGasFor(16)).toBe(3_370_650n);
    expect(triggerGasFor(16)).toBeLessThanOrEqual(GAS.triggerCeiling);
    expect(triggerGasFor(40)).toBe(GAS.triggerCeiling);
  });

  // 30 one-lot bids from distinct makers at 858,700: a paying close of 8 matches per call.
  const fragmented = (): Level[] => Array.from({ length: 30 }, () => ({ price: 858_700n, lots: 1n, fillable: true }));

  test('PoC: a close that runs out of gas at 2.2M in simulation is retried once at 3.5M and sent (was: never sent)', async () => {
    const h = modelHarness();
    h.model.R = R;
    h.model.bids = fragmented();
    h.model.covers.set(A, armedCover(A, h.chain.head));
    h.mgr.triggerMinGas = 3_000_000n;
    for (let i = 0; i < 5 && h.model.covers.get(A)!.filled < 22n; i++) await h.cycle();
    expect(h.model.covers.get(A)!.filled).toBe(22n);
    expect(h.sends().map((s) => s.gas)).toEqual([GAS.triggerCeiling, GAS.triggerCeiling, GAS.triggerCeiling]);
    expect(h.lines.filter((l) => l.msg === 'keeper.trigger_gas_ceiling' && l.level === 40)).toHaveLength(3);
    expect(h.lines.some((l) => l.msg === 'keeper.trigger_undecoded_revert')).toBe(false);
  });

  test('beyond the ceiling nothing is sent and the revert is an error', async () => {
    const h = modelHarness();
    h.model.R = R;
    h.model.bids = fragmented();
    h.model.covers.set(A, armedCover(A, h.chain.head));
    h.mgr.triggerMinGas = 4_000_000n;
    await h.cycle();
    expect(h.sends()).toHaveLength(0);
    expect(h.lines.find((l) => l.msg === 'keeper.trigger_undecoded_revert')?.level).toBe(50);
  });

  test('maxMatchesClose above 8: reported at boot, no arm or trigger on that market, housekeeping goes on', async () => {
    const h = modelHarness();
    h.mgr.params = { maxMatchesClose: 16 };
    expect(await h.keeper.init(h.chain.head)).toEqual([1]);
    expect(h.lines.find((l) => String(l.msg).startsWith('keeper.max_matches_unsupported'))).toMatchObject({ level: 50, maxMatchesClose: 16, supported: 8 });
    h.model.R = R;
    h.model.bids = fragmented();
    h.model.covers.set(A, armedCover(A, h.chain.head));
    h.mgr.arm.set(B, true);
    h.mgr.covers.set(B, { status: COVER_STATUS.Live, isLong: true, stopPNS: 900_000, armer: KEEPER, armedBlock: 0, lots: 10 });
    const C = coverId(3);
    h.mgr.covers.set(C, { status: COVER_STATUS.Triggered, isLong: true, stopPNS: 860_000, armer: KEEPER, armedBlock: 0, lots: 22, filledLots: 22, triggerBlock: Number(h.chain.head) - 5, windowBlocks: 40 });
    h.mgr.observe.set(C, true);
    h.mgr.hk.set(1, { toObserve: [C], toFinalize: [], toExpire: [], toVoid: [] });
    h.sync();
    h.mgr.watch.set(1, { toArm: [B], toTrigger: [A] });
    h.chain.setHead(h.chain.head + 1n);
    await h.keeper.cycle(h.head());
    expect(h.sends().map((s) => s.fn)).toEqual(['observe']);
    // Back to 8: the market opens again at the next params read.
    h.mgr.params = { maxMatchesClose: 8 };
    expect(await h.keeper.init(h.chain.head + 1_000n)).toEqual([]);
  });
});

describe('SA4-03: a step that meets a bid at landing', () => {
  test('PoC: the reverted (out of gas) step backs nothing off; the walk goes on from the receipt and closes', async () => {
    const h = modelHarness();
    h.model.R = R;
    h.model.bids = oneLot();
    h.model.covers.set(A, armedCover(A, h.chain.head));
    let triggers = 0;
    const inner = h.chain.request.bind(h.chain);
    h.chain.request = async (a: { method: string; params?: unknown[] }) => {
      if (a.method === 'eth_sendRawTransactionSync' && ++triggers === 3) {
        // The third attempt (a step) runs out of gas at landing: the contract state does not change.
        const covers = new Map([...h.model.covers].map(([k, v]) => [k, { ...v }]));
        const attempts = h.model.attempts.length;
        h.chain.sendQueue.unshift({ kind: 'revert' });
        const out = await inner(a);
        h.model.covers = covers;
        h.model.attempts.length = attempts;
        return out;
      }
      return inner(a);
    };
    for (let i = 0; i < 20 && h.model.covers.get(A)!.filled < 22n; i++) await h.cycle();
    expect(h.model.covers.get(A)!.filled).toBe(22n);
    expect(h.model.attempts.map((x) => x.k)).toEqual([0, 1, 2, 3, 4, 5, 5, 5]);
    expect(landingGaps(h.model.attempts, A).every((g) => g <= 2n)).toBe(true);
    expect(h.lines.some((l) => l.msg === 'keeper.step_reverted')).toBe(true);
    // Was: an 8-block backoff, which outlasts the 10-block gap after the next revert and restarts the walk.
    expect(h.lines.some((l) => l.msg === 'keeper.noop_receipt')).toBe(false);
  });
});

describe('SA4 budgets: two worst-case closes a day at 110 gwei on the canary funding', () => {
  test('two 32-lot closes (5 steps and 4 fills each), first arms, observes, finalizes, 2 expires, 12 sigma posts and the arm_repeat cap fit 4.6 MON on 5.1 MON', async () => {
    const h = modelHarness({ baseFeeGwei: 110 });
    const fee = feeQuote(parseGwei('110')).maxFeePerGas;
    const billed = parseGwei('112');
    // Everything else first: the order that leaves the closes the least room.
    const book = (action: string, gas: bigint, exempt: boolean) => {
      const r = h.governor.reserve({ action, amountWei: gas * fee, exempt });
      expect(r.ok).toBe(true);
      if (r.ok) h.governor.settle(r.id, gas * billed);
    };
    for (let i = 0; i < 12; i++) book('postSigma', GAS.postSigma, false);
    for (let i = 0; i < 2; i++) book('expire', GAS.expire, false);
    for (let i = 0; i < 2; i++) book('arm', GAS.arm, true);
    while (h.governor.room(false, REPEAT_ARM_LABEL) >= GAS.arm * fee) book(REPEAT_ARM_LABEL, GAS.arm, false);
    h.chain.balance(KEEPER, parseEther(CANARY_BUDGET.balance) - h.governor.usage().committedWei);

    const close = async (id: Hex) => {
      h.model.bids = oneLot(40);
      h.model.covers.set(id, armedCover(id, h.chain.head, { lots: 32n }));
      for (let i = 0; i < 20 && h.model.covers.get(id)!.filled < 32n; i++) await h.cycle();
      expect(h.model.covers.get(id)!.filled).toBe(32n);
      expect(h.model.attempts.filter((a) => a.id === id).map((a) => `${a.k}:${a.filled}`)).toEqual(['0:0', '1:0', '2:0', '3:0', '4:0', '5:8', '5:8', '5:8', '5:8']);
      // Observe, then finalize, of this cover.
      h.model.covers.delete(id);
      h.mgr.watch.set(1, { toArm: [], toTrigger: [] });
      h.mgr.covers.set(id, { status: 3, isLong: true, stopPNS: 860_000, armer: KEEPER, armedBlock: 0, lots: 32, filledLots: 32, triggerBlock: Number(h.chain.head), windowBlocks: 40 });
      h.mgr.observe.set(id, true);
      h.mgr.finalize.set(id, 1n);
      for (const hk of [{ toObserve: [id], toFinalize: [] }, { toObserve: [], toFinalize: [id] }]) {
        h.mgr.hk.set(1, { ...hk, toExpire: [], toVoid: [] });
        h.chain.setHead(h.chain.head + 1n);
        await h.keeper.cycle(h.head());
      }
      h.mgr.hk.set(1, { toObserve: [], toFinalize: [], toExpire: [], toVoid: [] });
    };
    h.model.R = R;
    await close(A);
    await close(B);

    expect(h.sends().map((s) => s.fn).filter((f) => f !== 'trigger')).toEqual(['observe', 'finalize', 'observe', 'finalize']);
    for (const msg of ['spend.cap_reached', 'keeper.touch_budget', 'keeper.touch_unfunded', 'send.insufficient_balance']) {
      expect(h.lines.filter((l) => l.msg === msg)).toEqual([]);
    }
    // Late in the day Monad's in-flight budget (min(10 MON, balance) over 3 blocks) may hold a back-to-back fill a block.
    for (const id of [A, B]) expect(landingGaps(h.model.attempts, id).every((g) => g <= 2n)).toBe(true);
    const spent = h.governor.usage().committedWei;
    // 2 x 1.730 (closes) + 0.0896 (expires) + 0.1075 (sigma) + about 0.2 (re-arms): 3.86 MON settled.
    expect(spent).toBeGreaterThan(parseEther('3.75'));
    expect(spent).toBeLessThanOrEqual(parseEther(CANARY_BUDGET.cap) - parseEther(CANARY_BUDGET.fillHeadroom));
    const left = await h.queue.balanceAt(h.chain.head, true);
    expect(left).toBe(parseEther(CANARY_BUDGET.balance) - spent);
    // The cap binds before the balance: what is left still holds one fill call at max fee.
    expect(left).toBeGreaterThanOrEqual(GAS.trigger * fee);
    console.log(`worst day at 110 gwei: settled ${formatEther(spent)} MON, left ${formatEther(left)} MON of ${CANARY_BUDGET.balance}`);
  }, 60_000);
});
