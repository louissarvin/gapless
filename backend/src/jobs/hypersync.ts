import { HypersyncClient, setLogLevel, type Query } from '@envio-dev/hypersync-client';
import type { Hex } from 'viem';
import { PERPL_EXCHANGE } from '../lib/addresses.ts';
import type { Database } from '../lib/db.ts';
import type { Logger } from '../lib/log.ts';
import { CONFIRMATION_BLOCKS, MIN_BLOCK_TIME_S } from './config.ts';
import { PERPL_TOPICS } from './perpl.ts';
import { batchRowCount, emptyBatch, logsToRows, type RawLog } from './rows.ts';
import { commitPage, getIngestState, pruneBefore } from './store.ts';

export interface LogPage {
  logs: RawLog[];
  blockTs: Map<number, number>;
  /** First block not yet covered; continue from here. */
  nextBlock: number;
}

/** What ingest needs from HyperSync; tests pass a fake. */
export interface LogSource {
  getHeight(): Promise<number>;
  /** Exchange logs for PERPL_TOPICS in [fromBlock, toBlock); may stop early (server time limit). */
  getPage(fromBlock: number, toBlock: number): Promise<LogPage>;
}

/** The two client calls the source uses, so tests can replay a recorded response shape. */
export type HypersyncLike = Pick<HypersyncClient, 'get' | 'getHeight'>;

const HEX = /^0x[0-9a-fA-F]*$/;
const asHex = (v: unknown, field: string): Hex => {
  if (typeof v !== 'string' || !HEX.test(v)) throw new Error(`hypersync: bad ${field}`);
  return v as Hex;
};
const asInt = (v: unknown, field: string): number => {
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0) throw new Error(`hypersync: bad ${field}`);
  return v;
};

export function createHypersyncClient(url: string, apiToken: string): HypersyncClient {
  // The native client logs plain text to stderr; failures reach our JSON logs via the thrown error.
  setLogLevel('off');
  // Few retries: a bad token or outage should surface within one run, not stall it.
  return new HypersyncClient({ url, apiToken, httpReqTimeoutMillis: 30_000, maxNumRetries: 3 });
}

export const PAGE_QUERY_FIELDS = {
  log: ['BlockNumber', 'LogIndex', 'TransactionHash', 'Data', 'Topic0'],
  block: ['Number', 'Timestamp']
} as const satisfies Query['fieldSelection'];

// 1.4.1 client: PascalCase field names, toBlock exclusive, blocks joined to matched logs (default join).
// A malformed field fails the whole page: the response itself is suspect, so it is retried, not quarantined.
export function createHypersyncSource(client: HypersyncLike): LogSource {
  return {
    getHeight: () => client.getHeight(),
    async getPage(fromBlock, toBlock) {
      const query: Query = {
        fromBlock,
        toBlock,
        logs: [{ address: [PERPL_EXCHANGE], topics: [[...PERPL_TOPICS]] }],
        fieldSelection: { log: [...PAGE_QUERY_FIELDS.log], block: [...PAGE_QUERY_FIELDS.block] }
      };
      const res = await client.get(query);
      const blockTs = new Map<number, number>();
      for (const b of res.data.blocks) blockTs.set(asInt(b.number, 'block.number'), asInt(b.timestamp, 'block.timestamp'));
      const logs: RawLog[] = res.data.logs.map((l) => ({
        blockNumber: asInt(l.blockNumber, 'log.blockNumber'),
        logIndex: asInt(l.logIndex, 'log.logIndex'),
        transactionHash: asHex(l.transactionHash, 'log.transactionHash'),
        topics: l.topics.filter((t): t is string => typeof t === 'string').map((t) => asHex(t, 'log.topic')),
        data: asHex(l.data ?? '0x', 'log.data')
      }));
      return { logs, blockTs, nextBlock: asInt(res.nextBlock, 'nextBlock') };
    }
  };
}

export const windowBlocks = (days: number): number => Math.ceil((days * 86_400) / MIN_BLOCK_TIME_S);

export interface IngestResult {
  fromBlock: number;
  toBlock: number;
  pages: number;
  rows: number;
  quarantined: number;
  pruned: number;
  windowFromBlock: number;
  coverageFromBlock: number;
  aborted: boolean;
}

export interface IngestOptions {
  windowDays: number;
  signal: AbortSignal;
  log: Logger;
  now?: () => Date;
  /** Called before each page commit; throws when this process no longer holds the writer lease. */
  renewLease?: () => void;
}

/**
 * Pulls Exchange logs from the stored cursor (or window start) up to height minus
 * CONFIRMATION_BLOCKS, one transaction per page, then prunes rows older than the window.
 */
export async function ingest(db: Database, source: LogSource, opts: IngestOptions): Promise<IngestResult> {
  const now = opts.now ?? (() => new Date());
  const height = await source.getHeight();
  const target = height - CONFIRMATION_BLOCKS;
  const windowFromBlock = Math.max(0, target - windowBlocks(opts.windowDays));
  const state = getIngestState(db);
  // After downtime longer than the window, skip to the window start; the covered range restarts there.
  const contiguous = state !== null && state.nextBlock >= windowFromBlock;
  let from = contiguous ? state.nextBlock : windowFromBlock;
  const coverageFromBlock = contiguous ? state.coverageFromBlock : from;
  const start = from;
  let pages = 0;
  let rows = 0;
  let quarantined = 0;
  while (from < target) {
    if (opts.signal.aborted) break;
    const page = await source.getPage(from, target);
    if (page.nextBlock <= from) throw new Error(`hypersync: no progress at block ${from}`);
    const next = Math.min(page.nextBlock, target);
    const batch = logsToRows(page.logs, page.blockTs);
    for (const q of batch.quarantined) {
      opts.log.error(
        { block: q.block, logIndex: q.logIndex, txHash: q.txHash, topic0: q.topic0, reason: q.reason },
        'jobs.log_quarantined'
      );
    }
    opts.renewLease?.();
    commitPage(db, batch, { nextBlock: next, windowFromBlock, coverageFromBlock }, now().toISOString());
    pages++;
    rows += batchRowCount(batch);
    quarantined += batch.quarantined.length;
    opts.log.debug({ from, next, logs: page.logs.length }, 'jobs.ingest_page');
    from = next;
  }
  // Keep the stored window bounds current even when there was nothing new to fetch.
  if (pages === 0) {
    opts.renewLease?.();
    commitPage(db, emptyBatch(), { nextBlock: from, windowFromBlock, coverageFromBlock }, now().toISOString());
  }
  const pruned = pruneBefore(db, windowFromBlock);
  return {
    fromBlock: start,
    toBlock: from,
    pages,
    rows,
    quarantined,
    pruned,
    windowFromBlock,
    coverageFromBlock,
    aborted: opts.signal.aborted
  };
}
