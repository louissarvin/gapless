import { SIGMA } from './config.ts';
import type { StepSeries } from './store.ts';

export interface SigmaSeries {
  baseBlock: number;
  stepBlocks: number;
  warmupSteps: number;
  /** Per-block sigma in bps at step k (uses returns up to step k only); NaN before warm-up. */
  sigmaBlkBps: Float64Array;
}

/** Block and price are all the estimator reads; ts is accepted so a full StepSeries passes as is. */
export type PriceSteps = Pick<StepSeries, 'block' | 'price'> & Partial<Pick<StepSeries, 'ts'>>;

export interface SigmaOptions {
  stepBlocks: number;
  halfLivesSteps: readonly number[];
  warmupSteps: number;
}

// 05 §2.4 step 2: bias-corrected EWMA of squared 1.2 s log returns per half-life; sigma_blk =
// sqrt(max) / sqrt(stepBlocks). Input is the onchain MarkUpdated step series (about every 50 s for
// BTC when calm, measured). The keeper posts sigma from this same function on the same series.
export function computeSigmaSeries(marks: PriceSteps, endBlock: number, opts: SigmaOptions = SIGMA): SigmaSeries {
  const n = marks.block.length;
  const base = n ? marks.block[0]! : 0;
  const steps = n ? Math.max(0, Math.floor((endBlock - 1 - base) / opts.stepBlocks) + 1) : 0;
  const out = new Float64Array(steps).fill(NaN);
  const lambdas = opts.halfLivesSteps.map((h) => Math.pow(0.5, 1 / h));
  const v = lambdas.map(() => 0);
  const decay = lambdas.map(() => 1);
  let j = 0;
  let prev = n ? marks.price[0]! : 0;
  for (let k = 1; k < steps; k++) {
    const b = base + k * opts.stepBlocks;
    while (j + 1 < n && marks.block[j + 1]! <= b) j++;
    const p = marks.price[j]!;
    const r = Math.log(p / prev) * 1e4;
    prev = p;
    let maxVar = 0;
    for (let h = 0; h < lambdas.length; h++) {
      const l = lambdas[h]!;
      v[h] = l * v[h]! + (1 - l) * r * r;
      decay[h]! *= l;
      maxVar = Math.max(maxVar, v[h]! / (1 - decay[h]!));
    }
    if (k >= opts.warmupSteps) out[k] = Math.sqrt(maxVar) / Math.sqrt(opts.stepBlocks);
  }
  return { baseBlock: base, stepBlocks: opts.stepBlocks, warmupSteps: opts.warmupSteps, sigmaBlkBps: out };
}

/** Sigma known at `block` (no look-ahead), or null before warm-up or outside the series. */
export function sigmaAt(s: SigmaSeries, block: number): number | null {
  const k = Math.floor((block - s.baseBlock) / s.stepBlocks);
  if (k < 0 || k >= s.sigmaBlkBps.length) return null;
  const v = s.sigmaBlkBps[k]!;
  return Number.isNaN(v) ? null : v;
}

/** sigmaBlkBpsE2 as CoverManager would accept it: rounded, clamped to the postSigma bounds. */
export function toSigmaE2(sigmaBlkBps: number): number {
  return Math.min(SIGMA.maxE2, Math.max(SIGMA.minE2, Math.round(sigmaBlkBps * 100)));
}

export function latestSigma(s: SigmaSeries): number | null {
  for (let k = s.sigmaBlkBps.length - 1; k >= 0; k--) {
    const v = s.sigmaBlkBps[k]!;
    if (!Number.isNaN(v)) return v;
  }
  return null;
}
