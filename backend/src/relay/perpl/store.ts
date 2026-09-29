import {
  MT,
  RELAY_STATUS_MT,
  relayStatusMessage,
  type BlockTimestamp,
  type BookFrame,
  type L2Level,
  type MarketState,
  type PerplFrame,
  type RelayFeedStatus,
  type RelayStatusFrame,
  type SubscriptionFrame,
  type Trade,
  type TradesFrame
} from './types.ts';

/** A feed whose last heartbeat is older than this is stale (heartbeats arrive every block, about 300 ms). */
export const STATE_STALE_MS = 10_000;
/** Perpl's head this far behind our RPC head means its backend lags (about 10 s of Monad blocks). */
export const MAX_FEED_LAG_BLOCKS = 30;
/** RPC head observations older than this are not used for the lag check. */
export const CHAIN_HEAD_MAX_AGE_MS = 15_000;
export const TRADES_PER_MARKET = 64;

/**
 * Latest view of one market for the keeper and routes. Prices are Perpl scaled integers:
 * divide by 10^price_decimals from /api/v1/pub/context (BTC: 1, MON: 6).
 */
export interface MarketQuote {
  marketId: number;
  oracle: number;
  mark: number;
  last: number;
  mid: number;
  /** Best bid and ask prices as reported in market-state. */
  bid: number;
  ask: number;
  /** Top of the locally maintained L2 book; null when the market's book is not subscribed or not synced. */
  bookTop: { bid: L2Level | null; ask: L2Level | null; block: number } | null;
  /** Block and block time of this market's last change. Quiet markets lag the head; that is not staleness. */
  block: number | null;
  timestampMs: number | null;
  /** Local receive time of this market's last change, and its age. Display only. */
  receivedAtMs: number;
  ageMs: number;
  /** Perpl head block from the latest heartbeat: the state is current as of this block. */
  headBlock: number | null;
  heartbeatAgeMs: number | null;
  /** Our RPC head minus Perpl's head; null when no recent RPC head is known. */
  feedLagBlocks: number | null;
  /**
   * Feed-level freshness: upstream down, heartbeat older than STATE_STALE_MS, or Perpl more than
   * MAX_FEED_LAG_BLOCKS behind the chain. Never act on stale quotes.
   */
  stale: boolean;
}

export interface FeedHealth {
  status: RelayFeedStatus;
  fresh: boolean;
  headBlock: number | null;
  heartbeatAgeMs: number | null;
  feedLagBlocks: number | null;
  missing: readonly string[];
}

interface Book {
  bid: Map<number, L2Level>;
  ask: Map<number, L2Level>;
  sn: number;
  at: BlockTimestamp;
  synced: boolean;
}

interface Trades {
  items: Trade[];
  sn: number | undefined;
  synced: boolean;
}

type Stream = { kind: 'book' | 'trades'; marketId: number } | { kind: 'state' | 'heartbeat' };

/**
 * In-memory snapshot of the upstream feed. Books are rebuilt from a snapshot (mt 15) and
 * diffs (mt 16, o = 0 removes a level); a diff for an unsynced book is dropped.
 */
export class MarketStore {
  private readonly now: () => number;
  private readonly tradesPerMarket: number;
  private connected = false;
  private missing: readonly string[] = [];
  private statusSinceMs: number;
  private chainHead: { block: number; atMs: number } | null = null;
  private lastStateSn: number | null = null;
  private sidToStream = new Map<number, Stream>();
  private streamToSid = new Map<string, number>();
  private readonly states = new Map<number, { state: MarketState; receivedAtMs: number }>();
  private readonly books = new Map<number, Book>();
  private readonly trades = new Map<number, Trades>();
  private heartbeat: { sn: number; h: number; receivedAtMs: number } | null = null;
  private stateSid: number | undefined;
  private heartbeatSid: number | undefined;

  constructor(opts: { now?: () => number; tradesPerMarket?: number } = {}) {
    this.now = opts.now ?? Date.now;
    this.statusSinceMs = this.now();
    this.tradesPerMarket = opts.tradesPerMarket ?? TRADES_PER_MARKET;
  }

  /**
   * Upstream connection state. On disconnect everything waits for fresh data: books and trades for
   * snapshots, quotes for the next market-state (Perpl's first frame after subscribe carries every market).
   * @param missing requested streams Perpl did not acknowledge (partial subscription).
   */
  setConnected(connected: boolean, missing: readonly string[] = []): void {
    const next = connected ? [...missing] : [];
    if (connected !== this.connected || next.join() !== this.missing.join()) this.statusSinceMs = this.now();
    this.connected = connected;
    this.missing = next;
    if (!connected) {
      for (const b of this.books.values()) b.synced = false;
      for (const t of this.trades.values()) t.synced = false;
      this.states.clear();
      this.heartbeat = null;
      this.lastStateSn = null;
      // Subscription ids are per connection; the next mt 6 rebuilds the map.
      this.sidToStream.clear();
      this.streamToSid.clear();
    }
  }

  /** Independent chain head (our RPC) used to detect a Perpl backend that streams old blocks. */
  observeChainHead(block: number, atMs: number = this.now()): void {
    if (!this.chainHead || block >= this.chainHead.block) this.chainHead = { block, atMs };
  }

  feedHealth(): FeedHealth {
    const now = this.now();
    const hb = this.heartbeat;
    const heartbeatAgeMs = hb ? Math.max(0, now - hb.receivedAtMs) : null;
    const head = this.chainHead && now - this.chainHead.atMs <= CHAIN_HEAD_MAX_AGE_MS ? this.chainHead : null;
    const feedLagBlocks = hb && head ? head.block - hb.h : null;
    const fresh =
      this.connected &&
      heartbeatAgeMs !== null &&
      heartbeatAgeMs <= STATE_STALE_MS &&
      (feedLagBlocks === null || feedLagBlocks <= MAX_FEED_LAG_BLOCKS);
    const status: RelayFeedStatus = !this.connected ? 'down' : this.missing.length > 0 ? 'partial' : 'up';
    return { status, fresh, headBlock: hb?.h ?? null, heartbeatAgeMs, feedLagBlocks, missing: this.missing };
  }

  /** The relay control frame for the current upstream state (sent on connect and on every change); `t` is when it began. */
  statusFrame(): string {
    const f = this.feedHealth();
    return relayStatusMessage(f.status, this.statusSinceMs, f.missing);
  }

  /**
   * Applies one parsed upstream frame. Returns true when the frame changed state and should be
   * fanned out to clients unchanged.
   */
  apply(frame: PerplFrame | RelayStatusFrame): boolean {
    switch (frame.mt) {
      // A relay client (the keeper) feeding this store from /ws/market.
      case RELAY_STATUS_MT:
        this.setConnected(frame.status !== 'down', frame.missing);
        return true;
      case MT.SUBSCRIPTION:
        this.applySubscriptions(frame);
        return true;
      case MT.HEARTBEAT:
        this.heartbeat = { sn: frame.sn, h: frame.h, receivedAtMs: this.now() };
        return true;
      case MT.MARKET_STATE: {
        const at = this.now();
        let sn = frame.sn ?? 0;
        for (const [key, state] of Object.entries(frame.d)) {
          this.states.set(Number(key), { state, receivedAtMs: at });
          sn = Math.max(sn, state.at.b ?? 0);
        }
        this.lastStateSn = Math.max(this.lastStateSn ?? 0, sn);
        return true;
      }
      case MT.BOOK_SNAPSHOT:
      case MT.BOOK_UPDATE:
        return this.applyBook(frame);
      case MT.TRADES_SNAPSHOT:
      case MT.TRADES_UPDATE:
        return this.applyTrades(frame);
      default:
        return false;
    }
  }

  private applySubscriptions(frame: SubscriptionFrame): void {
    for (const sub of frame.subs) {
      if (sub.sid === undefined || (sub.status && sub.status.code !== 0)) continue;
      const stream = classify(sub.stream);
      if (!stream) continue;
      this.sidToStream.set(sub.sid, stream);
      this.streamToSid.set(sub.stream, sub.sid);
      if (stream.kind === 'state') this.stateSid = sub.sid;
      if (stream.kind === 'heartbeat') this.heartbeatSid = sub.sid;
    }
  }

  private applyBook(frame: BookFrame): boolean {
    const stream = this.sidToStream.get(frame.sid);
    if (stream?.kind !== 'book') return false;
    if (frame.mt === MT.BOOK_SNAPSHOT) {
      this.books.set(stream.marketId, {
        bid: new Map(frame.bid.map((l) => [l.p, l])),
        ask: new Map(frame.ask.map((l) => [l.p, l])),
        sn: frame.sn,
        at: frame.at,
        synced: true
      });
      return true;
    }
    const book = this.books.get(stream.marketId);
    // sn is the block number; updates skip idle blocks, so only ordering can be checked.
    if (!book?.synced || frame.sn < book.sn) return false;
    for (const l of frame.bid) (l.o === 0 ? book.bid.delete(l.p) : book.bid.set(l.p, l));
    for (const l of frame.ask) (l.o === 0 ? book.ask.delete(l.p) : book.ask.set(l.p, l));
    book.sn = frame.sn;
    book.at = frame.at;
    return true;
  }

  private applyTrades(frame: TradesFrame): boolean {
    const stream = this.sidToStream.get(frame.sid);
    if (stream?.kind !== 'trades') return false;
    let t = this.trades.get(stream.marketId);
    if (frame.mt === MT.TRADES_SNAPSHOT || !t) {
      if (frame.mt === MT.TRADES_UPDATE) return false;
      t = { items: [], sn: undefined, synced: true };
      this.trades.set(stream.marketId, t);
    } else if (!t.synced) {
      return false;
    }
    t.items.push(...frame.d);
    if (t.items.length > this.tradesPerMarket) t.items.splice(0, t.items.length - this.tradesPerMarket);
    t.sn = frame.sn ?? t.sn;
    return true;
  }

  /** Typed read for the keeper and routes. Null until the market has reported state. */
  getQuote(marketId: number): MarketQuote | null {
    const entry = this.states.get(marketId);
    if (!entry) return null;
    const { state, receivedAtMs } = entry;
    const ageMs = Math.max(0, this.now() - receivedAtMs);
    const feed = this.feedHealth();
    return {
      marketId,
      oracle: state.orl,
      mark: state.mrk,
      last: state.lst,
      mid: state.mid,
      bid: state.bid,
      ask: state.ask,
      bookTop: this.getBookTop(marketId),
      block: state.at.b ?? null,
      timestampMs: state.at.t ?? null,
      receivedAtMs,
      ageMs,
      headBlock: feed.headBlock,
      heartbeatAgeMs: feed.heartbeatAgeMs,
      feedLagBlocks: feed.feedLagBlocks,
      stale: !feed.fresh
    };
  }

  /**
   * Raw market-state for one market, or null when the feed is not fresh. `sn` is the block it is
   * current as of; `ageMs` is the heartbeat age (how far behind the live feed this view is).
   */
  getFreshState(marketId: number): { sn: number; state: MarketState; ageMs: number } | null {
    const entry = this.states.get(marketId);
    const feed = this.feedHealth();
    if (!entry || !feed.fresh) return null;
    return { sn: this.lastStateSn ?? entry.state.at.b ?? 0, state: entry.state, ageMs: feed.heartbeatAgeMs ?? 0 };
  }

  getBookTop(marketId: number): MarketQuote['bookTop'] {
    const book = this.books.get(marketId);
    if (!book?.synced) return null;
    return { bid: best(book.bid, 'bid'), ask: best(book.ask, 'ask'), block: book.sn };
  }

  /** Sorted L2 book (best first) or null when not synced. */
  getBook(marketId: number, levels?: number): { sn: number; at: BlockTimestamp; bid: L2Level[]; ask: L2Level[] } | null {
    const book = this.books.get(marketId);
    if (!book?.synced) return null;
    return { sn: book.sn, at: book.at, bid: sorted(book.bid, 'bid', levels), ask: sorted(book.ask, 'ask', levels) };
  }

  getRecentTrades(marketId: number): Trade[] {
    const t = this.trades.get(marketId);
    return t?.synced ? [...t.items] : [];
  }

  getHeartbeat(): { sn: number; h: number; receivedAtMs: number } | null {
    return this.heartbeat;
  }

  /**
   * Frames a new client needs before live updates: the relay status frame, then in the upstream wire
   * format the subscription map, heartbeat, merged market-state, and a book and trades snapshot per market.
   */
  snapshotFrames(): string[] {
    const out: string[] = [this.statusFrame()];
    const subs = [...this.streamToSid].map(([stream, sid]) => ({ stream, sid, status: { code: 0 } }));
    if (subs.length === 0) return out;
    out.push(JSON.stringify({ mt: MT.SUBSCRIPTION, subs }));
    if (this.heartbeat) {
      out.push(JSON.stringify({ mt: MT.HEARTBEAT, sid: this.heartbeatSid, sn: this.heartbeat.sn, h: this.heartbeat.h }));
    }
    if (this.states.size > 0) {
      const d: Record<string, MarketState> = {};
      for (const [id, { state }] of this.states) d[id] = state;
      // Every entry is current as of the latest market-state frame, not only the newest entry's block.
      out.push(JSON.stringify({ mt: MT.MARKET_STATE, sid: this.stateSid, sn: this.lastStateSn ?? 0, d }));
    }
    for (const [sid, stream] of this.sidToStream) {
      if (stream.kind === 'book') {
        const book = this.getBook(stream.marketId);
        if (book) out.push(JSON.stringify({ mt: MT.BOOK_SNAPSHOT, sid, ...book }));
      } else if (stream.kind === 'trades') {
        const t = this.trades.get(stream.marketId);
        if (t?.synced) out.push(JSON.stringify({ mt: MT.TRADES_SNAPSHOT, sid, sn: t.sn, d: t.items }));
      }
    }
    return out;
  }
}

function classify(stream: string): Stream | null {
  const m = /^([a-z-]+)@(\d{1,10})$/.exec(stream);
  if (!m) return null;
  const id = Number(m[2]);
  switch (m[1]) {
    case 'order-book':
      return { kind: 'book', marketId: id };
    case 'trades':
      return { kind: 'trades', marketId: id };
    case 'market-state':
      return { kind: 'state' };
    case 'heartbeat':
      return { kind: 'heartbeat' };
    default:
      return null;
  }
}

function best(side: Map<number, L2Level>, kind: 'bid' | 'ask'): L2Level | null {
  let top: L2Level | null = null;
  for (const l of side.values()) {
    if (!top || (kind === 'bid' ? l.p > top.p : l.p < top.p)) top = l;
  }
  return top;
}

function sorted(side: Map<number, L2Level>, kind: 'bid' | 'ask', levels?: number): L2Level[] {
  const xs = [...side.values()].sort((a, b) => (kind === 'bid' ? b.p - a.p : a.p - b.p));
  return levels === undefined ? xs : xs.slice(0, levels);
}
