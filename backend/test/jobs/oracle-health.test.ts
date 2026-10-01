import { describe, expect, test } from 'bun:test';
import { diffs, markOracleDivergence, staleFraction, stalenessReport } from '../../src/jobs/oracle-health.ts';

// Hand-written test-only series.

describe('staleness math', () => {
  test('diffs', () => {
    expect(diffs([10, 15, 115])).toEqual([5, 100]);
    expect(diffs([1])).toEqual([]);
  });

  test('stale fraction counts time beyond the max age, including the tail to the window end', () => {
    // Publishes at 0, 50, 200; end 300; max age 60. Stale: (150 - 60) + (100 - 60) = 130 of 300.
    expect(staleFraction([0, 50, 200], 300, 60)).toBeCloseTo(130 / 300, 12);
    expect(staleFraction([0, 30, 60], 60, 60)).toBe(0);
    expect(staleFraction([], 100, 60)).toBeNull();
    expect(staleFraction([100], 100, 60)).toBeNull();
  });

  test('divergence uses the latest oracle at or before the mark, only when fresh', () => {
    const marks = { block: [10, 20, 30], ts: [100, 110, 200], price: [10_010, 10_000, 10_100] };
    const oracle = { block: [5, 20], ts: [95, 110], price: [10_000, 10_000] };
    // block 10: |10,010 - 10,000| = 10 bps; block 20: 0; block 30: oracle 90 s old, skipped.
    expect(markOracleDivergence(marks, oracle, 60)).toEqual([10, 0]);
  });

  test('report separates duplicate reports from real failures', () => {
    const marks = { block: [1, 2], ts: [0, 30], price: [100_000, 100_400] };
    const oracle = { block: [1], ts: [0], price: [100_000], reportTs: [-2] };
    const r = stalenessReport(marks, oracle, { oracle_report_not_newer: 2, oracle_update_failed: 1, mark_exceeds_tol: 0 }, 100, 1);
    expect(r.oracle.failures).toEqual({ reportNotNewer: 2, other: 1 });
    expect(r.oracle.rejectionRate).toBe(0.75); // 3 / (1 + 3)
    expect(r.oracle.otherFailureRate).toBe(0.25);
    expect(r.oracle.reportLagSec).toMatchObject({ n: 1, max: 2 });
    expect(r.mark.ageSecAtWindowEnd).toBe(70);
    expect(r.mark.intervalSec).toMatchObject({ n: 1, max: 30 });
    // 40 bps at block 2 against the oracle from block 1 (30 s old).
    expect(r.markOracleDivergenceBps).toMatchObject({ n: 2, max: 40, fractionAboveClamp: 0.5 });
  });

  test('rates divide by update logs, not per-block values, so two updates in one block both count', () => {
    const marks = { block: [1], ts: [0], price: [100_000] };
    // The series keeps one value for block 1, but two LinkPriceUpdated logs landed there.
    const oracle = { block: [1], ts: [0], price: [100_000], reportTs: [0] };
    const r = stalenessReport(marks, oracle, { oracle_report_not_newer: 0, oracle_update_failed: 2, mark_exceeds_tol: 0 }, 10, 2);
    expect(r.oracle.rejectionRate).toBe(0.5); // 2 / (2 + 2), not 2 / (1 + 2)
    expect(r.oracle.otherFailureRate).toBe(0.5);
  });

  test('gaplessStaleFraction uses refFreshSec + 2 = 62 s, staleFraction uses Perpl 60 s', () => {
    // One publish at 0, window end 100: stale for 40 s at 60 s, 38 s at 62 s.
    const s = { block: [1], ts: [0], price: [1] };
    const r = stalenessReport(s, { ...s, reportTs: [0] }, { oracle_report_not_newer: 0, oracle_update_failed: 0, mark_exceeds_tol: 0 }, 100, 1);
    expect(r.mark.staleFraction).toBe(0.4);
    expect(r.mark.gaplessStaleFraction).toBe(0.38);
  });
});
