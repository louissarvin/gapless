import type { FastifyPluginAsync } from 'fastify';
import { getAddress, type Address } from 'viem';
import { z } from 'zod';
import type { Database } from '../../lib/db.ts';
import { HttpError, ok } from '../../lib/http.ts';
import { registerOriginGuard } from '../../lib/security.ts';
import { gaplessForAddress } from '../../jobs/gapless.ts';
import { openJobsDbReadonly } from '../../jobs/store.ts';
import { buildWalletHistory, emptyWalletHistory, type WalletHistory } from '../../jobs/wallet.ts';

/** Each miss costs one RPC read (unless the account id is cached) plus bounded SQLite reads. */
export const WALLET_RATE_LIMIT = { max: 20, timeWindow: 60_000 } as const;
export const WALLET_CACHE_MS = 60_000;
/** An address's Perpl account id never changes once created, so hits are kept much longer. */
export const ACCOUNT_ID_CACHE_MS = 60 * 60_000;
// Bounds memory: at most 200 results of at most 3 x 200 rows, and 5,000 address-to-id entries.
export const WALLET_CACHE_MAX = 200;
const ACCOUNT_ID_CACHE_MAX = 5_000;
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 200;

export interface WalletRoutesOptions {
  appOrigin: string;
  /** The jobs JOBS_DB_PATH, opened read-only. */
  jobsDbPath: string;
  /** Owner address to Perpl account id, null when it has none (see resolvePerplAccountId). */
  resolveAccountId: (address: Address) => Promise<bigint | null>;
  now?: () => number;
}

const params = z.strictObject({
  addr: z.string().regex(/^0x[0-9a-fA-F]{40}$/, 'must be a 0x-prefixed 20-byte address')
});
const query = z.strictObject({
  limit: z
    .string()
    .regex(/^\d{1,3}$/, 'must be an integer')
    .transform(Number)
    .pipe(z.number().int().min(1).max(MAX_LIMIT))
    .optional()
});

type GaplessBlock = { account: Address; owner: Address; covers: { coverId: string; status: string; stopPNS: string; paidCNS: string; perpId: number }[] };
type History = Omit<WalletHistory, 'accountId'> & { accountId: string | null };
type Result = { address: Address; gapless: GaplessBlock | null } & History;

/** Map with TTL and LRU eviction: a hit refreshes recency, the oldest entry goes first. */
class TtlLru<V> {
  private readonly m = new Map<string, { value: V; until: number }>();
  constructor(
    private readonly max: number,
    private readonly now: () => number
  ) {}

  get(key: string): { value: V } | undefined {
    const e = this.m.get(key);
    if (!e) return undefined;
    this.m.delete(key);
    if (this.now() >= e.until) return undefined;
    this.m.set(key, e);
    return { value: e.value };
  }

  set(key: string, value: V, ttlMs: number): void {
    this.m.delete(key);
    if (this.m.size >= this.max) this.m.delete(this.m.keys().next().value!);
    this.m.set(key, { value, until: this.now() + ttlMs });
  }
}

function slice(r: Result, limit: number): Result {
  return {
    ...r,
    limit,
    positions: r.positions.slice(0, limit),
    fills: r.fills.slice(0, limit),
    collateral: r.collateral.slice(0, limit),
    nativeStops: r.nativeStops.slice(0, limit)
  };
}

/**
 * GET /:addr: Perpl fills, position, collateral and native stop history for the account owned by addr (or by its
 * Gapless clone), plus the Gapless account and covers when addr is a Gapless owner or account.
 */
export const walletRoutes: FastifyPluginAsync<WalletRoutesOptions> = async (scope, opts) => {
  registerOriginGuard(scope, opts.appOrigin);
  const now = opts.now ?? Date.now;
  // Keyed by address only: the history is built once at MAX_LIMIT and sliced, so varying limit cannot multiply work.
  const cache = new TtlLru<Result | null>(WALLET_CACHE_MAX, now);
  const accountIds = new TtlLru<bigint>(ACCOUNT_ID_CACHE_MAX, now);
  const inflight = new Map<string, Promise<Result | null>>();
  let db: Database | null = null;

  function jobsDb(): Database {
    if (db) return db;
    try {
      db = openJobsDbReadonly(opts.jobsDbPath);
      return db;
    } catch (err) {
      scope.log.warn({ err }, 'wallet.jobs_db_unavailable');
      throw new HttpError(503, 'WALLET_DATA_NOT_READY', 'Wallet history is not available yet');
    }
  }
  scope.addHook('onClose', async () => db?.close(false));

  async function accountIdOf(address: Address): Promise<bigint | null> {
    const hit = accountIds.get(address);
    if (hit) return hit.value;
    let id: bigint | null;
    try {
      id = await opts.resolveAccountId(address);
    } catch (err) {
      scope.log.warn({ err }, 'wallet.resolve_failed');
      throw new HttpError(503, 'UPSTREAM_UNAVAILABLE', 'Chain read failed, try again shortly');
    }
    // Only positives: an address without an account can create one at any time.
    if (id !== null) accountIds.set(address, id, ACCOUNT_ID_CACHE_MS);
    return id;
  }

  // Gapless owner or clone (jobs gapless_logs); null when the store is missing or predates migration 3.
  function gaplessOf(address: Address): GaplessBlock | null {
    let d: Database;
    try {
      d = jobsDb();
    } catch {
      return null;
    }
    try {
      const g = gaplessForAddress(d, address);
      return g && { account: g.account, owner: g.owner, covers: g.covers.map((c) => ({ coverId: c.coverId, status: c.status, stopPNS: c.stopPNS, paidCNS: c.paidCNS, perpId: c.perpId })) };
    } catch (err) {
      scope.log.warn({ err }, 'wallet.gapless_unavailable');
      return null;
    }
  }

  async function lookup(address: Address): Promise<Result | null> {
    const gapless = gaplessOf(address);
    let accountId = await accountIdOf(address);
    // An owner EOA trades through its clone: the Perpl account belongs to the clone.
    if (accountId === null && gapless && gapless.account !== address) accountId = await accountIdOf(gapless.account);
    if (accountId === null && !gapless) return null;
    if (accountId !== null && accountId > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('account id out of range');
    const history: History = accountId === null ? emptyWalletHistory(jobsDb(), MAX_LIMIT) : buildWalletHistory(jobsDb(), Number(accountId), MAX_LIMIT);
    return { address, ...history, gapless };
  }

  scope.get('/:addr', { config: { rateLimit: WALLET_RATE_LIMIT } }, async (request, reply) => {
    const { addr } = params.parse(request.params);
    const limit = query.parse(request.query).limit ?? DEFAULT_LIMIT;
    const address = getAddress(addr.toLowerCase());

    let value: Result | null;
    const hit = cache.get(address);
    if (hit) {
      value = hit.value;
    } else {
      let p = inflight.get(address);
      if (!p) {
        p = lookup(address).finally(() => inflight.delete(address));
        inflight.set(address, p);
      }
      value = await p;
      cache.set(address, value, WALLET_CACHE_MS);
    }
    if (!value) throw new HttpError(404, 'ACCOUNT_NOT_FOUND', 'No Perpl account for this address');
    reply.header('Cache-Control', `public, max-age=${WALLET_CACHE_MS / 1000}`);
    return ok(slice(value, limit));
  });
};
