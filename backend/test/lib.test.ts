import { describe, expect, test } from 'bun:test';
import { Writable } from 'node:stream';
import pino from 'pino';
import { getAddress, HttpRequestError } from 'viem';
import { AUSD, CHAINLINK_FEEDS, CRE_FORWARDERS, PERPL_EXCHANGE } from '../src/lib/addresses.ts';
import { orderedHttpUrls, PUBLIC_FALLBACK_HTTP } from '../src/lib/chain.ts';
import { migrate, openDb } from '../src/lib/db.ts';
import { isSecretKey, loggerOptions, redactUrl, scrubUrls, secretValues } from '../src/lib/log.ts';

function capture(secrets: string[] = []) {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      lines.push(chunk.toString());
      cb();
    }
  });
  return {
    log: pino(loggerOptions('test', 'info', secrets), stream),
    out: () => lines.join(''),
    json: () => lines.map((l) => JSON.parse(l) as Record<string, unknown>)
  };
}

describe('log redaction', () => {
  test('redactUrl keeps host only', () => {
    expect(redactUrl('https://x.quiknode.pro/abc123/')).toBe('https://x.quiknode.pro/<redacted>');
    expect(redactUrl('https://monad-mainnet.g.alchemy.com/v2/KEY?x=1')).toBe(
      'https://monad-mainnet.g.alchemy.com/<redacted>?<redacted>'
    );
    expect(redactUrl('https://rpc3.monad.xyz')).toBe('https://rpc3.monad.xyz');
    expect(scrubUrls('failed: wss://u:p@ws.example/TOKEN now')).toBe('failed: wss://ws.example/<redacted> now');
  });

  test('viem errors and messages do not leak RPC keys into logs', () => {
    const { log, out } = capture();
    const err = new HttpRequestError({ url: 'https://x.quiknode.pro/SECRET_PATH_KEY/', status: 401 });
    log.error({ err }, 'rpc failed');
    log.warn('connecting to https://monad-mainnet.g.alchemy.com/v2/SECRET_ALCHEMY');
    log.info({ rpcUrl: 'https://a/SECRET_FIELD', nested: { privateKey: '0xSECRET_PK' } }, 'cfg');
    const text = out();
    expect(text).not.toContain('SECRET');
    expect(text).toContain('x.quiknode.pro/<redacted>');
    expect(JSON.parse(text.split('\n')[0]!)).toMatchObject({ level: 'error', service: 'test', msg: 'rpc failed' });
  });

  // Audit L-2 repro: every shape below printed the key before the fix.
  test('errors under any key, cause chains, stringified errors and nested url fields are scrubbed', () => {
    const { log, out, json } = capture();
    const err = new HttpRequestError({ url: 'http://127.0.0.1:1/v2/SECRETKEY123?apikey=QSECRET', status: 401 });
    log.error({ cause: err }, 'a');
    log.error({ detail: String(err) }, 'b');
    log.error({ ctx: { deeper: { url: 'https://x.quiknode.pro/SECRETKEY456/' } } }, 'c');
    log.error(new Error('outer', { cause: new Error('inner wss://ws.example/SECRETCAUSE') }));
    log.error({ err: new Error('see https://h.example/v1/SECRETMSG') });
    const text = out();
    expect(text).not.toContain('SECRET');
    expect(text).not.toContain('QSECRET');
    const lines = json();
    expect(lines[0]!.cause).toMatchObject({ type: 'HttpRequestError', url: 'http://127.0.0.1:1/<redacted>?<redacted>' });
    expect(lines[3]!.err).toMatchObject({ type: 'Error', message: 'outer', cause: { message: 'inner wss://ws.example/<redacted>' } });
    expect(lines[4]!.msg).toBe('see https://h.example/<redacted>');
  });

  test('secret keys are redacted case-insensitively at any depth', () => {
    const { log, out, json } = capture();
    log.info(
      {
        headers: { Authorization: 'Bearer SECRET_A', AUTHORIZATION: 'SECRET_B', 'X-Api-Key': 'SECRET_C', Cookie: 'SECRET_D' },
        a: { b: { c: { privateKey: '0xSECRET_E', PRIVATE_KEY: 'SECRET_F', token: 'SECRET_G', ENVIO_API_TOKEN: 'SECRET_H' } } },
        list: [{ secret: 'SECRET_I', key: 'SECRET_J', relayKey: 'SECRET_K' }]
      },
      'cfg'
    );
    expect(out()).not.toContain('SECRET_');
    expect(json()[0]).toMatchObject({ headers: { Authorization: '<redacted>' }, list: [{ key: '<redacted>' }] });
    for (const k of ['authorization', 'Proxy-Authorization', 'apiKey', 'KEEPER_KEY', 'RELAY_INTERNAL_TOKEN', 'password']) {
      expect(isSecretKey(k)).toBe(true);
    }
    for (const k of ['ip', 'path', 'marketId', 'url', 'reason']) expect(isSecretKey(k)).toBe(false);
  });

  test('known secret values are stripped from plain strings and third-party messages', () => {
    const env = {
      MONAD_HTTP_URLS: ['https://rpc.example/v2/PATHSECRET1?key=QUERYSECRET1'],
      ENVIO_API_TOKEN: 'envio-token-0123456789',
      RELAY_INTERNAL_TOKEN: 'internal-token-0123456789abcdef',
      APP_ORIGIN: 'https://app.gapless.test'
    };
    const secrets = secretValues(env);
    expect(secrets).toContain('PATHSECRET1');
    expect(secrets).toContain('QUERYSECRET1');
    expect(secrets).not.toContain('v2');
    expect(secrets).not.toContain('https://app.gapless.test');
    const { log, out } = capture(secrets);
    log.warn('hypersync said: bad token envio-token-0123456789');
    log.error({ err: new Error('auth failed for PATHSECRET1') }, 'rpc');
    log.info({ note: 'quoted "internal-token-0123456789abcdef"' }, 'x');
    const text = out();
    for (const s of ['envio-token-0123456789', 'PATHSECRET1', 'internal-token-0123456789abcdef']) expect(text).not.toContain(s);
    expect(text).toContain('bad token <redacted>');
  });

  test('scrubbing is idempotent on already redacted URLs', () => {
    const once = scrubUrls('connect https://x.quiknode.pro/KEY/ and wss://a.example/p?q=1');
    expect(scrubUrls(once)).toBe(once);
    expect(once).toBe('connect https://x.quiknode.pro/<redacted> and wss://a.example/<redacted>?<redacted>');
  });
});

describe('addresses', () => {
  test('every address is EIP-55 checksummed', () => {
    for (const a of [PERPL_EXCHANGE, AUSD, ...Object.values(CHAINLINK_FEEDS), ...Object.values(CRE_FORWARDERS)]) {
      expect(getAddress(a)).toBe(a);
    }
  });
});

describe('chain config', () => {
  test('public RPC is always last and never duplicated', () => {
    expect(orderedHttpUrls({ httpUrls: ['https://p.example/k'] })).toEqual(['https://p.example/k', PUBLIC_FALLBACK_HTTP]);
    expect(orderedHttpUrls({ httpUrls: [PUBLIC_FALLBACK_HTTP] })).toEqual([PUBLIC_FALLBACK_HTTP]);
  });
});

describe('db', () => {
  test('migrations apply once, in order, with multi-statement SQL', () => {
    const db = openDb(':memory:');
    const migrations = [
      { id: 2, name: 'b', sql: 'CREATE TABLE b (x TEXT NOT NULL); CREATE INDEX b_x ON b (x);' },
      { id: 1, name: 'a', sql: 'CREATE TABLE a (x TEXT NOT NULL)' }
    ];
    expect(migrate(db, migrations)).toEqual([1, 2]);
    expect(migrate(db, migrations)).toEqual([]);
    expect(db.query<{ n: number }, []>("SELECT count(*) AS n FROM sqlite_master WHERE name = 'b_x'").get()?.n).toBe(1);
    db.close();
  });

  test('strict binding throws on missing params', () => {
    const db = openDb(':memory:');
    db.run('CREATE TABLE t (x TEXT)');
    expect(() => db.query('INSERT INTO t (x) VALUES ($x)').run({} as never)).toThrow();
    db.close();
  });
});
