import { describe, expect, test } from 'bun:test';
import { EnvError, jobsGaplessConfig, loadJobsEnv } from '../../src/lib/env.ts';

function problems(fn: () => unknown): string[] {
  try {
    fn();
  } catch (err) {
    if (err instanceof EnvError) return err.problems;
    throw err;
  }
  throw new Error('expected EnvError');
}

describe('jobs env', () => {
  test('defaults: Monad HyperSync, 7-day window, 5 min interval, data/ paths', () => {
    const env = loadJobsEnv({ ENVIO_API_TOKEN: 'tok' });
    expect(env).toMatchObject({
      HYPERSYNC_URL: 'https://monad.hypersync.xyz',
      OUT_DIR: 'data/gap-index',
      JOBS_DB_PATH: 'data/jobs.sqlite',
      JOBS_WINDOW_DAYS: 7,
      JOBS_INTERVAL_MS: 300_000,
      JOBS_CURVE_NOTIONAL_AUSD: 20
    });
  });

  test('curve notional is whole AUSD in [1, 100000]', () => {
    expect(loadJobsEnv({ ENVIO_API_TOKEN: 'tok', JOBS_CURVE_NOTIONAL_AUSD: '1000' }).JOBS_CURVE_NOTIONAL_AUSD).toBe(1_000);
    for (const bad of ['0', '1.5', '100001', 'fifty']) {
      expect(problems(() => loadJobsEnv({ ENVIO_API_TOKEN: 'tok', JOBS_CURVE_NOTIONAL_AUSD: bad })).some((x) => x.startsWith('JOBS_CURVE_NOTIONAL_AUSD'))).toBe(true);
    }
  });

  test('bounds the window and interval and requires https for HyperSync', () => {
    const p = problems(() =>
      loadJobsEnv({
        ENVIO_API_TOKEN: 'tok',
        JOBS_WINDOW_DAYS: '31',
        JOBS_INTERVAL_MS: '1000',
        HYPERSYNC_URL: 'http://monad.hypersync.xyz'
      })
    );
    expect(p.some((x) => x.startsWith('JOBS_WINDOW_DAYS'))).toBe(true);
    expect(p.some((x) => x.startsWith('JOBS_INTERVAL_MS'))).toBe(true);
    expect(p.some((x) => x.startsWith('HYPERSYNC_URL'))).toBe(true);
  });

  test('never echoes the token', () => {
    const p = problems(() => loadJobsEnv({ ENVIO_API_TOKEN: 'has space SECRET' })).join('\n');
    expect(p).toContain('ENVIO_API_TOKEN');
    expect(p).not.toContain('SECRET');
  });

  // Test-only addresses (not deployed contracts).
  const M = '0x00000000000000000000000000000000000000a1';
  const V = '0x00000000000000000000000000000000000000A2';

  test('Gapless vars are optional: unset means no stats config; native stops default on', () => {
    const env = loadJobsEnv({ ENVIO_API_TOKEN: 'tok' });
    expect(env.JOBS_NATIVE_STOPS).toBe(true);
    expect(env.COVER_MANAGER_ADDRESS).toBeUndefined();
    expect(jobsGaplessConfig(env)).toBeNull();
    expect(loadJobsEnv({ ENVIO_API_TOKEN: 'tok', JOBS_NATIVE_STOPS: 'false' }).JOBS_NATIVE_STOPS).toBe(false);
  });

  test('manager plus start block gives a config with only the addresses set (checksummed)', () => {
    const env = loadJobsEnv({ ENVIO_API_TOKEN: 'tok', COVER_MANAGER_ADDRESS: M, COVER_VAULT_ADDRESS: V.toLowerCase(), GAPLESS_START_BLOCK: '110800000' });
    expect(jobsGaplessConfig(env)).toEqual({
      startBlock: 110_800_000,
      addresses: { manager: '0x00000000000000000000000000000000000000A1', vault: '0x00000000000000000000000000000000000000A2' }
    });
  });

  test('any Gapless var needs both manager and start block; addresses distinct and well-formed', () => {
    for (const partial of [{ COVER_MANAGER_ADDRESS: M }, { GAPLESS_START_BLOCK: '5' }, { COVER_VAULT_ADDRESS: V, GAPLESS_START_BLOCK: '5' }]) {
      expect(problems(() => loadJobsEnv({ ENVIO_API_TOKEN: 'tok', ...partial })).some((x) => x.startsWith('GAPLESS_START_BLOCK'))).toBe(true);
    }
    expect(problems(() => loadJobsEnv({ ENVIO_API_TOKEN: 'tok', COVER_MANAGER_ADDRESS: M, COVER_VAULT_ADDRESS: M, GAPLESS_START_BLOCK: '5' }))).toContain(
      'COVER_MANAGER_ADDRESS: Gapless contract addresses must be distinct'
    );
    const p = problems(() => loadJobsEnv({ ENVIO_API_TOKEN: 'tok', COVER_MANAGER_ADDRESS: '0x1234', GAPLESS_START_BLOCK: '0' }));
    expect(p.some((x) => x.startsWith('COVER_MANAGER_ADDRESS'))).toBe(true);
    expect(p.some((x) => x.startsWith('GAPLESS_START_BLOCK'))).toBe(true);
  });
});
