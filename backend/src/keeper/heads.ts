import { z } from 'zod';
import type { Hex } from 'viem';
import { redactUrl, type Logger } from '../lib/log.ts';
import { backoffDelay, type UpstreamTimers } from '../relay/perpl/upstream.ts';

export type CommitState = 'Proposed' | 'Voted' | 'Finalized' | 'Verified';

export interface Head {
  number: bigint;
  hash: Hex;
  /** Monad proposal id; several proposals can share a height. Null on plain newHeads. */
  blockId: string | null;
  /** Null on plain newHeads (local node): treat as both Proposed and Finalized. */
  commitState: CommitState | null;
  timestamp: bigint;
  baseFeePerGas: bigint | null;
}

const hexQty = z.string().regex(/^0x[0-9a-fA-F]{1,64}$/).transform((v) => BigInt(v));

const headerSchema = z.object({
  number: hexQty,
  hash: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
  timestamp: hexQty,
  baseFeePerGas: hexQty.optional(),
  blockId: z.string().max(80).optional(),
  commitState: z.enum(['Proposed', 'Voted', 'Finalized', 'Verified']).optional()
});

const notification = z.object({
  method: z.literal('eth_subscription'),
  params: z.object({ subscription: z.string(), result: z.unknown() })
});

const subscribeAck = z.object({
  id: z.literal(1),
  result: z.string().optional(),
  error: z.object({ code: z.number(), message: z.string().max(500) }).optional()
});

export const HEAD_DEFAULTS = {
  // Monad blocks are about 300 ms; no head for this long means a dead subscription.
  stallMs: 5_000,
  connectTimeoutMs: 10_000,
  backoffBaseMs: 500,
  backoffMaxMs: 30_000,
  dedupeSize: 512,
  maxFrameChars: 65_536
} as const;

export interface HeadSubscriberOptions {
  url: string;
  kind: 'monadNewHeads' | 'newHeads';
  log: Logger;
  onHead: (head: Head) => void;
  createSocket?: (url: string) => WebSocket;
  timers?: UpstreamTimers;
  now?: () => number;
  random?: () => number;
  stallMs?: number;
}

const REAL_TIMERS: UpstreamTimers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (id) => clearTimeout(id),
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (id) => clearInterval(id)
};

/**
 * eth_subscribe monadNewHeads over a raw WebSocket. viem's transport reconnects but does not
 * resubscribe, so this owns reconnect, stall detection and dedupe (Monad delivers each header
 * once per commit state, and can repeat items).
 */
export class HeadSubscriber {
  private ws: WebSocket | null = null;
  private generation = 0;
  private stopped = true;
  private attempt = 0;
  private reconnects = 0;
  private subscribed = false;
  private lastFrameAt: number | null = null;
  private lastHeadAt: number | null = null;
  private watchdog: ReturnType<typeof setTimeout> | null = null;
  private retry: ReturnType<typeof setTimeout> | null = null;
  private readonly seen = new Set<string>();
  private readonly timers: UpstreamTimers;
  private readonly now: () => number;
  private readonly stallMs: number;

  constructor(private readonly o: HeadSubscriberOptions) {
    this.timers = o.timers ?? REAL_TIMERS;
    this.now = o.now ?? Date.now;
    this.stallMs = o.stallMs ?? HEAD_DEFAULTS.stallMs;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.watchdog = this.timers.setInterval(() => this.checkStall(), 1_000);
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.watchdog) this.timers.clearInterval(this.watchdog);
    if (this.retry) this.timers.clearTimeout(this.retry);
    this.watchdog = this.retry = null;
    this.close();
  }

  status() {
    const now = this.now();
    return {
      subscribed: this.subscribed,
      reconnects: this.reconnects,
      lastHeadAgeMs: this.lastHeadAt === null ? null : now - this.lastHeadAt
    };
  }

  private connect(): void {
    const gen = ++this.generation;
    this.subscribed = false;
    this.lastFrameAt = this.now();
    let ws: WebSocket;
    try {
      ws = (this.o.createSocket ?? ((u) => new WebSocket(u)))(this.o.url);
    } catch (err) {
      this.o.log.error({ err, endpoint: redactUrl(this.o.url) }, 'heads.connect_failed');
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    ws.onopen = () => {
      if (gen !== this.generation) return;
      ws.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_subscribe', params: [this.o.kind] }));
    };
    ws.onmessage = (ev) => {
      if (gen !== this.generation) return;
      this.onMessage(ev.data);
    };
    ws.onclose = (ev) => {
      if (gen !== this.generation) return;
      this.o.log.warn({ code: ev.code, endpoint: redactUrl(this.o.url) }, 'heads.closed');
      this.ws = null;
      this.subscribed = false;
      this.scheduleReconnect();
    };
    ws.onerror = () => {
      // onclose follows and handles the retry.
    };
  }

  private onMessage(data: unknown): void {
    this.lastFrameAt = this.now();
    if (typeof data !== 'string' || data.length > HEAD_DEFAULTS.maxFrameChars) return;
    let json: unknown;
    try {
      json = JSON.parse(data);
    } catch {
      return;
    }
    const ack = subscribeAck.safeParse(json);
    if (ack.success) {
      if (ack.data.error || !ack.data.result) {
        this.o.log.error({ error: ack.data.error, kind: this.o.kind }, 'heads.subscribe_failed');
        this.restart();
        return;
      }
      this.subscribed = true;
      this.attempt = 0;
      this.o.log.info({ kind: this.o.kind, endpoint: redactUrl(this.o.url) }, 'heads.subscribed');
      return;
    }
    const n = notification.safeParse(json);
    if (!n.success) return;
    const h = headerSchema.safeParse(n.data.params.result);
    if (!h.success) {
      this.o.log.warn('heads.invalid_header');
      return;
    }
    const head: Head = {
      number: h.data.number,
      hash: h.data.hash as Hex,
      blockId: h.data.blockId ?? null,
      commitState: h.data.commitState ?? null,
      timestamp: h.data.timestamp,
      baseFeePerGas: h.data.baseFeePerGas ?? null
    };
    const key = `${head.blockId ?? head.hash}:${head.commitState ?? '-'}`;
    if (this.seen.has(key)) return;
    this.seen.add(key);
    if (this.seen.size > HEAD_DEFAULTS.dedupeSize) this.seen.delete(this.seen.values().next().value!);
    this.lastHeadAt = this.now();
    this.o.onHead(head);
  }

  private checkStall(): void {
    if (this.stopped || !this.ws) return;
    const last = this.subscribed ? (this.lastHeadAt ?? this.lastFrameAt) : this.lastFrameAt;
    const limit = this.subscribed ? this.stallMs : HEAD_DEFAULTS.connectTimeoutMs;
    if (last !== null && this.now() - last > limit) {
      this.o.log.warn({ subscribed: this.subscribed, silentMs: this.now() - last }, 'heads.stalled');
      this.restart();
    }
  }

  private restart(): void {
    this.close();
    this.scheduleReconnect();
  }

  private close(): void {
    const ws = this.ws;
    this.ws = null;
    this.generation++;
    this.subscribed = false;
    try {
      ws?.close(1000);
    } catch {
      // Already closed.
    }
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.retry) return;
    const delay = backoffDelay(this.attempt++, HEAD_DEFAULTS.backoffBaseMs, HEAD_DEFAULTS.backoffMaxMs, this.o.random ?? Math.random);
    this.reconnects++;
    this.retry = this.timers.setTimeout(() => {
      this.retry = null;
      if (!this.stopped) this.connect();
    }, delay);
  }
}
