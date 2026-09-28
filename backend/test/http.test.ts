import { afterEach, describe, expect, test } from 'bun:test';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { HttpError, mapError } from '../src/lib/http.ts';
import { buildTestApp } from './helpers.ts';

const SECRET = 'db_password=hunter2 at /srv/gapless/src/secret.ts:42';

describe('mapError', () => {
  test('unknown errors become a generic 500', () => {
    expect(mapError(new Error(SECRET))).toEqual({
      status: 500,
      body: { code: 'INTERNAL_ERROR', message: 'Internal server error' }
    });
    expect(mapError('thrown string').status).toBe(500);
    expect(mapError(null).status).toBe(500);
  });

  test('library 4xx messages are replaced with fixed text', () => {
    const fst = Object.assign(new Error(SECRET), { statusCode: 413, code: 'FST_ERR_CTP_BODY_TOO_LARGE' });
    expect(mapError(fst)).toEqual({ status: 413, body: { code: 'PAYLOAD_TOO_LARGE', message: 'Payload too large' } });
  });

  test('HttpError passes its own code and message through', () => {
    expect(mapError(new HttpError(409, 'ALREADY_CREATED', 'Account exists'))).toEqual({
      status: 409,
      body: { code: 'ALREADY_CREATED', message: 'Account exists' }
    });
  });

  test('ZodError maps to 400 with field paths', () => {
    const res = z.object({ owner: z.string().length(42) }).safeParse({ owner: 1 });
    const mapped = mapError(res.error);
    expect(mapped.status).toBe(400);
    expect(mapped.body.code).toBe('VALIDATION_ERROR');
    expect(mapped.body.details?.[0]?.path).toBe('owner');
  });
});

describe('error handler on the relay app', () => {
  let app: FastifyInstance;
  afterEach(async () => app?.close());

  async function setup(env?: Record<string, string>) {
    ({ app } = await buildTestApp({ env }));
    app.get('/boom', async () => {
      throw new Error(SECRET);
    });
    app.post('/echo', async (request) => {
      const body = z.strictObject({ owner: z.string().regex(/^0x[0-9a-fA-F]{40}$/) }).parse(request.body);
      return { success: true, data: body, error: null };
    });
  }

  test('500 responses never include stack, message or paths', async () => {
    await setup();
    const res = await app.inject({ method: 'GET', url: '/boom' });
    expect(res.statusCode).toBe(500);
    const raw = res.body;
    for (const leak of ['hunter2', '/srv/', 'stack', 'secret.ts', 'at ']) expect(raw).not.toContain(leak);
    const body = res.json();
    expect(body).toEqual({
      success: false,
      data: null,
      error: { code: 'INTERNAL_ERROR', message: 'Internal server error', requestId: expect.any(String) }
    });
  });

  test('zod failures return 400 VALIDATION_ERROR', async () => {
    await setup();
    const res = await app.inject({ method: 'POST', url: '/echo', payload: { owner: 'nope', extra: 1 } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION_ERROR');
  });

  test('bodies over 4096 bytes are rejected with 413', async () => {
    await setup();
    const res = await app.inject({
      method: 'POST',
      url: '/echo',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ owner: 'x'.repeat(5000) })
    });
    expect(res.statusCode).toBe(413);
    expect(res.json().error.code).toBe('PAYLOAD_TOO_LARGE');
  });

  test('malformed JSON is a generic 400 without parser details', async () => {
    await setup();
    const res = await app.inject({
      method: 'POST',
      url: '/echo',
      headers: { 'content-type': 'application/json' },
      payload: '{"owner":'
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatchObject({ code: 'BAD_REQUEST', message: 'Bad request' });
  });

  test('text/plain bodies are refused (JSON only)', async () => {
    await setup();
    const res = await app.inject({ method: 'POST', url: '/echo', headers: { 'content-type': 'text/plain' }, payload: 'hi' });
    expect(res.statusCode).toBe(415);
  });

  test('unknown routes return the standard 404 shape', async () => {
    await setup();
    const res = await app.inject({ method: 'GET', url: '/nope' });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ success: false, data: null, error: { code: 'NOT_FOUND' } });
  });

  test('global rate limit returns 429 with Retry-After, 404s included', async () => {
    await setup({ RATE_LIMIT_MAX: '2' });
    for (let i = 0; i < 2; i++) expect((await app.inject({ method: 'GET', url: '/nope' })).statusCode).toBe(404);
    const res = await app.inject({ method: 'GET', url: '/nope' });
    expect(res.statusCode).toBe(429);
    expect(res.headers['retry-after']).toBeDefined();
    expect(res.json().error.code).toBe('RATE_LIMITED');
  });
});
