import type { FastifyPluginAsync } from 'fastify';
import { getAddress, isAddress, type Address } from 'viem';
import { z } from 'zod';
import { HttpError, ok } from '../../lib/http.ts';
import { registerOriginGuard } from '../../lib/security.ts';
import { readCapped } from '../perpl/rest.ts';
import { TtlLru } from './wallet.ts';

/** Per-account read data, same budget as /api/wallet/:addr. */
export const INDEXER_RATE_LIMIT = { max: 20, timeWindow: 60_000 } as const;
export const INDEXER_CACHE_MS = 10_000;
/** Upstream queries per minute across all clients: per-IP limits alone do not bound many IPs asking distinct accounts. */
export const INDEXER_UPSTREAM_PER_MIN = 120;
export const INDEXER_MAX_BYTES = 2 * 1024 * 1024;
export const COVER_HISTORY_MAX_LIMIT = 50;
const DEFAULT_LIMIT = 20;
const FETCH_TIMEOUT_MS = 5_000;
const CACHE_MAX = 1_000;

// Address goes in variables only, never into the query text. Envio stores addresses lowercase and exposes
// relations as <field>_id columns; Hasura's public role needs no admin secret.
export const COVER_HISTORY_QUERY = `query CoverHistory($account: String!, $limit: Int!) {
  GaplessAccountEntity_by_pk(id: $account) { id owner }
  Cover(where: {account_id: {_eq: $account}}, order_by: [{boughtBlock: desc}, {id: asc}], limit: $limit) {
    id perpId side status endReason lots stopPNS expiryBlock boughtBlock boughtTx endedBlock endedTx paidCNS
  }
  CoverEvent(where: {cover: {account_id: {_eq: $account}}}, order_by: [{blockNumber: desc}, {logIndex: desc}], limit: $limit) {
    cover_id kind blockNumber logIndex txHash
  }
  chain_metadata { latest_processed_block }
}`;

const params = z.strictObject({
  account: z
    .string()
    .regex(/^0x[0-9a-fA-F]{40}$/, 'must be a 0x-prefixed 20-byte address')
    .refine((v) => isAddress(v, { strict: true }), 'must be checksummed if mixed case')
});
const query = z.strictObject({
  limit: z
    .string()
    .regex(/^\d{1,2}$/, 'must be an integer')
    .transform(Number)
    .pipe(z.number().int().min(1).max(COVER_HISTORY_MAX_LIMIT))
    .optional()
});

// Hasura stringifies numeric (Envio BigInt); Int stays a JSON number.
const bigintStr = z.string().regex(/^\d{1,78}$/);
const blockNo = z.number().int().nonnegative();
const bytes32 = z.string().regex(/^0x[0-9a-fA-F]{64}$/);
const addr = z.string().regex(/^0x[0-9a-fA-F]{40}$/);

// Allowlist: z.object drops unlisted keys, and rows are rebuilt field by field below (Json params never pass).
const coverRow = z.object({
  id: bytes32,
  perpId: z.number().int().min(0).max(65_535),
  side: z.enum(['LONG', 'SHORT']),
  status: z.enum(['LIVE', 'ARMED', 'TRIGGERED', 'FINALIZED', 'CANCELLED', 'EXPIRED', 'VOIDED']),
  endReason: z.enum(['NONE', 'OWNER_CANCEL', 'EXPIRED', 'POSITION_REDUCED', 'POSITION_CLOSED_OR_FLIPPED', 'LIQUIDATED_OR_ADL']),
  lots: bigintStr,
  stopPNS: bigintStr,
  expiryBlock: blockNo,
  boughtBlock: blockNo,
  boughtTx: bytes32,
  endedBlock: blockNo.nullable(),
  endedTx: bytes32.nullable(),
  paidCNS: bigintStr
});
const eventRow = z.object({
  cover_id: bytes32,
  kind: z.enum(['BOUGHT', 'RESIZED', 'ARMED', 'DISARMED', 'TRIGGER_NO_FILL', 'TRIGGERED', 'OBSERVED', 'FINALIZED', 'ENDED', 'PAYOUT_DEFERRED', 'ESCROW_FORFEITED']),
  blockNumber: blockNo,
  logIndex: blockNo,
  txHash: bytes32
});
const responseSchema = z.object({
  data: z.object({
    GaplessAccountEntity_by_pk: z.object({ id: addr, owner: addr }).nullable(),
    Cover: z.array(coverRow).max(COVER_HISTORY_MAX_LIMIT),
    CoverEvent: z.array(eventRow).max(COVER_HISTORY_MAX_LIMIT),
    chain_metadata: z.array(z.object({ latest_processed_block: z.number().int() })).min(1).max(16)
  })
});
const graphqlErrors = z.object({ errors: z.array(z.object({ message: z.string() })).min(1) });

type CoverOut = {
  coverId: string;
  perpId: number;
  side: 'LONG' | 'SHORT';
  status: string;
  endReason: string;
  lots: string;
  stopPNS: string;
  expiryBlock: number;
  boughtBlock: number;
  boughtTx: string;
  endedBlock: number | null;
  endedTx: string | null;
  paidCNS: string;
};
type EventOut = { coverId: string; kind: string; blockNumber: number; logIndex: number; txHash: string };
type History = { account: Address; owner: Address; indexedBlock: number; covers: CoverOut[]; events: EventOut[] };

export interface IndexerRoutesOptions {
  appOrigin: string;
  /** ENVIO_GRAPHQL_URL; unset answers 503. */
  url: string | undefined;
  fetch?: typeof fetch;
  now?: () => number;
}

const unavailable = () => new HttpError(503, 'INDEXER_UNAVAILABLE', 'Cover history is not available right now');

/** GET /cover-history/:account: covers and lifecycle events of one GaplessAccount clone from Envio HyperIndex. */
export const indexerRoutes: FastifyPluginAsync<IndexerRoutesOptions> = async (scope, opts) => {
  registerOriginGuard(scope, opts.appOrigin);
  const now = opts.now ?? Date.now;
  const doFetch = opts.fetch ?? fetch;
  // Built once at the max limit and sliced, so varying limit cannot multiply upstream work.
  const cache = new TtlLru<History | null>(CACHE_MAX, now);
  const inflight = new Map<Address, Promise<History | null>>();
  let budget = { start: Number.NEGATIVE_INFINITY, used: 0 };

  function takeBudget(): boolean {
    const t = now();
    if (t - budget.start >= 60_000) budget = { start: t, used: 0 };
    if (budget.used >= INDEXER_UPSTREAM_PER_MIN) return false;
    budget.used++;
    return true;
  }

  async function pull(url: string, account: Address): Promise<History | null> {
    let text: string;
    try {
      const res = await doFetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ query: COVER_HISTORY_QUERY, operationName: 'CoverHistory', variables: { account: account.toLowerCase(), limit: COVER_HISTORY_MAX_LIMIT } }),
        redirect: 'error',
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
      });
      if (!res.ok) {
        await res.body?.cancel();
        scope.log.warn({ status: res.status }, 'indexer.upstream_status');
        throw unavailable();
      }
      text = await readCapped(res, INDEXER_MAX_BYTES);
    } catch (err) {
      if (err instanceof HttpError) throw err;
      scope.log.warn({ err }, 'indexer.fetch_failed');
      throw unavailable();
    }

    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      scope.log.error({ bytes: text.length }, 'indexer.body_invalid');
      throw unavailable();
    }
    // Hasura reports query errors with HTTP 200; log a bounded message server-side only.
    const errs = graphqlErrors.safeParse(body);
    if (errs.success) {
      scope.log.error({ count: errs.data.errors.length, first: errs.data.errors[0]!.message.slice(0, 200) }, 'indexer.graphql_error');
      throw unavailable();
    }
    const parsed = responseSchema.safeParse(body);
    if (!parsed.success) {
      scope.log.error({ issues: parsed.error.issues.slice(0, 3).map((i) => ({ path: i.path, code: i.code })) }, 'indexer.schema_mismatch');
      throw unavailable();
    }

    const d = parsed.data.data;
    // -1 until the first checkpoint: an unsynced indexer must not read as "no covers".
    const indexedBlock = Math.min(...d.chain_metadata.map((c) => c.latest_processed_block));
    if (indexedBlock < 0) throw new HttpError(503, 'INDEXER_NOT_READY', 'Cover history is still syncing');
    const acct = d.GaplessAccountEntity_by_pk;
    if (!acct || acct.id.toLowerCase() !== account.toLowerCase()) return null;
    return {
      account,
      owner: getAddress(acct.owner.toLowerCase()),
      indexedBlock,
      covers: d.Cover.map((c) => ({
        coverId: c.id.toLowerCase(),
        perpId: c.perpId,
        side: c.side,
        status: c.status,
        endReason: c.endReason,
        lots: c.lots,
        stopPNS: c.stopPNS,
        expiryBlock: c.expiryBlock,
        boughtBlock: c.boughtBlock,
        boughtTx: c.boughtTx.toLowerCase(),
        endedBlock: c.endedBlock,
        endedTx: c.endedTx?.toLowerCase() ?? null,
        paidCNS: c.paidCNS
      })),
      events: d.CoverEvent.map((e) => ({
        coverId: e.cover_id.toLowerCase(),
        kind: e.kind,
        blockNumber: e.blockNumber,
        logIndex: e.logIndex,
        txHash: e.txHash.toLowerCase()
      }))
    };
  }

  scope.get('/cover-history/:account', { config: { rateLimit: INDEXER_RATE_LIMIT } }, async (request, reply) => {
    const url = opts.url;
    if (!url) throw new HttpError(503, 'INDEXER_NOT_CONFIGURED', 'Cover history is not configured');
    const account = getAddress(params.parse(request.params).account.toLowerCase());
    const limit = query.parse(request.query).limit ?? DEFAULT_LIMIT;

    let value: History | null;
    const hit = cache.get(account);
    if (hit) {
      value = hit.value;
    } else {
      let p = inflight.get(account);
      if (!p) {
        if (!takeBudget()) {
          scope.log.warn('indexer.budget_exhausted');
          throw new HttpError(503, 'INDEXER_BUSY', 'Cover history is busy, retry shortly');
        }
        p = pull(url, account).finally(() => inflight.delete(account));
        inflight.set(account, p);
      }
      value = await p;
      cache.set(account, value, INDEXER_CACHE_MS);
    }
    if (!value) throw new HttpError(404, 'ACCOUNT_NOT_FOUND', 'No Gapless account at this address');
    reply.header('Cache-Control', `public, max-age=${INDEXER_CACHE_MS / 1000}`);
    return ok({ ...value, limit, covers: value.covers.slice(0, limit), events: value.events.slice(0, limit) });
  });
};
