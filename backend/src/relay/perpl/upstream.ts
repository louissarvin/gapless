import type { Logger } from '../../lib/log.ts';
import { redactUrl } from '../../lib/log.ts';
import type { MarketStore } from './store.ts';
import { MT, parseFrame, pingMessage, subscribeMessage, type PerplFrame } from './types.ts';

export const UPSTREAM_DEFAULTS = {
  // BUILD_PLAN §0: ping every 25 s (docs: about 30 s). Pings count toward 10 requests/min.
  pingIntervalMs: 25_000,
  // Heartbeats arrive every block (about 300 ms); 10 s of silence means a dead socket.
  staleAfterMs: 10_000,
  connectTimeoutMs: 10_000,
  subscribeTimeoutMs: 10_000,
  backoffBaseMs: 1_000,
  backoffMaxMs: 60_000,
  // A connection that lived this long resets the backoff.
  stableAfterMs: 60_000,
  // Self-imposed cap below the documented 10 requests/min per connection.
  maxRequestsPerMinute: 8,
  // Checked before JSON.parse. A 5000-level book snapshot is about 200 KB.
  maxFrameChars: 1_000_000
} as const;

/** Close codes from the Perpl api-docs README. */
const CLOSE_GOING_AWAY = 1001;
const CLOSE_POLICY = 1008;
/** Backoff floor after a 1008 (too many requests or connections): 2^4 s = 16 s. */
const POLICY_MIN_ATTEMPT = 4;
const LOCAL_CLOSE = 4000;

type TimerId = ReturnType<typeof setTimeout>;

/** Scheduler seam so tests can drive time deterministically. */
export interface UpstreamTimers {
  setTimeout: (fn: () => void, ms: number) => TimerId;
  clearTimeout: (id: TimerId) => void;
  setInterval: (fn: () => void, ms: number) => TimerId;
  clearInterval: (id: TimerId) => void;
}

const REAL_TIMERS: UpstreamTimers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (id) => clearTimeout(id),
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (id) => clearInterval(id)
};

export type UpstreamState = 'idle' | 'connecting' | 'open' | 'closed';

export interface UpstreamStatus {
  state: UpstreamState;
  connected: boolean;
  lastMessageAtMs: number | null;
  lastMessageAgeMs: number | null;
  connectedSinceMs: number | null;
  reconnects: number;
  headBlock: number | null;
  lastPongRttMs: number | null;
  /** Requested streams Perpl has not acknowledged on this connection. */
  missingStreams: string[];
}

export interface UpstreamOptions {
  url: string;
  streams: readonly string[];
  store: MarketStore;
  log: Logger;
  /** Called with the untouched upstream text after the store accepted the frame. */
  onFrame?: (raw: string, frame: PerplFrame) => void;
  /** Called with a relay status frame (types.ts RELAY_STATUS_MT) when the upstream drops or recovers. */
  onStatus?: (raw: string) => void;
  now?: () => number;
  random?: () => number;
  createSocket?: (url: string) => WebSocket;
  timers?: UpstreamTimers;
  pingIntervalMs?: number;
  staleAfterMs?: number;
  connectTimeoutMs?: number;
  subscribeTimeoutMs?: number;
  backoffBaseMs?: number;
  backoffMaxMs?: number;
  stableAfterMs?: number;
  maxRequestsPerMinute?: number;
  maxFrameChars?: number;
}

/** Exponential backoff with equal jitter: a uniform delay in [d/2, d], d = min(max, base * 2^attempt). */
export function backoffDelay(attempt: number, baseMs: number, maxMs: number, random: () => number): number {
  const d = Math.min(maxMs, baseMs * 2 ** Math.min(attempt, 30));
  return Math.round(d / 2 + random() * (d / 2));
}

/**
 * The relay's single upstream connection to Perpl market data. Perpl allows about 5 WS
 * connections per IP across all services, so nothing else may open one.
 */
export class PerplUpstream {
  private readonly o: Required<Omit<UpstreamOptions, 'onFrame' | 'onStatus'>> & Pick<UpstreamOptions, 'onFrame' | 'onStatus'>;
  private ws: WebSocket | null = null;
  private generation = 0;
  private state: UpstreamState = 'idle';
  private stopped = true;
  private attempt = 0;
  private reconnects = 0;
  private openedAt: number | null = null;
  private lastMessageAt: number | null = null;
  private lastHeartbeatSn: number | null = null;
  private subscribed = false;
  private readonly acked = new Set<string>();
  private announced = 'down';
  private lastPongRttMs: number | null = null;
  private readonly sentAt: number[] = [];
  private readonly pending = new Set<TimerId>();
  private pingTimer: TimerId | null = null;
  private watchdog: TimerId | null = null;
  private reconnectTimer: TimerId | null = null;

  constructor(opts: UpstreamOptions) {
    this.o = {
      now: Date.now,
      random: Math.random,
      createSocket: (url) => new WebSocket(url),
      timers: REAL_TIMERS,
      ...UPSTREAM_DEFAULTS,
      ...opts
    };
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.watchdog = this.o.timers.setInterval(() => this.checkLiveness(), Math.min(1_000, this.o.staleAfterMs / 2));
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.watchdog) this.o.timers.clearInterval(this.watchdog);
    if (this.reconnectTimer) this.o.timers.clearTimeout(this.reconnectTimer);
    this.watchdog = null;
    this.reconnectTimer = null;
    this.teardown(1000, 'shutdown');
    this.state = 'closed';
  }

  status(): UpstreamStatus {
    const now = this.o.now();
    return {
      state: this.state,
      connected: this.state === 'open' && this.subscribed,
      lastMessageAtMs: this.lastMessageAt,
      lastMessageAgeMs: this.lastMessageAt === null ? null : Math.max(0, now - this.lastMessageAt),
      connectedSinceMs: this.state === 'open' ? this.openedAt : null,
      reconnects: this.reconnects,
      headBlock: this.o.store.getHeartbeat()?.h ?? null,
      lastPongRttMs: this.lastPongRttMs,
      missingStreams: this.missingStreams()
    };
  }

  private missingStreams(): string[] {
    return this.o.streams.filter((s) => !this.acked.has(s));
  }

  private connect(): void {
    if (this.stopped) return;
    const gen = ++this.generation;
    this.state = 'connecting';
    this.subscribed = false;
    this.acked.clear();
    this.lastHeartbeatSn = null;
    this.o.log.info({ url: redactUrl(this.o.url), attempt: this.attempt }, 'perpl.upstream_connecting');

    let ws: WebSocket;
    try {
      ws = this.o.createSocket(this.o.url);
    } catch (err) {
      this.o.log.error({ err }, 'perpl.upstream_create_failed');
      this.scheduleReconnect(null);
      return;
    }
    this.ws = ws;
    this.later(() => {
      if (gen === this.generation && this.state === 'connecting') this.forceReconnect('connect_timeout');
    }, this.o.connectTimeoutMs);

    ws.onopen = () => {
      if (gen !== this.generation) return;
      this.state = 'open';
      this.openedAt = this.o.now();
      this.lastMessageAt = this.openedAt;
      this.send(subscribeMessage(this.o.streams));
      this.later(() => {
        if (gen === this.generation && !this.subscribed) this.forceReconnect('subscribe_timeout');
      }, this.o.subscribeTimeoutMs);
      this.pingTimer = this.o.timers.setInterval(() => this.ping(), this.o.pingIntervalMs);
      this.o.log.info({ streams: this.o.streams.length }, 'perpl.upstream_open');
    };
    ws.onmessage = (ev: MessageEvent) => {
      if (gen !== this.generation) return;
      this.onMessage(ev.data);
    };
    ws.onerror = () => {
      if (gen !== this.generation) return;
      this.o.log.warn('perpl.upstream_error');
    };
    ws.onclose = (ev: CloseEvent) => {
      if (gen !== this.generation) return;
      this.o.log.warn({ code: ev.code, reason: ev.reason.slice(0, 120) }, 'perpl.upstream_closed');
      this.teardown();
      this.scheduleReconnect(ev.code);
    };
  }

  private onMessage(data: unknown): void {
    const now = this.o.now();
    this.lastMessageAt = now;
    if (typeof data !== 'string') {
      this.o.log.warn('perpl.upstream_binary_frame');
      return;
    }
    // An oversized frame cannot be applied safely (it may be a book frame), so resync instead.
    if (data.length > this.o.maxFrameChars) {
      this.o.log.error({ chars: data.length }, 'perpl.upstream_frame_too_large');
      this.forceReconnect('frame_too_large');
      return;
    }
    const res = parseFrame(data);
    if (!res.ok) {
      // A rejected book diff would leave the local book wrong; resync instead of drifting.
      if (res.reason === 'schema' && (res.mt === MT.BOOK_UPDATE || res.mt === MT.BOOK_SNAPSHOT)) {
        this.o.log.error({ mt: res.mt }, 'perpl.upstream_invalid_book_frame');
        this.forceReconnect('invalid_book_frame');
        return;
      }
      this.o.log.warn({ reason: res.reason, mt: res.mt }, 'perpl.upstream_frame_rejected');
      return;
    }
    const frame = res.frame;
    if (frame.mt === MT.PONG) {
      if (frame.t !== undefined) this.lastPongRttMs = Math.max(0, now - frame.t);
      return;
    }
    if (frame.mt === MT.SUBSCRIPTION) this.onSubscription(frame.subs);
    if (frame.mt === MT.HEARTBEAT) {
      // Docs: heartbeat sn is strictly +1; a gap means lost frames, so fetch fresh snapshots.
      if (this.lastHeartbeatSn !== null && frame.sn !== this.lastHeartbeatSn + 1) {
        this.o.log.warn({ expected: this.lastHeartbeatSn + 1, got: frame.sn }, 'perpl.heartbeat_gap');
        this.forceReconnect('heartbeat_gap');
        return;
      }
      this.lastHeartbeatSn = frame.sn;
    }
    if (this.o.store.apply(frame)) this.o.onFrame?.(data, frame);
    // After the mt 6 itself, so clients see the new subscription map before the status.
    if (frame.mt === MT.SUBSCRIPTION) this.announce();
  }

  /** Publishes the relay status frame when the upstream state (or the set of missing streams) changes. */
  private announce(): void {
    const frame = this.o.store.statusFrame();
    const key = this.subscribed ? `up:${this.missingStreams().join(',')}` : 'down';
    if (key === this.announced) return;
    this.announced = key;
    this.o.onStatus?.(frame);
  }

  private onSubscription(subs: { stream: string; sid?: number; status?: { code: number; error?: string } }[]): void {
    const failed = subs.filter((s) => s.status && s.status.code !== 0);
    for (const s of failed) {
      this.o.log.error({ stream: s.stream, code: s.status?.code, error: s.status?.error }, 'perpl.subscribe_failed');
    }
    for (const s of subs) if (s.sid !== undefined && (!s.status || s.status.code === 0)) this.acked.add(s.stream);
    const ok = this.o.streams.filter((s) => this.acked.has(s)).length;
    if (ok === 0) return;
    const missing = this.missingStreams();
    this.subscribed = true;
    this.o.store.setConnected(true, missing);
    if (missing.length > 0) this.o.log.error({ missing }, 'perpl.upstream_partial_subscription');
    this.o.log.info({ ok, failed: failed.length }, 'perpl.upstream_subscribed');
  }

  private ping(): void {
    if (this.state !== 'open') return;
    const now = this.o.now();
    while (this.sentAt.length > 0 && now - this.sentAt[0]! > 60_000) this.sentAt.shift();
    if (this.sentAt.length >= this.o.maxRequestsPerMinute) {
      this.o.log.warn('perpl.ping_skipped_budget');
      return;
    }
    this.send(pingMessage(now));
  }

  private send(text: string): void {
    try {
      this.ws?.send(text);
      this.sentAt.push(this.o.now());
    } catch (err) {
      this.o.log.warn({ err }, 'perpl.upstream_send_failed');
    }
  }

  private checkLiveness(): void {
    if (this.state !== 'open' || this.lastMessageAt === null) return;
    const age = this.o.now() - this.lastMessageAt;
    if (age > this.o.staleAfterMs) {
      this.o.log.warn({ ageMs: age }, 'perpl.upstream_stale');
      this.forceReconnect('stale');
    }
  }

  /** Drops the current socket without waiting for its close event, then reconnects. */
  private forceReconnect(reason: string): void {
    this.o.log.warn({ reason }, 'perpl.upstream_resync');
    this.teardown(LOCAL_CLOSE, reason);
    this.scheduleReconnect(null);
  }

  private teardown(code?: number, reason?: string): void {
    const ws = this.ws;
    this.ws = null;
    this.generation++;
    if (this.pingTimer) this.o.timers.clearInterval(this.pingTimer);
    this.pingTimer = null;
    for (const t of this.pending) this.o.timers.clearTimeout(t);
    this.pending.clear();
    this.subscribed = false;
    this.acked.clear();
    this.o.store.setConnected(false);
    this.announce();
    if (this.openedAt !== null && this.o.now() - this.openedAt >= this.o.stableAfterMs) this.attempt = 0;
    this.openedAt = null;
    this.state = 'closed';
    if (ws && code !== undefined) {
      try {
        ws.close(code, reason);
      } catch {
        // Already closing; the generation bump ignores its late events.
      }
    }
  }

  private scheduleReconnect(closeCode: number | null): void {
    if (this.stopped || this.reconnectTimer) return;
    if (closeCode === CLOSE_POLICY) this.attempt = Math.max(this.attempt, POLICY_MIN_ATTEMPT);
    // Docs: 1001 means the server instance is going away; reconnect without growing the delay.
    const attempt = closeCode === CLOSE_GOING_AWAY ? 0 : this.attempt++;
    const delay = backoffDelay(attempt, this.o.backoffBaseMs, this.o.backoffMaxMs, this.o.random);
    this.reconnects++;
    this.o.log.info({ delayMs: delay, attempt }, 'perpl.upstream_reconnect_scheduled');
    this.reconnectTimer = this.o.timers.setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private later(fn: () => void, ms: number): void {
    const t = this.o.timers.setTimeout(() => {
      this.pending.delete(t);
      fn();
    }, ms);
    this.pending.add(t);
  }
}
