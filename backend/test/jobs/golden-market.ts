import type { Hex } from 'viem';
import type { RawLog } from '../../src/jobs/rows.ts';
import { encodeLog } from './synthetic.ts';

// Test-only deterministic market for perp 1 (integer math only, so output is identical on every
// platform): a 30 bps triangle wave with a 12,000-block period plus two 1.5% gaps down.
export function goldenMarket(from: number, to: number): { logs: RawLog[]; ts: Map<number, number> } {
  const logs: RawLog[] = [];
  const ts = new Map<number, number>();
  const tsOf = (b: number) => 1_790_000_000 + Math.floor((b * 3) / 10);
  const price = (b: number) => {
    const ph = (b - from) % 12_000;
    let p = 1_000_000 + (ph < 6_000 ? ph : 12_000 - ph) / 2 - 1_500;
    if (b >= from + 60_000) p = Math.floor((p * 985) / 1000);
    if (b >= from + 140_000) p = Math.floor((p * 985) / 1000);
    return Math.round(p);
  };
  for (let b = from + 1; b < to; b++) {
    let li = 0;
    if (b % 25 === 0) logs.push(encodeLog('MarkUpdated', { perpId: 1n, pricePNS: BigInt(price(b)) }, b, li++));
    if (b % 150 === 0) {
      logs.push(encodeLog('LinkPriceUpdated', { perpId: 1n, oraclePricePNS: BigInt(price(b) + 20), timestamp: BigInt(tsOf(b) - 1) }, b, li++));
    }
    if (b % 400 === 0) {
      const tx = `0x${'cd'.repeat(31)}${(b % 256).toString(16).padStart(2, '0')}` as Hex;
      logs.push(encodeLog('ReportAgeExceedsLastUpdate', { perpId: 1n, lastUpdateTimestamp: 5n, reportValidFromTimestamp: 5n }, b, li++, tx));
      logs.push(encodeLog('UpdateOracleFailed', { perpId: 1n }, b, li++, tx));
    }
    if (b % 60 === 0) {
      logs.push(
        encodeLog('MakerOrderFilledV2', {
          perpId: 1n, accountId: 42n, orderId: 1n, pricePNS: BigInt(price(b) - 50), lotLNS: 100n, feeCNS: 3n,
          lockedBalanceCNS: 0n, amountCNS: -5n, balanceCNS: 10n, builderId: 0n, builderFeeCNS: 0n
        }, b, li++)
      );
    }
    if (li > 0) ts.set(b, tsOf(b));
  }
  return { logs, ts };
}
