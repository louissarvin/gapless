# gapless-cre: Chainlink CRE workflow for Gapless (W2)

One TypeScript workflow, `gapless-ref`, with three handlers on Monad mainnet (chain 143). CRE is the decentralized liveness backstop (arms and fires covers when the keeper is down) and the consensus reference price. Reports go through the MockKeystoneForwarder `0x9eF6468C5f37b976E57d52054c693269479A784d` to `GaplessCreSink`, which only calls the manager's permissionless, state-checked `arm` and `trigger`; `refPricePNS` is display-only.

Notation: CLI flags are written `flag:name`; type them with two leading hyphens (`flag:target` means the long `target` flag). The `bun run sim:*` scripts below build the flags for you.

## Layout

```text
gapless-cre/
  project.yaml            monad-mainnet RPC from ${MONAD_RPC_URL} (staging and production targets)
  secrets.yaml            empty: public CEX endpoints need no keys
  contracts/abi/          ICoverManager, IGaplessCreSink as viem `as const` ABIs (bootstrap copy, see below)
  gapless-ref/
    main.ts               initWorkflow: handler order is the trigger-index contract
    src/config.ts         zod config schema (also passed to Runner.newRunner as configSchema)
    src/report.ts         frozen report encoding, seen key, per-report gas (D10)
    src/price.ts          node-level CEX fetch, outlier drop, quorum, PNS scaling
    src/chain.ts          selector check, watchList read, signed report write
    src/handlers.ts       onRefPrice, onWatch, onArmed
    workflow.yaml         staging-settings, production-settings (deployment-registry "private")
    config.staging.json   canary config (addresses are placeholders until W5)
    config.production.json
    scripts/simulate.ts   cre workflow simulate wrapper with preflight checks
    scripts/gen-vectors.ts  writes test/fixtures/cre_report_vectors.json
    test/                 bun tests (newTestRuntime, EvmMock, HttpActionsMock) and the parity fixture
```

## Handlers

| Index | Name | Trigger | Report |
|:-|:-|:-|:-|
| 0 | `onRefPrice` | cron `*/30 * * * * *` | kind 1 per market: `seq` = cron second, consensus `refPricePNS`, no ids, gas `gasRef` |
| 1 | `onWatch` | cron `*/30 * * * * *` | one `watchList(perpId, maxIdsPerReport)` read at latest; kind 2 only when non-empty |
| 2 | `onArmed` | EVM log, CoverManager `Armed` (topic0 from the frozen ABI), confidence SAFE | kind 3: `seq` = Armed `blockNumber`, `toTrigger = [coverId]` (D9) |

Report bytes: `abi.encode(uint8 kind, uint64 chainSelector, uint64 seq, uint256 perpId, uint256 refPricePNS, bytes32[] toArm, bytes32[] toTrigger)`, exactly what `GaplessCreReceiver.onReport` decodes. `chainSelector` comes from `getNetwork({chainSelectorName: "monad-mainnet"})` and the workflow refuses to run unless it equals `8481857512324358265` (`Constants.CHAIN_SELECTOR`).

Sink rules the workflow respects: kinds 1 and 2 are accepted when `seq` is within `[block.timestamp - 120, block.timestamp + 2]`, kind 3 within 400 blocks of the Armed block; anything else returns silently (no `CreReport`). A report's content is processed once (`seen[keccak256(abi.encode(decoded fields))]`). At most 3 ids per array onchain; the canary config sends 1.

Reference price: each DON node fetches Binance (public data mirror, USDT), Coinbase and Kraken, parses the decimal string to a 1e8 bigint (no floats), takes the median, drops sources more than `maxSourceDevBps` (50) from it, needs `minSources` (2) left, and returns their median; the DON takes the median of node values (`consensusMedianAggregation<bigint>`), then scales to Perpl PNS (`priceDecimals`, BTC = 1). Kind 1 fails the execution when the quorum fails; kinds 2 and 3 still send their ids with `refPricePNS = 0`.

Gas per report (Monad bills the limit): kind 1 `gasRef` 300K; kinds 2 and 3 `gasBase` 150K + `gasPerArm` 300K per arm + `gasPerTrigger` 2.4M per trigger, capped at `gasCap` 9.5M (CRE quota 10M). Every write logs `txHash`, `txStatus`, `receiverContractExecutionStatus` and throws if either status failed.

## One-time setup (user actions)

The local CLI is v1.1.0. Monad mainnet needs CLI 1.29.0 or later (latest 1.37.0) and every simulation needs a logged-in CRE account.

```bash
cre update          # to 1.37.0
cre version         # expect v1.37.0
cre login           # browser auth
cre whoami
```

Optional (production deploy is Stretch): `cre account access` to request deploy access.

Install (bun 1.3.1 or later, which the SDK requires to be at least 1.2.21):

```bash
cd cre/gapless-cre/gapless-ref
bun install flag:frozen-lockfile
```

Local note (2026-10-06): bun 1.3.1 on this machine hangs fetching large npm manifests. If `bun install` stalls at "Resolving dependencies", run `npm install flag:ignore-scripts`, then `bun install flag:lockfile-only` in a scratch copy containing `package.json` and `package-lock.json` (bun migrates the npm lockfile without network), copy the resulting `bun.lock` back and delete `package-lock.json`.

## Addresses and ABIs

- `receiver` (GaplessCreSink) and `coverManager` in `config.staging.json` and `config.production.json` are the zero address until the canary deploy. The config schema rejects them on purpose ("set by scripts/sync-abi.ts from deployments/143.json"), so nothing can run against a guessed address. W5 `scripts/sync-abi.ts` writes the real values; do not hand-edit them.
- `contracts/abi/*.ts` is a one-time bootstrap copy of `contract/abi/{ICoverManager,IGaplessCreSink}.json`. `scripts/sync-abi.ts` owns these files once it lands. A test fails if they drift from `contract/abi`.

## Local checks (no login needed)

```bash
cd cre/gapless-cre/gapless-ref
bun test                 # 46 tests
bun run typecheck
bun run compile          # cre-compile to dist/gapless-ref.wasm (same Javy toolchain as the CLI)
bun run vectors          # regenerate the parity fixture after a report change
```

## Environment

| Variable | Used by | Notes |
|:-|:-|:-|
| `MONAD_RPC_URL` | `project.yaml` (both targets), `scripts/simulate.ts` preflight | process env; never commit |
| `CRE_ETH_PRIVATE_KEY` | CLI | dry runs: a throwaway zero-balance key (`cast wallet new`); the one broadcast: the keeper key, process env only |

Never create `gapless-cre/.env` with a real key. Use `read -rs CRE_ETH_PRIVATE_KEY && export CRE_ETH_PRIVATE_KEY`, run, then `unset CRE_ETH_PRIVATE_KEY`.

## Simulate (dry runs, after the canary addresses are synced)

From `cre/gapless-cre/gapless-ref`:

```bash
bun run sim:ref                          # trigger-index 0, kind 1, dry
bun run sim:watch                        # trigger-index 1, live watchList, dry (expect no write on an empty list)
bun run sim:armed 0x<ArmedTxHash> <i>    # trigger-index 2, replays a real Armed log, dry
```

`scripts/simulate.ts` refuses to run with a CLI older than 1.29.0, without `MONAD_RPC_URL`, or with a malformed tx hash. Raw equivalents, run from `cre/gapless-cre`:

```text
cre workflow simulate gapless-ref flag:target staging-settings flag:non-interactive flag:trigger-index 0
cre workflow simulate gapless-ref flag:target staging-settings flag:non-interactive flag:trigger-index 1
cre workflow simulate gapless-ref flag:target staging-settings flag:non-interactive flag:trigger-index 2 flag:evm-tx-hash 0x<hash> flag:evm-event-index <i>
```

The simulator enforces the production quotas by default (`flag:limits default`). `flag:evm-event-index` is the log's index inside that transaction, not the handler. Without `flag:broadcast` the logged tx hash is all zeros. Kind-3 replays stay dry: the sink ignores kind 3 more than 400 blocks after the Armed block (D11), so a late broadcast would be a silent no-op.

Simulator quirk handled in code: in `flag:non-interactive` mode the CLI skips the cron wait and reports the next tick (up to 30 s ahead) as `scheduledExecutionTime` (cre-cli v1.37.0 `simulate.go`, chainlink `manual_cron_trigger.go`). The sink drops a `seq` more than 2 s in the future, so `cronSeq` clamps `seq` to `runtime.now()` and logs `seq_clamped`. Deployed DONs always execute after the tick, so production keeps the scheduled second. Keep the machine clock NTP-synced before a broadcast.

## The one broadcast (ADR-P5, kind 1, about 0.03 MON)

Only after the security-auditor signs off the key procedure, in an evening window:

1. `ETH_RPC_URL=$MONAD_RPC_URL cast call <CoverManager> "liveCount(uint256)(uint256)" 1` returns 0 (the script checks this again).
2. Stop the keeper and confirm its signer lease is released.
3. `read -rs CRE_ETH_PRIVATE_KEY && export CRE_ETH_PRIVATE_KEY` (keeper key), `export MONAD_RPC_URL=...`.
4. `bun run broadcast:ref` (trigger-index 0 with `flag:broadcast`; refused for any other handler or when a cover is live).
5. `unset CRE_ETH_PRIVATE_KEY`, restart the keeper, `/healthz` green within 1 min, `keeper.foreign_pending` stays 0. Target downtime under 3 min.
6. Verify on MonadVision, not only in the CLI output: the tx goes to `0x9eF6...784d`, emits `ReportProcessed(receiver = sink, ..., result = true)`, and the sink emits `CreReport(1, 1, refPricePNS, 0, 0)`. The mock forwarder does not revert when the receiver reverts (it records `success = false`), and the docs state `receiverContractExecutionStatus` is always SUCCESS in simulation, so the logged statuses alone do not prove delivery. `sink.seen(keccak256(report))` must read true.
7. Record the tx hash for `docs/BOUNTIES.md`.

## Production deploy (Stretch, not built)

Needs deploy access, a production receiver bound to the KeystoneForwarder `0x76c9cf548b4179F8901cda1f8623568b58215E62` with workflow id and owner checks, and its address in `config.production.json`. Then `cre workflow deploy gapless-ref flag:target production-settings` and `cre workflow activate gapless-ref flag:target production-settings`; pause after judging with `cre workflow pause`.

## Parity fixture

`gapless-ref/test/fixtures/cre_report_vectors.json` holds 8 vectors (kinds 1, 2, 3, extremes, wrong chain, a hand-built 4-id report) plus a trailing-bytes variant for N-06, each with the report bytes and the expected `seen` key. Bytes and hashes were cross-checked with `cast abi-encode` and `cast keccak`. `test/fixtures/CreParity.reference.sol` is a forge test that passed offline against `contract/src/cre/GaplessCreSink.sol`; lane S copies it and the JSON into `contract/test/`.
