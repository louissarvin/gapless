import { afterEach, describe, expect, test } from 'bun:test';
import type { Server, ServerWebSocket } from 'bun';
import { MarketStore } from '../src/relay/perpl/store.ts';
import { marketDataStreams } from '../src/relay/perpl/types.ts';
import { PerplUpstream, UPSTREAM_DEFAULTS, type UpstreamOptions, type UpstreamTimers } from '../src/relay/perpl/upstream.ts';
import { captureLogger, loadWsFixture } from './perplFixtures.ts';

const STREAMS = marketDataStreams(143, [1, 10]);
const FRAMES = loadWsFixture();

type Behavior = 'replay';

/** Local stand-in for Perpl: answers the subscribe frame by replaying captured frames. */
function fakePerpl(behavior: (conn: number) => Behavior) {
  const received: { conn: number; text: string }[] = [];
  const origins: (string | null)[] = [];
  let connections = 0;
  const sockets = new Set<ServerWebSocket<{ conn: number }>>();
  const server: Server<{ conn: number }> = Bun.serve({
    port: 0,
    fetch(req, srv) {
      origins.push(req.headers.get('origin'));
      return srv.upgrade(req, { data: { conn: ++connections } }) ? undefined : new Response('no', { status: 400 });
    },
    websocket: {
      data: {} as { conn: number },
      open(ws) {
        sockets.add(ws);
      },
      message(ws, msg) {
        const text = String(msg);
        received.push({ conn: ws.data.conn, text });
        if (JSON.parse(text).mt !== 5) return;
        behavior(ws.data.conn);
        for (const f of FRAMES) ws.send(f);
      },
      close(ws) {
        sockets.delete(ws);
      }
    }
  });
  return {
    url: `ws://127.0.0.1:${server.port}/ws/v1/market-data`,
    received,
    origins,
    connections: () => connections,
    dropAll: (code: number) => {
      for (const ws of sockets) ws.close(code, 'test');
    },
    stop: () => server.stop(true)
  };
}

async function until(cond: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out waiting for condition');
    await Bun.sleep(5);
  }
}

const fast: Partial<UpstreamOptions> = {
  backoffBaseMs: 20,
  backoffMaxMs: 200,
  staleAfterMs: 300,
  connectTimeoutMs: 1000,
  subscribeTimeoutMs: 1000,
  pingIntervalMs: 60_000,
  random: () => 1
};

describe('PerplUpstream', () => {
  let up: PerplUpstream | undefined;
  let fake: ReturnType<typeof fakePerpl> | undefined;
  afterEach(() => {
    up?.stop();
    fake?.stop();
    up = undefined;
    fake = undefined;
  });

  function start(behavior: (conn: number) => Behavior, extra: Partial<UpstreamOptions> = {}) {
    fake = fakePerpl(behavior);
    const store = new MarketStore();
    const forwarded: string[] = [];
    const cap = captureLogger();
    up = new PerplUpstream({
      url: fake.url,
      streams: STREAMS,
      store,
      log: cap.log,
      onFrame: (raw) => forwarded.push(raw),
      ...fast,
      ...extra
    });
    up.start();
    return { store, forwarded, cap, fake };
  }

  test('subscribes with the documented frame, sends no Origin, fills the store', async () => {
    const { store, forwarded, fake } = start(() => 'replay');
    await until(() => forwarded.length >= FRAMES.length - 1);
    expect(JSON.parse(fake.received[0]!.text)).toEqual({ mt: 5, subs: STREAMS.map((stream) => ({ stream, subscribe: true })) });
    expect(fake.origins).toEqual([null]);
    // Forwarded frames are the upstream bytes, unchanged; the captured pong is not forwarded.
    expect(forwarded).toEqual(FRAMES.filter((f) => JSON.parse(f).mt !== 2));
    expect(up!.status()).toMatchObject({ state: 'open', connected: true, reconnects: 0 });
    expect(store.getQuote(1)?.stale).toBe(false);
    expect(store.getBookTop(10)).not.toBeNull();
  });

  test('reconnects with backoff and resubscribes after the server drops the socket', async () => {
    const { fake, store, cap } = start(() => 'replay');
    await until(() => up!.status().connected);
    fake.dropAll(1011);
    await until(() => fake.connections() === 2 && up!.status().connected);
    const subs = fake.received.filter((r) => JSON.parse(r.text).mt === 5);
    expect(subs.map((s) => s.conn)).toEqual([1, 2]);
    expect(up!.status().reconnects).toBe(1);
    expect(store.getBookTop(1)).not.toBeNull();
    expect(cap.events()).toContain('perpl.upstream_closed');
  });

  test('sends documented pings and records the echoed RTT', async () => {
    const { fake } = start(() => 'replay', { pingIntervalMs: 50 });
    await until(() => fake.received.some((r) => JSON.parse(r.text).mt === 1));
    const ping = JSON.parse(fake.received.find((r) => JSON.parse(r.text).mt === 1)!.text);
    expect(Object.keys(ping).sort()).toEqual(['mt', 't']);
    expect(typeof ping.t).toBe('number');
  });
});

/** Manual clock and scheduler: due timers fire in time order only when the test advances. */
class ManualClock {
  t = 0;
  private seq = 0;
  private readonly tasks = new Map<number, { at: number; every: number | null; fn: () => void }>();
  readonly now = () => this.t;
  readonly timers: UpstreamTimers = {
    setTimeout: (fn, ms) => this.add(fn, ms, null),
    clearTimeout: (id) => void this.tasks.delete(id as unknown as number),
    setInterval: (fn, ms) => this.add(fn, ms, ms),
    clearInterval: (id) => void this.tasks.delete(id as unknown as number)
  };

  private add(fn: () => void, ms: number, every: number | null) {
    const id = ++this.seq;
    this.tasks.set(id, { at: this.t + Math.max(0, ms), every, fn });
    return id as unknown as ReturnType<typeof setTimeout>;
  }

  advance(ms: number): void {
    const end = this.t + ms;
    for (;;) {
      let next: [number, { at: number; every: number | null; fn: () => void }] | null = null;
      for (const e of this.tasks) if (e[1].at <= end && (!next || e[1].at < next[1].at)) next = e;
      if (!next) break;
      const [id, task] = next;
      this.t = task.at;
      if (task.every === null) this.tasks.delete(id);
      else task.at += task.every;
      task.fn();
    }
    this.t = end;
  }
}

/** In-memory socket driven by the test; the upstream only uses handlers, send and close. */
class FakeSocket {
  onopen: ((ev: Event) => void) | null = null;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;
  onclose: ((ev: CloseEvent) => void) | null = null;
  readonly sent: string[] = [];
  closedWith: { code?: number; reason?: string } | null = null;
  send(text: string) {
    this.sent.push(text);
  }
  close(code?: number, reason?: string) {
    this.closedWith = { code, reason };
  }
  open() {
    this.onopen?.(new Event('open'));
  }
  emit(text: string) {
    this.onmessage?.(new MessageEvent('message', { data: text }));
  }
  serverClose(code: number) {
    this.onclose?.(new CloseEvent('close', { code, reason: 'test' }));
  }
}

describe('PerplUpstream timing (manual clock)', () => {
  const SUB_ACK = FRAMES[0]!;
  const D = UPSTREAM_DEFAULTS;
  let up: PerplUpstream | undefined;
  afterEach(() => {
    up?.stop();
    up = undefined;
  });

  function start(extra: Partial<UpstreamOptions> = {}) {
    const clock = new ManualClock();
    const sockets: FakeSocket[] = [];
    const cap = captureLogger();
    const out: string[] = [];
    up = new PerplUpstream({
      url: 'wss://perpl.test/ws/v1/market-data',
      streams: STREAMS,
      store: new MarketStore({ now: clock.now }),
      log: cap.log,
      now: clock.now,
      timers: clock.timers,
      random: () => 1,
      onFrame: (raw) => out.push(raw),
      onStatus: (raw) => out.push(raw),
      createSocket: () => {
        const s = new FakeSocket();
        sockets.push(s);
        return s as unknown as WebSocket;
      },
      ...extra
    });
    up.start();
    const resyncs = () => cap.lines.filter((l) => l.msg === 'perpl.upstream_resync').map((l) => l.reason);
    const statuses = () => out.map((r) => JSON.parse(r)).filter((f) => f.mt === 9000);
    return { clock, sockets, cap, resyncs, out, statuses };
  }

  test('tells fan-out clients when the upstream drops and recovers, once per transition', () => {
    const { clock, sockets, out, statuses } = start();
    sockets[0]!.open();
    sockets[0]!.emit(SUB_ACK);
    // The new subscription map goes out before the status that refers to it.
    expect(out.map((r) => JSON.parse(r).mt)).toEqual([6, 9000]);
    expect(statuses()).toEqual([{ mt: 9000, status: 'up', t: 0 }]);

    clock.advance(500);
    sockets[0]!.serverClose(1011);
    expect(statuses().at(-1)).toEqual({ mt: 9000, status: 'down', t: 500 });
    // Failed reconnects do not repeat the down frame.
    clock.advance(D.backoffBaseMs);
    sockets[1]!.serverClose(1011);
    expect(statuses()).toHaveLength(2);

    clock.advance(2 * D.backoffBaseMs);
    sockets[2]!.open();
    sockets[2]!.emit(SUB_ACK);
    expect(statuses().map((f) => f.status)).toEqual(['up', 'down', 'up']);
  });

  test('a partial subscription is reported, not treated as healthy', () => {
    const { sockets, statuses, cap } = start();
    const ack = JSON.parse(SUB_ACK);
    ack.subs = ack.subs.map((s: { stream: string }) =>
      s.stream === 'trades@10' ? { stream: s.stream, status: { code: 500, error: 'internal' } } : s
    );
    sockets[0]!.open();
    sockets[0]!.emit(JSON.stringify(ack));
    expect(up!.status()).toMatchObject({ connected: true, missingStreams: ['trades@10'] });
    expect(statuses()).toEqual([{ mt: 9000, status: 'partial', t: 0, missing: ['trades@10'] }]);
    expect(cap.events()).toContain('perpl.upstream_partial_subscription');
  });

  test('an oversized frame is never parsed or forwarded; the feed resyncs', () => {
    const { sockets, out, resyncs } = start({ maxFrameChars: 4096 });
    sockets[0]!.open();
    sockets[0]!.emit(SUB_ACK);
    const before = out.length;
    sockets[0]!.emit(JSON.stringify({ mt: 16, sid: 1000001, sn: 1, at: {}, bid: [], pad: 'x'.repeat(5000) }));
    expect(resyncs()).toEqual(['frame_too_large']);
    expect(out.slice(before).map((r) => JSON.parse(r).mt)).toEqual([9000]);
  });

  test('forces a reconnect when the feed goes silent past staleAfterMs', () => {
    const { clock, sockets, resyncs } = start();
    sockets[0]!.open();
    sockets[0]!.emit(SUB_ACK);
    expect(up!.status().connected).toBe(true);

    // Exactly at the threshold is still live; the next watchdog tick resyncs.
    clock.advance(D.staleAfterMs);
    expect(resyncs()).toEqual([]);
    clock.advance(1_000);
    expect(resyncs()).toEqual(['stale']);
    expect(sockets[0]!.closedWith).toEqual({ code: 4000, reason: 'stale' });
    expect(up!.status().connected).toBe(false);

    // random() = 1 gives the full first backoff step.
    clock.advance(D.backoffBaseMs - 1);
    expect(sockets).toHaveLength(1);
    clock.advance(1);
    expect(sockets).toHaveLength(2);
  });

  test('frames keep the feed alive', () => {
    const { clock, sockets, resyncs } = start();
    sockets[0]!.open();
    sockets[0]!.emit(SUB_ACK);
    for (let i = 0; i < 30; i++) {
      clock.advance(D.staleAfterMs - 1);
      sockets[0]!.emit(JSON.stringify({ mt: 100, sid: 5000, sn: i + 1, h: i + 1 }));
    }
    expect(resyncs()).toEqual([]);
    expect(sockets).toHaveLength(1);
  });

  test('connect and subscribe timeouts resync', () => {
    const { clock, sockets, resyncs } = start();
    clock.advance(D.connectTimeoutMs);
    expect(resyncs()).toEqual(['connect_timeout']);
    clock.advance(D.backoffBaseMs);
    sockets[1]!.open();
    expect(JSON.parse(sockets[1]!.sent[0]!).mt).toBe(5);
    clock.advance(D.subscribeTimeoutMs);
    expect(resyncs()).toEqual(['connect_timeout', 'subscribe_timeout']);
  });

  test('treats a heartbeat sequence gap as lost frames and resyncs', () => {
    const { sockets, cap, resyncs } = start();
    sockets[0]!.open();
    sockets[0]!.emit(SUB_ACK);
    sockets[0]!.emit(JSON.stringify({ mt: 100, sid: 5000, sn: 10, h: 10 }));
    sockets[0]!.emit(JSON.stringify({ mt: 100, sid: 5000, sn: 12, h: 12 }));
    expect(cap.lines.find((l) => l.msg === 'perpl.heartbeat_gap')).toMatchObject({ expected: 11, got: 12 });
    expect(resyncs()).toEqual(['heartbeat_gap']);
  });

  test('backs off exponentially across consecutive failures and floors after 1008', () => {
    const { clock, sockets, cap } = start();
    // 1008 lifts the attempt to 4 (16 s), then it keeps growing (32 s).
    for (const [i, delay] of [[0, 16_000], [1, 32_000]] as const) {
      sockets[i]!.open();
      sockets[i]!.serverClose(1008);
      clock.advance(delay - 1);
      expect(sockets).toHaveLength(i + 1);
      clock.advance(1);
      expect(sockets).toHaveLength(i + 2);
    }
    const scheduled = cap.lines.filter((l) => l.msg === 'perpl.upstream_reconnect_scheduled');
    expect(scheduled.map((l) => [l.attempt, l.delayMs])).toEqual([[4, 16_000], [5, 32_000]]);
  });

  test('a 1001 close reconnects without growing the delay', () => {
    const { clock, sockets } = start();
    sockets[0]!.open();
    sockets[0]!.serverClose(1001);
    clock.advance(D.backoffBaseMs);
    expect(sockets).toHaveLength(2);
  });

  test('stop() closes the socket and never reconnects', () => {
    const { clock, sockets } = start();
    sockets[0]!.open();
    sockets[0]!.emit(SUB_ACK);
    up!.stop();
    expect(sockets[0]!.closedWith).toEqual({ code: 1000, reason: 'shutdown' });
    clock.advance(10 * 60_000);
    expect(sockets).toHaveLength(1);
    expect(up!.status().state).toBe('closed');
  });
});
