import proxyAddr from '@fastify/proxy-addr';
import type { IncomingMessage } from 'node:http';
import type { Server, ServerWebSocket } from 'bun';
import type { Logger } from '../../lib/log.ts';
import { IPV6_CLIENT_SUBNET, SECURITY_HEADERS, bearerToken, clientKey, isAllowedUpgrade, tokenMatches } from '../../lib/security.ts';
import type { MarketStore } from '../perpl/store.ts';
import { MT } from '../perpl/types.ts';

export const MARKET_WS_PATH = '/ws/market';
const TOPIC = 'market';

export const MARKET_WS_LIMITS = {
  /** Spec §4.2. Public clients only; internal clients have their own pool. */
  maxClients: 200,
  maxClientsPerIp: 5,
  upgradesPerIpPerMinute: 20,
  /** Token-authenticated readers (the keeper), outside every public cap. */
  maxInternalClients: 4,
  /** A client this far behind is closed and must reconnect for a fresh snapshot. */
  backpressureLimitBytes: 1024 * 1024,
  /** Clients only send keepalives; keep inbound frames tiny. */
  maxPayloadLength: 1024,
  /** Bun protocol pings: detects dead TCP. Pongs reset this, so it cannot detect parked sockets. */
  idleTimeoutS: 60,
  /** Application idle: a client must send a frame (for example {"mt":1}) this often. Pongs do not count. */
  clientIdleMs: 90_000,
  /** Public sockets are recycled (with up to 10% jitter) so parked slots turn over and pass the upgrade checks again. */
  maxLifetimeMs: 30 * 60_000,
  maxClientMessagesPerMinute: 60,
  sweepIntervalMs: 5_000,
  /** A closed socket that has not finished the close handshake by then is terminated. */
  closeGraceMs: 5_000,
  /** Same IPv6 grouping as the HTTP limiter (@fastify/rate-limit default). */
  ipv6Subnet: IPV6_CLIENT_SUBNET
} as const;

export type MarketWsLimits = { [K in keyof typeof MARKET_WS_LIMITS]: number };

/** Close codes sent by /ws/market. Clients reconnect on all of them (with backoff on 1008). */
export const MARKET_WS_CLOSE = {
  /** Shutdown or max lifetime: reconnect now for a fresh snapshot. */
  GOING_AWAY: 1001,
  /** Idle (no client frame within clientIdleMs) or message flood. */
  POLICY: 1008
} as const;

interface ClientData {
  ip: string;
  internal: boolean;
  openedAt: number;
  expiresAt: number;
  lastClientMsgAt: number;
  msgWindowStart: number;
  msgCount: number;
  closeRequestedAt: number | null;
}

export interface MarketWsOptions {
  host: string;
  port: number;
  appOrigin: string;
  store: MarketStore;
  log: Logger;
  /** Same list as Fastify's trustProxy, so per-IP limits see the same client address. */
  trustProxy?: readonly string[];
  /** RELAY_INTERNAL_TOKEN. Unset disables the internal path. */
  internalToken?: string;
  limits?: Partial<MarketWsLimits>;
  now?: () => number;
  random?: () => number;
}

export interface MarketWsServer {
  readonly port: number;
  /** Fans one frame out to every client, unchanged. */
  broadcast(raw: string): void;
  clientCount(): number;
  counts(): { public: number; internal: number };
  stop(): Promise<void>;
}

/** Answer to a client keepalive `{"mt":1,"t":ms}` in Perpl's pong shape, or null. */
function pongFor(msg: string): string | null {
  let json: unknown;
  try {
    json = JSON.parse(msg);
  } catch {
    return null;
  }
  if (json === null || typeof json !== 'object' || (json as { mt?: unknown }).mt !== MT.PING) return null;
  const t = (json as { t?: unknown }).t;
  return JSON.stringify(Number.isSafeInteger(t) && (t as number) >= 0 ? { mt: MT.PONG, t } : { mt: MT.PONG });
}

/**
 * Read-only market fan-out on Bun.serve (Fastify cannot hand upgrades to Bun's native pub/sub).
 * Public path: Origin, per-IP rate and caps, total cap. Internal path: `Authorization: Bearer
 * RELAY_INTERNAL_TOKEN`, its own small pool, no lifetime cap.
 */
export function startMarketWsServer(opts: MarketWsOptions): MarketWsServer {
  const limits: MarketWsLimits = { ...MARKET_WS_LIMITS, ...opts.limits };
  const now = opts.now ?? Date.now;
  const random = opts.random ?? Math.random;
  const log = opts.log;
  const trust = opts.trustProxy && opts.trustProxy.length > 0 ? proxyAddr.compile([...opts.trustProxy]) : null;
  const clients = new Set<ServerWebSocket<ClientData>>();
  const perIp = new Map<string, number>();
  const upgrades = new Map<string, { count: number; windowStart: number }>();
  let internalCount = 0;

  function clientIp(req: Request, server: Server<ClientData>): string {
    const socketAddr = server.requestIP(req)?.address ?? '';
    if (!trust) return clientKey(socketAddr, limits.ipv6Subnet);
    const xff = req.headers.get('x-forwarded-for') ?? undefined;
    const reqLike = { socket: { remoteAddress: socketAddr }, headers: { 'x-forwarded-for': xff } };
    return clientKey(proxyAddr(reqLike as unknown as IncomingMessage, trust), limits.ipv6Subnet);
  }

  function allowUpgrade(ip: string): boolean {
    const t = now();
    const w = upgrades.get(ip);
    if (!w || t - w.windowStart >= 60_000) {
      upgrades.set(ip, { count: 1, windowStart: t });
      return true;
    }
    w.count++;
    return w.count <= limits.upgradesPerIpPerMinute;
  }

  function requestClose(ws: ServerWebSocket<ClientData>, code: number, reason: string, t: number): void {
    if (ws.data.closeRequestedAt !== null) return;
    ws.data.closeRequestedAt = t;
    ws.close(code, reason);
  }

  const sweep = setInterval(() => {
    const t = now();
    for (const ws of clients) {
      const d = ws.data;
      if (d.closeRequestedAt !== null) {
        // A peer that never completes the close handshake must not keep its slot.
        if (t - d.closeRequestedAt >= limits.closeGraceMs) ws.terminate();
      } else if (t - d.lastClientMsgAt > limits.clientIdleMs) {
        log.info({ ip: d.ip, internal: d.internal }, 'ws.client_idle');
        requestClose(ws, MARKET_WS_CLOSE.POLICY, 'idle timeout', t);
      } else if (t >= d.expiresAt) {
        requestClose(ws, MARKET_WS_CLOSE.GOING_AWAY, 'max lifetime', t);
      }
    }
    for (const [ip, w] of upgrades) if (t - w.windowStart >= 60_000) upgrades.delete(ip);
  }, limits.sweepIntervalMs);

  function reject(status: number, code: string): Response {
    return new Response(JSON.stringify({ success: false, data: null, error: { code, message: code.toLowerCase().replaceAll('_', ' ') } }), {
      status,
      headers: { ...SECURITY_HEADERS, 'Content-Type': 'application/json; charset=utf-8' }
    });
  }

  function upgrade(req: Request, srv: Server<ClientData>, ip: string, internal: boolean): Response | undefined {
    const t = now();
    const lifetime = internal ? Infinity : limits.maxLifetimeMs * (0.9 + 0.1 * random());
    const data: ClientData = {
      ip,
      internal,
      openedAt: t,
      expiresAt: t + lifetime,
      lastClientMsgAt: t,
      msgWindowStart: t,
      msgCount: 0,
      closeRequestedAt: null
    };
    if (srv.upgrade(req, { data })) return undefined;
    return reject(426, 'UPGRADE_REQUIRED');
  }

  const server = Bun.serve({
    hostname: opts.host,
    port: opts.port,
    fetch(req, srv) {
      const url = new URL(req.url);
      if (url.pathname !== MARKET_WS_PATH) return reject(404, 'NOT_FOUND');
      if (req.method !== 'GET') return reject(405, 'METHOD_NOT_ALLOWED');
      const ip = clientIp(req, srv);
      if (!allowUpgrade(ip)) {
        log.warn({ ip }, 'ws.rejected_rate');
        return reject(429, 'RATE_LIMITED');
      }
      const authorization = req.headers.get('authorization');
      if (authorization !== null) {
        // Never log the header: it carries the token.
        if (!tokenMatches(bearerToken(authorization), opts.internalToken)) {
          log.warn({ ip }, 'ws.internal_auth_failed');
          return reject(401, 'UNAUTHORIZED');
        }
        if (internalCount >= limits.maxInternalClients) {
          log.warn({ internal: internalCount }, 'ws.rejected_internal_full');
          return reject(503, 'SERVER_FULL');
        }
        return upgrade(req, srv, ip, true);
      }
      if (!isAllowedUpgrade(req, opts.appOrigin)) {
        log.info('ws.rejected_origin');
        return reject(403, 'FORBIDDEN_ORIGIN');
      }
      if ((perIp.get(ip) ?? 0) >= limits.maxClientsPerIp) return reject(429, 'TOO_MANY_CONNECTIONS');
      if (clients.size - internalCount >= limits.maxClients) {
        log.warn({ clients: clients.size - internalCount }, 'ws.rejected_full');
        return reject(503, 'SERVER_FULL');
      }
      return upgrade(req, srv, ip, false);
    },
    websocket: {
      data: {} as ClientData,
      maxPayloadLength: limits.maxPayloadLength,
      idleTimeout: limits.idleTimeoutS,
      backpressureLimit: limits.backpressureLimitBytes,
      closeOnBackpressureLimit: true,
      sendPings: true,
      open(ws) {
        clients.add(ws);
        if (ws.data.internal) internalCount++;
        else perIp.set(ws.data.ip, (perIp.get(ws.data.ip) ?? 0) + 1);
        // Snapshot then subscribe in one tick: no publish can interleave, so nothing is missed.
        for (const frame of opts.store.snapshotFrames()) {
          if (ws.send(frame) === 0) {
            ws.terminate();
            return;
          }
        }
        ws.subscribe(TOPIC);
        log.debug({ clients: clients.size, internal: ws.data.internal }, 'ws.client_open');
      },
      message(ws, msg) {
        const d = ws.data;
        const t = now();
        d.lastClientMsgAt = t;
        if (t - d.msgWindowStart >= 60_000) {
          d.msgWindowStart = t;
          d.msgCount = 0;
        }
        if (++d.msgCount > limits.maxClientMessagesPerMinute) {
          log.warn({ ip: d.ip }, 'ws.client_flood');
          requestClose(ws, MARKET_WS_CLOSE.POLICY, 'too many messages', t);
          return;
        }
        const pong = typeof msg === 'string' ? pongFor(msg) : null;
        if (pong) ws.send(pong);
      },
      close(ws, code) {
        if (!clients.delete(ws)) return;
        if (ws.data.internal) {
          internalCount -= 1;
        } else {
          const n = (perIp.get(ws.data.ip) ?? 1) - 1;
          if (n <= 0) perIp.delete(ws.data.ip);
          else perIp.set(ws.data.ip, n);
        }
        log.debug({ code, clients: clients.size }, 'ws.client_close');
      }
    }
  });

  return {
    port: server.port ?? opts.port,
    broadcast(raw) {
      server.publish(TOPIC, raw);
      // Belt and braces on top of closeOnBackpressureLimit: drop anyone over the limit.
      for (const ws of clients) {
        if (ws.getBufferedAmount() > limits.backpressureLimitBytes) {
          log.warn({ buffered: ws.getBufferedAmount() }, 'ws.slow_consumer_dropped');
          // A close frame cannot flush behind a full buffer.
          ws.terminate();
        }
      }
    },
    clientCount: () => clients.size,
    counts: () => ({ public: clients.size - internalCount, internal: internalCount }),
    async stop() {
      clearInterval(sweep);
      // 1001 tells clients to reconnect right away (to another instance after a deploy).
      for (const ws of clients) ws.close(MARKET_WS_CLOSE.GOING_AWAY, 'going away');
      const deadline = Date.now() + 1_000;
      while (clients.size > 0 && Date.now() < deadline) await Bun.sleep(10);
      // Bun 1.3.1 never settles stop() after a server-initiated close, though it stops listening.
      await Promise.race([server.stop(true), Bun.sleep(500)]);
    }
  };
}
