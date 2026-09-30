import type { Logger } from '../lib/log.ts';
import { redactUrl } from '../lib/log.ts';
import type { MarketStore } from '../relay/perpl/store.ts';
import { MT, parseRelayFrame, pingMessage } from '../relay/perpl/types.ts';
import { backoffDelay, type UpstreamTimers } from '../relay/perpl/upstream.ts';

export const FEED_DEFAULTS = {
  // Relay closes clients silent for 90 s; any text frame counts.
  pingIntervalMs: 30_000,
  // Heartbeats arrive every block; 10 s of silence means a dead socket.
  staleAfterMs: 10_000,
  backoffBaseMs: 1_000,
  backoffMaxMs: 30_000,
  stableAfterMs: 60_000,
  // Same guard as the relay's upstream: checked before JSON.parse.
  maxFrameChars: 1_000_000
} as const;

export interface RelayFeedOptions {
  /** Relay /ws/market. */
  url: string;
  /** RELAY_INTERNAL_TOKEN: the reserved keeper pool, outside the public caps. */
  token: string;
  store: MarketStore;
  log: Logger;
  createSocket?: (url: string, headers: Record<string, string>) => WebSocket;
  timers?: UpstreamTimers;
  now?: () => number;
  random?: () => number;
}

const REAL_TIMERS: UpstreamTimers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (id) => clearTimeout(id),
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (id) => clearInterval(id)
};

/**
 * Keeper side of /ws/market: feeds a local MarketStore through apply(), so the relay status frame
 * (mt 9000) and every disconnect mark the store unsynced. A heartbeat sn gap reconnects for a fresh
 * snapshot. Callers read freshness from store.getQuote().stale and never act on stale data.
 */
export class RelayFeedClient {
  private ws: WebSocket | null = null;
  private generation = 0;
  private stopped = true;
  private attempt = 0;
  private reconnects = 0;
  private openedAt: number | null = null;
  private lastFrameAt: number | null = null;
  private lastSn: number | null = null;
  private ping: ReturnType<typeof setInterval> | null = null;
  private watchdog: ReturnType<typeof setInterval> | null = null;
  private retry: ReturnType<typeof setTimeout> | null = null;
  private readonly timers: UpstreamTimers;
  private readonly now: () => number;

  constructor(private readonly o: RelayFeedOptions) {
    this.timers = o.timers ?? REAL_TIMERS;
    this.now = o.now ?? Date.now;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.watchdog = this.timers.setInterval(() => this.checkStale(), 1_000);
    this.ping = this.timers.setInterval(() => this.sendPing(), FEED_DEFAULTS.pingIntervalMs);
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    for (const t of [this.watchdog, this.ping]) if (t) this.timers.clearInterval(t);
    if (this.retry) this.timers.clearTimeout(this.retry);
    this.watchdog = this.ping = this.retry = null;
    this.drop();
  }

  status() {
    return {
      connected: this.ws !== null && this.openedAt !== null,
      reconnects: this.reconnects,
      lastFrameAgeMs: this.lastFrameAt === null ? null : this.now() - this.lastFrameAt
    };
  }

  private connect(): void {
    const gen = ++this.generation;
    this.lastSn = null;
    this.lastFrameAt = this.now();
    this.openedAt = null;
    const headers = { Authorization: `Bearer ${this.o.token}` };
    let ws: WebSocket;
    try {
      ws = this.o.createSocket ? this.o.createSocket(this.o.url, headers) : new WebSocket(this.o.url, { headers });
    } catch (err) {
      this.o.log.error({ err, endpoint: redactUrl(this.o.url) }, 'feed.connect_failed');
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    ws.onopen = () => {
      if (gen !== this.generation) return;
      this.openedAt = this.now();
      this.o.log.info({ endpoint: redactUrl(this.o.url) }, 'feed.connected');
    };
    ws.onmessage = (ev) => {
      if (gen === this.generation) this.onMessage(ev.data);
    };
    ws.onclose = (ev) => {
      if (gen !== this.generation) return;
      this.o.log.warn({ code: ev.code }, 'feed.closed');
      this.ws = null;
      this.o.store.setConnected(false);
      this.scheduleReconnect();
    };
    ws.onerror = () => {
      // onclose follows.
    };
  }

  private onMessage(data: unknown): void {
    this.lastFrameAt = this.now();
    if (typeof data !== 'string') return;
    if (data.length > FEED_DEFAULTS.maxFrameChars) {
      this.restart('frame_too_large');
      return;
    }
    const parsed = parseRelayFrame(data);
    if (!parsed.ok) return;
    const frame = parsed.frame;
    if (frame.mt === MT.HEARTBEAT) {
      if (this.lastSn !== null && frame.sn !== this.lastSn + 1) {
        this.o.log.warn({ last: this.lastSn, sn: frame.sn }, 'feed.heartbeat_gap');
        this.restart('heartbeat_gap');
        return;
      }
      this.lastSn = frame.sn;
    }
    this.o.store.apply(frame);
    if (this.openedAt !== null && this.attempt > 0 && this.now() - this.openedAt > FEED_DEFAULTS.stableAfterMs) this.attempt = 0;
  }

  private sendPing(): void {
    if (!this.ws || this.openedAt === null) return;
    try {
      this.ws.send(pingMessage(this.now()));
    } catch {
      this.restart('ping_failed');
    }
  }

  private checkStale(): void {
    if (this.stopped || !this.ws || this.lastFrameAt === null) return;
    if (this.now() - this.lastFrameAt > FEED_DEFAULTS.staleAfterMs) this.restart('silent');
  }

  private restart(reason: string): void {
    this.o.log.warn({ reason }, 'feed.resync');
    this.drop();
    this.scheduleReconnect();
  }

  private drop(): void {
    const ws = this.ws;
    this.ws = null;
    this.generation++;
    this.openedAt = null;
    this.o.store.setConnected(false);
    try {
      ws?.close(1000);
    } catch {
      // Already closed.
    }
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.retry) return;
    const delay = backoffDelay(this.attempt++, FEED_DEFAULTS.backoffBaseMs, FEED_DEFAULTS.backoffMaxMs, this.o.random ?? Math.random);
    this.reconnects++;
    this.retry = this.timers.setTimeout(() => {
      this.retry = null;
      if (!this.stopped) this.connect();
    }, delay);
  }
}
