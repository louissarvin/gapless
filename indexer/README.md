# Gapless indexer (Envio HyperIndex)

GraphQL over every Gapless event on Monad mainnet (chain 143): cover lifecycle, vault flows, LP positions, GaplessAccount clones, CRE reports, plus a Perpl staleness sampler. Powers `/covers/:id` history, `/vault`, account views and the cross-check of `GET /api/stats`.

Pinned: `envio` 3.12.1, `viem` 2.57.3, `vitest` 4.1.0, `typescript` 6.0.3, pnpm 10.32.0, Node >= 22 (Cloud runs Node 24). Every dependency is an exact pin because Envio Cloud ignores the lockfile.

CLI flags are written `flag:name` in this file (meaning the flag `name` with its usual double-hyphen prefix).

## Layout

| Path | What |
|:-|:-|
| `config.yaml` | V3 config: chain 143 over HyperSync, `address_format: lowercase`, contracts via `abi_file_path` |
| `schema.graphql` | Entities (below) |
| `abis/` | Event ABIs, owned by `scripts/sync-abi.ts` (W5). Bootstrapped once by hand, see `abis/README.md` |
| `src/handlers/` | Auto-loaded by Envio: `manager`, `vault`, `factory` (+ clone registration), `account`, `sink`, `sampler` |
| `src/effects/` | `perpInfo`, `blockTime`, `triggerPrints` (Effect API, 5 calls/s, cached, never cached on error) |
| `src/lib/` | Shared helpers (not handler files) |
| `test/` | vitest + `createTestIndexer()` simulate mode, offline |

## Entities

`Cover`, `CoverEvent` (one row per lifecycle log, drives the stepper), `Fill` (one per `Triggered`), `TriggerPrint` (maker fills inside a trigger tx), `Market`, `StalenessSample`, `VaultFlow`, `RedeemRequest`, `LiquidityProvider`, `GaplessAccountEntity`, `Trade`, `CreReportEntity`, `AdminEvent`, `Stats` (singleton `id: "global"`).

Notes on meaning:
- `Cover.status` follows the logs. Onchain an `ARMED` cover past `armTtlBlocks` reads as `LIVE` lazily; compare `armedBlock + Market.armTtlBlocks` with the head.
- A `finalize` that leaves `owedCNS > 0` pays and shrinks the cap without a manager event, so `Cover.paidCNS` and `Cover.capCNS` lag until `Finalized`. `Stats.paidCNS` comes from vault `Paid` logs and is exact.
- `Stats.vault*` mirror `CoverVault` accounting exactly: gross assets += `Deposit`, += `PremiumReceived.toLps`, -= `Paid`, -= `RedeemClaimed`; owed from `OwedUpdated`; reserved from `Reserved`/`Released` minus `Paid`; `vaultTotalAssetsCNS` = gross - owed (ERC-4626 `totalAssets`).
- `Stats.escrowToVaultCNS` = `Finalized.escrowToVaultCNS` + every `EscrowForfeited`.
- `Stats.armToTriggerHist` buckets (blocks): <= 1, 2, 3, 4, 6, 10, 20, 40, 100, 200, then above 200. Only first fills of covers that were `ARMED` count; Live fast-path and lapsed-arm fills do not.
- `Fill.makerCount`, `printLots`, `vwapPNS` and `TriggerPrint` rows come from the trigger tx receipt (`MakerOrderFilledV2` from the Perpl Exchange only, same perp, after the previous `Triggered` log of that tx). They stay null when `ENVIO_MONAD_RPC_URL` is unset or the receipt call fails.
- `StalenessSample` rows exist only where both the historical `eth_call` and `getBlock` succeeded; gaps are visible by design.

## Environment

| Var | Where | Value |
|:-|:-|:-|
| `ENVIO_START_BLOCK` | config | Deploy block. Default `0` (placeholder); the sampler stays off while it is 0 |
| `ENVIO_COVER_MANAGER_ADDRESS`, `ENVIO_COVER_VAULT_ADDRESS`, `ENVIO_GAPLESS_FACTORY_ADDRESS`, `ENVIO_GAPLESS_CRE_SINK_ADDRESS` | config | Defaults `0x...0c01` to `0x...0c04` are inert placeholders with no code |
| `ENVIO_MONAD_RPC_URL` | effects | `https://rpc-mainnet.monadinfra.com` (historical state, D1). Unset means effects return null. https only (http allowed for localhost). Never logged |
| `ENVIO_SAMPLER_PERPS` | sampler | Comma-separated perp ids, default `1` |
| `ENVIO_PERPL_EXCHANGE_ADDRESS` | effects | Optional, default `Constants.PERPL_EXCHANGE` (`0x34B6...2a6F`) |
| `ENVIO_API_TOKEN` | local `envio dev` only | HyperSync token. Envio Cloud does not need one. Keep it in your shell, never in a committed file |

### Deploy markers (contract with W5)

Exactly these five lines end in a marker comment of the form `# @deploy:<Key>`, and each holds a quoted (for addresses) `${ENVIO_VAR:-default}` interpolation: `deployBlock`, `CoverManager`, `CoverVault`, `GaplessFactory`, `GaplessCreSink`. `scripts/sync-abi.ts` rewrites only the default after `:-` from `deployments/143.json`. Addresses must stay quoted: YAML reads an unquoted `0x...` as an integer. `test/config.test.ts` pins this.

## Local development

```bash
cd indexer
pnpm install            # CI: pnpm install flag:frozen-lockfile
pnpm codegen            # writes .envio/ (gitignored)
pnpm tsc
pnpm test               # offline, simulate mode
```

`pnpm dev` (`envio dev`) runs the full indexer with Postgres and Hasura in Docker and needs Docker running plus `ENVIO_API_TOKEN` exported in the shell. Hasura admin secret locally is `testing`. Config, schema or ABI changes need `pnpm envio start -r`.

## Tests

`createTestIndexer()` runs the real handlers in-process. Every test passes a `simulate` array (without one the test indexer pulls real blocks from HyperSync and needs a token). Effects are exercised against a local JSON-RPC stub (`test/helpers.ts` `startRpcStub`), so the real viem code path runs with no network.

| File | Covers |
|:-|:-|
| `lifecycle.test.ts` | bought, armed, disarmed, re-armed, 5 `TriggerNoFill`, deferral, 3 `Triggered`, observed, finalized; Live fast path; lapsed arm |
| `endPaths.test.ts` | cancel, expire after arm (escrow forfeited), void, resize with refund then forfeiture (ceil rounding), refund owed and claimed |
| `account.test.ts` | `AccountCreated` registers the clone; clone events (`Traded`, `Credited`, `OperatorSet`...); initialize's `OperatorSet` logged before `AccountCreated` |
| `vault.test.ts` | seed, deposits, reserve, premium, payout, owed, release, redeem request and claim, `lpCount` |
| `effects.test.ts` | sampler every 200 blocks with a gap on RPC failure; trigger prints attribution with two covers in one tx, another perp and a spoofed emitter |
| `sinkAdmin.test.ts`, `config.test.ts`, `env.test.ts` | CRE reports and admin logs; deploy markers and ABI topic0 parity; env validation |

After the canary (local, token needed, not CI): add a pinned block-range e2e over the canary blocks, `indexer.process({ chains: { 143: { startBlock, endBlock } } })` with inline snapshots.

## Envio Cloud deploy (later)

Prereqs: public repo with branch `envio` (W0), Envio Cloud login with GitHub and the Envio Deployments GitHub App installed on this repo only (decision 5).

1. Add indexer: Indexer Directory `indexer`, config file `config.yaml`, Git Release Branch `envio`.
2. Environment Variables tab: the `ENVIO_*` vars above (values from `deployments/143.json`; no `ENVIO_API_TOKEN` needed).
3. M1 smoke (before addresses): set `ENVIO_START_BLOCK` to a recent block, leave addresses as placeholders, push to `envio`. Confirms pnpm 10.32.0, exact pins, Node 24 and codegen on Cloud; only the sampler produces rows.
4. M2 final (after canary and W5): W5 rewrites the marker defaults, set the same values in the dashboard, delete M1 (3 deployments per indexer), push to `envio`. Every push re-indexes from `start_block`, so push only at milestones.
5. Verify: `_meta` synced to head; `Market(where: {perpId: {_eq: 1}})`, `MarketListed`, `SigmaPosted` and the vault seed `Deposit` indexed; canary `CoverBought`, `Armed`, `Triggered`, `Finalized` with tx hashes; `Stats` equals `/api/stats` (reconcile script).
6. Keep it alive: hourly `_meta` query (7 days without queries starts deletion); stay well under 100,000 events (Gapless only, projected under 30K to Oct 27). Fallback: self-host `envio start` next to the relay.

Example query:

```graphql
query CoverHistory($id: String!) {
  Cover(where: { id: { _eq: $id } }) {
    status side lots stopPNS paidCNS owedCNS armToTriggerBlocks
    events(order_by: { blockNumber: asc, logIndex: asc }) { kind blockNumber txHash amountCNS refPNS reason }
    fills { blockNumber filledLots paidNowCNS vwapPNS makerCount }
  }
}
```

## Dependency advisories

`pnpm audit` reports advisories only in packages pinned inside `envio` 3.12.1 itself (`express` 4.19.2 for its internal metrics server, `envio > viem 2.54 > ws`, `tsx > esbuild`). The indexer exposes no HTTP surface of its own; recheck on each `envio` upgrade rather than overriding the hosted runtime's internals.
