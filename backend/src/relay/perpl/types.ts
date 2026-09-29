import { z } from 'zod';

/**
 * Perpl market-data wire types (docs.perpl.xyz api/websocket.md, api-docs rest-endpoints.md),
 * checked against live frames on 2026-10-05. Prices and sizes are scaled integers: divide by
 * 10^price_decimals / 10^size_decimals from GET /api/v1/pub/context.
 */
export const MT = {
  PING: 1,
  PONG: 2,
  SUBSCRIBE: 5,
  SUBSCRIPTION: 6,
  MARKET_STATE: 9,
  BOOK_SNAPSHOT: 15,
  BOOK_UPDATE: 16,
  TRADES_SNAPSHOT: 17,
  TRADES_UPDATE: 18,
  HEARTBEAT: 100
} as const;

/** Docs: at most 16 subscriptions per market-data connection. */
export const MAX_UPSTREAM_SUBSCRIPTIONS = 16;

const uint = z.number().int().nonnegative();
const marketKey = z.string().regex(/^\d{1,10}$/);

export const blockTimestamp = z.object({ b: uint.optional(), t: uint.optional() });

export const l2Level = z.object({ p: uint, s: uint, o: uint });

export const marketState = z.object({
  at: blockTimestamp,
  orl: z.number(),
  mrk: z.number(),
  lst: z.number(),
  mid: z.number(),
  bid: z.number(),
  ask: z.number(),
  prv: z.number(),
  dv: z.number(),
  dva: z.string(),
  oi: z.number(),
  tvl: z.string()
});

export const trade = z.object({
  at: z.object({
    b: uint.optional(),
    t: uint.optional(),
    tx: uint.optional(),
    txid: z.string().max(80).optional(),
    l: uint.optional()
  }),
  p: uint,
  s: uint,
  sd: z.union([z.literal(1), z.literal(2)])
});

const pong = z.object({ mt: z.literal(MT.PONG), sn: uint.optional(), t: uint.optional() });

const subscription = z.object({
  mt: z.literal(MT.SUBSCRIPTION),
  subs: z.array(
    z.object({
      stream: z.string().max(64),
      sid: uint.optional(),
      status: z.object({ code: z.number().int(), error: z.string().max(200).optional() }).optional()
    })
  )
});

const marketStateUpdate = z.object({
  mt: z.literal(MT.MARKET_STATE),
  sid: uint.optional(),
  sn: uint.optional(),
  d: z.record(marketKey, marketState)
});

function bookFrame<M extends number>(mt: M) {
  return z.object({
    mt: z.literal(mt),
    sid: uint,
    sn: uint,
    at: blockTimestamp,
    bid: z.array(l2Level).max(5000).default([]),
    ask: z.array(l2Level).max(5000).default([])
  });
}

function tradesFrame<M extends number>(mt: M) {
  return z.object({ mt: z.literal(mt), sid: uint, sn: uint.optional(), d: z.array(trade).max(5000) });
}

const heartbeat = z.object({ mt: z.literal(MT.HEARTBEAT), sid: uint.optional(), sn: uint, h: uint });

export const perplFrame = z.discriminatedUnion('mt', [
  pong,
  subscription,
  marketStateUpdate,
  bookFrame(MT.BOOK_SNAPSHOT),
  bookFrame(MT.BOOK_UPDATE),
  tradesFrame(MT.TRADES_SNAPSHOT),
  tradesFrame(MT.TRADES_UPDATE),
  heartbeat
]);

export type BlockTimestamp = z.infer<typeof blockTimestamp>;
export type L2Level = z.infer<typeof l2Level>;
export type MarketState = z.infer<typeof marketState>;
export type Trade = z.infer<typeof trade>;
export type PerplFrame = z.infer<typeof perplFrame>;
export type SubscriptionFrame = z.infer<typeof subscription>;
export type BookFrame = Extract<PerplFrame, { mt: 15 | 16 }>;
export type TradesFrame = Extract<PerplFrame, { mt: 17 | 18 }>;

const KNOWN_MT = new Set<number>(Object.values(MT));

export type ParseResult =
  | { ok: true; frame: PerplFrame }
  | { ok: false; reason: 'json' | 'not_object' | 'unknown_mt' | 'schema'; mt?: number };

/** Parses one upstream text frame. Unknown message types are reported, not thrown. */
export function parseFrame(raw: string): ParseResult {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return { ok: false, reason: 'json' };
  }
  if (json === null || typeof json !== 'object' || Array.isArray(json)) return { ok: false, reason: 'not_object' };
  const mt = (json as { mt?: unknown }).mt;
  if (typeof mt !== 'number' || !KNOWN_MT.has(mt) || mt === MT.PING || mt === MT.SUBSCRIBE) {
    return { ok: false, reason: 'unknown_mt', mt: typeof mt === 'number' ? mt : undefined };
  }
  const parsed = perplFrame.safeParse(json);
  return parsed.success ? { ok: true, frame: parsed.data } : { ok: false, reason: 'schema', mt };
}

/** Stream names per docs: chain-scoped `<name>@<chainId>`, market-scoped `<name>@<marketId>`. */
export function marketDataStreams(chainId: number, marketIds: readonly number[]): string[] {
  const streams = [`heartbeat@${chainId}`, `market-state@${chainId}`];
  for (const id of marketIds) streams.push(`order-book@${id}`, `trades@${id}`);
  if (streams.length > MAX_UPSTREAM_SUBSCRIPTIONS) {
    throw new Error(`too many upstream subscriptions: ${streams.length} > ${MAX_UPSTREAM_SUBSCRIPTIONS}`);
  }
  return streams;
}

export function subscribeMessage(streams: readonly string[]): string {
  return JSON.stringify({ mt: MT.SUBSCRIBE, subs: streams.map((stream) => ({ stream, subscribe: true })) });
}

export function pingMessage(nowMs: number): string {
  return JSON.stringify({ mt: MT.PING, t: nowMs });
}

/**
 * Relay control frame on /ws/market, never sent by Perpl (its mts stay below 9000).
 * `down`: upstream lost, treat every book, trade list and quote as unsynced until fresh snapshots.
 * `up` / `partial`: upstream subscribed again (`missing` lists streams Perpl did not acknowledge).
 */
export const RELAY_STATUS_MT = 9000;
export type RelayFeedStatus = 'up' | 'partial' | 'down';

export const relayStatusFrame = z.object({
  mt: z.literal(RELAY_STATUS_MT),
  status: z.enum(['up', 'partial', 'down']),
  t: uint,
  missing: z.array(z.string().max(64)).max(MAX_UPSTREAM_SUBSCRIPTIONS).optional()
});
export type RelayStatusFrame = z.infer<typeof relayStatusFrame>;

export function relayStatusMessage(status: RelayFeedStatus, t: number, missing: readonly string[] = []): string {
  return JSON.stringify({ mt: RELAY_STATUS_MT, status, t, ...(missing.length > 0 ? { missing } : {}) });
}

/** Parses one /ws/market frame (Perpl wire frames plus the relay status frame), for relay clients. */
export function parseRelayFrame(raw: string): { ok: true; frame: PerplFrame | RelayStatusFrame } | Exclude<ParseResult, { ok: true }> {
  let mt: unknown;
  try {
    mt = (JSON.parse(raw) as { mt?: unknown } | null)?.mt;
  } catch {
    return { ok: false, reason: 'json' };
  }
  if (mt !== RELAY_STATUS_MT) return parseFrame(raw);
  const parsed = relayStatusFrame.safeParse(JSON.parse(raw));
  return parsed.success ? { ok: true, frame: parsed.data } : { ok: false, reason: 'schema', mt: RELAY_STATUS_MT };
}
