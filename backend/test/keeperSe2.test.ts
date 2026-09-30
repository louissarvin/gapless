// SE2 keeper regressions, ported from the audit PoCs (/tmp/se2) onto the C7 contract model in coverModel.ts.
import { describe, expect, test } from 'bun:test';
import { parseEther } from 'viem';
import { STEP_MAX_GAP_BLOCKS } from '../src/keeper/actions.ts';
import { CHAIN_GAP_ALERT_BLOCKS } from '../src/keeper/keeper.ts';
import { GAS } from '../src/lib/gas.ts';
import { armedCover, landingGaps, modelHarness, type Level } from './coverModel.ts';
import { coverId } from './fakeGapless.ts';

const A = coverId(1);
const B = coverId(2);
// Reference through the 860,000 stop, within refTol.
const R = 859_000n;
// Only liquidity at 851,000: inside step 5 (850,410), outside step 4 (852,128).
const deepBook = (): Level[] => [{ price: 851_000n, lots: 100n, fillable: true }];
// The 22-lot demo against 30 one-lot bids at 851,000: fills only at step 5, 8 matches per call (canary), so the step-5
// fills are match-limited with depth left (C6 leaves the step, C7 restarts the gap from it): 8, 8, 6.
const oneLotBook = (): Level[] => Array.from({ length: 30 }, () => ({ price: 851_000n, lots: 1n, fillable: true }));

describe('SE2-H1: an active close runs from each receipt (fast lane)', () => {
  test('PoC walk: closes at step 5 whatever the head cadence (was: D >= 4 looped at step 0)', async () => {
    for (const D of [1n, 2n, 3n, 4n, 5n]) {
      const h = modelHarness();
      h.model.R = R;
      h.model.bids = deepBook();
      h.model.covers.set(A, armedCover(A, h.chain.head));
      for (let i = 0; i < 20 && h.model.covers.get(A)!.filled === 0n; i++) await h.cycle(D);
      expect(h.model.covers.get(A)!.filled).toBe(22n);
      expect(h.model.attempts.map((a) => a.k)).toEqual([0, 1, 2, 3, 4, 5]);
      expect(landingGaps(h.model.attempts, A).every((g) => g === 1n)).toBe(true);
      expect(h.lines.some((l) => l.msg === 'keeper.zero_paid_skip' || l.msg === 'spend.cap_reached')).toBe(false);
    }
  });

  test('PoC C6/C7: the match-limited partials at step 5 are finished at step 5 (was: 6 lots left open)', async () => {
    for (const D of [1n, 2n, 3n]) {
      const h = modelHarness();
      h.model.R = R;
      h.model.bids = oneLotBook();
      h.model.covers.set(A, armedCover(A, h.chain.head));
      for (let i = 0; i < 20 && h.model.covers.get(A)!.filled < 22n; i++) await h.cycle(D);
      expect(h.model.covers.get(A)!.filled).toBe(22n);
      expect(h.model.attempts.map((a) => `${a.k}:${a.filled}`)).toEqual(['0:0', '1:0', '2:0', '3:0', '4:0', '5:8', '5:8', '5:6']);
      // SE2-M1: all three fills pay and go on the hot path; only the five no-fill steps are trigger_zero.
      expect(h.labels()).toEqual([...Array(5).fill('trigger_zero'), 'trigger*', 'trigger*', 'trigger*']);
    }
  });

  test('PoC dust: a match-limited partial at step 0 is finished at once', async () => {
    const h = modelHarness();
    h.model.R = R;
    h.model.bids = [...Array.from({ length: 20 }, () => ({ price: 858_700n, lots: 1n, fillable: true })), { price: 858_600n, lots: 100n, fillable: true }];
    h.model.covers.set(A, armedCover(A, h.chain.head));
    for (let i = 0; i < 4 && h.model.covers.get(A)!.filled < 22n; i++) await h.cycle();
    expect(h.model.covers.get(A)!.filled).toBe(22n);
    expect(h.model.attempts.map((a) => `${a.k}:${a.filled}`)).toEqual(['0:8', '0:8', '0:6']);
  });

  // Public RPC measured 0.12 to 2.0 s per call; a co-located node about 60 ms.
  for (const rpcMs of [60, 150, 300]) {
    test(`RTT ${rpcMs} ms per call: the 22-lot demo close lands every attempt within the 10-block rule`, async () => {
      const h = modelHarness({ rtt: { rpcMs } });
      h.model.R = R;
      h.model.bids = oneLotBook();
      h.model.covers.set(A, armedCover(A, h.chain.head));
      for (let i = 0; i < 40 && h.model.covers.get(A)!.filled < 22n; i++) await h.cycle();
      expect(h.model.covers.get(A)!.filled).toBe(22n);
      expect(h.model.attempts.map((a) => a.k)).toEqual([0, 1, 2, 3, 4, 5, 5, 5]);
      const gaps = landingGaps(h.model.attempts, A);
      expect(gaps.every((g) => g <= STEP_MAX_GAP_BLOCKS)).toBe(true);
      // Canary target: 2 blocks typical, 6 max at a private endpoint.
      if (rpcMs <= 150) expect(gaps.every((g) => g <= 2n)).toBe(true);
      expect(gaps.every((g) => g <= CHAIN_GAP_ALERT_BLOCKS)).toBe(true);
      expect(h.lines.some((l) => l.msg === 'keeper.chain_gap_high')).toBe(false);
      expect(h.lines.filter((l) => l.msg === 'keeper.chain_gap').length).toBeGreaterThanOrEqual(5);
    });
  }

  test('RTT 700 ms per call: still inside the 10-block rule, and the gap alert fires above 6', async () => {
    const h = modelHarness({ rtt: { rpcMs: 700 } });
    h.model.R = R;
    h.model.bids = oneLotBook();
    h.model.covers.set(A, armedCover(A, h.chain.head));
    for (let i = 0; i < 40 && h.model.covers.get(A)!.filled < 22n; i++) await h.cycle();
    expect(h.model.covers.get(A)!.filled).toBe(22n);
    const gaps = landingGaps(h.model.attempts, A);
    expect(gaps.every((g) => g <= STEP_MAX_GAP_BLOCKS)).toBe(true);
    expect(gaps.some((g) => g > CHAIN_GAP_ALERT_BLOCKS)).toBe(true);
    expect(h.lines.some((l) => l.msg === 'keeper.chain_gap_high')).toBe(true);
  });

  test('RTT 1,000 ms per call (public RPC range): gaps exceed 10 blocks, walks restart and every attempt alerts', async () => {
    const h = modelHarness({ rtt: { rpcMs: 1_000 } });
    h.model.R = R;
    h.model.bids = oneLotBook();
    h.model.covers.set(A, armedCover(A, h.chain.head));
    for (let i = 0; i < 40 && h.model.covers.get(A)!.filled < 22n; i++) await h.cycle();
    expect(h.model.covers.get(A)!.filled).toBe(0n);
    expect(landingGaps(h.model.attempts, A).every((g) => g > STEP_MAX_GAP_BLOCKS)).toBe(true);
    // Bounded by the per-cover step count (two touches), and loud.
    expect(h.model.attempts.length).toBeLessThanOrEqual(10);
    expect(h.lines.filter((l) => l.msg === 'keeper.chain_gap_high').length).toBeGreaterThan(0);
  });

  test('a lane attempt costs one multicall, one simulation and the send (was 6 RPCs plus the send)', async () => {
    const h = modelHarness();
    h.model.R = R;
    h.model.bids = deepBook();
    h.model.covers.set(A, armedCover(A, h.chain.head));
    await h.cycle();
    expect(h.model.covers.get(A)!.filled).toBe(22n);
    const sends = h.methods.reduce<number[]>((acc, m, i) => (m === 'eth_sendRawTransactionSync' ? [...acc, i] : acc), []);
    // Between consecutive lane sends: exactly two eth_calls (lane multicall, simulation).
    for (let i = 1; i < sends.length; i++) expect(h.methods.slice(sends[i - 1]! + 1, sends[i])).toEqual(['eth_call', 'eth_call']);
  });

  test('two covers mid-close take turns in the lane, both inside the gap rule', async () => {
    const h = modelHarness();
    h.model.R = R;
    h.model.bids = [...deepBook(), { price: 851_000n, lots: 100n, fillable: true }];
    h.model.covers.set(A, armedCover(A, h.chain.head));
    h.model.covers.set(B, armedCover(B, h.chain.head));
    for (let i = 0; i < 10 && [A, B].some((id) => h.model.covers.get(id)!.filled < 22n); i++) await h.cycle();
    for (const id of [A, B]) {
      expect(h.model.covers.get(id)!.filled).toBe(22n);
      expect(landingGaps(h.model.attempts, id).every((g) => g <= 2n)).toBe(true);
    }
  });
});

describe('SE2-M1 and M2: budgets for two worst-case closes a day (canary: 5.1 MON funding, cap 4.6)', () => {
  test('PoC: two worst-case touches close fully, then both observes and finalizes go the same UTC day', async () => {
    const h = modelHarness();
    h.model.R = R;
    h.model.bids = oneLotBook();
    h.model.covers.set(A, armedCover(A, h.chain.head));
    for (let i = 0; i < 20 && h.model.covers.get(A)!.filled < 22n; i++) await h.cycle();
    h.model.bids = oneLotBook();
    h.model.covers.set(B, armedCover(B, h.chain.head + 1n));
    for (let i = 0; i < 20 && h.model.covers.get(B)!.filled < 22n; i++) await h.cycle();
    expect(h.model.covers.get(A)!.filled).toBe(22n);
    expect(h.model.covers.get(B)!.filled).toBe(22n);
    expect(h.labels().filter((l) => l === 'trigger_zero')).toHaveLength(10);
    expect(h.labels().filter((l) => l === 'trigger*')).toHaveLength(6);

    // Observe both (exempt, 40-block window), then finalize both (non-exempt).
    h.model.covers.clear();
    h.mgr.watch.set(1, { toArm: [], toTrigger: [] });
    for (const id of [A, B]) {
      h.mgr.covers.set(id, { status: 3, isLong: true, stopPNS: 860_000, armer: h.mgr.covers.get(id)?.armer ?? `0x${'00'.repeat(20)}`, armedBlock: 0, lots: 22, filledLots: 22, triggerBlock: Number(h.chain.head), windowBlocks: 40 });
      h.mgr.observe.set(id, true);
      h.mgr.finalize.set(id, 1n);
    }
    h.mgr.hk.set(1, { toObserve: [A, B], toFinalize: [], toExpire: [], toVoid: [] });
    h.chain.setHead(h.chain.head + 1n);
    await h.keeper.cycle(h.head());
    h.mgr.hk.set(1, { toObserve: [], toFinalize: [A, B], toExpire: [], toVoid: [] });
    h.chain.setHead(h.chain.head + 1n);
    await h.keeper.cycle(h.head());
    expect(h.sends().slice(-4).map((s) => s.fn)).toEqual(['observe', 'observe', 'finalize', 'finalize']);
    expect(h.lines.some((l) => l.msg === 'spend.cap_reached')).toBe(false);
    // Settled at the fee floor without arms: 5 steps 0.561 + 3 fills 0.6732 + observe + finalize = 1.32 MON per close.
    expect(h.governor.usage().committedWei).toBeGreaterThan(parseEther('2.5'));
    expect(h.governor.usage().committedWei).toBeLessThan(parseEther('2.7'));
  });

  test('PoC: observe still goes when non-exempt spend sits at cap minus hot reserve (was skipped governor_cap)', async () => {
    const h = modelHarness();
    // Non-exempt spend already at its limit (1.95 of 4.6).
    const r = h.governor.reserve({ action: 'finalize', amountWei: parseEther('1.95'), exempt: false });
    expect(r.ok).toBe(true);
    expect(h.governor.reserve({ action: 'finalize', amountWei: 1n, exempt: false }).ok).toBe(false);
    h.mgr.covers.set(A, { status: 3, isLong: true, stopPNS: 860_000, armer: `0x${'00'.repeat(20)}`, armedBlock: 0, lots: 22, filledLots: 22, triggerBlock: Number(h.chain.head) - 5, windowBlocks: 40 });
    h.mgr.hk.set(1, { toObserve: [A], toFinalize: [], toExpire: [], toVoid: [] });
    h.mgr.observe.set(A, true);
    await h.keeper.cycle(h.head());
    expect(h.sends().map((s) => s.fn)).toEqual(['observe']);
    expect(h.labels().at(-1)).toBe('observe*');
  });

  test('a touch that cannot afford its walk and fills does not start (no stranded walk)', async () => {
    const h = modelHarness({ zero: '0.3' });
    h.model.R = R;
    h.model.bids = deepBook();
    h.model.covers.set(A, armedCover(A, h.chain.head));
    await h.cycle();
    expect(h.sends()).toHaveLength(0);
    expect(h.lines.some((l) => l.msg === 'keeper.touch_budget')).toBe(true);
  });
});

describe('SE2-L1: boundary blocks (simulate at head, land at head + 1)', () => {
  test('PoC: no trigger when head is the expiry block (was: sent and reverted, 0.153 MON)', async () => {
    const h = modelHarness();
    h.model.R = R;
    h.model.bids = [{ price: 858_600n, lots: 100n, fillable: true }];
    const n = h.chain.head + 1n;
    h.model.covers.set(A, armedCover(A, n, { expiry: n }));
    h.chain.setHead(n - 1n);
    await h.cycle();
    expect(h.chain.head).toBe(n);
    expect(h.sends()).toHaveLength(0);
    expect(h.lines.some((l) => l.msg === 'send.reverted')).toBe(false);
  });

  test('no remainder or observe sent at the last window block', async () => {
    const h = modelHarness();
    const head = h.chain.head;
    h.mgr.covers.set(A, { status: 3, isLong: true, stopPNS: 860_000, armer: `0x${'00'.repeat(20)}`, armedBlock: 0, lots: 22, filledLots: 16, refTrigPNS: 859_000, triggerBlock: Number(head) - 40, windowBlocks: 40 });
    h.mgr.trigger.set(A, 5_000n);
    h.mgr.observe.set(A, true);
    h.mgr.watch.set(1, { toArm: [], toTrigger: [A] });
    h.mgr.hk.set(1, { toObserve: [A], toFinalize: [], toExpire: [], toVoid: [] });
    await h.keeper.cycle(h.head());
    expect(h.sends()).toHaveLength(0);
    // One block earlier both still land in the window.
    h.mgr.covers.set(A, { ...h.mgr.covers.get(A)!, triggerBlock: Number(head) - 39 });
    await h.keeper.cycle(h.head());
    expect(h.sends().map((s) => s.fn)).toEqual(['trigger', 'observe']);
  });
});

describe('SE2-L4: unfillable book top', () => {
  test('PoC: 1,200 blocks of phantom top levels: one full-gas close, then step-limit retries with backoff (was 3 full-gas closes)', async () => {
    const h = modelHarness();
    h.model.R = R;
    h.model.bids = [...Array.from({ length: 16 }, () => ({ price: 858_700n, lots: 1n, fillable: false })), { price: 858_600n, lots: 100n, fillable: true }];
    h.model.covers.set(A, armedCover(A, h.chain.head));
    for (let i = 0; i < 1_200; i++) await h.cycle();
    const t = h.sends().filter((s) => s.fn === 'trigger');
    expect(h.model.covers.get(A)!.filled).toBe(0n);
    // One full-gas close; retries at the step limit, backing off 8, 16, 32, 64 blocks until the arm lapses.
    expect(t.filter((s) => s.gas === GAS.trigger)).toHaveLength(1);
    expect(t.filter((s) => s.gas === GAS.triggerStep).length).toBeLessThanOrEqual(4);
    expect(h.lines.some((l) => l.msg === 'keeper.phantom_top')).toBe(true);
    // One 2.2M close (0.2244) plus at most four 1.1M retries (0.1122 each) at the fee floor.
    expect(h.governor.usage().committedWei).toBeLessThanOrEqual(GAS.trigger * 102_000_000_000n + 4n * GAS.triggerStep * 102_000_000_000n);
  }, 30_000);
});
