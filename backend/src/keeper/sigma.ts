import { getLogs } from 'viem/actions';
import { PERPL_EVENTS_ABI } from '../jobs/perpl.ts';
import { computeSigmaSeries, latestSigma, toSigmaE2 } from '../jobs/sigma.ts';
import { PERPL_EXCHANGE } from '../lib/addresses.ts';
import type { Logger } from '../lib/log.ts';
import type { ChainClient } from '../lib/sendQueue.ts';

const MARK_UPDATED = PERPL_EVENTS_ABI.find((e) => e.name === 'MarkUpdated')!;

export const SIGMA_POLICY = {
  // 4 half-lives of the 1 h EWMA (12,000 blocks), so the estimate matches the jobs' 7-day series closely.
  historyBlocks: 48_000n,
  // BUILD_PLAN W3: at most one post per 600 blocks.
  minPostIntervalBlocks: 600n,
  // BUILD_PLAN §0: post when age passes 5,400 of sigmaMaxAgeBlocks 6,000.
  staleFraction: 0.9,
  // Post when the estimate moved more than 10% from the onchain value.
  changeRatio: 0.1,
  // A /sigma-refresh request counts as quote demand for this long.
  requestTtlMs: 120_000,
  // Feed mark vs last onchain mark sanity bound (mark publishes on 5 bps moves).
  maxMarkDeviationBps: 100,
  // F-2: the background history fetch may trail the Finalized head by this much and still decide (about 30 s).
  maxHistoryLagBlocks: 100n,
  // SE2-M3: daily sub-cap on posts (80K gas each, 0.108 MON settled at 110 gwei), all under this label. 12 posts keep
  // quotes open about 5.9 h per UTC day; SE3-M3: raise it, with the keeper cap, before quotes are public.
  maxPostsPerDay: 12,
  postLabel: 'postSigma',
  // Label of refresh-only posts before SE2-M3; still counted toward today's cap.
  legacyRefreshLabel: 'postSigma_refresh'
} as const;

interface Series {
  block: number[];
  price: number[];
}

/**
 * Onchain MarkUpdated step series per perp, the same logs the jobs ingest (last log per block wins).
 * Fetched only up to Finalized heads, so no reorg handling is needed.
 */
export class MarkHistory {
  private readonly series = new Map<number, Series>();
  private fetchedTo: bigint | null = null;

  constructor(
    private readonly o: { client: ChainClient; perpIds: readonly number[]; chunkBlocks: number; log: Logger; historyBlocks?: bigint }
  ) {
    for (const id of o.perpIds) this.series.set(id, { block: [], price: [] });
  }

  get coveredTo(): bigint | null {
    return this.fetchedTo;
  }

  /** Fetches (coveredTo, toBlock]. Progress is kept per chunk; an error leaves the series contiguous. */
  async catchUp(toBlock: bigint): Promise<void> {
    const history = this.o.historyBlocks ?? SIGMA_POLICY.historyBlocks;
    if (this.fetchedTo !== null && toBlock - this.fetchedTo > history) {
      // Outage longer than the window: start a fresh window rather than bridge the gap with one return.
      this.o.log.warn({ from: this.fetchedTo.toString(), to: toBlock.toString() }, 'sigma.history_reset');
      for (const s of this.series.values()) s.block.length = s.price.length = 0;
      this.fetchedTo = null;
    }
    let from = this.fetchedTo === null ? (toBlock > history ? toBlock - history + 1n : 0n) : this.fetchedTo + 1n;
    const chunk = BigInt(this.o.chunkBlocks);
    while (from <= toBlock) {
      const to = from + chunk - 1n < toBlock ? from + chunk - 1n : toBlock;
      const logs = await getLogs(this.o.client, { address: PERPL_EXCHANGE, event: MARK_UPDATED, fromBlock: from, toBlock: to, strict: true });
      logs.sort((a, b) => (a.blockNumber === b.blockNumber ? a.logIndex - b.logIndex : a.blockNumber < b.blockNumber ? -1 : 1));
      for (const log of logs) {
        const args = log.args as { perpId: bigint; pricePNS: bigint };
        const s = this.series.get(Number(args.perpId));
        if (s) this.append(s, Number(log.blockNumber), Number(args.pricePNS));
      }
      this.fetchedTo = to;
      from = to + 1n;
    }
    this.prune(toBlock - history);
  }

  /** sigmaBlkBpsE2 at `endBlock` exactly as the jobs compute it; null during warm-up. */
  sigmaE2(perpId: number, endBlock: bigint): number | null {
    const s = this.series.get(perpId);
    if (!s || s.block.length < 2) return null;
    const sigma = latestSigma(computeSigmaSeries(s, Number(endBlock)));
    return sigma === null ? null : toSigmaE2(sigma);
  }

  lastMark(perpId: number): { block: number; price: number } | null {
    const s = this.series.get(perpId);
    const n = s?.block.length ?? 0;
    return n > 0 ? { block: s!.block[n - 1]!, price: s!.price[n - 1]! } : null;
  }

  private append(s: Series, block: number, price: number): void {
    const n = s.block.length;
    if (n > 0 && s.block[n - 1] === block) {
      s.price[n - 1] = price;
      return;
    }
    if (n > 0 && block < s.block[n - 1]!) return;
    s.block.push(block);
    s.price.push(price);
  }

  private prune(before: bigint): void {
    const cut = Number(before);
    for (const s of this.series.values()) {
      let i = 0;
      while (i < s.block.length - 1 && s.block[i]! < cut) i++;
      if (i > 0) {
        s.block.splice(0, i);
        s.price.splice(0, i);
      }
    }
  }
}

export interface SigmaDecisionInput {
  estimateE2: number;
  onchainE2: number;
  /** 0 when never posted. */
  postedBlock: bigint;
  head: bigint;
  maxAgeBlocks: number;
  /** A /sigma-refresh (a quote about to be made) within requestTtlMs. */
  quoteRequested: boolean;
}

export type SigmaDecision =
  | { post: true; reason: 'stale' | 'changed' }
  | { post: false; reason: 'no_demand' | 'rate_limited' | 'fresh' };

/**
 * Post only when a quote is pending (SE2-M3: since C5 the contract reads sigma only in quote, never for a live
 * cover) and only when stale or off by > 10%.
 */
export function decideSigmaPost(i: SigmaDecisionInput): SigmaDecision {
  if (!i.quoteRequested) return { post: false, reason: 'no_demand' };
  const age = i.postedBlock === 0n ? null : i.head - i.postedBlock;
  if (age !== null && age < SIGMA_POLICY.minPostIntervalBlocks) return { post: false, reason: 'rate_limited' };
  const staleAt = BigInt(Math.floor(i.maxAgeBlocks * SIGMA_POLICY.staleFraction));
  if (age === null || age >= staleAt) return { post: true, reason: 'stale' };
  const changed = i.onchainE2 === 0 || Math.abs(i.estimateE2 - i.onchainE2) > i.onchainE2 * SIGMA_POLICY.changeRatio;
  return changed ? { post: true, reason: 'changed' } : { post: false, reason: 'fresh' };
}

/** |a - b| / b in bps. */
export function deviationBps(a: number, b: number): number {
  return b === 0 ? Number.POSITIVE_INFINITY : (Math.abs(a - b) / b) * 10_000;
}
