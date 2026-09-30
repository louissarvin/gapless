import { privateKeyToAccount } from 'viem/accounts';
import { getBlockNumber, getCode, readContract } from 'viem/actions';
import { ICoverManagerAbi } from '../abi/index.ts';
import { checkEndpoints, createMonadPublicClient, createMonadSendClient } from '../lib/chain.ts';
import { migrate, openDb } from '../lib/db.ts';
import { clearSecretEnv, EnvError, keeperZeroPaidCapWei, loadKeeperEnv, missingKeeperRuntime, type KeeperEnv } from '../lib/env.ts';
import { DESIGN_BASE_FEE_WEI, feeQuote, GAS } from '../lib/gas.ts';
import { createLogger, secretValues, type Logger } from '../lib/log.ts';
import { SEND_DEFAULTS, SendQueue } from '../lib/sendQueue.ts';
import { SignerLease } from '../lib/signerLease.ts';
import { SpendGovernor } from '../lib/spendGovernor.ts';
import { MarketStore } from '../relay/perpl/store.ts';
import { RelayFeedClient } from './feed.ts';
import { HeadSubscriber } from './heads.ts';
import { Keeper, REPEAT_ARM_LABEL, ZERO_PAID_TRIGGER } from './keeper.ts';
import { buildConsole, exemptUsedWei, liveCountReader, observeSends, SendRecorder } from './console.ts';
import { KEEPER_MIGRATIONS } from './migrations.ts';
import { startKeeperServer, type KeeperHealth } from './server.ts';
import { MarkHistory } from './sigma.ts';

const SHUTDOWN_GRACE_MS = 8_000;
const RPC_HEAD_POLL_MS = 5_000;
const BALANCE_POLL_MS = 30_000;
const LOW_BALANCE_LOG_EVERY_MS = 10 * 60_000;
/** Spec §4.1 alert thresholds. */
const MAX_HEAD_LAG_BLOCKS = 10;
const MAX_HEAD_AGE_MS = 10_000;
/** A pending nonce we have no ledger row for, seen twice this far apart, means another sender is live (L-4). */
const FOREIGN_PENDING_RECHECK_MS = 3_000;

const minWei = (a: bigint, b: bigint) => (a < b ? a : b);

function fail(log: Logger, msg: string, fields: Record<string, unknown> = {}): never {
  log.fatal(fields, msg);
  process.exit(1);
}

async function main(): Promise<void> {
  let env: KeeperEnv;
  try {
    env = loadKeeperEnv();
  } catch (err) {
    const boot = createLogger('keeper');
    if (err instanceof EnvError) boot.fatal({ problems: err.problems }, 'env.invalid');
    else boot.fatal({ err }, 'env.load_failed');
    process.exit(1);
  }
  clearSecretEnv();
  const log = createLogger('keeper', env.LOG_LEVEL, secretValues(env));
  const missing = missingKeeperRuntime(env);
  if (missing.length > 0) fail(log, 'keeper.not_configured', { missing });
  process.on('unhandledRejection', (err) => fail(log, 'process.unhandled_rejection', { err }));
  process.on('uncaughtException', (err) => fail(log, 'process.uncaught_exception', { err }));

  const manager = env.COVER_MANAGER_ADDRESS!;
  const chainCfg = { httpUrls: env.MONAD_HTTP_URLS };
  const checks = await checkEndpoints(chainCfg);
  const wrongChain = checks.filter((c) => !c.ok && c.reason === 'wrong_chain');
  if (wrongChain.length > 0) fail(log, 'chain.wrong_chain_id', { endpoints: wrongChain });
  const unreachable = checks.filter((c) => !c.ok);
  if (unreachable.length > 0) log.warn({ endpoints: unreachable }, 'chain.endpoint_unreachable');

  // Reads over HTTP; heads use their own WebSocket; sends never fail over on a node error.
  const client = createMonadPublicClient(chainCfg);
  const sendClient = createMonadSendClient(chainCfg, SEND_DEFAULTS.sendTimeoutMs + 3_000);
  const account = privateKeyToAccount(env.KEEPER_KEY!);

  const code = await getCode(client, { address: manager });
  if (!code || code === '0x') fail(log, 'keeper.manager_not_deployed', { manager });
  const listed = (await readContract(client, { address: manager, abi: ICoverManagerAbi, functionName: 'listedPerps' })).map(Number);
  const perps = env.LISTED_PERPS.filter((p) => listed.includes(p));
  const unlisted = env.LISTED_PERPS.filter((p) => !listed.includes(p));
  if (unlisted.length > 0) log.warn({ unlisted }, 'keeper.perps_not_listed');
  if (perps.length === 0) fail(log, 'keeper.no_listed_perps', { configured: env.LISTED_PERPS, listed });
  const sigmaRole = await readContract(client, { address: manager, abi: ICoverManagerAbi, functionName: 'SIGMA_ROLE' });
  const sigmaEnabled = await readContract(client, { address: manager, abi: ICoverManagerAbi, functionName: 'hasRole', args: [sigmaRole, account.address] });
  if (!sigmaEnabled) log.error({ keeper: account.address }, 'keeper.no_sigma_role: postSigma disabled');

  const db = openDb(env.KEEPER_DB_PATH);
  log.info({ applied: migrate(db, KEEPER_MIGRATIONS) }, 'db.ready');
  const lease = new SignerLease({ db, signer: account.address, log });
  // SE2-L3: a crashed predecessor's lease lapses within its TTL; wait it out instead of crash-looping.
  if (!(await lease.acquireWait())) fail(log, 'signer.lease_held', { signer: account.address });
  // Any exit (fatal included) frees the lease at once; a no-op when another holder took it.
  process.on('exit', () => lease.release());
  const capWei = env.KEEPER_DAILY_SPEND_CAP_WEI!;
  const alertWei = env.KEEPER_SPEND_ALERT_WEI ?? (capWei * 8n) / 10n;
  const governor = new SpendGovernor(
    db,
    account.address,
    {
      capWei,
      hotReserveWei: env.KEEPER_HOTPATH_RESERVE_WEI,
      alertWei,
      actionCapsWei: { [ZERO_PAID_TRIGGER.label]: keeperZeroPaidCapWei(env), [REPEAT_ARM_LABEL]: env.KEEPER_ARM_REPEAT_CAP_WEI },
      // SE3-L1: non-exempt sends always leave one fill call at the design fee.
      fillHeadroomWei: minWei(capWei, GAS.trigger * feeQuote(DESIGN_BASE_FEE_WEI).maxFeePerGas)
    },
    log.child({ component: 'spend' })
  );
  governor.recover();

  const store = new MarketStore();
  let lastHead: { number: bigint; baseFeePerGas: bigint | null } | null = null;
  const queue = new SendQueue({
    client,
    sendClient,
    account,
    governor,
    log: log.child({ component: 'send' }),
    strictReserveSpacing: env.STRICT_RESERVE_SPACING,
    // The head the cycle acts on; fee base from the same header.
    head: async () => {
      const h = lastHead;
      if (!h) throw new Error('no head yet');
      return { number: h.number, baseFeePerGas: h.baseFeePerGas };
    }
  });
  // Console (read-only): copies landed sends after the queue returns them; outcomes pass through unchanged.
  const recorder = new SendRecorder();
  observeSends(queue, recorder, log.child({ component: 'console' }));
  await queue.init();
  if ((await queue.foreignPending()) > 0) {
    await Bun.sleep(FOREIGN_PENDING_RECHECK_MS);
    const foreign = await queue.foreignPending();
    if (foreign > 0) fail(log, 'signer.foreign_pending', { signer: account.address, foreign });
  }
  lease.start(() => fail(log, 'signer.lease_lost', { signer: account.address }));

  const marks = new MarkHistory({ client, perpIds: perps, chunkBlocks: env.KEEPER_LOG_CHUNK_BLOCKS, log: log.child({ component: 'sigma' }) });
  const keeper = new Keeper({ client, queue, governor, db, manager, keeper: account.address, perps, store, marks, log, sigmaEnabled });
  // Seeds the head plausibility bound before the first WS head (L-2).
  const rpcHead = await getBlockNumber(client, { cacheTime: 0 });
  keeper.observeRpcHead(rpcHead);
  // SA4-01: an unsupported maxMatchesClose is logged at error now; arm and trigger stay off for that market.
  const gated = await keeper.init(rpcHead);
  if (gated.length > 0) log.error({ perps: gated }, 'keeper.markets_gated');

  const feed = new RelayFeedClient({ url: env.RELAY_WS_URL!, token: env.RELAY_INTERNAL_TOKEN!, store, log: log.child({ component: 'feed' }) });
  const heads = new HeadSubscriber({
    url: env.MONAD_WS_URL,
    kind: env.KEEPER_HEADS,
    log: log.child({ component: 'heads' }),
    onHead: (h) => {
      if (keeper.onHead(h) && (h.commitState === 'Proposed' || h.commitState === null)) lastHead = h;
    }
  });

  let polling = false;
  const rpcPoll = setInterval(() => {
    if (polling) return;
    polling = true;
    getBlockNumber(client, { cacheTime: 0 })
      .then((n) => keeper.observeRpcHead(n))
      .catch((err: unknown) => log.debug({ err }, 'chain.head_poll_failed'))
      .finally(() => {
        polling = false;
      });
  }, RPC_HEAD_POLL_MS);

  let lowLoggedAt = 0;
  const balancePoll = setInterval(() => {
    const h = lastHead;
    if (!h) return;
    queue
      .balanceAt(h.number)
      .then((wei) => {
        if (wei >= env.KEEPER_LOW_BALANCE_WEI || Date.now() - lowLoggedAt < LOW_BALANCE_LOG_EVERY_MS) return;
        lowLoggedAt = Date.now();
        log.error({ balanceWei: wei.toString(), thresholdWei: env.KEEPER_LOW_BALANCE_WEI.toString() }, 'keeper.low_balance');
      })
      .catch((err: unknown) => log.debug({ err }, 'keeper.balance_poll_failed'));
  }, BALANCE_POLL_MS);

  const health = (): KeeperHealth => {
    const k = keeper.snapshot();
    const q = queue.status();
    const usage = governor.usage();
    const feedHealth = store.feedHealth();
    const critical: string[] = [];
    const info: string[] = [];
    if (!heads.status().subscribed) critical.push('heads_unsubscribed');
    if (k.headAgeMs === null || k.headAgeMs > MAX_HEAD_AGE_MS) critical.push('head_stale');
    if (k.lagBlocks !== null && k.lagBlocks > MAX_HEAD_LAG_BLOCKS) critical.push('head_lag');
    if (q.balanceWei !== null && BigInt(q.balanceWei) < env.KEEPER_LOW_BALANCE_WEI) critical.push('low_balance');
    if (usage.committedWei >= usage.alertWei) info.push('spend_threshold');
    if (!feedHealth.fresh) info.push('feed_stale_sigma_paused');
    return {
      status: critical.length === 0 ? 'ok' : 'degraded',
      service: 'keeper',
      alerts: [...critical, ...info],
      head: { proposed: k.proposed, finalized: k.finalized, ageMs: k.headAgeMs, rpcHead: k.rpcHead, lagBlocks: k.lagBlocks },
      signer: q,
      spend: {
        day: usage.day,
        usedWei: usage.committedWei.toString(),
        capWei: usage.capWei.toString(),
        hotReserveWei: usage.hotReserveWei.toString(),
        alertWei: usage.alertWei.toString()
      },
      feed: { ...feedHealth, ...feed.status() },
      perps,
      sigma: k.sigma,
      lastCycle: k.lastCycle,
      cycles: k.cycles,
      errors: k.errors
    };
  };

  const startedAtMs = Date.now();
  const liveCounts = liveCountReader(client, manager, perps, log.child({ component: 'console' }));
  const consoleDoc = () =>
    buildConsole({
      health,
      snapshot: () => keeper.snapshot(),
      markets: () => keeper.consoleView().markets,
      gaps: () => keeper.consoleView().gaps,
      queueStatus: () => queue.status(),
      usage: () => governor.usage(),
      exemptUsed: (day) => exemptUsedWei(db, account.address, day),
      liveCounts,
      recorder,
      startedAtMs
    });

  const server = startKeeperServer({
    host: env.KEEPER_HOST,
    port: env.KEEPER_PORT,
    token: env.RELAY_INTERNAL_TOKEN!,
    log: log.child({ component: 'http' }),
    health,
    requestSigma: (p) => keeper.requestSigma(p),
    console: consoleDoc
  });

  let closing = false;
  const shutdown = async (signal: string) => {
    if (closing) return;
    closing = true;
    log.info({ signal }, 'keeper.shutdown');
    heads.stop();
    feed.stop();
    clearInterval(rpcPoll);
    clearInterval(balancePoll);
    // Let an in-flight send settle its ledger row before the db closes.
    await Promise.race([keeper.idle(), Bun.sleep(SHUTDOWN_GRACE_MS)]);
    await Promise.race([server.stop(true), Bun.sleep(1_000)]);
    lease.release();
    db.close(false);
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  feed.start();
  heads.start();
  log.info(
    { keeper: account.address, manager, perps, sigmaEnabled, healthz: `${env.KEEPER_HOST}:${server.port}`, heads: env.KEEPER_HEADS },
    'keeper.started'
  );
}

void main();
