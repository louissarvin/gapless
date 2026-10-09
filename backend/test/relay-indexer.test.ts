import { afterEach, describe, expect, test } from 'bun:test';
import type { FastifyInstance } from 'fastify';
import { getAddress } from 'viem';
import { COVER_HISTORY_MAX_LIMIT, INDEXER_CACHE_MS, INDEXER_MAX_BYTES, INDEXER_UPSTREAM_PER_MIN } from '../src/relay/routes/indexer.ts';
import { APP_ORIGIN, buildTestApp } from './helpers.ts';

// Test-only values: no real indexer, account or tx. Shapes follow indexer/schema.graphql as Hasura serves them
// (lowercase addresses, BigInt as strings, Int as numbers, relations as <field>_id).
const GRAPHQL_URL = 'http://localhost:8080/v1/graphql';
const ACCOUNT_LC = '0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed';
const ACCOUNT = getAddress(ACCOUNT_LC);
const OWNER_LC = '0xfb6916095ca1df60bb79ce92ce3ea74c37c5d359';
const COVER = `0x${'ab'.repeat(32)}`;
const TX1 = `0x${'c1'.repeat(32)}`;
const TX2 = `0x${'c2'.repeat(32)}`;

const cover = () => ({
  id: COVER,
  perpId: 1,
  side: 'LONG',
  status: 'FINALIZED',
  endReason: 'NONE',
  lots: '22',
  stopPNS: '6123450',
  expiryBlock: 111_960_000,
  boughtBlock: 111_906_400,
  boughtTx: TX1,
  endedBlock: 111_906_520,
  endedTx: TX2,
  paidCNS: '1830000'
});
const event = (kind: string, blockNumber: number, logIndex: number, txHash: string) => ({ cover_id: COVER, kind, blockNumber, logIndex, txHash });
const valid = () => ({
  data: {
    GaplessAccountEntity_by_pk: { id: ACCOUNT_LC, owner: OWNER_LC },
    Cover: [cover()],
    CoverEvent: [event('FINALIZED', 111_906_520, 4, TX2), event('TRIGGERED', 111_906_480, 7, TX2), event('BOUGHT', 111_906_400, 2, TX1)],
    chain_metadata: [{ latest_processed_block: 111_906_600 }]
  }
});
const expected = () => ({
  account: ACCOUNT,
  owner: getAddress(OWNER_LC),
  indexedBlock: 111_906_600,
  limit: 20,
  covers: [cover()].map(({ id, ...c }) => ({ coverId: id, ...c })),
  events: valid().data.CoverEvent.map(({ cover_id, ...e }) => ({ coverId: cover_id, ...e }))
});

describe('relay GET /api/indexer/cover-history/:account', () => {
  let app: FastifyInstance | undefined;
  let clock = 0;
  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  type Call = { url: string; method: string | undefined; headers: Headers; body: { query: string; operationName: string; variables: Record<string, unknown> } };
  async function setup(respond: () => Promise<Response> | Response, configured = true) {
    const calls: Call[] = [];
    clock = 0;
    const fetchIndexer = (async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(input), method: init?.method, headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) });
      return respond();
    }) as typeof fetch;
    ({ app } = await buildTestApp({ env: configured ? { ENVIO_GRAPHQL_URL: GRAPHQL_URL } : {}, fetchIndexer, now: () => clock }));
    return calls;
  }
  const get = (path: string, origin: string | null = APP_ORIGIN, remoteAddress?: string) =>
    app!.inject({ method: 'GET', url: `/api/indexer/cover-history/${path}`, headers: origin === null ? {} : { origin }, remoteAddress });

  test('503 INDEXER_NOT_CONFIGURED without ENVIO_GRAPHQL_URL, nothing fetched', async () => {
    const calls = await setup(() => Response.json(valid()), false);
    const res = await get(ACCOUNT);
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ success: false, data: null, error: { code: 'INDEXER_NOT_CONFIGURED' } });
    expect(calls).toEqual([]);
  });

  test('rejects foreign Origin before querying the indexer', async () => {
    const calls = await setup(() => Response.json(valid()));
    expect((await get(ACCOUNT, 'https://evil.example')).statusCode).toBe(403);
    expect((await get(ACCOUNT, null)).statusCode).toBe(403);
    expect(calls).toEqual([]);
  });

  test.each(['0x123', 'not-an-address', `${ACCOUNT}00`, '0xZZaeb6053f3e94c9b9a09f33669435e7ef1beaed', ACCOUNT.replace('A', 'a')])(
    'rejects malformed or bad-checksum account %p with VALIDATION_ERROR',
    async (account) => {
      const calls = await setup(() => Response.json(valid()));
      const res = await get(account);
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('VALIDATION_ERROR');
      expect(calls).toEqual([]);
    }
  );

  test('rejects unknown query keys and out-of-range limits', async () => {
    const calls = await setup(() => Response.json(valid()));
    for (const q of ['?foo=1', '?limit=0', `?limit=${COVER_HISTORY_MAX_LIMIT + 1}`, '?limit=1e1']) expect((await get(`${ACCOUNT}${q}`)).statusCode).toBe(400);
    expect(calls).toEqual([]);
  });

  test('posts a parameterized query as the public role; the allowlist drops every other upstream field', async () => {
    const up = valid();
    const leaky = {
      ...up,
      extensions: { internal: 'trace-id' },
      data: {
        ...up.data,
        GaplessAccountEntity_by_pk: { ...up.data.GaplessAccountEntity_by_pk, operator: '0x1111111111111111111111111111111111111111' },
        Cover: [{ ...cover(), escrowCNS: '999', armer: '0x2222222222222222222222222222222222222222', note: '<script>' }],
        CoverEvent: up.data.CoverEvent.map((e) => ({ ...e, params: { secret: 'p' }, actor: '0x3333333333333333333333333333333333333333', reason: 'free text' })),
        Stats: [{ id: 'global' }]
      }
    };
    const calls = await setup(() => Response.json(leaky));
    const res = await get(ACCOUNT_LC);
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe(`public, max-age=${INDEXER_CACHE_MS / 1000}`);
    const body: unknown = res.json();
    expect(body).toEqual({ success: true, error: null, data: expected() });
    for (const s of ['trace-id', 'escrowCNS', '2222', '3333', '1111', '<script>', 'free text', 'secret', 'global']) expect(res.body).not.toContain(s);

    expect(calls).toHaveLength(1);
    const c = calls[0]!;
    expect(c.url).toBe(GRAPHQL_URL);
    expect(c.method).toBe('POST');
    expect(c.headers.get('accept')).toBe('application/json');
    expect(c.headers.get('content-type')).toBe('application/json');
    expect(c.headers.get('x-hasura-admin-secret')).toBeNull();
    expect(c.headers.get('authorization')).toBeNull();
    expect(c.body.operationName).toBe('CoverHistory');
    expect(c.body.variables).toEqual({ account: ACCOUNT_LC, limit: COVER_HISTORY_MAX_LIMIT });
    // The address only ever travels as a variable.
    expect(c.body.query).not.toContain(ACCOUNT_LC.slice(2));
  });

  test('limit slices one cached upstream result', async () => {
    const calls = await setup(() => Response.json(valid()));
    const one = (await get(`${ACCOUNT}?limit=1`)).json().data;
    expect(one.limit).toBe(1);
    expect(one.events).toEqual(expected().events.slice(0, 1));
    expect((await get(`${ACCOUNT}?limit=50`)).json().data.events).toHaveLength(3);
    expect(calls).toHaveLength(1);
  });

  test('10 s cache with single flight per account', async () => {
    const calls = await setup(() => Response.json(valid()));
    await Promise.all([get(ACCOUNT), get(ACCOUNT_LC), get(ACCOUNT)]);
    expect(calls).toHaveLength(1);
    clock += INDEXER_CACHE_MS - 1;
    await get(ACCOUNT);
    expect(calls).toHaveLength(1);
    clock += 1;
    await get(ACCOUNT);
    expect(calls).toHaveLength(2);
  });

  test('404 ACCOUNT_NOT_FOUND when the indexer has no such clone', async () => {
    await setup(() => Response.json({ data: { ...valid().data, GaplessAccountEntity_by_pk: null, Cover: [], CoverEvent: [] } }));
    const res = await get(ACCOUNT);
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('ACCOUNT_NOT_FOUND');
  });

  test('an account with no covers yet is 200 with empty lists', async () => {
    await setup(() => Response.json({ data: { ...valid().data, Cover: [], CoverEvent: [] } }));
    const res = await get(ACCOUNT);
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toMatchObject({ covers: [], events: [], indexedBlock: 111_906_600 });
  });

  test('503 INDEXER_NOT_READY before the first checkpoint, never an empty history', async () => {
    await setup(() => Response.json({ data: { ...valid().data, GaplessAccountEntity_by_pk: null, Cover: [], CoverEvent: [], chain_metadata: [{ latest_processed_block: -1 }] } }));
    const res = await get(ACCOUNT);
    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe('INDEXER_NOT_READY');
  });

  test.each([
    ['network failure', () => Promise.reject(new Error('connect ECONNREFUSED 127.0.0.1:8080'))],
    ['timeout', () => Promise.reject(new DOMException('The operation timed out.', 'TimeoutError'))],
    ['HTTP 500', () => new Response('upstream exploded', { status: 500 })],
    ['GraphQL errors with HTTP 200', () => Response.json({ errors: [{ message: "field 'account_id' not found in type: 'Cover_bool_exp'" }] })],
    ['not JSON', () => new Response('<html>')],
    ['off-contract enum', () => Response.json({ data: { ...valid().data, Cover: [{ ...cover(), status: 'EXPLODED' }] } })],
    ['free text in a hash', () => Response.json({ data: { ...valid().data, CoverEvent: [event('BOUGHT', 1, 0, 'javascript:alert(1)')] } })],
    ['BigInt as a number', () => Response.json({ data: { ...valid().data, Cover: [{ ...cover(), lots: 22 }] } })],
    ['too many rows', () => Response.json({ data: { ...valid().data, CoverEvent: Array.from({ length: COVER_HISTORY_MAX_LIMIT + 1 }, () => event('ARMED', 1, 0, TX1)) } })],
    ['missing data', () => Response.json({})],
    ['oversized body', () => new Response(JSON.stringify({ ...valid(), pad: 'x'.repeat(INDEXER_MAX_BYTES) }))]
  ])('503 INDEXER_UNAVAILABLE on %s, upstream text never reaches the client', async (_n, respond) => {
    await setup(respond);
    const res = await get(ACCOUNT);
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ error: { code: 'INDEXER_UNAVAILABLE', message: 'Cover history is not available right now' } });
    for (const s of ['ECONNREFUSED', 'exploded', 'account_id', 'EXPLODED', 'javascript', '<html>', 'timed out']) expect(res.body).not.toContain(s);
  });

  test('failures are not cached: the next request queries again', async () => {
    let up = false;
    const calls = await setup(() => (up ? Response.json(valid()) : new Response('', { status: 502 })));
    expect((await get(ACCOUNT)).statusCode).toBe(503);
    up = true;
    expect((await get(ACCOUNT)).statusCode).toBe(200);
    expect(calls).toHaveLength(2);
  });

  test('rate limited at 20/min per IP', async () => {
    await setup(() => Response.json(valid()));
    const codes: number[] = [];
    for (let i = 0; i < 21; i++) codes.push((await get(ACCOUNT)).statusCode);
    expect(codes.slice(0, 20).every((c) => c === 200)).toBe(true);
    expect(codes[20]).toBe(429);
  });

  test('global upstream budget bounds distinct accounts from many IPs', async () => {
    const calls = await setup(() => Response.json({ data: { ...valid().data, GaplessAccountEntity_by_pk: null, Cover: [], CoverEvent: [] } }));
    const codes: number[] = [];
    for (let i = 0; i <= INDEXER_UPSTREAM_PER_MIN; i++) {
      const account = `0x${(i + 1).toString(16).padStart(40, '0')}`;
      codes.push((await get(account, APP_ORIGIN, `10.0.${Math.floor(i / 20)}.1`)).statusCode);
    }
    expect(codes.slice(0, INDEXER_UPSTREAM_PER_MIN).every((c) => c === 404)).toBe(true);
    expect(codes[INDEXER_UPSTREAM_PER_MIN]).toBe(503);
    expect(calls).toHaveLength(INDEXER_UPSTREAM_PER_MIN);
    clock += 60_000;
    expect((await get(ACCOUNT, APP_ORIGIN, '10.9.9.9')).statusCode).toBe(404);
  });
});
