// Parity vectors for PremiumMath from the backend's contract-parity quote (backend/src/jobs/premium.ts).
// Run from contract/: bun test/fixtures/gen_premium_vectors.ts > test/fixtures/premium_vectors.json
import { quote } from '../../../backend/src/jobs/premium.ts';
import { SPEC_DEFAULT_PARAMS, type MarketParams } from '../../../backend/src/jobs/config.ts';

let seed = 0x6761706c657373n;
const rnd = (lo: number, hi: number): number => {
  seed = (seed * 6364136223846793005n + 1442695040888963407n) & ((1n << 64n) - 1n);
  return lo + Number((seed >> 11n) % BigInt(hi - lo + 1));
};

const N = 400;
const cols: Record<string, string[]> = {};
const push = (k: string, v: bigint | number) => (cols[k] ??= []).push(v.toString());

for (let i = 0; i < N; i++) {
  const p: MarketParams = { ...SPEC_DEFAULT_PARAMS, zEdgesE2: [...SPEC_DEFAULT_PARAMS.zEdgesE2], gapBpsE2: [...SPEC_DEFAULT_PARAMS.gapBpsE2] };
  if (i % 4 !== 0) {
    p.slipAllowanceBps = rnd(5, 50);
    p.maxGapBpsCap = rnd(50, 500);
    p.minStopDistanceBps = rnd(5, 500);
    p.kDistE2 = rnd(100, 1000);
    p.loadBps = rnd(0, 20000);
    p.rentAprBps = rnd(0, 10000);
    p.uKinkBps = rnd(1000, 9000);
    p.slope1Bps = rnd(0, 20000);
    p.slope2Bps = rnd(0, 60000);
    p.impactBpsPerKE2 = rnd(0, 1000);
    p.warmupBlocks = rnd(100, 2000);
    p.minFeeCNS = rnd(0, 1_000_000);
    let e = 0;
    for (let k = 0; k < 8; k++) { e += rnd(1, 200); p.zEdgesE2[k] = e; }
    for (let k = 0; k < 9; k++) p.gapBpsE2[k] = rnd(0, p.maxGapBpsCap * 100);
  }
  const notional = BigInt(rnd(1, 2_000_000)) * BigInt(rnd(1, 100_000));
  const distance = BigInt(rnd(0, 3000));
  const sigma = rnd(5, 2000);
  const duration = rnd(500, 48000);
  const maxGap = rnd(50, p.maxGapBpsCap);
  const util = rnd(0, 10000);
  const q = quote(p, { notionalCNS: notional, distanceBps: distance, sigmaBlkBpsE2: sigma, durationBlocks: duration, maxGapBps: maxGap, utilBpsAfter: util });
  for (const k of ['slipAllowanceBps', 'maxGapBpsCap', 'minStopDistanceBps', 'kDistE2', 'loadBps', 'rentAprBps', 'uKinkBps', 'slope1Bps', 'slope2Bps', 'impactBpsPerKE2', 'warmupBlocks', 'minFeeCNS'] as const) push(k, p[k]);
  for (let k = 0; k < 8; k++) push(`z${k}`, p.zEdgesE2[k]!);
  for (let k = 0; k < 9; k++) push(`g${k}`, p.gapBpsE2[k]!);
  push('notional', notional); push('distance', distance); push('sigma', sigma); push('duration', duration); push('maxGap', maxGap); push('util', util);
  push('outMinDist', q.minDistanceBps); push('outZ', q.zE2); push('outBucket', q.bucket); push('outFee', q.feeBpsE2);
  push('outCap', q.capCNS); push('outM', q.multiplierBps); push('outEscrow', q.escrowCNS);
  // PremiumMath.rentCNS has no L-09 duration floor (that lives in PremiumMath.quote), so pin the raw rent.
  push('outRent', q.rentRawCNS);
}
console.log(JSON.stringify({ source: 'backend/src/jobs/premium.ts', n: N, ...cols }));
