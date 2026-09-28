import { createHash, timingSafeEqual } from 'node:crypto';
import { normalizeIP } from '@fastify/rate-limit';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { HttpError } from './http.ts';

/**
 * Exact match against the configured origin. Missing, "null" and any variant (path,
 * trailing slash, other port or scheme) are rejected. Browsers always send Origin on
 * cross-origin fetch and WebSocket handshakes. Non-browser clients can forge it, so this
 * stops cross-site browser abuse only; rate limits and budgets cover the rest.
 */
export function isAllowedOrigin(origin: string | null | undefined, appOrigin: string): boolean {
  return typeof origin === 'string' && origin === appOrigin;
}

/** For Bun.serve WebSocket upgrades: call before server.upgrade(), return 403 when false. */
export function isAllowedUpgrade(req: Request, appOrigin: string): boolean {
  return isAllowedOrigin(req.headers.get('origin'), appOrigin);
}

/**
 * Adds an onRequest Origin check to the current encapsulation scope. Register it inside
 * the plugin that owns browser-facing routes; /healthz stays outside for uptime probes.
 */
export function registerOriginGuard(app: FastifyInstance, appOrigin: string): void {
  app.addHook('onRequest', async (request: FastifyRequest) => {
    if (!isAllowedOrigin(request.headers.origin, appOrigin)) {
      throw new HttpError(403, 'FORBIDDEN_ORIGIN', 'Origin not allowed');
    }
  });
}

/** JSON-only API: deny framing, sniffing, caching and any active content. */
export const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Resource-Policy': 'same-site',
  'Cache-Control': 'no-store'
};

export function registerSecurityHeaders(app: FastifyInstance): void {
  app.addHook('onSend', async (_request: FastifyRequest, reply: FastifyReply, payload: unknown) => {
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) {
      // Routes that opt into caching (for example the Perpl proxy) set Cache-Control themselves.
      if (k === 'Cache-Control' && reply.hasHeader(k)) continue;
      reply.header(k, v);
    }
    // Guarded routes answer 200 or 403 by Origin; a shared cache must not reuse one for the other.
    reply.header('Vary', withVaryOrigin(reply.getHeader('Vary')));
    return payload;
  });
}

function withVaryOrigin(current: unknown): string {
  const raw = Array.isArray(current) ? current.join(', ') : typeof current === 'string' ? current : '';
  const fields = raw.split(',').map((f) => f.trim()).filter(Boolean);
  if (fields.includes('*') || fields.some((f) => f.toLowerCase() === 'origin')) return fields.join(', ');
  return [...fields, 'Origin'].join(', ');
}

/** `Authorization: Bearer <token>` value, or null. */
export function bearerToken(authorization: string | null | undefined): string | null {
  if (typeof authorization !== 'string') return null;
  const m = /^Bearer ([A-Za-z0-9_-]{1,512})$/i.exec(authorization);
  return m ? m[1]! : null;
}

/**
 * Constant-time comparison for shared secrets. Hashing first makes both inputs the same length,
 * so neither the content nor the length of `expected` leaks through timing.
 */
export function tokenMatches(presented: string | null | undefined, expected: string | undefined): boolean {
  if (!expected || typeof presented !== 'string') return false;
  const a = createHash('sha256').update(presented).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}

/** IPv6 prefix that counts as one client, same as the @fastify/rate-limit default. */
export const IPV6_CLIENT_SUBNET = 64;

/** Per-client key for limits, same as @fastify/rate-limit: IPv4-mapped to IPv4, IPv6 masked to its /64. */
export function clientKey(ip: string, ipv6Subnet: number = IPV6_CLIENT_SUBNET): string {
  try {
    return normalizeIP(ip, ipv6Subnet);
  } catch {
    return ip.toLowerCase();
  }
}
