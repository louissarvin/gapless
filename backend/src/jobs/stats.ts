/** Nearest-rank percentile of an ascending array: the value at index ceil(p/100 * n) - 1. */
export function percentile(sortedAsc: readonly number[], p: number): number | null {
  const n = sortedAsc.length;
  if (n === 0) return null;
  const idx = Math.min(n - 1, Math.max(0, Math.ceil((p / 100) * n) - 1));
  return sortedAsc[idx]!;
}

export const round2 = (x: number): number => Math.round(x * 100) / 100;

export interface Distribution {
  n: number;
  mean: number | null;
  p50: number | null;
  p90: number | null;
  p99: number | null;
  max: number | null;
}

/** Mean and nearest-rank percentiles, rounded to 2 decimals. */
export function distribution(values: readonly number[]): Distribution {
  const s = [...values].sort((a, b) => a - b);
  const r = (x: number | null) => (x === null ? null : round2(x));
  return {
    n: s.length,
    mean: s.length ? round2(s.reduce((a, b) => a + b, 0) / s.length) : null,
    p50: r(percentile(s, 50)),
    p90: r(percentile(s, 90)),
    p99: r(percentile(s, 99)),
    max: r(s.length ? s[s.length - 1]! : null)
  };
}

export interface EventDistribution extends Distribution {
  /** Distinct events behind the values (overlapping samples of one event count once). */
  events: number;
  /** Distinct events with a value at or above each statistic: a p99 resting on 1 event says so. */
  eventsAtOrAbove: { p50: number; p90: number; p99: number; max: number };
}

/** `distribution` plus distinct-event support; `eventIds[i]` identifies the event behind `values[i]`. */
export function eventDistribution(values: readonly number[], eventIds: readonly (string | number)[]): EventDistribution {
  const d = distribution(values);
  const atOrAbove = (v: number | null) => {
    if (v === null) return 0;
    const ids = new Set<string | number>();
    // Compare against the rounded statistic so a published value and its count agree.
    values.forEach((x, i) => Math.round(x * 100) / 100 >= v && ids.add(eventIds[i]!));
    return ids.size;
  };
  return {
    ...d,
    events: new Set(eventIds).size,
    eventsAtOrAbove: { p50: atOrAbove(d.p50), p90: atOrAbove(d.p90), p99: atOrAbove(d.p99), max: atOrAbove(d.max) }
  };
}

/** Distinct events with a value strictly above each threshold. */
export function exceedanceEvents(
  values: readonly number[],
  eventIds: readonly (string | number)[],
  thresholds: readonly number[]
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const t of thresholds) {
    const ids = new Set<string | number>();
    values.forEach((x, i) => x > t && ids.add(eventIds[i]!));
    out[String(t)] = ids.size;
  }
  return out;
}

/** Fraction of values strictly greater than each threshold; null when there are no values. */
export function exceedance(values: readonly number[], thresholds: readonly number[]): Record<string, number | null> {
  const out: Record<string, number | null> = {};
  for (const t of thresholds) {
    out[String(t)] = values.length ? values.filter((v) => v > t).length / values.length : null;
  }
  return out;
}

/** Weighted isotonic (non-decreasing) regression by pool-adjacent-violators. Weights must be > 0. */
export function pava(values: readonly number[], weights: readonly number[]): number[] {
  const blocks: { sum: number; w: number; len: number }[] = [];
  values.forEach((v, i) => {
    const w = weights[i]!;
    blocks.push({ sum: v * w, w, len: 1 });
    while (blocks.length > 1) {
      const b = blocks[blocks.length - 1]!;
      const a = blocks[blocks.length - 2]!;
      if (a.sum / a.w <= b.sum / b.w) break;
      blocks.splice(-2, 2, { sum: a.sum + b.sum, w: a.w + b.w, len: a.len + b.len });
    }
  });
  return blocks.flatMap((b) => Array<number>(b.len).fill(b.sum / b.w));
}

/** Smallest non-decreasing sequence that is >= every input (running max). */
export function nonDecreasingMajorant(values: readonly number[]): number[] {
  let m = -Infinity;
  return values.map((v) => (m = Math.max(m, v)));
}
