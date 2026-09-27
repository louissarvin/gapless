# Gapless contracts: independent test verification (2026-10-05)

Foundry 1.8.3 (cae51ad), solc 0.8.37, `evm_version = osaka`, `network = monad`. Read-only on `src/` (SHA-1 of every src file identical before and after). No forks, no transactions. Raw logs were kept in `/tmp/gl_audit/` (not committed).

## Verdict

| Area | Result |
|:-|:-|
| Build | Clean. 0 warnings in `src/`; 2 in tests. All contracts far under 128 KB |
| `forge test` (default) x3 | 385/385 pass each run, 0 skipped, about 18 to 23 s |
| Alternate fuzz seeds (0x1, 0xdeadbeef, 0x5eed2026) | 385/385 each. No flaky test found |
| `FOUNDRY_PROFILE=ci forge test` | 385/385 pass, 20 s |
| `forge test --isolate` (non-invariant) | 381/381 pass |
| Coverage (src) | Lines 99.6 to 100%, branches 85.7 to 100%, functions 100%. 15 uncovered branch points, 3 with real security weight |
| Invariants at 256 x 500 | All 10 pass (128,000 calls); optimization O1/O2 best 0. Depth-500 soak of 1.13M calls (more than `long`) passes. `FOUNDRY_PROFILE=long` silently runs 64 x 200 (config bug) |
| Gas vs spec budgets | Pass on shallow books. `trigger` and `arm` exceed budget on deep mock books (mock is O(n)); needs Perpl measurement |
| Slither 0.11.6 | 109 results, 0 real vulnerabilities. 2 "High" are false positives |
| Backend | `check-abi` in sync, `typecheck` clean, `bun test` 375/375 |

## 1. Build and sizes

`forge build --sizes --force`: 136 files, compiled in 14 s. Limits: 131,072 B runtime, 262,144 B initcode (`network = monad`).

| Contract | Runtime B | Initcode B | Runtime margin B |
|:-|-:|-:|-:|
| CoverManager | 42,655 | 43,497 | 88,417 |
| GaplessAccount | 15,246 | 16,735 | 115,826 |
| CoverVault | 14,266 | 17,756 | 116,806 |
| GaplessFactory | 4,077 | 22,178 | 126,995 |
| GaplessCreSink | 2,291 | 2,600 | 128,781 |

Libraries are internal (inlined); no linked library deployments.

Compiler warnings (none in `src/` or `script/`):
- `test/invariant/handlers/HandlerBase.sol:86` (6335): identifier `at` will become a keyword. Rename before a solc upgrade.
- `test/fuzz/Payout.t.sol:23` (2018): `_bound` can be `pure`.

## 2. Test runs

| Run | Suites | Passed | Failed | Skipped | Wall |
|:-|-:|-:|-:|-:|-:|
| default #1 | 26 | 385 | 0 | 0 | 22.7 s |
| default #2 | 26 | 385 | 0 | 0 | 18.3 s |
| default #3 | 26 | 385 | 0 | 0 | 18.4 s |
| default, `--fuzz-seed 0x1` | 26 | 385 | 0 | 0 | 15.0 s |
| default, `--fuzz-seed 0xdeadbeef` | 26 | 385 | 0 | 0 | 15.6 s |
| default, `--fuzz-seed 0x5eed2026` | 26 | 385 | 0 | 0 | 17.0 s |
| `ci` (fuzz 1024) | 26 | 385 | 0 | 0 | 20.2 s |
| `--isolate`, invariants excluded | 23 | 381 | 0 | 0 | 3.8 s |

Flakiness: the fuzz seed is pinned in `foundry.toml` (`0x6761706c657373`), so three default runs are deterministic by construction. The three alternate seeds are the real flakiness probe; all green. The suite does not depend on wall-clock or ordering.

Per-suite counts (unchanged across runs): CoverManager 63, GaplessAccount 82, CoverVault 41, MockPerplExchange 39, GaplessFactory 21, CoverManagerAttack 16, PremiumMath 14, GaplessCreSink 13, GaplessAccountAttacks 12, MockAUSD 11, PayoutMath 10, ReferenceLib 9, Payout fuzz 8, VaultInflation 7, Deploy 6, FrozenSurface 6, Quote fuzz 5, CoverManagerGas 5, CoverManagerIntegration 4, MockFeed 4, Params fuzz 2, PerplSelectors 2, GaplessOptimization 2, ManagerStubSelectors 1, ScenarioCoverage 1, GaplessInvariant 1 (10 invariants in one campaign).

Slow tests (over 5 s wall): `GaplessInvariantTest` (about 20 s), `GaplessOptimizationTest` (about 22 s), `VaultInflationTest` (5.2 s default, 11 s under `ci`). `CoverManagerTest` shows 10 s wall on 0.37 s CPU (scheduler wait, not test cost).

Tests that cannot fail (no assertion): `CoverManagerGasTest.test_gas_trigger32Levels` and `test_gas_openCover` only log gas. The first is the one case over the trigger budget, so the overrun is visible only in logs. `ParamsFuzzTest.test_allFieldsCovered` delegates to an asserting fuzz body and is fine.

Note: S1_NOTES says 374 tests for the full repo; the count is now 385 (S2 suites landed after).

## 3. Coverage

`forge coverage --report summary --report lcov`. No `--ir-minimum` needed: the default (optimizer off, no via-IR) compiled without stack-too-deep. All 385 tests pass under coverage.

| File | Lines | Statements | Branches | Functions |
|:-|-:|-:|-:|-:|
| src/CoverManager.sol | 99.61% (514/516) | 98.77% (722/731) | 94.57% (122/129) | 100% (68/68) |
| src/CoverVault.sol | 100% (173/173) | 99.02% (202/204) | 93.75% (30/32) | 100% (38/38) |
| src/GaplessAccount.sol | 99.48% (192/193) | 98.03% (249/254) | 92.86% (39/42) | 100% (33/33) |
| src/GaplessFactory.sol | 100% (31/31) | 97.50% (39/40) | 85.71% (6/7) | 100% (7/7) |
| src/cre/GaplessCreReceiver.sol | 100% (18/18) | 100% (24/24) | 100% (4/4) | 100% (5/5) |
| src/cre/GaplessCreSink.sol | 100% (14/14) | 100% (24/24) | 100% (4/4) | 100% (2/2) |
| src/libraries/PayoutMath.sol | 100% (32/32) | 100% (47/47) | 100% (6/6) | 100% (6/6) |
| src/libraries/PremiumMath.sol | 100% (54/54) | 100% (87/87) | 100% (9/9) | 100% (12/12) |
| src/libraries/ReferenceLib.sol | 100% (34/34) | 100% (68/68) | 100% (12/12) | 100% (5/5) |
| src/Constants.sol | 100% (34/34) | 100% (31/31) | n/a | 100% (3/3) |
| script/Deploy.s.sol | 100% (45/45) | 100% (43/43) | 62.07% (18/29) | 100% (5/5) |
| script/ListMarket.s.sol | 91.67% (33/36) | 94.44% (34/36) | 51.72% (15/29) | 75% (3/4) |

### Uncovered branches in src (from lcov, BRDA taken = 0)

Libraries: none. Every branch in PayoutMath, PremiumMath and ReferenceLib is hit.

| # | Location | Branch never taken | Reachable? | Security weight |
|:-|:-|:-|:-|:-|
| U1 | CoverManager.sol:725-730 (`_markThrough`) | `mark == 0` or stale mark returns false | Yes: Live cover, fast path, mark through the stop but stale or zero | **High.** This is the I9 gate that stops a stale mark from triggering a Live cover in one block. Code reads correctly; no test proves it. `test_trigger_live_requiresFastPath` only uses a fresh mark above the stop |
| U2 | CoverManager.sol:547 (`_triggerRemainder`) | `pos.lotLNS == 0 || _flipped` reverts `ConditionNotMet` | Yes: partial fill, then liquidation or ADL inside the remainder window | **Medium.** Guards a remainder close against a vanished or flipped position. Without it the manager would rely on the account's own side and size checks (the real account returns a zero result, so `_close` emits `TriggerNoFill`); the manager-side revert is untested |
| U3 | CoverManager.sol:266 (`syncCover`) | `status == Triggered` returns early | Not through the real account (`trade` reverts `PerpLocked` first), yes through any account that calls `syncCover` directly | **Medium (defense in depth).** If missing, a reduce during the remainder window could void or resize a Triggered cover. Easy test with `AccountStub` |
| U4 | CoverManager.sol:807-808 (`_watchKind`) | Live cover inside warm-up returns 0; Live fast-path candidate returns 2 | Yes | Low for funds, medium for liveness: `watchList` is how the keeper finds Live fast-path triggers. Never asserted |
| U5 | CoverManager.sol:836-837 (`_scanWindow`) | Rotation when more than 512 live covers | Yes, under cover spam | Low (views only). The rotation `(block * 512) % len` reaches every cover since windows start on multiples of `gcd(512, len) <= 512`, but no test proves it |
| U6 | CoverManager.sol:763 (`_position`) | `perplAccountId == 0` returns an empty position | Account without Perpl activation | Low; result is "no position", which every caller treats as such |
| U7 | CoverManager.sol:830 (`_houseKind`) | Status neither Live nor Armed | No: the live set only holds Live, Armed, Triggered, and Triggered returns earlier | None (defensive) |
| U8 | GaplessAccount.sol:292 (`_fundPremium`) | Wallet still short after `withdrawCollateral` | Only with a misbehaving Perpl | Low (defensive) |
| U9 | GaplessAccount.sol:318 (`_sweep`) | `createAccount` returns id 0 | Only with a misbehaving Perpl | Low (defensive) |
| U10 | GaplessAccount.sol:369 (`_extension`) | Builder extension encoding | No while `Constants.BUILDER_ID = 0` | Low now; untested encoding goes live if the builder ID is ever set. Add a test before enabling |
| U11 | GaplessAccount.sol:74 (`initialize`) | `owner_ == 0` | No: factory rejects owner 0 (line 61) and `msg.sender` is never 0 | None |
| U12 | GaplessFactory.sol:84 (`_create`) | `owner == 0` | No (same reason) | None |
| U13 | CoverVault.sol:70 (constructor) | `ausd == 0` | Deploy-time only | Low |
| U14 | CoverVault.sol:328 (`_deposit`) | `shares == 0` | Practically no: `minDepositCNS` and the 6-decimal offset keep shares above 0 | Low (defensive) |

Recommended tests, in order: U1 (stale mark and zero mark through the stop, Live, past warm-up: expect `ConditionNotMet`, and `watchList` returns nothing), U2 (partial fill, liquidate, `trigger` again: expect `ConditionNotMet`), U3 (`AccountStub` calls `syncCover` on a Triggered cover after reducing: expect no state change), U4 and U5 (`watchList` over 513+ covers returns each id across blocks).

## 4. Invariants at a larger profile

Inline config pins `default` and `ci` to 64 x 200 in both invariant contracts, and non-default profiles inherit those pins (env vars such as `FOUNDRY_INVARIANT_DEPTH` do not override inline config; verified: a `long` profile run with env overrides still ran depth 200). To run a real 256 x 500 without editing the repo, the project was copied to `/tmp`, the `forge-config:` lines were stripped, and `lib/` was symlinked. `src/` and the handlers are byte-identical to the repo.

| Campaign | Runs x depth | Calls | Time | Result |
|:-|:-|-:|-:|:-|
| GaplessInvariantTest, repo, `long` + `FOUNDRY_INVARIANT_TIMEOUT=420` | 8,876 x 200 (time-boxed) | 1,775,200 | 420 s | 10/10 pass |
| GaplessInvariantTest, scratch, profile default | 256 x 500 | 128,000 | 295 s | 10/10 pass |
| GaplessOptimizationTest, scratch, profile default | 256 x 500 | 128,000 | 70 s | O1 best 0, O2 best 0 (no profitable episode, no block over cap) |
| GaplessInvariantTest, scratch, depth 500, `--fuzz-seed 0x1`, timeout 420 s (stands in for `long`) | 2,263 x 500 (time-boxed) | 1,131,500 | 420 s | 10/10 pass |

The last row exceeds the `long` profile target (2,048 x 500 = 1,024,000 calls), so a second chunk was not needed. Seed 0x1 differs from the pinned seed, so it also explores new sequences.

All ten invariants passed in every campaign: I1 solvency, I2 payout bound, I3 single active, I4/O2 block cap, I5 manager custody, I7 reserves, I11 isolation, I13 escrow floor, handler checks (I3 transitions, I4 at finalize, I6, I8, I9, I10, I12), O1 attacker PnL.

Last-run stats (256 x 500): 23 covers, 6 triggers, 6 finalizes, 16 attack episodes (5 triggered), attacker protocol PnL -323,258 CNS, best MTM episode -23,490 CNS, max single-block payout 792,892 CNS. Buy reverts seen: `StopTooClose` 4, `VenueUnavailable` 2, `MarkStale` 1, `LiquidationBufferTooThin` 1.

Observations:
- Setting `invariant.timeout` makes Foundry ignore `runs` and loop until the timeout. Use it for time-boxed soak runs, not for an exact runs x depth.
- Both time-boxed runs skewed toward one selector: `TraderHandler.reduce` took 695,626 of 1,775,200 calls (39%, others about 32,000 each), and in the seed 0x1 run `AdminHandler.postSigma` took 690,232 of 1,131,500 (61%, others about 13,000 each). Fixed-run campaigns were uniform (about 3,600 each at 256 x 500). Soak runs therefore exercise less variety than their call count suggests; the seed 0x1 soak gave every other selector about 13,000 calls, about 3.5 times the 256 x 500 run.
- In the time-boxed run the last run's "attacker best MTM episode" was +25,408,717 CNS. Per S2_NOTES this mark-to-market includes trades against the harness market maker's stale quotes and is reported, not asserted; the asserted vault-side O1 stayed at or below 0.

## 5. Gas vs spec budgets

`forge snapshot --snap audit/.gas-snapshot` (393 entries; per-test totals). Per-function numbers come from the `CoverManagerGas` logs (`gasleft` deltas inside the test) and from `forge test --isolate --gas-report` (each call is its own transaction, so intrinsic gas and cold storage are included). `CoverManagerGas` uses `AccountStub`; the e2e row uses the real `GaplessAccount`.

| Function | Budget | gasleft (1 level) | Isolated tx (1 level) | Isolated, real account e2e | Isolated, worst seen | Status |
|:-|-:|-:|-:|-:|-:|:-|
| arm | 300,000 | 216,788 | 215,720 | 251,790 | 581,760 (A6, 41 resting orders) | Pass at 1 to 8 levels (278,377 at 8). Over at 25+ levels in the mock |
| trigger | 1,500,000 | 675,974 | 674,940 | 660,487 | 2,719,622 (A6, 32 matches) | Pass at 1 and 8 levels (1,006,729). Over at 25 levels (1,979,376) and 32 matches |
| observe | 250,000 | 146,825 | 136,314 | 162,408 | 162,408 | Pass |
| finalize | 600,000 | 223,797 | 223,320 | 459,407 | 459,407 | Pass (77% at max) |
| expire | 400,000 | 216,140 | 215,667 | n/a | 215,707 | Pass |
| voidCover | 400,000 | 257,610 | 247,137 | n/a | 266,692 | Pass |
| postSigma | 80,000 | 52,630 | 68,580 | n/a | 68,580 | Pass (86% of budget as a tx) |

Reading:
- The mock book is an array: `getPerpetualInfo` and matching are O(n) in resting orders. That is why `arm` (no matching of its own) grows with book depth. Perpl numbers will differ; the 1.5M `trigger` budget at `maxMatchesClose = 32` must be measured on Perpl (S2 open risk 1 still stands).
- A6 split: of 2,720,099 trigger gas, 1,842,514 is the close call and 877,585 is outside it. At one level the outside part is about 510K. So the manager alone uses about a third of the trigger budget before the venue walk. If Perpl costs more than about 30K per match, 32 matches will not fit; plan to lower `maxMatchesClose` toward 16.
- Monad charges the gas limit, not gas used, so keeper limits should sit near these numbers plus margin, not at the budget ceiling.
- Snapshot diff against `.gas-snapshot-s1`: only fuzz-test drift (input-dependent), no regression in deterministic tests.

## 6. Static analysis

- aderyn 0.1.9 (already in `~/.cargo/bin`) fails: `Unknown evm version: osaka`. Not upgraded.
- slither 0.11.6 installed into a throwaway venv at `/tmp/gl_audit/venv` (nothing system-wide). Run on the scratch copy because slither calls `forge clean`. Filtered `lib/`, `test/`, `script/`. 68 contracts, 102 detectors, 109 results.

| Impact | Detector | Count | Verdict |
|:-|:-|-:|:-|
| High | arbitrary-send-erc20 (`CoverManager.openCover`, line 256) | 1 | False positive: `_onlyAccount(account)` requires `msg.sender == account` and a factory clone |
| High | arbitrary-send-erc20-permit (`GaplessAccount.depositWithPermit`, line 99) | 1 | Not theft: pulls only from `owner` into the owner's own clone. Known open risk (S1_NOTES: standing allowance lets anyone push the owner's AUSD into the owner's account and Perpl) |
| Medium | reentrancy-no-eth | 6 | Noise: every mutator is `nonReentrant` (transient); external callees are Perpl, the vault, AUSD and the clone. Cross-function hits are views (`getCover`, `isLocked`, `watchList`, `housekeeping`) |
| Medium | unused-return | 14 | Intentional: `execOrder` result is re-measured from position reads (measure, not trust); `toUint40/32` used as range checks; `EnumerableSet.add/remove` guarded by `_active` |
| Medium | incorrect-equality | 7 | Intentional zero checks (`filledLots == 0`, `n == 0`, `ta == 0`) |
| Medium | uninitialized-local | 7 | Counters relying on zero init |
| Medium | divide-before-multiply | 2 | Intentional: `closeLimitPNS` double floor is the spec formula (S2_NOTES 1); `_fundingShare` uses `f * den != num` to floor toward negative infinity |
| Low | timestamp 16, reentrancy-events 5, calls-loop 4 | 25 | Expected (freshness windows; events after Perpl calls; bounded loops: sink max 3 arm and 3 trigger, views max 512) |
| Info | naming 38, unindexed-event-address 5, assembly 1, complexity 1, dead-code 1 | 46 | Style. dead-code on `CoverVault._deposit` is a false positive (ERC4626 override) |

Real findings: none.

## 7. Backend

`script/export-abi.sh` (runs `forge build`, writes `abi/` only) produced 9 ABIs byte-identical to the previous `abi/` (`diff -r` empty).

| Command | Result |
|:-|:-|
| `bun run check-abi` | "ABIs in sync", exit 0 |
| `bun run typecheck` (`tsc --noEmit`) | exit 0, no errors |
| `bun test` (bun 1.3.1) | 375 pass, 0 fail, 1,346 expects, 24 files, 13.1 s |

## 8. Recommendations

1. Add tests for U1 (stale or zero mark on the Live fast path), U2 (remainder after liquidation) and U3 (`syncCover` on Triggered). U1 is the only gap on a safety gate.
2. Measure `trigger` and `arm` on Perpl before setting keeper gas limits; be ready to drop `maxMatchesClose` to 16.
3. Add a `watchList` test for Live fast-path candidates and for more than 512 live covers.
4. Before enabling a builder ID, test `_extension()` encoding against Perpl's V2 format.
5. Rename `at` in `HandlerBase.sol:86`; mark `_bound` in `Payout.t.sol` as `pure`.
6. `FOUNDRY_PROFILE=long` does not run 2048 x 500. Verified: it ran `GaplessOptimizationTest` at 64 runs x 12,800 calls, because the inline `default.*` pins carry into every profile. The planned pre-freeze long run (BUILD_PLAN 5) would silently be a default run. Fix: add `long.invariant.runs/depth` inline lines to both contracts, or move the 64 x 200 pins into `[profile.default.invariant]` in `foundry.toml`.
