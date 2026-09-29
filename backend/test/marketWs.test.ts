import { afterEach, describe, expect, test } from 'bun:test';
import net from 'node:net';
import pino from 'pino';
import { MarketStore } from '../src/relay/perpl/store.ts';
import { parseFrame } from '../src/relay/perpl/types.ts';
import { MARKET_WS_LIMITS, MARKET_WS_PATH, startMarketWsServer, type MarketWsLimits, type MarketWsServer } from '../src/relay/ws/marketServer.ts';
import { clientKey } from '../src/lib/security.ts';
import { loadWsFixture } from './perplFixtures.ts';

const ORIGIN = 'https://app.gapless.test';
// Test-only value; production reads RELAY_INTERNAL_TOKEN from env.
const INTERNAL_TOKEN = 'k'.repeat(48);
const FRAMES = loadWsFixture();

function seededStore(): MarketStore {
  const store = new MarketStore();
  for (const raw of FRAMES) {
    const r = parseFrame(raw);
    if (r.ok) store.apply(r.frame);
  }
  store.setConnected(true);
  return store;
}

async function until(cond: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out waiting for condition');
    await Bun.sleep(5);
  }
}

describe('/ws/market fan-out', () => {
  let srv: MarketWsServer | undefined;
  const sockets: WebSocket[] = [];
  afterEach(async () => {
    for (const s of sockets) s.close();
    sockets.length = 0;
    await srv?.stop();
    srv = undefined;
  });

  function start(limits: Partial<MarketWsLimits> = {}, trustProxy?: string[], store = seededStore(), internalToken?: string) {
    srv = startMarketWsServer({
      host: '127.0.0.1',
      port: 0,
      appOrigin: ORIGIN,
      store,
      log: pino({ level: 'silent' }),
      limits,
      trustProxy,
      internalToken,
      random: () => 1
    });
    return { url: `ws://127.0.0.1:${srv.port}${MARKET_WS_PATH}`, http: `http://127.0.0.1:${srv.port}${MARKET_WS_PATH}`, store };
  }

  function connect(url: string, headers: Record<string, string> = { Origin: ORIGIN }) {
    const ws = new WebSocket(url, { headers } as unknown as string[]);
    sockets.push(ws);
    const messages: string[] = [];
    ws.onmessage = (e) => messages.push(String(e.data));
    let closeCode: number | null = null;
    const opened = new Promise<boolean>((resolve) => {
      ws.onopen = () => resolve(true);
      ws.onclose = (e) => {
        closeCode = e.code;
        resolve(false);
      };
      ws.onerror = () => resolve(false);
    });
    return { ws, messages, opened, closeCode: () => closeCode };
  }

  const internal = { Authorization: `Bearer ${INTERNAL_TOKEN}` };

  test.each([
    ['foreign origin', { Origin: 'https://evil.test' }],
    ['missing origin', {} as Record<string, string>],
    ['origin with trailing slash', { Origin: `${ORIGIN}/` }]
  ])('rejects the upgrade for %s', async (_name, headers) => {
    const { url, http } = start();
    expect(await connect(url, headers).opened).toBe(false);
    const res = await fetch(http, { headers });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ success: false, error: { code: 'FORBIDDEN_ORIGIN' } });
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(srv!.clientCount()).toBe(0);
  });

  test('404 for other paths and 405 for other methods', async () => {
    const { http } = start();
    expect((await fetch(http.replace(MARKET_WS_PATH, '/ws/trading'), { headers: { Origin: ORIGIN } })).status).toBe(404);
    expect((await fetch(http, { method: 'POST', headers: { Origin: ORIGIN } })).status).toBe(405);
  });

  test('sends the current snapshot on connect, then live frames, and ignores client messages', async () => {
    const { url, store } = start();
    const c = connect(url);
    expect(await c.opened).toBe(true);
    const expected = store.snapshotFrames();
    await until(() => c.messages.length >= expected.length);
    expect(c.messages).toEqual(expected);

    expect(JSON.parse(c.messages[0]!)).toMatchObject({ mt: 9000, status: 'up' });

    c.ws.send(JSON.stringify({ mt: 5, subs: [{ stream: 'trades@20', subscribe: true }] }));
    c.ws.send('x'.repeat(200));
    const live = FRAMES.find((f) => JSON.parse(f).mt === 16)!;
    srv!.broadcast(live);
    await until(() => c.messages.length === expected.length + 1);
    expect(c.messages.at(-1)).toBe(live);
    expect(c.ws.readyState).toBe(WebSocket.OPEN);
  });

  test('answers client keepalives with a pong that echoes t', async () => {
    const { url } = start();
    const c = connect(url);
    expect(await c.opened).toBe(true);
    c.ws.send(JSON.stringify({ mt: 1, t: 12345 }));
    await until(() => c.messages.some((m) => JSON.parse(m).mt === 2));
    expect(c.messages.map((m) => JSON.parse(m)).find((f) => f.mt === 2)).toEqual({ mt: 2, t: 12345 });
  });

  test('closes clients that send nothing, even if they answer protocol pings', async () => {
    const { url } = start({ clientIdleMs: 300, sweepIntervalMs: 25 });
    const silent = connect(url);
    const alive = connect(url);
    expect(await silent.opened).toBe(true);
    expect(await alive.opened).toBe(true);
    // Protocol-level traffic only: pings and pongs reset Bun's idleTimeout, not the app idle check.
    const pinger = setInterval(() => {
      silent.ws.ping();
      silent.ws.pong();
      alive.ws.send('{"mt":1}');
    }, 50);
    try {
      await until(() => silent.ws.readyState === WebSocket.CLOSED, 3000);
      expect(silent.closeCode()).toBe(1008);
      expect(alive.ws.readyState).toBe(WebSocket.OPEN);
    } finally {
      clearInterval(pinger);
    }
  });

  test('closes clients that flood messages', async () => {
    const { url } = start({ maxClientMessagesPerMinute: 5 });
    const c = connect(url);
    expect(await c.opened).toBe(true);
    for (let i = 0; i < 6; i++) c.ws.send('{"mt":1}');
    await until(() => c.ws.readyState === WebSocket.CLOSED);
    expect(c.closeCode()).toBe(1008);
  });

  test('recycles public sockets after the max lifetime so parked slots turn over; internal ones stay', async () => {
    const { url } = start({ maxLifetimeMs: 300, sweepIntervalMs: 25 }, undefined, seededStore(), INTERNAL_TOKEN);
    const pub = connect(url);
    const keeper = connect(url, internal);
    expect(await pub.opened).toBe(true);
    expect(await keeper.opened).toBe(true);
    const keepalive = setInterval(() => {
      if (pub.ws.readyState === WebSocket.OPEN) pub.ws.send('{"mt":1}');
      keeper.ws.send('{"mt":1}');
    }, 50);
    try {
      await until(() => pub.ws.readyState === WebSocket.CLOSED, 3000);
      // Bun's client reports 1000 for a server 1001 (backend CLAUDE.md quirks).
      expect([1000, 1001]).toContain(pub.closeCode()!);
      await Bun.sleep(400);
      expect(keeper.ws.readyState).toBe(WebSocket.OPEN);
      expect(srv!.counts()).toEqual({ public: 0, internal: 1 });
    } finally {
      clearInterval(keepalive);
    }
  });

  test('closes clients that send oversized frames', async () => {
    const { url } = start();
    const c = connect(url);
    expect(await c.opened).toBe(true);
    const closed = new Promise<number>((r) => (c.ws.onclose = (e) => r(e.code)));
    c.ws.send('x'.repeat(MARKET_WS_LIMITS.maxPayloadLength + 1));
    // Bun drops the TCP connection (client sees 1006) rather than sending 1009.
    expect([1006, 1009]).toContain(await closed);
    await until(() => srv!.clientCount() === 0);
  });

  test('caps total clients', async () => {
    const { url, http } = start({ maxClients: 2, maxClientsPerIp: 10 });
    expect(await connect(url).opened).toBe(true);
    expect(await connect(url).opened).toBe(true);
    expect(await connect(url).opened).toBe(false);
    const res = await fetch(http, { headers: { Origin: ORIGIN } });
    expect(res.status).toBe(503);
    expect(srv!.clientCount()).toBe(2);
  });

  test('caps clients per IP and upgrade attempts per IP', async () => {
    const { url, http } = start({ maxClientsPerIp: 1, upgradesPerIpPerMinute: 3 });
    expect(await connect(url).opened).toBe(true);
    expect((await fetch(http, { headers: { Origin: ORIGIN } })).status).toBe(429); // attempt 2: per-IP cap
    expect((await fetch(http, { headers: { Origin: ORIGIN } })).status).toBe(429); // attempt 3
    const res = await fetch(http, { headers: { Origin: ORIGIN } }); // attempt 4: rate
    expect(res.status).toBe(429);
    expect(await res.json()).toMatchObject({ error: { code: 'RATE_LIMITED' } });
  });

  test('groups IPv6 clients by /64 like the HTTP limiter (upgrade rate and socket cap)', async () => {
    const { url, http } = start({ upgradesPerIpPerMinute: 2, maxClientsPerIp: 1 }, ['loopback']);
    const h = (ip: string) => ({ Origin: ORIGIN, 'X-Forwarded-For': ip });
    expect(await connect(url, h('2001:db8:dead:beef::1')).opened).toBe(true);
    // Another /128 in the same /64 is the same client: the socket cap applies.
    const second = await fetch(http, { headers: h('2001:db8:dead:beef::2') });
    expect(second.status).toBe(429);
    expect(await second.json()).toMatchObject({ error: { code: 'TOO_MANY_CONNECTIONS' } });
    // ...and so does the upgrade rate (third attempt from the /64).
    expect((await fetch(http, { headers: h('2001:db8:dead:beef:ffff::3') })).status).toBe(429);
    expect(await (await fetch(http, { headers: h('2001:db8:dead:beef::4') })).json()).toMatchObject({ error: { code: 'RATE_LIMITED' } });
    // A different /64 has its own budget (426: plain GET, not an upgrade).
    expect((await fetch(http, { headers: h('2001:db8:dead:bef0::1') })).status).toBe(426);
  });

  test('clientKey matches @fastify/rate-limit normalization', () => {
    expect(clientKey('2001:db8:dead:beef:1:2:3:4')).toBe('2001:db8:dead:beef::');
    expect(clientKey('::ffff:203.0.113.9')).toBe('203.0.113.9');
    expect(clientKey('203.0.113.9')).toBe('203.0.113.9');
    expect(clientKey('not-an-ip')).toBe('not-an-ip');
  });

  test('internal token path: reserved pool outside the public caps, no Origin needed', async () => {
    const { url, http } = start({ maxClients: 1, maxClientsPerIp: 1, maxInternalClients: 1 }, undefined, seededStore(), INTERNAL_TOKEN);
    expect(await connect(url).opened).toBe(true);
    expect((await fetch(http, { headers: { Origin: ORIGIN } })).status).toBe(429);
    // Public pool full, keeper still gets in; it receives the same snapshot.
    const keeper = connect(url, internal);
    expect(await keeper.opened).toBe(true);
    await until(() => keeper.messages.length > 0);
    expect(JSON.parse(keeper.messages[0]!)).toMatchObject({ mt: 9000 });
    expect(srv!.counts()).toEqual({ public: 1, internal: 1 });
    // The internal pool has its own cap.
    expect((await fetch(http, { headers: internal })).status).toBe(503);
  });

  test.each([
    ['wrong token', `Bearer ${'x'.repeat(48)}`],
    ['token prefix', `Bearer ${INTERNAL_TOKEN.slice(0, 47)}`],
    ['not bearer', `Basic ${INTERNAL_TOKEN}`]
  ])('internal path rejects %s with 401', async (_name, authorization) => {
    const { url, http } = start({}, undefined, seededStore(), INTERNAL_TOKEN);
    const res = await fetch(http, { headers: { Authorization: authorization, Origin: ORIGIN } });
    expect(res.status).toBe(401);
    expect(await res.text()).not.toContain(INTERNAL_TOKEN);
    expect(await connect(url, { Authorization: authorization }).opened).toBe(false);
  });

  test('internal path is off when no token is configured', async () => {
    const { http } = start();
    expect((await fetch(http, { headers: internal })).status).toBe(401);
  });

  test('uses X-Forwarded-For only from a trusted proxy', async () => {
    const trusted = start({ upgradesPerIpPerMinute: 1 }, ['loopback']);
    const h = (ip: string) => ({ Origin: ORIGIN, 'X-Forwarded-For': ip });
    // Distinct client IPs behind the trusted proxy get separate budgets (426: plain GET, not an upgrade).
    expect((await fetch(trusted.http, { headers: h('203.0.113.1') })).status).toBe(426);
    expect((await fetch(trusted.http, { headers: h('203.0.113.2') })).status).toBe(426);
    expect((await fetch(trusted.http, { headers: h('203.0.113.1') })).status).toBe(429);
    await srv!.stop();

    const untrusted = start({ upgradesPerIpPerMinute: 1 });
    expect((await fetch(untrusted.http, { headers: h('203.0.113.1') })).status).toBe(426);
    expect((await fetch(untrusted.http, { headers: h('203.0.113.2') })).status).toBe(429);
  });

  test('drops a slow consumer instead of buffering without bound', async () => {
    const { store } = start({ backpressureLimitBytes: 64 * 1024 });
    let handshake = '';
    // Raw client that completes the handshake, then stops reading (TCP backpressure).
    const sock = net.connect(srv!.port, '127.0.0.1');
    sock.on('data', (d) => {
      handshake += d.toString('latin1');
      if (handshake.includes('\r\n\r\n')) sock.pause();
    });
    sock.write(
      `GET ${MARKET_WS_PATH} HTTP/1.1\r\nHost: 127.0.0.1\r\nOrigin: ${ORIGIN}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
        'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n'
    );
    await until(() => handshake.startsWith('HTTP/1.1 101'));
    await until(() => srv!.clientCount() === 1);
    expect(store.snapshotFrames().length).toBeGreaterThan(0);
    // Each frame is far below the limit; only the accumulated backlog can trip it.
    const frame = JSON.stringify({ mt: 16, pad: 'x'.repeat(8 * 1024) });
    let sent = 0;
    while (srv!.clientCount() > 0 && sent < 20_000) {
      srv!.broadcast(frame);
      if (++sent % 50 === 0) await Bun.sleep(1);
    }
    expect(srv!.clientCount()).toBe(0);
    expect(sent).toBeGreaterThan(8);
    sock.destroy();
  });
});
