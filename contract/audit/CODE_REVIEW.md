# CR1: final code quality review before the frozen mainnet deploy (2026-10-06)

Scope: `src/**`, `script/**`, test quality, and agreement between `INTERFACES.md`, `CHANGE_REQUESTS.md`, `docs/*.md` and the code after C0 to C6. `src/` was not modified.

Baseline on this tree: Foundry 1.8.3, solc 0.8.37. `forge build` is clean and `forge test` passes 477 of 477 (102 s). `abi/*.json` matches `out/` for all 9 exported interfaces. Runtime sizes: CoverManager 47,937 B, GaplessAccount 16,571 B, CoverVault 14,571 B (all fit the 128 KB limit).

Verdict: **no functional defect found** in the state machine or the floor-step logic. Every finding below is documentation, naming, test structure or script hygiene. Two facts were checked on a temp copy of `src/`:
1. Comment and NatSpec edits leave deployed bytecode identical (`bytecode_hash = "none"`; checked on CoverVault and GaplessAccount).
2. Replacing the `_checkParams` literals with `Constants.F_*` also leaves CoverManager bytecode identical.

So every "Must fix" item below costs no re-audit. **No item changes the ABI** unless marked `[ABI]`.

## State machine and floor-step walkthrough (no findings)

Every transition was traced against INTERFACES section 4 and the C4, C5 and C6 rules:

- `arm`:
  - effective Live only, warm-up passed, `block < expiryBlock`.
  - A broken position voids the cover.
  - Needs a fresh R, a crossed book, and R at or through the stop.
  - A lapsed arm emits `Disarmed(ArmTtlElapsed)` before re-arming. The chain is reset.
- `trigger` on a Live or Armed cover:
  - `CoverExpired` past expiry.
  - The fast path is open to anyone, including in the arm block.
  - The slow path needs `block > armedBlock`, holds the armer window only when it ends before expiry, and disarms on venue down, book uncrossed, or R outside tol.
  - With n == 0 it closes at the D49 floor.
  - A lapsed arm disarms first, then takes the fast path or returns 0.
- `_step` / `_chain` / `_bookThin`:
  - One step per block.
  - A same-block retry reuses step k; the capped case drops one step (SA3-I3, accepted).
  - A full fill, or an attempt with R not through, resets the chain.
  - A match-limited short leaves the chain unchanged.
  - `shortBlock != 0` implies `shortSteps >= 1`, so `c.shortSteps - 1` cannot underflow.
- End paths:
  - Past expiry, every end path ends as `Expired` and refunds iff `armedBlock == 0`.
  - Before expiry, the zone rule uses the purchase snapshot.
  - Refunds go through `trySafeTransfer`, with `refundOwed` as the fallback.
- Payouts:
  - `_settle` reports every owed change to the vault.
  - `_releaseExcess` keeps exactly `paid + owed`.
  - `_closeOut` releases `cap - paid`.

Storage layout:
- `Cover` is exactly 6 slots; slot 5 is 256 bits.
- `MarketParams` is about 6 consecutive slots, which is one Monad page.
- GaplessAccount packs `_opUsedCNS` with `_opUsedAt`.

Hot-path gas: I found nothing worth changing before the freeze.
- Monad charges the gas limit, not gas used (SA3 section 4), so cheaper revert paths save the keeper nothing.
- Monad warms storage one 128-slot page at a time (8,100 gas per cold page, [Monad opcode pricing](https://docs.monad.xyz/developer-essentials/opcode-pricing)). So trimming the `MarketParams` loads in `trigger` would save about 200 gas.
- The only extra external read (`_bookThin`) is required by SA3-02.

## Must fix before deploy

All items here are comments, NatSpec or scripts. The verified source on the explorer is permanent, and the keeper, indexer and backend read this text.

### MF-1 Stale NatSpec in frozen files that become the verified source

| Where | Now says | Code does | Fix |
|:-|:-|:-|:-|
| `src/types/GaplessTypes.sol:157` | `realizedCNS // balance(after) - balance(before)` | `(balance + locked)` delta (`GaplessAccount.sol:215`, `_equityCNS`) | Apply CR1, open since C0: `// (balance + locked)(after) - (balance + locked)(before); own resting orders cleared by the close do not count` |
| `src/interfaces/ICoverVault.sol:69-70` (`reserve`) | checks against `totalAssets` | gross `_assets` = `totalAssets() + owedTotal` (`CoverVault.sol:159`) | `Checks (reservedTotal + amt) <= grossAssets x maxUtilizationBps and ...; grossAssets = totalAssets + owedTotal (L-08)` |
| `ICoverVault.sol:74-75` (`payCapped`) | cap snapshot `totalAssets x bps`; pays `min(amount, per-block remaining)` | `_assets x bps`; also capped at `reserved[perpId]` (`CoverVault.sol:193, 197`) | Say gross assets, and add `and reserved[perpId]` |
| `ICoverVault.sol:88` (`freeAssets`) | `totalAssets - reservedTotal` | `_assets - reservedTotal` (`CoverVault.sol:317-321`) | `gross assets - reservedTotal (0 if negative)` |
| `src/CoverVault.sol:323` (`utilizationBps`) | `reservedTotal / totalAssets` | `/ _assets` | Same wording. Note: the PWA's displayed utilization will differ from `quote().utilAfterBps`, which uses net `totalAssets` |
| `ICoverVault.sol:16` | `SEED_ASSETS` | `Constants.VAULT_SEED_CNS` | Rename in the comment |
| `src/interfaces/IGaplessAccount.sol:21` (`Credited`) | "Manager payout or refund received" | only `creditToPerpl` emits it, and refunds are plain transfers (conflict C6, INTERFACES 5.4) | `Manager payout received; toPerpl false when it stayed in the wallet. Refunds arrive as plain AUSD transfers.` The indexer will otherwise expect a `Credited` for every refund |
| `IGaplessAccount.sol:67-68` (`opNonce`) | "Next EIP-712 nonce shared by Withdraw and SetOperator" | `setOperator` and `revokeOperator` also bump it (`GaplessAccount.sol:155, 183`) | Apply CR3: `; setOperator and revokeOperator also bump it` |
| `src/interfaces/ICoverManager.sol:193` (`arm @return`) | false only when the venue is unavailable | also false after voiding a broken position (`CoverManager.sol:312-315`) | `False (no revert) when the venue is unavailable or the position broke (cover voided).` |
| `ICoverManager.sol:202` (`trigger @return`) | 0 on disarm, TTL lapse, zero fill | also 0 on void (`CoverManager.sol:363-366`) | Add `or void (LiquidatedOrAdl)` |
| `src/libraries/PayoutMath.sol:21-22, 25` (`closeLimitPNS`) | C4 text: "used after a short close in an earlier block"; param `floorSlackBps` | since C5 it receives the step allowance `min(floorSlack, A x 2^k)` (`CoverManager.sol:684`) | NatSpec: `Widened IOC limit: min(stop, R) x (1 - slackBps) (step k >= 1), or the D49 floor when R = 0.` Rename params `refTrigPNS -> refPNS` and `floorSlackBps -> slackBps` (internal, no ABI change) |
| `src/Constants.sol:8` | "Defaults are the canary listing values" | the canary overrides `maxCoverNotionalCNS` (20e6) and `marketCapBps` (10,000) in `ListMarket.s.sol:40-42` | `Defaults are the code defaults; the canary listing overrides two fields (docs/CANARY_PARAMS.md).` |
| `Constants.sol:233` | "canary cap 50 AUSD" | canary lists at 20 AUSD | `default cap 50 AUSD (canary lists 20e6, ListMarket)` |
| `Constants.sol:321` | "treasury = deployer for the canary" | `Deploy.s.sol:54` reads env `TREASURY` | `treasury from Deploy's TREASURY env` |
| `src/types/GaplessTypes.sol:48` (`Quote.rentCNS`) | `>= minFeeCNS` | `>= minFee x ceil(T / 12,000)` (L-09) | Update |

Check after editing: compare `forge inspect <C> deployedBytecode` before and after for every contract. It must be byte-identical (verified for CoverVault and GaplessAccount).

### MF-2 `script/Deploy.s.sol:115-137` `_check` misses two one-shot wiring facts (SA3-I6, still open)

The broadcast is one-shot. A typo in `TREASURY` sends protocol fees to the wrong address until the admin (after `acceptDefaultAdminTransfer`) calls `setConfig`. `SIGMA_ROLE` is only checked later, by ListMarket. Add:

```solidity
require(IAccessControl(d.manager).hasRole(Constants.SIGMA_ROLE, c.keeper), "Deploy: keeper sigma");
require(d.vault.config().treasury == c.treasury, "Deploy: treasury");
```

This is a script-only change; no contract changes. Re-run `test/unit/Deploy.t.sol`.

### MF-3 `INTERFACES.md` consumer tables are stale; keeper and indexer configs are cut from them

Event-subscription gaps matter on deploy day: the indexer's start block is the deploy block.

- **Section 8, line 345:** "manager: all 14 lifecycle and market events". The manager now emits 18:
  - FactorySet, MarketListed, MarketParamsSet, SigmaPosted
  - CoverBought, CoverResized, Armed, Disarmed, TriggerNoFill, Triggered, Observed, Finalized, CoverEnded
  - PayoutDeferred, EscrowForfeited, RefundOwed, RefundClaimed, MarketPauseSet

  The vault list omits `OwedUpdated`, `ConfigSet` and `ManagerSet`. Replace the count with the explicit list.
- **Section 5.4 table, lines 156-163:**
  - Views lack `marketPaused`, `refundOwed`, `refundOwedTotal`.
  - Permissionless lacks `claimRefund`.
  - Roles lack `pauseMarket` and `unpauseMarket`.
  - Events lack the four C4 events.
  - Errors lack `MarketPaused`, `CoverShareExceeded`, `NoRefundOwed`.
  - The keeper row in section 8 should list `claimRefund` and `housekeeping` follow-ups.
- **Section 5.5 table, lines 187-192:** lacks `updateOwed`, `owedTotal` and `OwedUpdated`.
- **Section 5.3 table, lines 135-142:**
  - Views lack `operatorUsage`.
  - Errors lack `LimitOffMarket`, `CloseExceedsPosition`, `OperatorBudgetExceeded`.
- **Line 146:** "decays at the current grant's rate" is pre-C6. Since CR32, usage is checkpointed at the outgoing grant's rate on every grant change and on revoke, and does not decay while revoked.

## Should fix

### Code (no behavior change, no ABI change)

**SF-1 `src/CoverManager.sol:1094-1122`:** `_checkParams` passes literal indices 0 to 26, while `Constants.F_SLIP_ALLOWANCE` to `F_MAX_COVER_NOTIONAL` exist and are referenced nowhere in src, script or tests. Use the named constants (bytecode-identical, verified). Example:

```solidity
_in(p.slipAllowanceBps, Constants.SLIP_ALLOWANCE_BPS_MIN, Constants.SLIP_ALLOWANCE_BPS_MAX, Constants.F_SLIP_ALLOWANCE);
```

`CoverVault.sol:358-368` has the same issue with `ConfigOutOfBounds(0..3)`. There are no constants for those; add `C_TREASURY`, `C_MAX_UTIL`, `C_PROTOCOL_FEE` and `C_MIN_DEPOSIT`, or keep the interface comment at `ICoverVault.sol:51` as the single source.

**SF-2 Floor-step naming (`CoverManager.sol:635-638, 703`):**
- In `_close`, `short_` actually means short **and** through, and `_chain` names the same value `shortThrough`. Rename `short_` to `shortThrough` so the SA3-02 guard reads `if (!shortThrough || _bookThin(c, limit)) _chain(c, shortThrough, k);`.
- Also apply the `PayoutMath.closeLimitPNS` parameter renames from MF-1.

This is the most audited logic in the repo; the names should match the spec text.

**SF-3 `CoverManager.sol:60` `SETTLING_SLOT`:** this is an unexplained 32-byte literal. It equals `keccak256("gapless.CoverManager.settling")` (verified with `cast keccak`). Write it as that expression, or add the preimage as a one-line comment; solc folds it at compile time.

### Scripts and env

**SF-4 `.env.example`:** lacks the ListMarket variables `MANAGER`, `VAULT`, `SEED_DEPOSIT_CNS`, `MAX_COVER_NOTIONAL_CNS`, `MARKET_CAP_BPS` and `SIGMA_BPS_E2` (read at `script/ListMarket.s.sol:100-109`). Add the names; no values.

### Docs that disagree with code or with each other

**SF-5 `CHANGE_REQUESTS.md:3`:** "Nothing below has been applied; no frozen file was edited" is false since C4. Rewrite it as "CR1 to CR8 are requests; C4 to C6 rows are applied", and add a Status column. On this tree:
- CR1 (realizedCNS comment), CR3 (opNonce NatSpec), CR5 (`F_SIGMA_POST` in Constants) and CR6 (INTERFACES section 7 rounding) are still **open**.
- CR4 is applied (`IGaplessCreSink.sol:17`).
- CR8 (`SCAN_LIMIT = 512`) is implemented, but INTERFACES never mentions it.

**SF-6 `INTERFACES.md` section 4 (lines 84-110):**
- The mermaid diagram predates C5 and C6. Add or change these edges:
  - `A -> T` for a fast-path trigger in the arm block (C6; the current label says `(armedBlock, ...]`).
  - `L -> L` and `A -> A` for `TriggerNoFill`, which moves the chain.
  - `L -> E` and `A -> E` for `cancelCover` / `syncCover` / `voidCover` past expiry (N-02).
  - `A -> V` for `syncCover` before expiry.
  - "past warm-up" on the `L -> T` fast path.
- The C4 paragraph (line 102) still states the single widened floor "only after a close came up short in an earlier block". Mark it superseded by the C5 paragraph or delete it.
- Line 110: `isLocked` is also false for an Armed cover past expiry (C5).

**SF-7 `INTERFACES.md` sections 6, 7 and 12:**
- Line 240: "50e6 (BUILD_PLAN canary)". The canary lists at 20e6 (section 3 step 8, CANARY_PARAMS 3); call 50e6 the code default.
- Line 268: "files not in `src/` until S2 writes them" is stale.
- Lines 283 and 292 say `minDistanceBps` and `multiplierBps` ceil; the code floors (CR6, premium.ts parity).
- The section 7 PremiumMath list lacks `rentFloorCNS`.
- The section 12 change table (lines 420-424) has no C6 row, although C6 edited the frozen `src/Constants.sol` (`F_FLOOR_SLACK_VS_SLIP`).
- Section 5.4 should state `SCAN_LIMIT` (CR8).
- Line 176: `_releaseExcess` also runs on an early finalize (observed and full) with owed > 0, not only past the window.

**SF-8 `README.md:7`:** "invariant (256 x 500)" is wrong; `forge test` runs 64 x 200 (`foundry.toml:28-29`, INTERFACES section 1). Point readers to `FOUNDRY_PROFILE=deep` for 256 x 500.

**SF-9 `docs/S1_NOTES.md` and `docs/S2_NOTES.md`:** these still state behavior later rounds replaced. Add a one-line "superseded by C4 to C6 where noted" banner, or strike these lines:
- S1:39: "per-kind monotonic `seq`" (replaced by the L-04 seen-set).
- S2:22: limit "clamped to [1, uint32 max]" (now 16,777,215, L-06), and the close limit lacks the step-0 tight floor.
- S2:31: "Armed path needs `block > armedBlock`" (C6: the fast path runs in the arm block).
- S2:76, 77, 78: open risks fixed by C4/C5 (maxMatches 32, live params, frozen-AUSD refunds).

**SF-10 `docs/CANARY_PARAMS.md:47`:** uses the C5 sizes (CoverManager 47,554 B). C6 is 47,937 B and GaplessAccount 16,571 B. Re-derive the MON estimate from these, or state it as a lower bound.

### Test quality

**SF-11 S1 suites run on the interim `ManagerStub`, not the real manager.**
- `GaplessAccount.t.sol`, `GaplessAccountAttacks.t.sol`, `GaplessFactory.t.sol`, `CoverVault.t.sol`, `VaultInflation.t.sol` and `Deploy.t.sol` use `GaplessFixture` with `useRealManager` left false.
- The stub says it is "Deleted once the fixture uses the real manager" (`test/unit/stubs/ManagerStub.sol:14`, INTERFACES section 2 line 58), but that never happened.
- As a result, the account's `isLocked` / `syncCover` / `quote` interplay (C5 post-expiry unlock, operator charge on `q.notionalCNS`) is exercised against the real manager only in `CoverManagerIntegration` (4 tests), the audit suites and the invariants.
- Fix: switch `GaplessAccount.t.sol` and `GaplessAccountAttacks.t.sol` to `useRealManager = true` (the fixture already supports it). Keep the stub only where a test needs to drive payouts directly, and rename it so its scope is clear.

**SF-12 Duplicated fixtures.**
- These helpers are copy-pasted with identical bodies:
  - `_roll` (6 copies, all with the magic `(n * 3 + 9) / 10` warp).
  - `_refs` (5 copies).
  - `_trader` (3 copies).
  - `_mainnetBidsUnder`, `_sweepBidsDownTo`, `_coveredLong`, `_expectNoFill` (2 copies each).
- They live across `test/audit/SA{1,2,3}Audit.t.sol`, `test/unit/CoverManagerIntegration.t.sol`, `CoverManagerBase.t.sol` and `test/invariant/handlers/HandlerBase.sol`.
- Hoist them into `GaplessFixture`, with `uint256 constant MS_PER_BLOCK = 300` (or similar) replacing the inline formula, so a timing change cannot drift between suites.

**SF-13 `test/invariant/GaplessOptimization.t.sol:15-21`:** the optimization-mode invariants return `int256` and therefore cannot fail ([Foundry invariant docs](https://getfoundry.sh/forge/invariant-testing)). C5 and C6 results report "O1 best 0, O2 best 0" as a pass, but nothing gates it. Either say "reported, not asserted" in `docs/C5_FIXES.md`, or rely only on the asserting `invariant_O1_attackerPnL` / `check_I4_O2_blockCap` in `GaplessInvariant.t.sol`, which already exist.

## Nit

- **`isLocked` (`CoverManager.sol:120`):** stays true for a Triggered cover after its window while `owedCNS > 0`. The trader cannot trade that perp until a `finalize` clears the owed amount, which normally happens the next block under the per-block cap. Behavior change, so not for this freeze; consider `Triggered && block <= triggerBlock + windowBlocks` in v2.
- **`CoverManager.sol:56-57`:** `F_SIGMA_POST = 33` stays local, while C6 added `F_FLOOR_SLACK_VS_SLIP = 34` to Constants. Move it (CR5) and keep `uint8 public constant F_SIGMA_POST = Constants.F_SIGMA_POST;` so the getter ABI is unchanged. The comment "no F_* constant exists" is then stale.
- **`CoverManager.sol:1026-1066`:** `_watchKind` and `_houseKind` return magic `uint8` kinds 1 to 4. Use an internal enum (no ABI impact).
- **`CoverManager.sol:526-527`:** the bare `cp.lots.toUint40(); cp.stopPNS.toUint32();` reads like dead code. Add `// quote reverts like openCover on overflow`.
- **`CoverManager.sol:373`:** `observe` on an already-observed cover reverts `BadStatus(id, Triggered)`, which is confusing for the keeper. `ConditionNotMet` would read better. ABI-neutral: the error is already declared.
- **`src/types/GaplessTypes.sol:7`:** the state-machine `@dev` omits Armed -> Expired | Voided.
- **`src/libraries/ReferenceLib.sol:22-24, 66-69`:** the CRE source branch and `Sources.cre*` are unreachable while `listMarket` rejects `creRefStore != 0` (`CoverManager.sol:1080`), and `CRE_REF_MAX_DEVIATION_BPS` is used only there. Add a one-line "unreachable until a store interface is frozen" note, or drop it in v2.
- **`GaplessAccount.sol:437-440`:** `_extension` with a nonzero builder id is unreachable on the canary (`BUILDER_ID` 0); it is the only uncovered src code in C6. A comment is enough.
- **`src/Constants.sol`:** these constants are referenced nowhere in src, script or tests:
  - `PERPL_OWNER_SAFE`, `FEED_ETH_USD`, `FEED_MON_USD`, `CRE_FORWARDER_PROD`, `PERP_MON`, `PERP_ETH`, `PERPL_MAX_MATCHES`
  - `USER_TTL_BLOCKS`, `USER_MAX_MATCHES`, `PERPL_NATIVE_STOP_SLIPPAGE_BPS`, `AUSD_EIP712_VERSION`, `SIGMA_BPS_E2_STRESSED`
  - `OPERATOR_EXPIRY_DEFAULT_SEC`, `OPERATOR_MAX_NOTIONAL_DEFAULT_CNS`, `OPERATOR_MAX_NOTIONAL_PER_DAY_DEFAULT_CNS`

  Library constants cost no bytecode but are invisible to the ABI, so offchain code cannot read them. Group them under `// Offchain reference values (not read onchain)`. Line 40's comment "0 or above is replaced by 1000" is garbled; it should read "0 or above 1000 means 1000".
- **`src/cre/GaplessCreSink.sol:43-45`:** `triggered` counts every non-reverting `trigger` call, including disarms and `TriggerNoFill`. Rename it in NatSpec ("trigger calls that did not revert") so the indexer does not read it as fills.
- **`src/cre/GaplessCreReceiver.sol:60-68`:** an unknown `kind` is accepted under the seconds window. This is harmless for the simulation sink; document it, or return early for `kind == 0 || kind > 3`.
- **`src/interfaces/IGaplessInherited.sol:16`:** "all four contracts" should be five (manager, vault, account, factory, CRE receiver).
- **Line length and formatting:**
  - These lines exceed `line_length = 120`: `Constants.sol:83, 88, 95, 116`, `CoverManager.sol:56, 1007`, `ICoverManager.sol:172`, `ICoverVault.sol:24`, `IGaplessAccount.sol:56, 82, 95`, `IGaplessFactory.sol:25`, `PremiumMath.sol:86`.
  - `forge fmt` with flag:check reports diffs in 27 files across src, script and test.
  - Running `forge fmt` before the freeze is whitespace-only, so bytecode is identical; add the check to CI.
- **NatSpec length:**
  - `ICoverManager.trigger` (7 lines), `ICoverVault` header (10) and `IGaplessCreSink` header (8) exceed the 3-line guidance for doc comments.
  - The rule text belongs in INTERFACES section 4. NatSpec can keep the one-line rule plus the finding id.
- **Test comments:**
  - `test/audit/SA3Audit.t.sol:180-181` still describes the pre-fix behavior ("walks the chain to floorSlack") above tests that now assert the opposite.
  - The SA3 tests assert `shortSteps` / `shortBlock` directly. A behavior-level assertion on the `TriggerNoFill` limit would survive a storage refactor.
- **Root `.gas-snapshot-s1`:** an S1-era artifact next to `audit/.gas-snapshot`. Delete it, or move it under `audit/`.
- **`INTERFACES.md:352`:** "62 conformance tests". Re-count after the C4 mock changes.

## Doc agreement summary (INTERFACES vs CHANGE_REQUESTS vs CANARY_PARAMS)

| Item | INTERFACES | CHANGE_REQUESTS | CANARY_PARAMS / scripts | Code | Agree? |
|:-|:-|:-|:-|:-|:-|
| maxCoverNotionalCNS | 50e6 "canary" (s6), 20e6 (s3) | | 20e6 | default 50e6, ListMarket 20e6 | No: s6 wording |
| marketCapBps canary | 10,000 (s3) | | 10,000 | ListMarket 10,000 | Yes |
| Seed vault | 1 + 3 AUSD | | 4 AUSD | Deploy 1e6, ListMarket 3e6 | Yes |
| Sigma first post | 27 | | 27 | `SIGMA_BPS_E2_CALM` 27 | Yes |
| Invariant profiles | 64 x 200 default | CR16 64 x 200 | | foundry.toml 64 x 200 | Yes (README no) |
| F_34 floorSlack >= 2A | yes | CR31 | | `_checkParams` | Yes |
| Operator decay on grant change | current rate (pre-C6) | CR32 checkpoint | | checkpoint | No: INTERFACES:146 |
| PremiumMath rounding | ceil | CR6 floor | | floor | No: INTERFACES s7 |
| CR status | | "nothing applied" | | CR1, CR3, CR5, CR6 open | No |
| ABI after C6 | unchanged | unchanged | | `abi/` equals `out/` | Yes |
