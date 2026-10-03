import { z } from 'zod'
import { env } from '@/env'

/**
 * `/ws/market` client (ARCHITECTURE 5.2, backend/CLAUDE.md "Relay market
 * data"). Perpl wire format passthrough: the relay fans out one upstream
 * Perpl connection byte for byte, keyed by `sid`, plus its own status frame.
 * Display only: the limit and mark used in any trade always come from chain
 * reads (ARCHITECTURE 5.2), never from here.
 */

const MT = {
  PING: 1,
  PONG: 2,
  SUBSCRIPTION: 6,
  MARKET_STATE: 9,
  BOOK_SNAPSHOT: 15,
  BOOK_UPDATE: 16,
  HEARTBEAT: 100,
  STATUS: 9000,
} as const

const uint = z.number().int().nonnegative()
const l2Level = z.object({ p: uint, s: uint, o: uint })

const statusFrameSchema = z.object({
  mt: z.literal(MT.STATUS),
  status: z.enum(['up', 'partial', 'down']),
})

const subscriptionFrameSchema = z.object({
  mt: z.literal(MT.SUBSCRIPTION),
  subs: z.array(z.object({ stream: z.string(), sid: uint.optional() }).loose()),
})

const heartbeatFrameSchema = z.object({
  mt: z.literal(MT.HEARTBEAT),
  sn: uint,
})

const marketStateEntrySchema = z
  .object({
    at: z.object({ t: uint.optional() }).loose(),
    mrk: z.number(),
    lst: z.number(),
    mid: z.number(),
    bid: z.number(),
    ask: z.number(),
  })
  .loose()

const marketStateFrameSchema = z.object({
  mt: z.literal(MT.MARKET_STATE),
  d: z.record(z.string(), marketStateEntrySchema),
})

function bookFrameSchema<TMt extends number>(mt: TMt) {
  return z.object({
    mt: z.literal(mt),
    sid: uint,
    bid: z.array(l2Level).default([]),
    ask: z.array(l2Level).default([]),
  })
}
const bookSnapshotSchema = bookFrameSchema(MT.BOOK_SNAPSHOT)
const bookUpdateSchema = bookFrameSchema(MT.BOOK_UPDATE)

/** Perpl-scaled integers; divide by `10 ** priceDecimals` to display (same scale as chain PNS). */
export interface MarketQuoteScaled {
  markScaled: number
  lastScaled: number
  midScaled: number
  bidScaled: number
  askScaled: number
  atMs: number | null
}

export interface BookLevel {
  priceScaled: number
  sizeScaled: number
}

export interface MarketBook {
  bids: Array<BookLevel>
  asks: Array<BookLevel>
}

export type MarketSyncStatus = 'connecting' | 'synced' | 'unsynced'

export interface MarketSnapshot {
  status: MarketSyncStatus
  quote: MarketQuoteScaled | null
  book: MarketBook | null
  /** When `quote` or `book` last changed, display-only ("Updated Ns ago"). */
  updatedAtMs: number | null
}

interface BookState {
  bids: Map<number, number>
  asks: Map<number, number>
}

interface MarketEntry {
  book: BookState
  quote: MarketQuoteScaled | null
  hasBookSnapshot: boolean
  updatedAtMs: number | null
}

/** Keeps each side under this many levels; the UI never shows more than 20. */
const MAX_STORED_LEVELS = 64

function applyLevels(
  map: Map<number, number>,
  levels: ReadonlyArray<z.infer<typeof l2Level>>,
) {
  for (const level of levels) {
    if (level.o === 0) map.delete(level.p)
    else map.set(level.p, level.s)
  }
}

function trimBook(map: Map<number, number>, side: 'bid' | 'ask') {
  if (map.size <= MAX_STORED_LEVELS) return
  const sorted = [...map.keys()].sort((a, b) =>
    side === 'bid' ? b - a : a - b,
  )
  for (const price of sorted.slice(MAX_STORED_LEVELS)) map.delete(price)
}

function sortedLevels(
  map: Map<number, number>,
  side: 'bid' | 'ask',
  depth: number,
): Array<BookLevel> {
  const entries = [...map.entries()].sort((a, b) =>
    side === 'bid' ? b[0] - a[0] : a[0] - b[0],
  )
  return entries
    .slice(0, depth)
    .map(([priceScaled, sizeScaled]) => ({ priceScaled, sizeScaled }))
}

const RECONNECT_MIN_MS = 1_000
const RECONNECT_MAX_MS = 30_000
const RECYCLED_CLOSE_CODE = 1001
const POLICY_CLOSE_CODE = 1008
const POLICY_BACKOFF_MS = 16_000
const KEEPALIVE_INTERVAL_MS = 30_000
const REST_FALLBACK_INTERVAL_MS = 3_000
const BOOK_LEVELS_TO_KEEP = 20

const restTickerSchema = z.object({
  success: z.literal(true),
  data: z.object({ d: z.record(z.string(), marketStateEntrySchema) }),
})
const restBookSchema = z.object({
  success: z.literal(true),
  data: z.object({
    bid: z.array(l2Level).default([]),
    ask: z.array(l2Level).default([]),
  }),
})

/**
 * One socket, fanned out to every subscriber in this tab via `acquire`/
 * `release` refcounting. Reconnect and REST-fallback rules per ARCHITECTURE
 * 5.2: 1 s doubling to 30 s with jitter, 1001 reconnects at once, 1008 backs
 * off a fixed 16 s, `GET /api/perpl/{ticker,book}/:id` while the socket is down.
 */
class MarketWsClient {
  private socket: WebSocket | null = null
  private sidMap = new Map<number, { kind: 'book'; marketId: number }>()
  private markets = new Map<number, MarketEntry>()
  private listeners = new Set<() => void>()
  private refCounts = new Map<number, number>()
  private reconnectAttempt = 0
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private keepaliveTimer: ReturnType<typeof setInterval> | null = null
  private restFallbackTimer: ReturnType<typeof setInterval> | null = null
  private down = true
  private boundVisibility = false

  acquire(perpId: number) {
    const next = (this.refCounts.get(perpId) ?? 0) + 1
    this.refCounts.set(perpId, next)
    this.entryFor(perpId)
    this.bindLifecycleListenersOnce()
    if (this.totalRefCount() === 1) this.connect()
  }

  release(perpId: number) {
    const next = (this.refCounts.get(perpId) ?? 1) - 1
    if (next <= 0) this.refCounts.delete(perpId)
    else this.refCounts.set(perpId, next)
    if (this.totalRefCount() === 0) this.teardown()
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  getSnapshot(perpId: number): MarketSnapshot {
    const entry = this.markets.get(perpId)
    if (!entry)
      return {
        status: 'connecting',
        quote: null,
        book: null,
        updatedAtMs: null,
      }
    const status: MarketSyncStatus = this.down
      ? 'unsynced'
      : entry.hasBookSnapshot && entry.quote
        ? 'synced'
        : 'connecting'
    const book: MarketBook | null = entry.hasBookSnapshot
      ? {
          bids: sortedLevels(entry.book.bids, 'bid', BOOK_LEVELS_TO_KEEP),
          asks: sortedLevels(entry.book.asks, 'ask', BOOK_LEVELS_TO_KEEP),
        }
      : null
    return { status, quote: entry.quote, book, updatedAtMs: entry.updatedAtMs }
  }

  private totalRefCount(): number {
    let total = 0
    for (const count of this.refCounts.values()) total += count
    return total
  }

  private entryFor(marketId: number): MarketEntry {
    let entry = this.markets.get(marketId)
    if (!entry) {
      entry = {
        book: { bids: new Map(), asks: new Map() },
        quote: null,
        hasBookSnapshot: false,
        updatedAtMs: null,
      }
      this.markets.set(marketId, entry)
    }
    return entry
  }

  private emit() {
    for (const listener of this.listeners) listener()
  }

  private connect() {
    if (typeof WebSocket === 'undefined') return
    this.clearReconnectTimer()
    let socket: WebSocket
    try {
      socket = new WebSocket(env.VITE_RELAY_WS_URL)
    } catch {
      this.scheduleReconnect(0)
      return
    }
    this.socket = socket
    socket.addEventListener('open', this.handleOpen)
    socket.addEventListener('message', this.handleMessage)
    socket.addEventListener('close', this.handleClose)
    // A close event always follows; nothing else to do here.
    socket.addEventListener('error', () => {})
  }

  private handleOpen = () => {
    this.reconnectAttempt = 0
    this.stopRestFallback()
    this.startKeepalive()
  }

  private handleMessage = (event: MessageEvent) => {
    if (typeof event.data !== 'string') return
    let json: unknown
    try {
      json = JSON.parse(event.data)
    } catch {
      return
    }
    if (json === null || typeof json !== 'object' || Array.isArray(json)) return
    const mt = (json as { mt?: unknown }).mt
    if (typeof mt !== 'number') return

    switch (mt) {
      case MT.STATUS:
        this.handleStatus(json)
        break
      case MT.SUBSCRIPTION:
        this.handleSubscription(json)
        break
      case MT.HEARTBEAT:
        this.handleHeartbeat(json)
        break
      case MT.MARKET_STATE:
        this.handleMarketState(json)
        break
      case MT.BOOK_SNAPSHOT:
        this.handleBook(json, true)
        break
      case MT.BOOK_UPDATE:
        this.handleBook(json, false)
        break
      default:
        // Pong, trades and anything else: no display state depends on them.
        break
    }
    this.emit()
  }

  private markAllUnsynced() {
    this.down = true
    for (const entry of this.markets.values()) entry.hasBookSnapshot = false
  }

  private handleStatus(json: unknown) {
    const parsed = statusFrameSchema.safeParse(json)
    if (!parsed.success) return
    if (parsed.data.status === 'down') {
      this.sidMap.clear()
      this.markAllUnsynced()
    } else {
      // "up" or "partial": real sync happens once the next mt 6 and its
      // snapshots land (handleSubscription clears hasBookSnapshot again).
      this.down = false
    }
  }

  private lastHeartbeatSn: number | null = null

  private handleSubscription(json: unknown) {
    const parsed = subscriptionFrameSchema.safeParse(json)
    if (!parsed.success) return
    this.sidMap.clear()
    this.lastHeartbeatSn = null
    for (const sub of parsed.data.subs) {
      if (sub.sid === undefined) continue
      const bookMatch = /^order-book@(\d+)$/.exec(sub.stream)
      if (bookMatch)
        this.sidMap.set(sub.sid, {
          kind: 'book',
          marketId: Number(bookMatch[1]),
        })
    }
    for (const entry of this.markets.values()) entry.hasBookSnapshot = false
  }

  private handleHeartbeat(json: unknown) {
    const parsed = heartbeatFrameSchema.safeParse(json)
    if (!parsed.success) return
    if (
      this.lastHeartbeatSn !== null &&
      parsed.data.sn !== this.lastHeartbeatSn + 1
    ) {
      // A gap: resync only once a fresh mt 6 and its snapshots arrive.
      this.markAllUnsynced()
    }
    this.lastHeartbeatSn = parsed.data.sn
  }

  private handleMarketState(json: unknown) {
    const parsed = marketStateFrameSchema.safeParse(json)
    if (!parsed.success) return
    const now = Date.now()
    for (const [key, state] of Object.entries(parsed.data.d)) {
      const marketId = Number(key)
      if (!this.refCounts.has(marketId)) continue
      const entry = this.entryFor(marketId)
      entry.quote = {
        markScaled: state.mrk,
        lastScaled: state.lst,
        midScaled: state.mid,
        bidScaled: state.bid,
        askScaled: state.ask,
        atMs: state.at.t ?? null,
      }
      entry.updatedAtMs = now
    }
  }

  private handleBook(json: unknown, isSnapshot: boolean) {
    const parsed = (
      isSnapshot ? bookSnapshotSchema : bookUpdateSchema
    ).safeParse(json)
    if (!parsed.success) return
    const sidInfo = this.sidMap.get(parsed.data.sid)
    if (!sidInfo || !this.refCounts.has(sidInfo.marketId)) return
    const entry = this.entryFor(sidInfo.marketId)
    if (isSnapshot) {
      entry.book.bids.clear()
      entry.book.asks.clear()
    }
    applyLevels(entry.book.bids, parsed.data.bid)
    applyLevels(entry.book.asks, parsed.data.ask)
    trimBook(entry.book.bids, 'bid')
    trimBook(entry.book.asks, 'ask')
    if (isSnapshot) entry.hasBookSnapshot = true
    entry.updatedAtMs = Date.now()
  }

  private handleClose = (event: CloseEvent) => {
    this.stopKeepalive()
    this.socket = null
    this.markAllUnsynced()
    this.startRestFallback()
    this.emit()
    if (this.totalRefCount() > 0) this.scheduleReconnect(event.code)
  }

  private scheduleReconnect(code: number) {
    this.clearReconnectTimer()
    let delayMs: number
    if (code === RECYCLED_CLOSE_CODE) {
      delayMs = 0
      this.reconnectAttempt = 0
    } else if (code === POLICY_CLOSE_CODE) {
      delayMs = POLICY_BACKOFF_MS
      this.reconnectAttempt = 0
    } else {
      const base = Math.min(
        RECONNECT_MAX_MS,
        RECONNECT_MIN_MS * 2 ** this.reconnectAttempt,
      )
      delayMs = base / 2 + Math.random() * (base / 2)
      this.reconnectAttempt += 1
    }
    this.reconnectTimer = setTimeout(() => {
      if (this.totalRefCount() > 0) this.connect()
    }, delayMs)
  }

  private clearReconnectTimer() {
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
  }

  private startKeepalive() {
    this.stopKeepalive()
    this.keepaliveTimer = setInterval(() => {
      this.socket?.send(JSON.stringify({ mt: MT.PING, t: Date.now() }))
    }, KEEPALIVE_INTERVAL_MS)
  }

  private stopKeepalive() {
    if (this.keepaliveTimer !== null) {
      clearInterval(this.keepaliveTimer)
      this.keepaliveTimer = null
    }
  }

  private startRestFallback() {
    if (this.restFallbackTimer !== null) return
    this.restFallbackTimer = setInterval(() => {
      for (const perpId of this.refCounts.keys())
        void this.fetchRestFallback(perpId)
    }, REST_FALLBACK_INTERVAL_MS)
    for (const perpId of this.refCounts.keys())
      void this.fetchRestFallback(perpId)
  }

  private stopRestFallback() {
    if (this.restFallbackTimer !== null) {
      clearInterval(this.restFallbackTimer)
      this.restFallbackTimer = null
    }
  }

  private async fetchRestFallback(perpId: number) {
    try {
      const base = env.VITE_RELAY_URL
      const [tickerRes, bookRes] = await Promise.all([
        fetch(new URL(`/api/perpl/ticker/${perpId}`, base)),
        fetch(
          new URL(
            `/api/perpl/book/${perpId}?levels=${BOOK_LEVELS_TO_KEEP}`,
            base,
          ),
        ),
      ])
      if (!tickerRes.ok || !bookRes.ok) return
      const tickerParsed = restTickerSchema.safeParse(await tickerRes.json())
      const bookParsed = restBookSchema.safeParse(await bookRes.json())
      if (!tickerParsed.success || !bookParsed.success) return
      // The socket may have come back up while this request was in flight.
      if (!this.down) return

      const entry = this.entryFor(perpId)
      const key = String(perpId)
      if (key in tickerParsed.data.data.d) {
        const state = tickerParsed.data.data.d[key]
        entry.quote = {
          markScaled: state.mrk,
          lastScaled: state.lst,
          midScaled: state.mid,
          bidScaled: state.bid,
          askScaled: state.ask,
          atMs: state.at.t ?? null,
        }
      }
      entry.book.bids.clear()
      entry.book.asks.clear()
      applyLevels(entry.book.bids, bookParsed.data.data.bid)
      applyLevels(entry.book.asks, bookParsed.data.data.ask)
      entry.hasBookSnapshot = true
      entry.updatedAtMs = Date.now()
      this.emit()
    } catch {
      // Keep the last known values; the next tick tries again.
    }
  }

  private bindLifecycleListenersOnce() {
    if (this.boundVisibility || typeof document === 'undefined') return
    this.boundVisibility = true
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') this.forceReconnectIfDown()
    })
    window.addEventListener('online', () => this.forceReconnectIfDown())
  }

  private forceReconnectIfDown() {
    if (this.socket !== null || this.totalRefCount() === 0) return
    this.reconnectAttempt = 0
    this.clearReconnectTimer()
    this.connect()
  }

  private teardown() {
    this.clearReconnectTimer()
    this.stopKeepalive()
    this.stopRestFallback()
    if (this.socket) {
      this.socket.removeEventListener('open', this.handleOpen)
      this.socket.removeEventListener('message', this.handleMessage)
      this.socket.removeEventListener('close', this.handleClose)
      this.socket.close()
      this.socket = null
    }
    this.markets.clear()
    this.sidMap.clear()
  }
}

export const marketWs = new MarketWsClient()
