import { privateKeyToAccount } from 'viem/accounts';
import { MONAD_CHAIN_ID } from '../lib/addresses.ts';
import { checkEndpoints, createMonadPublicClient, createMonadSendClient, readHead, type ChainConfig, type MonadPublicClient } from '../lib/chain.ts';
import { migrate, openDb, type Database } from '../lib/db.ts';
import { clearSecretEnv, EnvError, loadRelayEnv, type RelayEnv } from '../lib/env.ts';
import { createLogger, secretValues, type Logger } from '../lib/log.ts';
import { getBlock } from 'viem/actions';
import { SendQueue } from '../lib/sendQueue.ts';
import { SignerLease } from '../lib/signerLease.ts';
import { SpendGovernor } from '../lib/spendGovernor.ts';
import { buildRelayApp } from './app.ts';
import type { MarketDataHealth } from './healthz.ts';
import { RELAY_MIGRATIONS } from './migrations.ts';
import { MarketStore } from './perpl/store.ts';
import { marketDataStreams } from './perpl/types.ts';
import { PerplUpstream } from './perpl/upstream.ts';
import { checkFactoryDomain } from './sponsor/eip712.ts';
import { SponsorLedger } from './sponsor/ledger.ts';
import { SponsorService, sponsorGrantPolicy } from './sponsor/service.ts';
import { startMarketWsServer } from './ws/marketServer.ts';

const SHUTDOWN_GRACE_MS = 10_000;
/** Relay sends wait longer than the keeper's 2 s: nothing races them. */
const RELAY_SEND_TIMEOUT_MS = 5_000;
/** L-3: the relay has no head stream, so finalized reconciles run on a timer. */
const RECONCILE_MS = 3_000;
/** L-4: a pending nonce we have no ledger row for, seen twice this far apart, means another sender is live. */
const FOREIGN_PENDING_RECHECK_MS = 3_000;
/** SE2-L3: a sponsor start that failed for a reason that can clear (lease, RPC) is retried this often. */
const SPONSOR_RETRY_MS = 10_000;

interface Sponsor {
  service: SponsorService;
  queue: SendQueue;
  lease: SignerLease;
}

/**
 * Sponsor routes spend the relay key. Refused (routes answer 503) unless the deployed factory signs
 * the frozen typed data; the relay keeps serving market data either way. `retry` marks failures that can clear
 * (a crashed predecessor's lease, RPC errors); a domain mismatch is final.
 */
async function buildSponsor(env: RelayEnv, chainCfg: ChainConfig, client: MonadPublicClient, db: Database, log: Logger): Promise<{ sponsor: Sponsor | null; retry: boolean }> {
  if (!env.SPONSOR_ENABLED) return { sponsor: null, retry: false };
  const factory = env.GAPLESS_FACTORY_ADDRESS!;
  try {
    const problems = await checkFactoryDomain(client, factory);
    if (problems.length > 0) {
      log.error({ factory, problems }, 'sponsor.disabled_domain_mismatch');
      return { sponsor: null, retry: false };
    }
  } catch (err) {
    log.error({ err, factory }, 'sponsor.disabled_factory_unreadable');
    return { sponsor: null, retry: true };
  }
  try {
    return { sponsor: await startSponsor(env, chainCfg, client, db, log, factory), retry: false };
  } catch (err) {
    log.error({ err }, 'sponsor.disabled_start_failed');
    return { sponsor: null, retry: true };
  }
}

async function startSponsor(env: RelayEnv, chainCfg: ChainConfig, client: MonadPublicClient, db: Database, log: Logger, factory: `0x${string}`): Promise<Sponsor> {
  const account = privateKeyToAccount(env.RELAY_KEY!);
  const slog = log.child({ component: 'sponsor' });
  const lease = new SignerLease({ db, signer: account.address, log: slog });
  if (!lease.acquire()) throw new Error('signer lease held by another relay process');
  return lease.holding(async () => {
    const governor = new SpendGovernor(db, account.address, { capWei: env.RELAY_DAILY_SPEND_CAP_WEI, hotReserveWei: 0n, alertWei: (env.RELAY_DAILY_SPEND_CAP_WEI * 8n) / 10n }, slog);
    governor.recover();
    const queue = new SendQueue({
      client,
      sendClient: createMonadSendClient(chainCfg, RELAY_SEND_TIMEOUT_MS + 3_000),
      account,
      governor,
      log: slog,
      sendTimeoutMs: RELAY_SEND_TIMEOUT_MS,
      strictReserveSpacing: env.STRICT_RESERVE_SPACING
    });
    await queue.init();
    if ((await queue.foreignPending()) > 0) {
      await Bun.sleep(FOREIGN_PENDING_RECHECK_MS);
      const foreign = await queue.foreignPending();
      if (foreign > 0) throw new Error(`relay key has ${foreign} pending txs this process did not send`);
    }
    lease.start(() => queue.halt('lease_lost'));
    // SE2-L3: a fatal exit frees the lease at once, so the restarted relay can sponsor without waiting out the TTL.
    process.on('exit', () => lease.release());
    const ledger = new SponsorLedger(db, {
      createsPerIpPerDay: env.CREATES_PER_IP_PER_DAY,
      dailyCreateCap: env.DAILY_CREATE_CAP,
      totalCreateCap: env.TOTAL_CREATE_CAP,
      activationsPerIpPerDay: env.ACTIVATIONS_PER_IP_PER_DAY,
      dailyActivationCap: env.DAILY_ACTIVATION_CAP,
      demoOwner: env.SPONSOR_DEMO_OWNER?.toLowerCase()
    });
    log.info(
      {
        relay: account.address,
        factory,
        dripWei: env.DRIP_WEI.toString(),
        allowlisted: env.DRIP_ALLOWLIST.length,
        ownerAllowlistOnly: env.SPONSOR_ALLOWLIST_ONLY,
        owners: env.SPONSOR_OWNER_ALLOWLIST.length,
        demoOwner: env.SPONSOR_DEMO_OWNER ?? null
      },
      'sponsor.enabled'
    );
    const service = new SponsorService({
      client,
      queue,
      ledger,
      factory,
      dripWei: env.DRIP_WEI,
      dripAllowlist: new Set(env.DRIP_ALLOWLIST.map((a) => a.toLowerCase())),
      ownerAllowlistOnly: env.SPONSOR_ALLOWLIST_ONLY,
      ownerAllowlist: new Set(env.SPONSOR_OWNER_ALLOWLIST.map((a) => a.toLowerCase())),
      grantPolicy: sponsorGrantPolicy(env),
      log: slog
    });
    return { service, queue, lease };
  });
}
/** RPC head poll for the Perpl feed lag check (store.observeChainHead). */
const HEAD_POLL_MS = 5_000;

async function main(): Promise<void> {
  let env;
  try {
    env = loadRelayEnv();
  } catch (err) {
    const boot = createLogger('relay');
    if (err instanceof EnvError) boot.fatal({ problems: err.problems }, 'env.invalid');
    else boot.fatal({ err }, 'env.load_failed');
    process.exit(1);
  }
  clearSecretEnv();

  const log = createLogger('relay', env.LOG_LEVEL, secretValues(env));
  process.on('unhandledRejection', (err) => {
    log.fatal({ err }, 'process.unhandled_rejection');
    process.exit(1);
  });
  process.on('uncaughtException', (err) => {
    log.fatal({ err }, 'process.uncaught_exception');
    process.exit(1);
  });

  const chainCfg = { httpUrls: env.MONAD_HTTP_URLS, wsUrl: env.MONAD_WS_URL };
  if (env.MONAD_HTTP_URLS.length === 0) {
    log.warn('chain.public_rpc_only: set MONAD_HTTP_URLS to a private endpoint for production');
  }
  const checks = await checkEndpoints(chainCfg);
  const wrongChain = checks.filter((c) => !c.ok && c.reason === 'wrong_chain');
  if (wrongChain.length > 0) {
    log.fatal({ endpoints: wrongChain }, 'chain.wrong_chain_id');
    process.exit(1);
  }
  const unreachable = checks.filter((c) => !c.ok);
  if (unreachable.length > 0) log.warn({ endpoints: unreachable }, 'chain.endpoint_unreachable');

  const db = openDb(env.DB_PATH);
  const applied = migrate(db, RELAY_MIGRATIONS);
  log.info({ applied }, 'db.ready');

  const client = createMonadPublicClient(chainCfg);

  // One process, two listeners: Fastify (HTTP API) on PORT, Bun.serve (/ws/market) on WS_PORT.
  const store = new MarketStore();
  const wsServer = startMarketWsServer({
    host: env.HOST,
    port: env.WS_PORT,
    appOrigin: env.APP_ORIGIN,
    store,
    log: log.child({ component: 'ws' }),
    trustProxy: env.TRUST_PROXY,
    internalToken: env.RELAY_INTERNAL_TOKEN
  });
  if (!env.RELAY_INTERNAL_TOKEN) log.warn('ws.internal_path_disabled: set RELAY_INTERNAL_TOKEN so the keeper has reserved slots');
  const upstream = new PerplUpstream({
    url: env.PERPL_WS_URL,
    streams: marketDataStreams(MONAD_CHAIN_ID, env.PERPL_MARKET_IDS),
    store,
    log: log.child({ component: 'perpl' }),
    onFrame: (raw) => wsServer.broadcast(raw),
    onStatus: (raw) => wsServer.broadcast(raw)
  });
  const marketData = (): MarketDataHealth => {
    const s = upstream.status();
    const feed = store.feedHealth();
    const subscribed = s.connected ? (s.missingStreams.length > 0 ? 'partial' : 'connected') : null;
    return {
      upstream: subscribed ?? (s.state === 'connecting' || s.state === 'open' ? 'connecting' : 'down'),
      lastMessageAgeMs: s.lastMessageAgeMs,
      headBlock: s.headBlock,
      feedLagBlocks: feed.feedLagBlocks,
      reconnects: s.reconnects,
      clients: wsServer.counts(),
      missingStreams: s.missingStreams
    };
  };

  // Independent head for the feed lag check: a Perpl backend replaying old blocks looks live otherwise.
  let headPolling = false;
  const headPoll = setInterval(() => {
    if (headPolling) return;
    headPolling = true;
    readHead(client)
      .then((h) => store.observeChainHead(Number(h.number)))
      .catch((err: unknown) => log.debug({ err }, 'chain.head_poll_failed'))
      .finally(() => {
        headPolling = false;
      });
  }, HEAD_POLL_MS);

  let closing = false;
  const first = await buildSponsor(env, chainCfg, client, db, log);
  let sponsor = first.sponsor;
  let starting = false;
  // SE2-L3: retried until it starts, so a restart inside the lease TTL does not leave sponsoring off until a manual restart.
  const retryTimer = first.retry
    ? setInterval(() => {
        if (sponsor || starting || closing) return;
        starting = true;
        buildSponsor(env, chainCfg, client, db, log)
          .then((r) => {
            sponsor = r.sponsor;
            if (sponsor) log.info('sponsor.started_after_retry');
            if (sponsor || !r.retry) clearInterval(retryTimer!);
          })
          .catch((err: unknown) => log.error({ err }, 'sponsor.retry_failed'))
          .finally(() => {
            starting = false;
          });
      }, SPONSOR_RETRY_MS)
    : null;
  let reconciling = false;
  const reconcileTimer = env.SPONSOR_ENABLED
    ? setInterval(() => {
        const s = sponsor;
        if (!s || reconciling) return;
        reconciling = true;
        getBlock(client, { blockTag: 'finalized' })
          .then((b) => s.queue.reconcile(b.number))
          .catch((err: unknown) => log.warn({ err }, 'sponsor.reconcile_failed'))
          .finally(() => {
            reconciling = false;
          });
      }, RECONCILE_MS)
    : null;
  const app = await buildRelayApp({ env, log, db, client, readHead: () => readHead(client), marketData, marketStore: store, sponsor: () => sponsor?.service ?? null });

  const shutdown = async (signal: string) => {
    if (closing) return;
    closing = true;
    log.info({ signal }, 'relay.shutdown');
    const force = setTimeout(() => {
      log.error('relay.shutdown_timeout');
      process.exit(1);
    }, SHUTDOWN_GRACE_MS);
    try {
      clearInterval(headPoll);
      if (reconcileTimer) clearInterval(reconcileTimer);
      if (retryTimer) clearInterval(retryTimer);
      upstream.stop();
      await wsServer.stop();
      await app.close();
      sponsor?.lease.release();
      db.close(false);
    } finally {
      clearTimeout(force);
      process.exit(0);
    }
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  await app.listen({ host: env.HOST, port: env.PORT });
  upstream.start();
  log.info({ wsPort: wsServer.port, markets: env.PERPL_MARKET_IDS }, 'relay.market_ws_listening');
}

void main();
