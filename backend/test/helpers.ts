import pino from 'pino';
import type { Address } from 'viem';
import { createMonadPublicClient, type ChainHead } from '../src/lib/chain.ts';
import { openDb } from '../src/lib/db.ts';
import { loadRelayEnv } from '../src/lib/env.ts';
import { buildRelayApp } from '../src/relay/app.ts';

export const APP_ORIGIN = 'https://app.gapless.test';

export function relayEnv(overrides: Record<string, string> = {}) {
  return loadRelayEnv({ APP_ORIGIN, NODE_ENV: 'test', ...overrides });
}

/** Never used for reads: tests inject resolveAccountId and readHead. Building it opens no connection. */
export const testClient = () => createMonadPublicClient({ httpUrls: [] });

const noChainReads = async (): Promise<never> => {
  throw new Error('unexpected chain read in test');
};

export async function buildTestApp(opts: {
  env?: Record<string, string>;
  readHead?: () => Promise<ChainHead>;
  resolveAccountId?: (address: Address) => Promise<bigint | null>;
  fetchKeeper?: typeof fetch;
  now?: () => number;
} = {}) {
  const db = openDb(':memory:');
  const app = await buildRelayApp({
    env: relayEnv(opts.env),
    log: pino({ level: 'silent' }),
    db,
    client: testClient(),
    resolveAccountId: opts.resolveAccountId ?? noChainReads,
    readHead: opts.readHead ?? (async () => ({ number: 1n, timestamp: BigInt(Math.floor(Date.now() / 1000)) })),
    fetchKeeper: opts.fetchKeeper,
    now: opts.now
  });
  return { app, db };
}
