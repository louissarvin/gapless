import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { getAddress } from 'viem';
import { clearSecretEnv, EnvError, jobsGaplessConfig, keeperZeroPaidCapWei, loadJobsEnv, loadKeeperEnv, loadRelayEnv, missingKeeperRuntime, ZERO_PAID_CAP_DEFAULT_WEI } from '../src/lib/env.ts';

function problems(fn: () => unknown): string[] {
  try {
    fn();
  } catch (err) {
    if (err instanceof EnvError) return err.problems;
    throw err;
  }
  throw new Error('expected EnvError');
}

describe('relay env', () => {
  test('applies secure defaults with only APP_ORIGIN set', () => {
    const env = loadRelayEnv({ APP_ORIGIN: 'https://app.gapless.test' });
    expect(env.NODE_ENV).toBe('production');
    expect(env.HOST).toBe('127.0.0.1');
    expect(env.PORT).toBe(3700);
    expect(env.MONAD_HTTP_URLS).toEqual([]);
    expect(env.TRUST_PROXY).toBeUndefined();
    expect(env.RATE_LIMIT_MAX).toBe(120);
  });

  test('fails fast when APP_ORIGIN is missing', () => {
    expect(problems(() => loadRelayEnv({})).some((p) => p.startsWith('APP_ORIGIN'))).toBe(true);
  });

  test.each([
    'https://app.gapless.test/',
    'https://app.gapless.test/path',
    'http://app.gapless.test',
    '*',
    'null',
    'app.gapless.test'
  ])('rejects APP_ORIGIN %p', (origin) => {
    expect(problems(() => loadRelayEnv({ APP_ORIGIN: origin }))[0]).toStartWith('APP_ORIGIN');
  });

  test('allows plain http only for localhost origins, and only outside production', () => {
    expect(loadRelayEnv({ APP_ORIGIN: 'http://localhost:5173', NODE_ENV: 'development' }).APP_ORIGIN).toBe('http://localhost:5173');
  });

  test.each(['http://localhost:5173', 'https://localhost:5173', 'https://127.0.0.1', 'https://app.localhost'])(
    'rejects APP_ORIGIN %p when NODE_ENV=production (the default)',
    (origin) => {
      expect(problems(() => loadRelayEnv({ APP_ORIGIN: origin }))).toEqual([
        'APP_ORIGIN: must be https and not localhost when NODE_ENV=production'
      ]);
    }
  );

  test.each(['0.0.0.0/0', '::/0', '1.0.0.0/7', '2001::/31', '10.0.0.0/8, ::/0'])('rejects trust-all TRUST_PROXY %p', (value) => {
    expect(problems(() => loadRelayEnv({ APP_ORIGIN: 'https://app.gapless.test', TRUST_PROXY: value }))[0]).toStartWith('TRUST_PROXY');
  });

  test('accepts narrow TRUST_PROXY ranges and named ranges', () => {
    const env = loadRelayEnv({ APP_ORIGIN: 'https://app.gapless.test', TRUST_PROXY: '172.18.0.2, 10.0.0.0/8, fd00:1::/32, loopback' });
    expect(env.TRUST_PROXY).toEqual(['172.18.0.2', '10.0.0.0/8', 'fd00:1::/32', 'loopback']);
  });

  test('RELAY_INTERNAL_TOKEN: optional, 32+ url-safe chars, never echoed', () => {
    expect(loadRelayEnv({ APP_ORIGIN: 'https://app.gapless.test' }).RELAY_INTERNAL_TOKEN).toBeUndefined();
    const ok = 'a1'.repeat(32);
    expect(loadRelayEnv({ APP_ORIGIN: 'https://app.gapless.test', RELAY_INTERNAL_TOKEN: ok }).RELAY_INTERNAL_TOKEN).toBe(ok);
    for (const bad of ['SHORTSECRET123', `${'z'.repeat(40)} space`]) {
      const p = problems(() => loadRelayEnv({ APP_ORIGIN: 'https://app.gapless.test', RELAY_INTERNAL_TOKEN: bad }));
      expect(p[0]).toStartWith('RELAY_INTERNAL_TOKEN');
      expect(p.join()).not.toContain(bad.slice(0, 10));
    }
  });

  test('parses ordered RPC list and rejects duplicates and insecure remotes', () => {
    const env = loadRelayEnv({
      APP_ORIGIN: 'https://app.gapless.test',
      MONAD_HTTP_URLS: 'https://a.example/k1, https://b.example/k2'
    });
    expect(env.MONAD_HTTP_URLS).toEqual(['https://a.example/k1', 'https://b.example/k2']);

    const dup = problems(() =>
      loadRelayEnv({ APP_ORIGIN: 'https://app.gapless.test', MONAD_HTTP_URLS: 'https://a.example,https://a.example' })
    );
    expect(dup[0]).toContain('duplicates');
  });

  test('never echoes values, which may contain RPC keys', () => {
    const err = problems(() =>
      loadRelayEnv({
        APP_ORIGIN: 'https://app.gapless.test',
        MONAD_HTTP_URLS: 'http://rpc.example/SECRET_TOKEN_123',
        MONAD_WS_URL: 'ftp://x/SECRET_WS'
      })
    ).join('\n');
    expect(err).not.toContain('SECRET');
    expect(err).toContain('MONAD_HTTP_URLS');
    expect(err).toContain('MONAD_WS_URL');
  });

  test('treats blank values as unset', () => {
    expect(loadRelayEnv({ APP_ORIGIN: 'https://app.gapless.test', PORT: '  ' }).PORT).toBe(3700);
  });

  test('validates PORT and TRUST_PROXY', () => {
    expect(problems(() => loadRelayEnv({ APP_ORIGIN: 'https://app.gapless.test', PORT: '70000' }))[0]).toStartWith('PORT');
    expect(
      loadRelayEnv({ APP_ORIGIN: 'https://app.gapless.test', TRUST_PROXY: '10.0.0.0/8, 127.0.0.1' }).TRUST_PROXY
    ).toEqual(['10.0.0.0/8', '127.0.0.1']);
    expect(
      problems(() => loadRelayEnv({ APP_ORIGIN: 'https://app.gapless.test', TRUST_PROXY: 'everyone' }))[0]
    ).toStartWith('TRUST_PROXY');
  });

  test('market data defaults point at Perpl mainnet with spec markets 1 and 10', () => {
    const env = loadRelayEnv({ APP_ORIGIN: 'https://app.gapless.test' });
    expect(env.WS_PORT).toBe(3701);
    expect(env.PERPL_API_URL).toBe('https://app.perpl.xyz/api');
    expect(env.PERPL_WS_URL).toBe('wss://app.perpl.xyz/ws/v1/market-data');
    expect(env.PERPL_MARKET_IDS).toEqual([1, 10]);
    expect(loadRelayEnv({ APP_ORIGIN: 'https://app.gapless.test', PERPL_MARKET_IDS: '1, 20' }).PERPL_MARKET_IDS).toEqual([1, 20]);
  });

  test('jobs output paths default to the jobs defaults on the shared data/ volume', () => {
    const env = loadRelayEnv({ APP_ORIGIN: 'https://app.gapless.test' });
    const jobs = loadJobsEnv({ ENVIO_API_TOKEN: 'tok' });
    expect(env.GAP_INDEX_DIR).toBe('data/gap-index');
    expect(env.JOBS_DB_PATH).toBe('data/jobs.sqlite');
    expect(env.GAP_INDEX_DIR).toBe(jobs.OUT_DIR);
    expect(env.JOBS_DB_PATH).toBe(jobs.JOBS_DB_PATH);
  });

  test('accepts explicit jobs output paths and treats blanks as unset', () => {
    const env = loadRelayEnv({
      APP_ORIGIN: 'https://app.gapless.test',
      GAP_INDEX_DIR: '/app/data/gap-index',
      JOBS_DB_PATH: ' '
    });
    expect(env.GAP_INDEX_DIR).toBe('/app/data/gap-index');
    expect(env.JOBS_DB_PATH).toBe('data/jobs.sqlite');
  });

  test('relay does not require ENVIO_API_TOKEN', () => {
    expect(loadRelayEnv({ APP_ORIGIN: 'https://app.gapless.test' })).not.toHaveProperty('ENVIO_API_TOKEN');
  });

  test.each([
    ['PERPL_MARKET_IDS', '1,1'],
    ['PERPL_MARKET_IDS', '0'],
    ['PERPL_MARKET_IDS', '1,2,3,4,5,6,7,8'],
    ['PERPL_MARKET_IDS', 'btc'],
    ['PERPL_WS_URL', 'ws://perpl.example/ws'],
    ['PERPL_API_URL', 'http://perpl.example/api'],
    ['WS_PORT', '3700']
  ])('rejects %s=%p', (name, value) => {
    const p = problems(() => loadRelayEnv({ APP_ORIGIN: 'https://app.gapless.test', [name]: value }));
    expect(p.some((x) => x.startsWith(name))).toBe(true);
  });
});

describe('per-process schemas', () => {
  test('relay does not require keeper or jobs vars', () => {
    expect(() => loadRelayEnv({ APP_ORIGIN: 'https://app.gapless.test' })).not.toThrow();
  });

  test('keeper requires a private HTTP RPC and a WebSocket, not APP_ORIGIN', () => {
    const missing = problems(() => loadKeeperEnv({}));
    expect(missing.some((p) => p.startsWith('MONAD_HTTP_URLS'))).toBe(true);
    expect(missing.some((p) => p.startsWith('MONAD_WS_URL'))).toBe(true);
    expect(missing.some((p) => p.startsWith('APP_ORIGIN'))).toBe(false);

    const env = loadKeeperEnv({ MONAD_HTTP_URLS: 'https://a.example/k', MONAD_WS_URL: 'wss://a.example/k' });
    expect(env.MONAD_WS_URL).toBe('wss://a.example/k');
  });

  test('jobs requires ENVIO_API_TOKEN only', () => {
    expect(problems(() => loadJobsEnv({}))).toEqual([expect.stringMatching(/^ENVIO_API_TOKEN/)]);
    expect(loadJobsEnv({ ENVIO_API_TOKEN: 'tok' }).OUT_DIR).toBe('data/gap-index');
  });
});

describe('stage 3: keeper and sponsor env', () => {
  const KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
  const keeperBase = { MONAD_HTTP_URLS: 'https://a.example/k', MONAD_WS_URL: 'wss://a.example/k' };
  const relayBase = { APP_ORIGIN: 'https://app.gapless.test' };

  test('keeper runtime vars are optional in the schema and listed by missingKeeperRuntime', () => {
    const env = loadKeeperEnv(keeperBase);
    expect(missingKeeperRuntime(env)).toEqual(['KEEPER_KEY', 'COVER_MANAGER_ADDRESS', 'RELAY_WS_URL', 'RELAY_INTERNAL_TOKEN', 'KEEPER_DAILY_SPEND_CAP_WEI']);
    expect(env.LISTED_PERPS).toEqual([1]);
    expect(env.KEEPER_HOST).toBe('127.0.0.1');
    expect(env.KEEPER_HEADS).toBe('monadNewHeads');
    const full = loadKeeperEnv({
      ...keeperBase,
      KEEPER_KEY: KEY,
      COVER_MANAGER_ADDRESS: '0x00000000000000000000000000000000000c0de1',
      RELAY_WS_URL: 'ws://relay.internal:3701/ws/market',
      RELAY_INTERNAL_TOKEN: 'a1'.repeat(20),
      KEEPER_DAILY_SPEND_CAP_WEI: '4600000000000000000'
    });
    expect(missingKeeperRuntime(full)).toEqual([]);
    expect(full.KEEPER_DAILY_SPEND_CAP_WEI).toBe(4_600_000_000_000_000_000n);
  });

  test.each([
    ['KEEPER_KEY', '0x1234'],
    ['KEEPER_KEY', `0x${'0'.repeat(64)}`],
    ['KEEPER_KEY', `0x${'f'.repeat(64)}`],
    ['COVER_MANAGER_ADDRESS', '0x00000000000000000000000000000000000C0dE1'],
    ['COVER_MANAGER_ADDRESS', 'manager'],
    ['RELAY_WS_URL', 'ws://relay.example.com/ws/market'],
    ['KEEPER_DAILY_SPEND_CAP_WEI', '0.5'],
    ['LISTED_PERPS', '1,1'],
    ['KEEPER_HEADS', 'logs']
  ])('keeper rejects %s=%p without echoing it', (name, value) => {
    const p = problems(() => loadKeeperEnv({ ...keeperBase, [name]: value }));
    expect(p.some((x) => x.startsWith(name))).toBe(true);
    expect(p.join()).not.toContain(value.slice(2, 20));
  });

  test('keeper reserve and alert must fit inside the cap', () => {
    const p = problems(() => loadKeeperEnv({ ...keeperBase, KEEPER_DAILY_SPEND_CAP_WEI: '100', KEEPER_HOTPATH_RESERVE_WEI: '200', KEEPER_SPEND_ALERT_WEI: '300' }));
    expect(p.some((x) => x.startsWith('KEEPER_HOTPATH_RESERVE_WEI'))).toBe(true);
    expect(p.some((x) => x.startsWith('KEEPER_SPEND_ALERT_WEI'))).toBe(true);
  });

  test('sponsor is off by default and safe without keys or addresses', () => {
    const env = loadRelayEnv(relayBase);
    expect(env.SPONSOR_ENABLED).toBe(false);
    expect(env.RELAY_KEY).toBeUndefined();
    expect(env.GAPLESS_FACTORY_ADDRESS).toBeUndefined();
    expect(env.DRIP_WEI).toBe(500_000_000_000_000_000n);
    expect(env.DRIP_ALLOWLIST).toEqual([]);
    expect(env.TOTAL_CREATE_CAP).toBe(6);
  });

  test('SPONSOR_ENABLED requires RELAY_KEY and GAPLESS_FACTORY_ADDRESS; KEEPER_INTERNAL_URL requires the token', () => {
    expect(problems(() => loadRelayEnv({ ...relayBase, SPONSOR_ENABLED: 'true' }))[0]).toStartWith('SPONSOR_ENABLED');
    const sponsorOn = { ...relayBase, SPONSOR_ENABLED: 'true', RELAY_KEY: KEY, GAPLESS_FACTORY_ADDRESS: '0x00000000000000000000000000000000000fac70' };
    // H-2: allowlist mode is on by default, so someone must be sponsorable.
    expect(problems(() => loadRelayEnv(sponsorOn))[0]).toStartWith('SPONSOR_ALLOWLIST_ONLY');
    const ok = loadRelayEnv({ ...sponsorOn, SPONSOR_DEMO_OWNER: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8' });
    expect(ok.SPONSOR_ENABLED).toBe(true);
    expect(ok.SPONSOR_ALLOWLIST_ONLY).toBe(true);
    expect(loadRelayEnv({ ...sponsorOn, SPONSOR_OWNER_ALLOWLIST: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8' }).SPONSOR_OWNER_ALLOWLIST).toHaveLength(1);
    expect(loadRelayEnv({ ...sponsorOn, SPONSOR_ALLOWLIST_ONLY: 'false' }).SPONSOR_ALLOWLIST_ONLY).toBe(false);
    const p = problems(() => loadRelayEnv({ ...relayBase, KEEPER_INTERNAL_URL: 'http://keeper.internal:3702' }));
    expect(p[0]).toStartWith('KEEPER_INTERNAL_URL');
    // M-5: /sigma-refresh verifies the caller's account through the factory.
    expect(p.some((x) => x.includes('GAPLESS_FACTORY_ADDRESS'))).toBe(true);
  });

  test('SE1 defaults: activation and refresh caps, strict spacing off, zero-paid cap clamped to the non-hot budget', () => {
    const relay = loadRelayEnv(relayBase);
    expect(relay.DAILY_ACTIVATION_CAP).toBe(6);
    expect(relay.SIGMA_REFRESH_PER_ACCOUNT_PER_DAY).toBe(6);
    expect(relay.STRICT_RESERVE_SPACING).toBe(false);
    expect(loadRelayEnv({ ...relayBase, STRICT_RESERVE_SPACING: 'true' }).STRICT_RESERVE_SPACING).toBe(true);
    const keeper = (cap: string, over: Record<string, string> = {}) => loadKeeperEnv({ ...keeperBase, KEEPER_DAILY_SPEND_CAP_WEI: cap, ...over });
    expect(keeper('4600000000000000000').STRICT_RESERVE_SPACING).toBe(false);
    expect(keeperZeroPaidCapWei(keeper('4600000000000000000'))).toBe(ZERO_PAID_CAP_DEFAULT_WEI);
    // 3.5 MON cap minus the 2.65 hot reserve leaves 0.85, below the 1.4 default.
    expect(keeperZeroPaidCapWei(keeper('3500000000000000000'))).toBe(850_000_000_000_000_000n);
    // 2.69 MON cap minus the 2.65 hot reserve leaves 0.04.
    expect(keeperZeroPaidCapWei(keeper('2690000000000000000'))).toBe(40_000_000_000_000_000n);
    expect(keeperZeroPaidCapWei(keeper('100000000000000000', { KEEPER_HOTPATH_RESERVE_WEI: '100000000000000000' }))).toBe(0n);
    expect(problems(() => keeper('3000000000000000000', { KEEPER_ZERO_PAID_CAP_WEI: '700000000000000000' }))[0]).toStartWith('KEEPER_ZERO_PAID_CAP_WEI');
    expect(keeperZeroPaidCapWei(keeper('3000000000000000000', { KEEPER_ZERO_PAID_CAP_WEI: '300000000000000000' }))).toBe(300_000_000_000_000_000n);
  });

  test('SA4 canary defaults (5.1 MON funding, cap 4.6): hot reserve, zero-paid backstop two walks, arm_repeat sub-cap', () => {
    const k = loadKeeperEnv({ ...keeperBase, KEEPER_DAILY_SPEND_CAP_WEI: '4600000000000000000' });
    expect(k.KEEPER_HOTPATH_RESERVE_WEI).toBe(2_650_000_000_000_000_000n);
    expect(k.KEEPER_LOW_BALANCE_WEI).toBe(2_000_000_000_000_000_000n);
    expect(k.KEEPER_ARM_REPEAT_CAP_WEI).toBe(200_000_000_000_000_000n);
    // 10 steps x 1.1M x 112 gwei + one step in flight (1.1M x 110 gwei), at a 110 gwei base fee.
    expect(ZERO_PAID_CAP_DEFAULT_WEI).toBe(1_400_000_000_000_000_000n);
    expect(10n * 1_100_000n * 112_000_000_000n + 1_100_000n * 110_000_000_000n).toBeLessThanOrEqual(ZERO_PAID_CAP_DEFAULT_WEI);
    expect(keeperZeroPaidCapWei(k)).toBe(ZERO_PAID_CAP_DEFAULT_WEI);
  });

  test('SE2-I1: the same key for relay and keeper is refused; secrets leave the environment once parsed', () => {
    const shared = { ...keeperBase, ...relayBase, KEEPER_KEY: KEY, RELAY_KEY: KEY.toUpperCase().replace('0X', '0x') };
    expect(problems(() => loadKeeperEnv(shared))).toEqual(['RELAY_KEY: must differ from KEEPER_KEY']);
    expect(problems(() => loadRelayEnv(shared))).toEqual(['RELAY_KEY: must differ from KEEPER_KEY']);
    const other = '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a';
    const source: Record<string, string | undefined> = { ...keeperBase, KEEPER_KEY: KEY, RELAY_KEY: other, RELAY_INTERNAL_TOKEN: 'a1'.repeat(20), LOG_LEVEL: 'debug' };
    const env = loadKeeperEnv(source);
    clearSecretEnv(source);
    expect(env.KEEPER_KEY).toBe(KEY);
    for (const k of ['KEEPER_KEY', 'RELAY_KEY', 'RELAY_INTERNAL_TOKEN', 'MONAD_HTTP_URLS', 'MONAD_WS_URL']) expect(source[k]).toBeUndefined();
    expect(source.LOG_LEVEL).toBe('debug');
  });

  test('C5 sponsored grant policy defaults (SA2 N-03) and bounds', () => {
    const r = loadRelayEnv(relayBase);
    expect(r.SPONSOR_GRANT_MAX_PER_TRADE_CNS).toBe(25_000_000n);
    expect(r.SPONSOR_GRANT_MAX_PER_DAY_CNS).toBe(100_000_000n);
    expect(r.SPONSOR_GRANT_MAX_TTL_S).toBe(21_600);
    expect(problems(() => loadRelayEnv({ ...relayBase, SPONSOR_GRANT_MAX_PER_TRADE_CNS: '200000000' }))[0]).toStartWith('SPONSOR_GRANT_MAX_PER_TRADE_CNS');
    for (const [name, bad] of [
      ['SPONSOR_GRANT_MAX_PER_DAY_CNS', '0'],
      ['SPONSOR_GRANT_MAX_PER_DAY_CNS', '1e8'],
      ['SPONSOR_GRANT_MAX_PER_DAY_CNS', '9'.repeat(39)],
      ['SPONSOR_GRANT_MAX_TTL_S', '599'],
      ['SPONSOR_GRANT_MAX_TTL_S', '86401']
    ] as const) {
      expect(problems(() => loadRelayEnv({ ...relayBase, [name]: bad })).some((x) => x.startsWith(name))).toBe(true);
    }
  });

  test.each([
    ['DRIP_WEI', '2000000000000000000'],
    ['DRIP_ALLOWLIST', 'not-an-address'],
    ['SPONSOR_ENABLED', 'yes'],
    ['KEEPER_INTERNAL_URL', 'http://keeper.example.com'],
    ['RELAY_KEY', 'abc'],
    ['SPONSOR_ALLOWLIST_ONLY', 'yes'],
    ['SPONSOR_OWNER_ALLOWLIST', 'not-an-address'],
    ['SPONSOR_DEMO_OWNER', '0x70997970c51812dc3a010c7d01b50e0d17dc79c'],
    ['DAILY_ACTIVATION_CAP', '-1'],
    ['SIGMA_REFRESH_PER_ACCOUNT_PER_DAY', '0'],
    ['STRICT_RESERVE_SPACING', 'on']
  ])('relay rejects %s=%p', (name, value) => {
    expect(problems(() => loadRelayEnv({ ...relayBase, [name]: value })).some((x) => x.startsWith(name))).toBe(true);
  });
});

interface Deployment {
  chainId: number;
  deployBlock: number;
  contracts: Record<'CoverVault' | 'CoverManager' | 'GaplessFactory' | 'GaplessAccountImpl' | 'GaplessCreSink', { address: string }>;
  listing: { perpId: number; block: number };
}

// The deploy record sits next to backend/ in this workspace; skip where it is absent (Docker build context).
const DEPLOYMENT_PATH = new URL('../../deployments/143.json', import.meta.url);
const deployment: Deployment | null = existsSync(DEPLOYMENT_PATH) ? JSON.parse(readFileSync(DEPLOYMENT_PATH, 'utf8')) : null;

describe.skipIf(!deployment)('canary deployment (deployments/143.json)', () => {
  const d = deployment!;
  const c = d?.contracts;
  const keeperBase = { MONAD_HTTP_URLS: 'https://a.example/k', MONAD_WS_URL: 'wss://a.example/k' };

  test('record is chain 143 with checksummed, distinct addresses; listing after deploy', () => {
    expect(d.chainId).toBe(143);
    const addrs = Object.values(c).map((x) => x.address);
    for (const a of addrs) expect(getAddress(a)).toBe(a as `0x${string}`);
    expect(new Set(addrs.map((a) => a.toLowerCase())).size).toBe(addrs.length);
    expect(d.listing.block).toBeGreaterThan(d.deployBlock);
  });

  test('keeper: manager and listed perp parse unchanged; only the key, token and relay URL stay unset', () => {
    const env = loadKeeperEnv({
      ...keeperBase,
      COVER_MANAGER_ADDRESS: c.CoverManager.address,
      LISTED_PERPS: String(d.listing.perpId),
      KEEPER_DAILY_SPEND_CAP_WEI: '4600000000000000000'
    });
    expect(env.COVER_MANAGER_ADDRESS).toBe(c.CoverManager.address as `0x${string}`);
    expect(env.LISTED_PERPS).toEqual([d.listing.perpId]);
    expect(missingKeeperRuntime(env)).toEqual(['KEEPER_KEY', 'RELAY_WS_URL', 'RELAY_INTERNAL_TOKEN']);
    expect(keeperZeroPaidCapWei(env)).toBe(ZERO_PAID_CAP_DEFAULT_WEI);
  });

  test('relay: factory parses unchanged; sponsoring still needs RELAY_KEY', () => {
    const relayBase = { APP_ORIGIN: 'https://app.gapless.test', GAPLESS_FACTORY_ADDRESS: c.GaplessFactory.address };
    expect(loadRelayEnv(relayBase).GAPLESS_FACTORY_ADDRESS).toBe(c.GaplessFactory.address as `0x${string}`);
    expect(problems(() => loadRelayEnv({ ...relayBase, SPONSOR_ENABLED: 'true' }))[0]).toBe('SPONSOR_ENABLED: requires RELAY_KEY and GAPLESS_FACTORY_ADDRESS');
  });

  test('jobs: Gapless stats ingest from the deploy block over all four event sources', () => {
    const env = loadJobsEnv({
      ENVIO_API_TOKEN: 'tok',
      COVER_MANAGER_ADDRESS: c.CoverManager.address,
      COVER_VAULT_ADDRESS: c.CoverVault.address,
      GAPLESS_FACTORY_ADDRESS: c.GaplessFactory.address,
      GAPLESS_CRE_SINK_ADDRESS: c.GaplessCreSink.address,
      GAPLESS_START_BLOCK: String(d.deployBlock)
    });
    expect(jobsGaplessConfig(env)).toEqual({
      startBlock: d.deployBlock,
      addresses: {
        manager: c.CoverManager.address as `0x${string}`,
        vault: c.CoverVault.address as `0x${string}`,
        factory: c.GaplessFactory.address as `0x${string}`,
        sink: c.GaplessCreSink.address as `0x${string}`
      }
    });
  });

  test('DEPLOYMENT_143.md and env.example.proposed carry the deployed values', () => {
    for (const file of ['../DEPLOYMENT_143.md', '../env.example.proposed']) {
      const text = readFileSync(new URL(file, import.meta.url), 'utf8');
      for (const name of ['CoverManager', 'CoverVault', 'GaplessFactory', 'GaplessCreSink'] as const) expect(text).toContain(c[name].address);
      expect(text).toContain(`GAPLESS_START_BLOCK=${d.deployBlock}`);
      expect(text).toContain(`LISTED_PERPS=${d.listing.perpId}`);
    }
  });
});
