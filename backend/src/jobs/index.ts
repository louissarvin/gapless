import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { parseUnits } from 'viem';
import { AUSD_DECIMALS } from '../lib/addresses.ts';
import { createMonadPublicClient } from '../lib/chain.ts';
import { clearSecretEnv, EnvError, jobsGaplessConfig, loadJobsEnv } from '../lib/env.ts';
import { createLogger, secretValues } from '../lib/log.ts';
import { createGaplessSource, readVault } from './gapless.ts';
import { createHypersyncClient, createHypersyncSource } from './hypersync.ts';
import { createNativeStopSource } from './native-ingest.ts';
import { readPerps } from './perpl.ts';
import { LeaseHeldError, runOnce, type RunDeps } from './run.ts';
import { startRunner } from './runner.ts';
import { openJobsDb } from './store.ts';

// Usage: bun src/jobs/index.ts        every JOBS_INTERVAL_MS until SIGTERM
//        bun src/jobs/index.ts once   one cycle (on-demand refit): exit 0 written, 1 failed, 2 another run holds the lease

// Under the compose stop_grace_period (35 s); data is safe either way (page transactions, atomic JSON).
const SHUTDOWN_GRACE_MS = 30_000;

async function main(): Promise<void> {
  let env;
  try {
    env = loadJobsEnv();
  } catch (err) {
    const boot = createLogger('jobs');
    if (err instanceof EnvError) boot.fatal({ problems: err.problems }, 'env.invalid');
    else boot.fatal({ err }, 'env.load_failed');
    process.exit(1);
  }
  clearSecretEnv();

  const log = createLogger('jobs', env.LOG_LEVEL, secretValues(env));
  process.on('unhandledRejection', (err) => {
    log.fatal({ err }, 'process.unhandled_rejection');
    process.exit(1);
  });
  process.on('uncaughtException', (err) => {
    log.fatal({ err }, 'process.uncaught_exception');
    process.exit(1);
  });

  const db = openJobsDb(env.JOBS_DB_PATH);
  const client = createMonadPublicClient({ httpUrls: env.MONAD_HTTP_URLS, wsUrl: env.MONAD_WS_URL });
  const hs = createHypersyncClient(env.HYPERSYNC_URL, env.ENVIO_API_TOKEN);
  const gapless = jobsGaplessConfig(env);
  const deps: RunDeps = {
    db,
    log,
    source: createHypersyncSource(hs),
    nativeSource: env.JOBS_NATIVE_STOPS ? createNativeStopSource(hs) : undefined,
    gapless: gapless
      ? { source: createGaplessSource(hs, gapless), config: gapless, readVault: () => readVault(client, gapless.addresses.vault) }
      : undefined,
    readPerps: () => readPerps(client),
    outDir: env.OUT_DIR,
    windowDays: env.JOBS_WINDOW_DAYS,
    curveNotionalCNS: parseUnits(String(env.JOBS_CURVE_NOTIONAL_AUSD), AUSD_DECIMALS),
    leaseOwner: `${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`
  };
  log.info(
    { outDir: env.OUT_DIR, windowDays: env.JOBS_WINDOW_DAYS, intervalMs: env.JOBS_INTERVAL_MS, nativeStops: env.JOBS_NATIVE_STOPS, gapless: gapless ?? 'not_configured' },
    'jobs.start'
  );

  if (process.argv.slice(2).includes('once')) {
    const ac = new AbortController();
    process.on('SIGTERM', () => ac.abort());
    process.on('SIGINT', () => ac.abort());
    let code = 1;
    try {
      code = (await runOnce(deps, ac.signal)).wrote ? 0 : 1;
    } catch (err) {
      if (err instanceof LeaseHeldError) {
        log.error('jobs.lease_held: the daemon or another once run is mid-cycle; retry after it finishes');
        code = 2;
      } else {
        log.error({ err }, 'jobs.run_failed');
      }
    }
    db.close(false);
    process.exit(code);
  }

  const runner = startRunner({
    intervalMs: env.JOBS_INTERVAL_MS,
    log,
    task: async (signal) => {
      try {
        await runOnce(deps, signal);
      } catch (err) {
        // A manual `once` run is not a fault; skip this tick without counting a failure.
        if (err instanceof LeaseHeldError) log.warn('jobs.lease_held: skipping tick');
        else throw err;
      }
    }
  });

  let closing = false;
  const shutdown = async (signal: string) => {
    if (closing) return;
    closing = true;
    log.info({ signal }, 'jobs.shutdown');
    const force = setTimeout(() => {
      log.error('jobs.shutdown_timeout');
      process.exit(1);
    }, SHUTDOWN_GRACE_MS);
    try {
      await runner.stop();
      db.close(false);
    } finally {
      clearTimeout(force);
      process.exit(0);
    }
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

void main();
