// SE3-L3: test/coverModel.ts against C7 CoverManager._close / _step / _advance / _hold / _resetChain (ported from
// /tmp/se3/model_diff.test.ts) and the two C7Audit cases the old model got wrong.
import { describe, expect, test } from 'bun:test';
import { COVER_STATUS } from '../src/keeper/actions.ts';
import { CoverModel, armedCover, type Level } from './coverModel.ts';
import { coverId } from './fakeGapless.ts';

const id = coverId(9);
const R = 859_000n;
// Match-limited: 17 one-lot bids at 858,700 that consume matches and fill nothing (expired orders, self-matches).
const dust = (): Level[] => Array.from({ length: 17 }, () => ({ price: 858_700n, lots: 1n, fillable: false }));

/** Line-by-line C7: shortBlock, shortSteps and _heldBlock. */
class C7 {
  sb = 0n;
  steps = 0;
  held = 0n;
  step(n: bigint, through: boolean): number {
    if (!through || this.sb === 0n || n - this.sb > 10n) return 0;
    if (n !== this.sb) return this.steps;
    return this.held === this.sb ? this.steps : this.steps - 1;
  }
  apply(n: bigint, o: 'thin' | 'hold' | 'reset'): number {
    const k = this.step(n, o !== 'reset');
    if (o === 'reset') {
      if (this.sb !== 0n) {
        if (this.sb === n) this.held = 0n;
        this.sb = 0n;
        this.steps = 0;
      }
    } else if (o === 'thin') {
      if (this.sb === n) {
        if (this.held !== n) return k;
        this.held = 0n;
      }
      this.sb = n;
      this.steps = Math.min(k + 1, 6);
    } else if (k !== 0 && this.sb !== n) {
      this.sb = n;
      this.held = n;
    }
    return k;
  }
}

function rng(seed: number) {
  let s = seed >>> 0;
  return () => (s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32;
}

function model(over: Parameters<typeof armedCover>[2] = {}) {
  const m = new CoverModel();
  m.ttl = 10n ** 9n;
  m.R = R;
  m.covers.set(id, armedCover(id, 1000n, { lots: 1_000_000n, armedBlock: 1n, expiry: 10n ** 9n, window: 10n ** 9n, ...over }));
  return m;
}

/** One attempt at block n; returns the step it ran at. */
function attempt(m: CoverModel, n: bigint, bids: Level[]): number {
  m.bids = bids;
  m.trigger(id, n, true);
  return m.attempts.at(-1)!.k;
}

describe('SE3-L3: the cover model is exact C7', () => {
  test('random attempt sequences: same step, shortBlock and shortSteps as the C7 port (was: diverged)', () => {
    const diverge: string[] = [];
    for (let seed = 1; seed <= 3000 && diverge.length === 0; seed++) {
      const r = rng(seed);
      const m = model();
      const c7 = new C7();
      let n = 1000n;
      for (let i = 0; i < 14; i++) {
        const x = r();
        n += x < 0.25 ? 0n : x < 0.85 ? BigInt(1 + Math.floor(r() * 10)) : BigInt(11 + Math.floor(r() * 3));
        const p = r();
        const o = p < 0.45 ? 'thin' : p < 0.7 ? 'hold' : p < 0.85 ? 'holdFill' : 'reset';
        m.R = o === 'reset' ? 861_000n : R;
        const bids = o === 'hold' ? dust() : o === 'holdFill' ? dust().map((b) => ({ ...b, fillable: true })) : [];
        const before = m.attempts.length;
        m.bids = bids;
        m.trigger(id, n, true);
        const km = m.attempts.length > before ? m.attempts.at(-1)!.k : -1;
        const kc = c7.apply(n, o === 'holdFill' ? 'hold' : o);
        const mc = m.covers.get(id)!;
        if (km !== kc || mc.sb !== c7.sb || mc.steps !== c7.steps) diverge.push(`seed ${seed} block ${n} ${o}: k ${km}/${kc} sb ${mc.sb}/${c7.sb} steps ${mc.steps}/${c7.steps}`);
      }
    }
    expect(diverge).toEqual([]);
  });

  test('C7Audit holdThenThinSameBlock_advancesOnce: a thin retry after a hold advances once, a third keeps the step', () => {
    const m = model();
    let n = 2000n;
    for (let k = 0; k < 5; k++) expect(attempt(m, n++, [])).toBe(k);
    expect(m.covers.get(id)!.steps).toBe(5);
    // Block n: the step-5 attempt is match-limited (hold), then the dust goes and two retries find the book thin.
    expect(attempt(m, n, dust())).toBe(5);
    expect(attempt(m, n, [])).toBe(5);
    expect(m.covers.get(id)!.steps).toBe(6);
    expect(m.covers.get(id)!.sb).toBe(n);
    expect(attempt(m, n, [])).toBe(5);
    expect(m.covers.get(id)!.steps).toBe(6);
    // The old model never advanced in the hold's block (steps stayed 5).
    expect(attempt(m, n + 1n, [])).toBe(6);
  });

  test('C7Audit remainder_beyondGap_resetsToTight with dust: a hold on a dead chain does not revive it', () => {
    const b = 3000n;
    const m = model({ status: COVER_STATUS.Triggered, filled: 16n, refTrig: R, triggerBlock: b - 20n, sb: b, steps: 5 });
    // 11 blocks later the chain is dead: the dust attempt runs tight and holds nothing (C7 _hold returns on k == 0).
    expect(attempt(m, b + 11n, dust())).toBe(0);
    expect(m.covers.get(id)!.sb).toBe(b);
    // Was: the dust revived the chain at step 5 for this attempt.
    expect(attempt(m, b + 12n, [])).toBe(0);
    expect(m.covers.get(id)!.steps).toBe(1);
  });
});
