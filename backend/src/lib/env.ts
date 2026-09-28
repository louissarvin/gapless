import { getAddress, isAddress, type Address, type Hex } from 'viem';
import { z } from 'zod';
import { SECRET_ENV_KEYS } from './log.ts';

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

function parseUrl(v: string): URL | null {
  try {
    return new URL(v);
  } catch {
    return null;
  }
}

// Plain http/ws is only acceptable for a node on the same machine.
function secureUrl(secure: string, insecure: string, label: string) {
  return z.string().refine((v) => {
    const u = parseUrl(v);
    if (!u) return false;
    return u.protocol === secure || (u.protocol === insecure && LOCAL_HOSTS.has(u.hostname));
  }, `must be a ${label} URL (${insecure}// only for localhost)`);
}

const httpsUrl = secureUrl('https:', 'http:', 'https');
const wssUrl = secureUrl('wss:', 'ws:', 'wss');

// Keeper and relay talk over a private network (Fly 6PN is WireGuard), so `.internal` hosts may use plain ws/http.
function privateUrl(secure: string, insecure: string, label: string) {
  return z.string().refine((v) => {
    const u = parseUrl(v);
    if (!u) return false;
    const local = LOCAL_HOSTS.has(u.hostname) || u.hostname.endsWith('.internal');
    return u.protocol === secure || (u.protocol === insecure && local);
  }, `must be a ${label} URL (${insecure}// only for localhost or *.internal)`);
}

const privateWsUrl = privateUrl('wss:', 'ws:', 'wss');
const privateHttpUrl = privateUrl('https:', 'http:', 'https');

/** secp256k1 group order: a private key must be in [1, n). */
const SECP256K1_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;

const PRIVATE_KEY_RE = /^0x[0-9a-fA-F]{64}$/;

// zod 4 runs refinements after a failed regex, so the range check re-tests the format before BigInt.
const privateKey = z
  .string()
  .regex(PRIVATE_KEY_RE, 'must be 0x followed by 64 hex characters')
  .refine((v) => {
    if (!PRIVATE_KEY_RE.test(v)) return true;
    const n = BigInt(v);
    return n > 0n && n < SECP256K1_N;
  }, 'must be a valid secp256k1 private key')
  .transform((v) => v.toLowerCase() as Hex);

const address = z
  .string()
  .refine((v) => isAddress(v, { strict: true }), 'must be a 0x address (checksummed if mixed case)')
  .transform((v): Address => getAddress(v));

const weiAmount = z
  .string()
  .regex(/^\d{1,30}$/, 'must be an integer amount in wei')
  .transform((v) => BigInt(v));

const ONE_MON = 10n ** 18n;

// Positive AUSD amount in CNS (6 decimals); 38 digits stay below 2^128 (OperatorGrant fields are uint128).
const cnsAmount = z
  .string()
  .regex(/^[1-9]\d{0,37}$/, 'must be a positive integer amount in CNS')
  .transform((v) => BigInt(v));

const flag = z.enum(['true', 'false']).default('false').transform((v) => v === 'true');
const flagOn = z.enum(['true', 'false']).default('true').transform((v) => v === 'true');

const origin = z.string().refine((v) => {
  const u = parseUrl(v);
  if (!u || u.origin !== v) return false;
  return u.protocol === 'https:' || (u.protocol === 'http:' && LOCAL_HOSTS.has(u.hostname));
}, 'must be a bare origin such as https://app.example.com (no path, no trailing slash)');

function csv<T extends string>(item: z.ZodType<T, string>, max: number) {
  return z
    .string()
    .transform((s) => s.split(',').map((x) => x.trim()).filter(Boolean))
    .pipe(
      z
        .array(item)
        .max(max)
        .refine((xs) => new Set(xs).size === xs.length, 'must not contain duplicates')
    );
}

// Trust-all or near trust-all ranges make every client able to forge X-Forwarded-For.
export const MIN_TRUST_PREFIX = { v4: 8, v6: 32 } as const;

const proxyEntry = z.union([
  z.ipv4(),
  z.ipv6(),
  z.cidrv4().refine((v) => Number(v.split('/')[1]) >= MIN_TRUST_PREFIX.v4, 'IPv4 CIDR must be /8 or narrower'),
  z.cidrv6().refine((v) => Number(v.split('/')[1]) >= MIN_TRUST_PREFIX.v6, 'IPv6 CIDR must be /32 or narrower'),
  z.enum(['loopback', 'linklocal', 'uniquelocal'])
]);

/** Shared secret for internal callers (keeper WS, detailed /healthz). Hex or base64url, 32+ chars. */
const internalToken = z
  .string()
  .regex(/^[A-Za-z0-9_-]{32,256}$/, 'must be 32 to 256 characters of [A-Za-z0-9_-] (openssl rand -hex 32)');

function isLocalHostname(hostname: string): boolean {
  return LOCAL_HOSTS.has(hostname) || hostname.endsWith('.localhost');
}

const base = {
  NODE_ENV: z.enum(['production', 'development', 'test']).default('production'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info')
};

// Monad reverts only value spend below 10 MON, so only value sends wait for the emptying window.
// true restores spacing for every send below 10 MON (if the canary shows gas-only calls reverting).
const signer = { STRICT_RESERVE_SPACING: flag };

const rpc = {
  // Ordered, private endpoints first. The public RPC is appended in chain.ts as last resort.
  MONAD_HTTP_URLS: csv(httpsUrl, 5).default([]),
  MONAD_WS_URL: wssUrl.optional()
};

export const relayEnvSchema = z.object({
  ...base,
  ...rpc,
  APP_ORIGIN: origin,
  HOST: z.union([z.ipv4(), z.ipv6(), z.literal('localhost')]).default('127.0.0.1'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3700),
  // Only these proxy hops may set X-Forwarded-For. Unset means trust none.
  TRUST_PROXY: csv(proxyEntry, 16).optional(),
  DB_PATH: z.string().min(1).default('data/relay.sqlite'),
  RATE_LIMIT_MAX: z.coerce.number().int().min(1).max(10_000).default(120),
  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().min(1_000).max(3_600_000).default(60_000),
  // Bun.serve listener for /ws/market (Fastify cannot hand upgrades to Bun pub/sub).
  WS_PORT: z.coerce.number().int().min(1).max(65535).default(3701),
  PERPL_API_URL: httpsUrl.default('https://app.perpl.xyz/api'),
  PERPL_WS_URL: wssUrl.default('wss://app.perpl.xyz/ws/v1/market-data'),
  // Markets with book and trades streams. 2 chain streams + 2 per market must stay <= 16.
  PERPL_MARKET_IDS: z
    .string()
    .transform((s) => s.split(',').map((x) => x.trim()).filter(Boolean))
    .pipe(
      z
        .array(z.string().regex(/^[1-9]\d{0,5}$/, 'must be a market id').transform(Number))
        .min(1)
        .max(7)
        .refine((xs) => new Set(xs).size === xs.length, 'must not contain duplicates')
    )
    .default([1, 10]),
  // Jobs output on the shared data/ volume. GAP_INDEX_DIR must equal the jobs OUT_DIR.
  GAP_INDEX_DIR: z.string().min(1).default('data/gap-index'),
  // Jobs event store, opened read-only for /api/wallet/:addr.
  JOBS_DB_PATH: z.string().min(1).default('data/jobs.sqlite'),
  // Keeper WS access outside the public caps, the detailed /healthz body and /sigma-refresh forwarding.
  RELAY_INTERNAL_TOKEN: internalToken.optional(),
  // Feature flag for /sponsor/create and /activate (the only routes that spend the relay key).
  SPONSOR_ENABLED: flag,
  RELAY_KEY: privateKey.optional(),
  // GaplessFactory from the canary deploy. No default: Gapless addresses are never hardcoded.
  GAPLESS_FACTORY_ADDRESS: address.optional(),
  // Global daily MON for the relay key (gas plus drips), UTC day, reserve-then-settle in relay.sqlite.
  RELAY_DAILY_SPEND_CAP_WEI: weiAmount.default(ONE_MON),
  // BUILD_PLAN §0: 0.5 MON, demo operator only. 0 disables drips.
  DRIP_WEI: weiAmount.default(ONE_MON / 2n).refine((v) => v <= ONE_MON, 'must be at most 1 MON'),
  // Operator keys that may receive the drip. Empty means no drips.
  DRIP_ALLOWLIST: csv(address, 20).default([]),
  DAILY_CREATE_CAP: z.coerce.number().int().min(0).max(300).default(6),
  // BUILD_PLAN W4: sponsored creates over the whole run (budget).
  TOTAL_CREATE_CAP: z.coerce.number().int().min(0).max(10_000).default(6),
  CREATES_PER_IP_PER_DAY: z.coerce.number().int().min(0).max(50).default(5),
  ACTIVATIONS_PER_IP_PER_DAY: z.coerce.number().int().min(0).max(100).default(10),
  // Global /activate claims per UTC day (M-1).
  DAILY_ACTIVATION_CAP: z.coerce.number().int().min(0).max(300).default(6),
  // H-2: only allowlisted owners (plus the demo owner) are sponsored. Default on for the canary.
  SPONSOR_ALLOWLIST_ONLY: flagOn,
  SPONSOR_OWNER_ALLOWLIST: csv(address, 50).default([]),
  // Always sponsorable, with a create slot reserved outside the total and daily caps.
  SPONSOR_DEMO_OWNER: address.optional(),
  // Keeper /sigma-refresh on the private network.
  KEEPER_INTERNAL_URL: privateHttpUrl.optional(),
  // M-5: accepted /sigma-refresh forwards per Gapless account per UTC day.
  SIGMA_REFRESH_PER_ACCOUNT_PER_DAY: z.coerce.number().int().min(1).max(100).default(6),
  // SA2 N-03 go-condition: sponsored operator grants stay small and short (canary: 25 AUSD per trade, 100 per day, 6 h).
  SPONSOR_GRANT_MAX_PER_TRADE_CNS: cnsAmount.default(25_000_000n),
  SPONSOR_GRANT_MAX_PER_DAY_CNS: cnsAmount.default(100_000_000n),
  SPONSOR_GRANT_MAX_TTL_S: z.coerce.number().int().min(600).max(86_400).default(21_600),
  ...signer
})
  .refine((e) => e.WS_PORT !== e.PORT, { path: ['WS_PORT'], message: 'must differ from PORT' })
  .refine(
    (e) =>
      typeof e.SPONSOR_GRANT_MAX_PER_TRADE_CNS !== 'bigint' ||
      typeof e.SPONSOR_GRANT_MAX_PER_DAY_CNS !== 'bigint' ||
      e.SPONSOR_GRANT_MAX_PER_TRADE_CNS <= e.SPONSOR_GRANT_MAX_PER_DAY_CNS,
    { path: ['SPONSOR_GRANT_MAX_PER_TRADE_CNS'], message: 'must not exceed SPONSOR_GRANT_MAX_PER_DAY_CNS' }
  )
  .refine((e) => !e.SPONSOR_ENABLED || (e.RELAY_KEY !== undefined && e.GAPLESS_FACTORY_ADDRESS !== undefined), {
    path: ['SPONSOR_ENABLED'],
    message: 'requires RELAY_KEY and GAPLESS_FACTORY_ADDRESS'
  })
  .refine((e) => !e.KEEPER_INTERNAL_URL || e.RELAY_INTERNAL_TOKEN !== undefined, {
    path: ['KEEPER_INTERNAL_URL'],
    message: 'requires RELAY_INTERNAL_TOKEN'
  })
  .refine((e) => !e.SPONSOR_ENABLED || !e.SPONSOR_ALLOWLIST_ONLY || e.SPONSOR_DEMO_OWNER !== undefined || e.SPONSOR_OWNER_ALLOWLIST.length > 0, {
    path: ['SPONSOR_ALLOWLIST_ONLY'],
    message: 'with SPONSOR_ENABLED requires SPONSOR_DEMO_OWNER or SPONSOR_OWNER_ALLOWLIST'
  })
  .refine((e) => !e.KEEPER_INTERNAL_URL || e.GAPLESS_FACTORY_ADDRESS !== undefined, {
    path: ['KEEPER_INTERNAL_URL'],
    message: 'requires GAPLESS_FACTORY_ADDRESS (/sigma-refresh checks the caller account onchain)'
  })
  .refine((e) => e.NODE_ENV !== 'production' || isProductionOrigin(e.APP_ORIGIN), {
    path: ['APP_ORIGIN'],
    message: 'must be https and not localhost when NODE_ENV=production'
  });

function isProductionOrigin(v: string): boolean {
  const u = parseUrl(v);
  return !!u && u.protocol === 'https:' && !isLocalHostname(u.hostname);
}

/**
 * Keeper. Runtime secrets and addresses are optional here so the schema validates before deploy;
 * keeper/index.ts refuses to start without them (missingKeeperRuntime).
 */
export const keeperEnvSchema = z
  .object({
    ...base,
    MONAD_HTTP_URLS: csv(httpsUrl, 5).refine((xs) => xs.length > 0, 'must list at least one URL'),
    // Head-driven: monadNewHeads needs a WebSocket.
    MONAD_WS_URL: wssUrl,
    // Holds SIGMA_ROLE; also the CRE broadcast key, used only while the keeper is stopped.
    KEEPER_KEY: privateKey.optional(),
    // CoverManager from the canary deploy. No default: Gapless addresses are never hardcoded.
    COVER_MANAGER_ADDRESS: address.optional(),
    // Relay fan-out /ws/market (internal bearer path) and the shared secret for it and /sigma-refresh.
    RELAY_WS_URL: privateWsUrl.optional(),
    RELAY_INTERNAL_TOKEN: internalToken.optional(),
    LISTED_PERPS: z
      .string()
      .transform((s) => s.split(',').map((x) => x.trim()).filter(Boolean))
      .pipe(
        z
          .array(z.string().regex(/^[1-9]\d{0,4}$/, 'must be a perp id').transform(Number))
          .min(1)
          .max(4)
          .refine((xs) => new Set(xs).size === xs.length, 'must not contain duplicates')
      )
      .default([1]),
    KEEPER_DB_PATH: z.string().min(1).default('data/keeper.sqlite'),
    // /healthz and /sigma-refresh. Bind to a private interface only.
    KEEPER_HOST: z.union([z.ipv4(), z.ipv6(), z.literal('localhost')]).default('127.0.0.1'),
    KEEPER_PORT: z.coerce.number().int().min(1).max(65535).default(3702),
    // Hard daily MON cap (UTC day) for every keeper send, arm and trigger included. Canary: 4.6 MON with 5.1 MON funding.
    KEEPER_DAILY_SPEND_CAP_WEI: weiAmount.optional(),
    // Part of the cap only hot-path sends (paying closes, remainder fills, first arms, observe) may use; non-exempt
    // spend stays under cap minus this. Default: the exempt part of two worst-case 32-lot closes at 110 gwei plus one
    // 3.5M retry (CLAUDE.md budget table).
    KEEPER_HOTPATH_RESERVE_WEI: weiAmount.default(2_650_000_000_000_000_000n),
    // Error log when daily spend reaches this. Default: 80% of the cap.
    KEEPER_SPEND_ALERT_WEI: weiAmount.optional(),
    // Below this a worst-case close (5 steps, 4 fills, arm, observe, finalize at 110 gwei) plus one fill in flight
    // no longer fits, so the next touch may be refused at admission (keeper.touch_unfunded).
    KEEPER_LOW_BALANCE_WEI: weiAmount.default(2_000_000_000_000_000_000n),
    // newHeads only for a plain local node without Monad commit states.
    KEEPER_HEADS: z.enum(['monadNewHeads', 'newHeads']).default('monadNewHeads'),
    // eth_getLogs range per request for the mark history (public rpc3 allows 100).
    KEEPER_LOG_CHUNK_BLOCKS: z.coerce.number().int().min(100).max(10_000).default(1_000),
    // H-1: daily wei for triggers that simulate to paidNow 0 (outside the hot reserve). Default: keeperZeroPaidCapWei().
    KEEPER_ZERO_PAID_CAP_WEI: weiAmount.optional(),
    // SE3-L1: daily wei for repeat arms of one cover (arm TTL lapse in chop), non-exempt.
    KEEPER_ARM_REPEAT_CAP_WEI: weiAmount.default(200_000_000_000_000_000n),
    ...signer
  })
  .refine((e) => !e.KEEPER_DAILY_SPEND_CAP_WEI || e.KEEPER_HOTPATH_RESERVE_WEI <= e.KEEPER_DAILY_SPEND_CAP_WEI, {
    path: ['KEEPER_HOTPATH_RESERVE_WEI'],
    message: 'must not exceed KEEPER_DAILY_SPEND_CAP_WEI'
  })
  .refine((e) => !e.KEEPER_SPEND_ALERT_WEI || !e.KEEPER_DAILY_SPEND_CAP_WEI || e.KEEPER_SPEND_ALERT_WEI <= e.KEEPER_DAILY_SPEND_CAP_WEI, {
    path: ['KEEPER_SPEND_ALERT_WEI'],
    message: 'must not exceed KEEPER_DAILY_SPEND_CAP_WEI'
  })
  // zod runs object refines even when a field failed, so check types before doing bigint math.
  .refine(
    (e) =>
      typeof e.KEEPER_ZERO_PAID_CAP_WEI !== 'bigint' ||
      typeof e.KEEPER_DAILY_SPEND_CAP_WEI !== 'bigint' ||
      typeof e.KEEPER_HOTPATH_RESERVE_WEI !== 'bigint' ||
      e.KEEPER_ZERO_PAID_CAP_WEI + e.KEEPER_HOTPATH_RESERVE_WEI <= e.KEEPER_DAILY_SPEND_CAP_WEI,
    { path: ['KEEPER_ZERO_PAID_CAP_WEI'], message: 'must not exceed KEEPER_DAILY_SPEND_CAP_WEI minus KEEPER_HOTPATH_RESERVE_WEI' }
  );

/**
 * Backstop for trigger_zero (SE2-M1): two worst-case walks, 10 steps at GAS.triggerStep settled at 112 gwei (1.232 MON)
 * plus one step in flight at 222 gwei (0.121). Per-touch admission binds first. Math in CLAUDE.md.
 */
export const ZERO_PAID_CAP_DEFAULT_WEI = 1_400_000_000_000_000_000n;

/** KEEPER_ZERO_PAID_CAP_WEI, or the default clamped to the non-hot part of the cap. */
export function keeperZeroPaidCapWei(env: KeeperEnv): bigint {
  if (env.KEEPER_ZERO_PAID_CAP_WEI !== undefined) return env.KEEPER_ZERO_PAID_CAP_WEI;
  const room = (env.KEEPER_DAILY_SPEND_CAP_WEI ?? 0n) - env.KEEPER_HOTPATH_RESERVE_WEI;
  if (room <= 0n) return 0n;
  return room < ZERO_PAID_CAP_DEFAULT_WEI ? room : ZERO_PAID_CAP_DEFAULT_WEI;
}

const KEEPER_RUNTIME = ['KEEPER_KEY', 'COVER_MANAGER_ADDRESS', 'RELAY_WS_URL', 'RELAY_INTERNAL_TOKEN', 'KEEPER_DAILY_SPEND_CAP_WEI'] as const;

/** Names the keeper needs to run that the schema allows to be unset before deploy. */
export function missingKeeperRuntime(env: KeeperEnv): string[] {
  return KEEPER_RUNTIME.filter((k) => env[k] === undefined);
}

export const jobsEnvSchema = z.object({
  ...base,
  ...rpc,
  ENVIO_API_TOKEN: z.string().regex(/^\S+$/, 'must be a non-empty token without whitespace'),
  HYPERSYNC_URL: httpsUrl.default('https://monad.hypersync.xyz'),
  // Gap Index JSON for the relay (GET /api/gap-index/*).
  OUT_DIR: z.string().min(1).default('data/gap-index'),
  // Event store; the relay opens it read-only for /api/wallet/:addr.
  JOBS_DB_PATH: z.string().min(1).default('data/jobs.sqlite'),
  JOBS_WINDOW_DAYS: z.coerce.number().int().min(1).max(30).default(7),
  JOBS_INTERVAL_MS: z.coerce.number().int().min(60_000).max(3_600_000).default(300_000),
  // Premium curve notional in whole AUSD. Default is the canary maxCoverNotional (20 AUSD, CANARY_PARAMS.md).
  JOBS_CURVE_NOTIONAL_AUSD: z.coerce.number().int().min(1).max(100_000).default(20),
  // W4a: native stop ingest (HyperSync JoinAll on the trigger topics) and native-stops.json.
  JOBS_NATIVE_STOPS: flagOn,
  // W4b: Gapless contracts from the canary deploy for stats.json. No defaults: never hardcoded. Unset skips stats.
  COVER_MANAGER_ADDRESS: address.optional(),
  COVER_VAULT_ADDRESS: address.optional(),
  GAPLESS_FACTORY_ADDRESS: address.optional(),
  GAPLESS_CRE_SINK_ADDRESS: address.optional(),
  // Deploy block (deployments/143.json deployBlock): Gapless logs are ingested from here, all time.
  GAPLESS_START_BLOCK: z.coerce.number().int().min(1).max(Number.MAX_SAFE_INTEGER).optional()
}).refine(
  (e) =>
    (e.COVER_MANAGER_ADDRESS === undefined && e.COVER_VAULT_ADDRESS === undefined && e.GAPLESS_FACTORY_ADDRESS === undefined &&
      e.GAPLESS_CRE_SINK_ADDRESS === undefined && e.GAPLESS_START_BLOCK === undefined) ||
    (e.COVER_MANAGER_ADDRESS !== undefined && e.GAPLESS_START_BLOCK !== undefined),
  { path: ['GAPLESS_START_BLOCK'], message: 'Gapless stats need both COVER_MANAGER_ADDRESS and GAPLESS_START_BLOCK once any Gapless var is set' }
).refine(
  (e) => {
    const set = [e.COVER_MANAGER_ADDRESS, e.COVER_VAULT_ADDRESS, e.GAPLESS_FACTORY_ADDRESS, e.GAPLESS_CRE_SINK_ADDRESS].filter((a) => typeof a === 'string');
    return new Set(set).size === set.length;
  },
  { path: ['COVER_MANAGER_ADDRESS'], message: 'Gapless contract addresses must be distinct' }
);

/** Gapless log ingest config from the jobs env; null before the deploy addresses are set. */
export function jobsGaplessConfig(env: JobsEnv): { startBlock: number; addresses: { manager: Address; vault?: Address; factory?: Address; sink?: Address } } | null {
  if (env.COVER_MANAGER_ADDRESS === undefined || env.GAPLESS_START_BLOCK === undefined) return null;
  const addresses: { manager: Address; vault?: Address; factory?: Address; sink?: Address } = { manager: env.COVER_MANAGER_ADDRESS };
  if (env.COVER_VAULT_ADDRESS) addresses.vault = env.COVER_VAULT_ADDRESS;
  if (env.GAPLESS_FACTORY_ADDRESS) addresses.factory = env.GAPLESS_FACTORY_ADDRESS;
  if (env.GAPLESS_CRE_SINK_ADDRESS) addresses.sink = env.GAPLESS_CRE_SINK_ADDRESS;
  return { startBlock: env.GAPLESS_START_BLOCK, addresses };
}

export type RelayEnv = z.infer<typeof relayEnvSchema>;
export type KeeperEnv = z.infer<typeof keeperEnvSchema>;
export type JobsEnv = z.infer<typeof jobsEnvSchema>;

/** Lists offending variable names and rules. Never includes values, which may be secrets. */
export class EnvError extends Error {
  constructor(readonly problems: string[]) {
    super(`Invalid environment: ${problems.join('; ')}`);
    this.name = 'EnvError';
  }
}

type EnvSource = Record<string, string | undefined>;

/**
 * Validates only the keys the schema declares. Blank values count as unset.
 * @throws EnvError with one line per problem.
 */
export function parseEnv<S extends z.ZodObject>(schema: S, source: EnvSource = process.env): z.infer<S> {
  const input: Record<string, string> = {};
  for (const key of Object.keys(schema.shape)) {
    const v = source[key]?.trim();
    if (v) input[key] = v;
  }
  const result = schema.safeParse(input);
  if (!result.success) {
    throw new EnvError(
      result.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
    );
  }
  return result.data;
}

/** SE2-I1: one key for both signers would share a nonce stream and the relay's budget with the keeper's. */
function assertDistinctSigners(source: EnvSource): void {
  const relay = source.RELAY_KEY?.trim().toLowerCase();
  const keeper = source.KEEPER_KEY?.trim().toLowerCase();
  if (relay && keeper && relay === keeper) throw new EnvError(['RELAY_KEY: must differ from KEEPER_KEY']);
}

export const loadRelayEnv = (source: EnvSource = process.env) => {
  assertDistinctSigners(source);
  return parseEnv(relayEnvSchema, source);
};
export const loadKeeperEnv = (source: EnvSource = process.env) => {
  assertDistinctSigners(source);
  return parseEnv(keeperEnvSchema, source);
};
export const loadJobsEnv = (source?: EnvSource) => parseEnv(jobsEnvSchema, source);

/**
 * SE2-I1: drops keys, tokens and tokenized RPC URLs from the process environment once parsed, so env dumps and
 * child processes never see them. The parsed env keeps the values (signing, log redaction).
 */
export function clearSecretEnv(source: EnvSource = process.env): void {
  for (const k of SECRET_ENV_KEYS) delete source[k];
}
