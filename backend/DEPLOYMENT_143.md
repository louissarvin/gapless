# Monad mainnet canary (chain 143): backend env

Source of truth: `deployments/143.json` (deploy block 111101834, 2026-10-06; BTC perp 1 listed at block 111105424). Schemas: `src/lib/env.ts`. Full commented proposal: `env.example.proposed`. `test/env.test.ts` parses these values through all three schemas and fails if this file drifts from the deploy record.

## Secrets

`KEEPER_KEY`, `RELAY_KEY`, `RELAY_INTERNAL_TOKEN`, `ENVIO_API_TOKEN`, `MONAD_HTTP_URLS` and `MONAD_WS_URL` (provider tokens live in the URL) come from the host secret store only, injected as process env (Compose: `.env.docker`, mode 600, gitignored, see `RUNNING.md`). Never a repo `.env`, a command argument or shell history. Each entrypoint calls `clearSecretEnv()` right after loading, so they leave `process.env` at once.

Bun auto-loads `.env` from the working directory (bun.sh/docs/runtime/env). The image never ships one (`.dockerignore`, `COPY src` only). On a bare host, keep no `backend/.env` or set `env = false` in `bunfig.toml`.

Every placeholder below (`<SET VIA HOST SECRET STORE>`, `<OPERATOR: ...>`) fails schema validation, so a block pasted unedited refuses to boot.

## Verified onchain (rpc.monad.xyz, 2026-10-07, read-only)

- Chain id 143. All five contracts have code. Creation blocks: CoverVault 111101834 (= `deployBlock`, the first Gapless contract), CoverManager 111101843, GaplessFactory 111101852, GaplessCreSink 111101896.
- `CoverManager.VAULT()` = CoverVault, `CoverManager.factory()` = GaplessFactory, `listedPerps()` = `[1]`.
- `marketParams(1)`: `maxMatchesClose` 8 (passes the SA4-01 gate), `maxCoverNotionalCNS` 20 AUSD (= `JOBS_CURVE_NOTIONAL_AUSD`).
- Keeper signer `0xC0C1EEe02794005eC4ba9ac20A818da42c97a219` (`roles.keeper`) holds `SIGMA_ROLE`; balance 5.99 MON at the read. `KEEPER_KEY` must derive to this address.

## Start order

1. jobs (applies jobs migration 3; the relay never migrates and opens `jobs.sqlite` read-only)
2. relay
3. keeper (its feed and `/sigma-refresh` path use the relay)

## Relay (`bun src/relay/index.ts`)

```sh
NODE_ENV=production
LOG_LEVEL=info
MONAD_HTTP_URLS=<SET VIA HOST SECRET STORE>
MONAD_WS_URL=<SET VIA HOST SECRET STORE>
APP_ORIGIN=<OPERATOR: https origin of the PWA, no path, no trailing slash>
HOST=127.0.0.1
PORT=3700
WS_PORT=3701
TRUST_PROXY=<OPERATOR: exact proxy hop IPs, or leave blank to trust none>
DB_PATH=data/relay.sqlite
RATE_LIMIT_MAX=120
RATE_LIMIT_WINDOW_MS=60000
PERPL_API_URL=https://app.perpl.xyz/api
PERPL_WS_URL=wss://app.perpl.xyz/ws/v1/market-data
PERPL_MARKET_IDS=1,10
GAP_INDEX_DIR=data/gap-index
JOBS_DB_PATH=data/jobs.sqlite
RELAY_INTERNAL_TOKEN=<SET VIA HOST SECRET STORE>
GAPLESS_FACTORY_ADDRESS=0xB1a255e9D4CEdC20998ddC67a7Ec5e0B71bd8777
KEEPER_INTERNAL_URL=<OPERATOR: http://<keeper-app>.internal:3702 or http://127.0.0.1:3702>
SIGMA_REFRESH_PER_ACCOUNT_PER_DAY=6
STRICT_RESERVE_SPACING=false
# Sponsoring: flip to true only with RELAY_KEY in the secret store and SPONSOR_DEMO_OWNER set.
SPONSOR_ENABLED=false
RELAY_KEY=<SET VIA HOST SECRET STORE>
SPONSOR_DEMO_OWNER=<OPERATOR: demo trader owner EOA, checksummed>
SPONSOR_ALLOWLIST_ONLY=true
SPONSOR_OWNER_ALLOWLIST=
RELAY_DAILY_SPEND_CAP_WEI=1000000000000000000
DRIP_WEI=500000000000000000
DRIP_ALLOWLIST=
DAILY_CREATE_CAP=6
TOTAL_CREATE_CAP=6
CREATES_PER_IP_PER_DAY=5
ACTIVATIONS_PER_IP_PER_DAY=10
DAILY_ACTIVATION_CAP=6
SPONSOR_GRANT_MAX_PER_TRADE_CNS=25000000
SPONSOR_GRANT_MAX_PER_DAY_CNS=100000000
SPONSOR_GRANT_MAX_TTL_S=21600
```

`RELAY_KEY` must differ from `KEEPER_KEY` (only checked when both share one environment). With `SPONSOR_ENABLED=false`, leave `RELAY_KEY` and `SPONSOR_DEMO_OWNER` unset rather than placeholder.

## Keeper (`bun src/keeper/index.ts`)

```sh
NODE_ENV=production
LOG_LEVEL=info
MONAD_HTTP_URLS=<SET VIA HOST SECRET STORE>
MONAD_WS_URL=<SET VIA HOST SECRET STORE>
KEEPER_KEY=<SET VIA HOST SECRET STORE>
RELAY_INTERNAL_TOKEN=<SET VIA HOST SECRET STORE>
COVER_MANAGER_ADDRESS=0xb07C20cb5328d5208A1453521b94beeB3Faa1771
RELAY_WS_URL=<OPERATOR: ws://<relay-app>.internal:3701/ws/market or ws://127.0.0.1:3701/ws/market>
LISTED_PERPS=1
KEEPER_DB_PATH=data/keeper.sqlite
KEEPER_HOST=127.0.0.1
KEEPER_PORT=3702
KEEPER_DAILY_SPEND_CAP_WEI=4600000000000000000
KEEPER_HOTPATH_RESERVE_WEI=2650000000000000000
KEEPER_LOW_BALANCE_WEI=2000000000000000000
KEEPER_ARM_REPEAT_CAP_WEI=200000000000000000
# Unset on purpose: alert defaults to 80% of the cap (3.68 MON), zero-paid backstop to min(1.4, cap - hot reserve) = 1.4 MON.
KEEPER_SPEND_ALERT_WEI=
KEEPER_ZERO_PAID_CAP_WEI=
KEEPER_HEADS=monadNewHeads
KEEPER_LOG_CHUNK_BLOCKS=1000
STRICT_RESERVE_SPACING=false
```

- The first `MONAD_HTTP_URLS` entry must be a private endpoint near the keeper (SE2-H1 landing gap check); `MONAD_WS_URL` is required (`monadNewHeads`).
- `RELAY_INTERNAL_TOKEN` is the same value as the relay's (`openssl rand -hex 32`, generated straight into the secret store).
- Funding: 5.1 MON (`KEEPER_FUNDING_MON`) at the start of each demo day and every UTC midnight while covers are live; refill on `keeper.low_balance` (2 MON). Budget math: CLAUDE.md keeper budget table.

## Jobs (`bun src/jobs/index.ts`)

```sh
NODE_ENV=production
LOG_LEVEL=info
ENVIO_API_TOKEN=<SET VIA HOST SECRET STORE>
# Optional: perp metadata and vault reads fall back to the public rpc3 when unset.
MONAD_HTTP_URLS=<SET VIA HOST SECRET STORE>
HYPERSYNC_URL=https://monad.hypersync.xyz
OUT_DIR=data/gap-index
JOBS_DB_PATH=data/jobs.sqlite
JOBS_WINDOW_DAYS=7
JOBS_INTERVAL_MS=300000
JOBS_CURVE_NOTIONAL_AUSD=20
JOBS_NATIVE_STOPS=true
COVER_MANAGER_ADDRESS=0xb07C20cb5328d5208A1453521b94beeB3Faa1771
COVER_VAULT_ADDRESS=0xab3CB7b3b28366eD7f6C59DbD2D708890919B289
GAPLESS_FACTORY_ADDRESS=0xB1a255e9D4CEdC20998ddC67a7Ec5e0B71bd8777
GAPLESS_CRE_SINK_ADDRESS=0xB9908Df02187c49cc77905e62bCA73AB28d9FD1B
GAPLESS_START_BLOCK=111101834
```

`OUT_DIR` and `JOBS_DB_PATH` must equal the relay's `GAP_INDEX_DIR` and `JOBS_DB_PATH` on the shared `data/` volume. `GaplessAccountImpl` (`0xc175a64BcE88dC4AC0Cfefd20daf8826b8c88cDC`) is not an env var: clones are found through the factory's `AccountCreated`.

## Not env

`GAS` limits are compiled constants in `src/lib/gas.ts` (trigger 2.2M, triggerStep 1.1M, triggerCeiling 3.5M, arm 300K, observe 250K, finalize 600K, expire 400K, postSigma 80K, createAccountFor 223,156, sweep 331,819). Changing one is a code change plus the budget table, not a config change.

## Hosting (decided 2026-10-07): Docker Compose on one host

`docker-compose.yml` carries every non-secret value above. Runbook: `RUNNING.md`. Fly was dropped: 6PN listeners must bind `fly-local-6pn` (docs.fly.io/networking/private-networking), which `HOST` and `KEEPER_HOST` (IP literals or `localhost` only) cannot express, and a Fly volume attaches to one machine while relay and jobs must share `data/`.

Values that differ from the bare-host blocks above, because each container has its own loopback:

| Var | Compose value | Why |
|:-|:-|:-|
| `HOST` (relay) | `0.0.0.0` | published ports forward to the container interface; the host side stays `127.0.0.1:3700`/`3701` |
| `KEEPER_HOST` | `0.0.0.0` | reachable only on the private `gapless` network, no published port, bearer token on every route |
| `RELAY_WS_URL` | `ws://relay.internal:3701/ws/market` | network alias; the schema allows plain ws only for localhost or `*.internal` |
| `KEEPER_INTERNAL_URL` | `http://keeper.internal:3702` | same rule for http |
| `TRUST_PROXY` | `172.28.143.1` | gateway of the pinned `gapless` network, where the host proxy arrives from (verify once, `RUNNING.md` section 6) |
| `DB_PATH`, `KEEPER_DB_PATH`, `OUT_DIR`, `GAP_INDEX_DIR`, `JOBS_DB_PATH` | image defaults under `/app/data` | same files as the relative paths above (WORKDIR `/app`) |

Secrets come from `.env.docker` (template `.env.docker.example`), used only for compose interpolation, and each process receives only its own. `test/compose.test.ts` parses the compose env through all three schemas and fails if it drifts from `deployments/143.json`.
