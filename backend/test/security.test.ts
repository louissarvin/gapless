import { afterEach, describe, expect, test } from 'bun:test';
import type { FastifyInstance } from 'fastify';
import { bearerToken, isAllowedOrigin, isAllowedUpgrade, registerOriginGuard, tokenMatches } from '../src/lib/security.ts';
import { APP_ORIGIN, buildTestApp } from './helpers.ts';

describe('isAllowedOrigin', () => {
  test('accepts only the exact origin', () => {
    expect(isAllowedOrigin(APP_ORIGIN, APP_ORIGIN)).toBe(true);
  });

  test.each([
    undefined,
    null,
    '',
    'null',
    `${APP_ORIGIN}/`,
    'https://APP.gapless.test',
    'http://app.gapless.test',
    'https://app.gapless.test:444',
    'https://evil.app.gapless.test',
    'https://app.gapless.test.evil.com'
  ])('rejects %p', (origin) => {
    expect(isAllowedOrigin(origin, APP_ORIGIN)).toBe(false);
  });

  test('WebSocket upgrade check reads the Origin header', () => {
    const ok = new Request('http://relay.local/ws/market', { headers: { origin: APP_ORIGIN } });
    const bad = new Request('http://relay.local/ws/market', { headers: { origin: 'https://evil.test' } });
    const none = new Request('http://relay.local/ws/market');
    expect(isAllowedUpgrade(ok, APP_ORIGIN)).toBe(true);
    expect(isAllowedUpgrade(bad, APP_ORIGIN)).toBe(false);
    expect(isAllowedUpgrade(none, APP_ORIGIN)).toBe(false);
  });
});

describe('internal token helpers', () => {
  const token = 't'.repeat(40);

  test('bearerToken parses only a well-formed Bearer header', () => {
    expect(bearerToken(`Bearer ${token}`)).toBe(token);
    expect(bearerToken(`bearer ${token}`)).toBe(token);
    for (const h of [undefined, null, '', token, `Basic ${token}`, `Bearer  ${token}`, `Bearer ${token} x`, 'Bearer a"b']) {
      expect(bearerToken(h)).toBeNull();
    }
  });

  test('tokenMatches is exact and fails closed without a configured token', () => {
    expect(tokenMatches(token, token)).toBe(true);
    expect(tokenMatches(token.slice(1), token)).toBe(false);
    expect(tokenMatches(`${token}x`, token)).toBe(false);
    expect(tokenMatches(token, undefined)).toBe(false);
    expect(tokenMatches('', '')).toBe(false);
    expect(tokenMatches(null, token)).toBe(false);
  });
});

describe('relay HTTP hardening', () => {
  let app: FastifyInstance;
  afterEach(async () => app?.close());

  async function appWithGuardedRoute() {
    ({ app } = await buildTestApp());
    await app.register(async (scope) => {
      registerOriginGuard(scope, APP_ORIGIN);
      scope.get('/api/ping', async () => ({ success: true, data: 'pong', error: null }));
    });
    return app;
  }

  test('guarded routes reject missing and foreign Origin with 403', async () => {
    await appWithGuardedRoute();
    for (const headers of [{}, { origin: 'https://evil.test' }]) {
      const res = await app.inject({ method: 'GET', url: '/api/ping', headers });
      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe('FORBIDDEN_ORIGIN');
    }
    const ok = await app.inject({ method: 'GET', url: '/api/ping', headers: { origin: APP_ORIGIN } });
    expect(ok.statusCode).toBe(200);
  });

  test('/healthz stays reachable without Origin', async () => {
    await appWithGuardedRoute();
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);
  });

  test('CORS allows exactly APP_ORIGIN', async () => {
    await appWithGuardedRoute();
    const pre = await app.inject({
      method: 'OPTIONS',
      url: '/api/ping',
      headers: { origin: APP_ORIGIN, 'access-control-request-method': 'POST' }
    });
    expect(pre.statusCode).toBe(204);
    expect(pre.headers['access-control-allow-origin']).toBe(APP_ORIGIN);

    const foreign = await app.inject({ method: 'GET', url: '/healthz', headers: { origin: 'https://evil.test' } });
    expect(foreign.headers['access-control-allow-origin']).not.toBe('https://evil.test');
    expect(foreign.headers['access-control-allow-origin']).not.toBe('*');
  });

  test('sets security headers and a request id', async () => {
    await appWithGuardedRoute();
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['content-security-policy']).toBe("default-src 'none'; frame-ancestors 'none'");
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers.vary).toBe('Origin');
    expect(res.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });

  test('ignores client-supplied request ids', async () => {
    await appWithGuardedRoute();
    const res = await app.inject({ method: 'GET', url: '/healthz', headers: { 'request-id': 'attacker' } });
    expect(res.headers['x-request-id']).not.toBe('attacker');
  });
});
