# C5: fixes for audit SA2 (2026-10-05)

Scope: every finding in `audit/SA2_REPORT.md` plus the L-03 remainder and L-09. One mainnet deploy (address freeze), so everything is fixed before deploy, not before raising caps. Interface changes: CR20 to CR28 in `CHANGE_REQUESTS.md`; INTERFACES.md amended; mechanism addendum in `gapless/05` section 10; canary sizing in `docs/CANARY_PARAMS.md`.

Toolchain unchanged: Foundry 1.8.3, solc 0.8.37, OZ 5.6.1 (`SafeCast.toUint8/toUint16`, `pendingDefaultAdmin` read from the pinned source), `ReentrancyGuardTransient`, `SafeERC20`, CEI. No forks, no transactions.

## Finding to fix to test

| ID | Fix | Where | Regression tests |
|:-|:-|:-|:-|
| N-01 | Close floor is a chain of steps. Step 0 is `R x (1 - A)`. Step k >= 1 is `min(stop, R) x (1 - min(floorSlack, A x 2^k))` (short: max, ceil). k counts consecutive earlier attempts that came up short with the fresh reference through the stop (remainder: R_trig too), each at most `SHORT_CHAIN_MAX_GAP_BLOCKS` (3) after the previous. Every executed attempt rewrites the chain: a full fill or an attempt with R above the stop ends it; a same-block retry reuses its step and keeps it (a third party cannot reset it by double-calling). `arm`, `_disarm` and a lapsed arm clear it; a lapsed arm on the fast path now disarms first (`Disarmed(ArmTtlElapsed)`), then closes at step 0 | `CoverManager.trigger`, `_close`, `_step`, `_chain`, `_resetChain`, `_closeLimit`, `_allowanceBps`, `_triggerRemainder`; `Cover.shortBlock`, `shortSteps` | `SA2Audit: test_N01_staleShortBlock_doesNotWidenLaterTouch` (SA2 scenario: tight, hunter bid unfilled), `test_N01_chainExpiresAfterGap`, `test_N01_armTtlLapse_clearsChain`, `test_N01_armTtlLapse_noFastPath_disarmsAndClears`, `test_N01_control_withoutEarlierEpisode_tightFloorHolds`; `CoverManager: test_N01_stepsCapAtFloorSlack`, `test_N01_steps_shortSide`, `test_N01_remainderChain`, `test_trigger_noFill_staysArmed_thenFills` |
| N-05 / I14 | I14 no longer reads `shortBlock`. Every handler arm and trigger goes through `HandlerBase._armTracked` / `_triggerTracked`, which rebuild the chain from observed outcomes (events, fills, position) and book the allowance the spec grants each fill; I14 asserts `G_realCum <= paid + owed + G_ref + sum(allowance_i) + rounding`. New handler `KeeperHandler.touchRecoverTouch` interleaves a no-fill touch, an optional recovery, a gap of 1 to 1,500 blocks and a later touch with a resting order a tick inside the widest floor, then retries | `test/invariant/**` | Mutation checks: removing the gap bound fails I14 in the scenario sweep and at run 1 of the campaign; jumping straight to floorSlack fails I14 and two SA2 tests. `ScenarioCoverage` asserts relapses > 5 and stepped fills > 0 |
| N-02 | Past `expiryBlock` every end path is an expiry: `expire`, `cancelCover` (Live or Armed), `syncCover`, `voidCover` end as `Expired` and refund the escrow unless the cover was ever armed. No prices, sigma, params or Perpl reads, so the outcome is independent of caller and timing. Before expiry the zone rule (cancel, owner close or shrink, void) uses the cover's purchase-time `minDistanceBps` (snapshot) against the least favorable fresh reference. `isLocked` is false for an Armed cover past expiry | `CoverManager._end`, `cancelCover`, `syncCover`, `voidCover`, `_escrowRefundable`, `isLocked`; `Cover.minDistanceBps` | `SA2Audit: test_N02_expiryRefund_independentOfCallTimeInputs` (SA2 branches A to D: prompt, late in the zone, sigma 2000 plus minStopDistance 500, owner cancel after expiry all refund identically), `test_N02_armedEver_forfeitsAtExpiry_viaCancelToo`, `test_N02_cancelBeforeExpiry_usesPurchaseMinDistance`; `CoverManager: test_N02_expire_staleRefs_refunds`, `test_M03_cancel_staleRefs_forfeits`, `test_N02_syncAfterExpiry_isExpiry`, `test_N02_voidAfterExpiry_isExpiry` |
| N-03 | `OperatorGrant.maxNotionalPerDayCNS`: leaky bucket refilling over `OPERATOR_WINDOW_SEC` (1 day). Every operator order except types 4 and 5 (closes included) is charged `lots x max(limit, mark) x scale`; operator `buyCover` and `tradeAndCover` are charged the cover notional; `OperatorBudgetExceeded(notional, available)`. 0 blocks operator trades and buys. Usage survives grant changes; the owner is never charged. Signed in both typed-data structs | `GaplessAccount._checkOperator`, `_chargeOperator`, `_opUsed`, `operatorUsage`, `_buyCover`; `GaplessFactory`; `Constants` typehashes | `SA2Audit: test_N03_operatorRoundTrips_boundedByBudget` (SA2 colluder: 2 round trips then `OperatorBudgetExceeded`, drain under 2 AUSD of a 40 AUSD budget instead of 18.71, refills after a day), `test_N03_operatorBuyCharged_ownerFree`; `GaplessAccount: test_N03_budget_*` (4); `GaplessFactory: test_createAccountFor_tamperedGrant` |
| N-04 | Documented precisely (INTERFACES section 4, `gapless/05` section 10). Cheap mitigation implemented: a short attempt starts or extends a chain only if the median reference itself is through the stop (not only the mark or the book), and the stepped floor makes the forced fallback cost 5 consecutive blocks of an empty book to reach floorSlack | as N-01 | `SA2Audit: test_N04_steppedFloor_needsFiveBlocksOfEmptyBook` (limits 5, 10, 20, 40, 80 bps, fill only at step 5), `test_N04_shortWithRefAboveStop_doesNotStartChain` |
| N-06 | CRE seen-set keyed on `keccak256(abi.encode(decoded fields))` | `GaplessCreReceiver.onReport` | `SA2Audit: test_N06_creSeenSet_trailingBytesDoNotReplay` (1 and 32 trailing bytes: processed once) |
| N-07 | Canary sizing computed and pinned | `docs/CANARY_PARAMS.md`, `script/ListMarket.s.sol` | `SA2Audit: test_N07_canarySizing_boundary`; `ListMarketScript: test_threeSessions_canaryDefaults`, `test_canaryParamsWithinBounds` |
| N-08 Perpl view | `cancelCover`, `syncCover` refund checks and `housekeeping` read Perpl through `_marketSoft` (a reverting `getPerpetualInfo` drops mark and oracle; the feed alone can still prove distance); `voidCover` reverts `VenueUnavailable` when the position view reverts; `expire` and every post-expiry path read no Perpl state | `CoverManager._marketSoft`, `_tryPosition`, `_houseKind` | `SA2Audit: test_N08_perplViewRevert_endPathsDoNotBrick` |
| N-08 Deploy | `_check` asserts the pending default admin on the manager as well as the vault | `script/Deploy.s.sol` | `Deploy: test_splitRoles` (runs `_check`) |
| N-08 ListMarket | Three sessions: `run()` (RISK_ADMIN lists), `postSigma()` (keeper), `seed()` (LP key; reverts if it holds RISK_ADMIN_ROLE). Canary env defaults | `script/ListMarket.s.sol` | `ListMarketScript: test_threeSessions_canaryDefaults`, `test_run_requiresRiskAdmin`; `CoverManagerIntegration: test_listMarketScript` (RISK_ADMIN holds no shares) |
| L-03 remainder | `warmupBlocks`, `windowBlocks` and the refund-zone `minDistanceBps` snapshotted per cover (slot 5 now full) | `CoverManager.openCover`, `arm`, `_fastPath`, `observe`, `finalize`, `_triggerRemainder`, `_watchKind`, `_houseKind` | `CoverManager: test_L03_warmupAndWindowSnapshotted`; `AdminHandler.setParams` fuzzes warmup |
| L-09 | Rent floor of `minFeeCNS` per started 12,000 blocks (`PremiumMath.rentFloorCNS`, applied in `quote`) | `PremiumMath` | `PremiumMath: test_rentFloor_perStartedPeriod`; `CoverManager: test_L09_rentFloorScalesWithDuration` |

## L-03: parameters still read live, and why each is safe

| Param | Used for | Why live is safe |
|:-|:-|:-|
| `refTolBps` | Armed re-check keeps an armed cover alive while R is within tol above the stop | Only decides disarm vs close at `R x (1 - A)`; the payout bound and the step-0 floor do not use it. Lowering it disarms earlier (fast path still fires); raising it closes at `R x (1 - A)` above the stop with payout <= A x SN <= escrow |
| `armTtlBlocks` | Arm lifetime and the trade lock | Liveness only, bounded [10, 400]; a lapsed arm can re-arm on a genuine touch, the fast path never needs an arm |
| `exclusiveBlocks` | Armer-only window | Gas-race preference only, bounded [0, 10], never reaches expiry (L-02), never applies to the fast path |
| `perBlockPayoutCapBps` | Per-block payout cap | Changes timing only: the shortfall is owed, reserved and paid at finalize; entitlement is fixed by the snapshotted A and the fills |
| `maxMatchesClose` | Matches per close call | Changes how many calls a close takes, not any floor or payout; bounded [8, 200]. Keep at 16 (trigger 1.42M gas on the mock) until Perpl gas is measured |
| `refFreshSec`, `feedMaxAgeSec` | Which references count as fresh | Oracle hygiene must apply market-wide (an emergency tightening must reach live covers). Bounded below (10 s, 30 s). Residual: a malicious RISK_ADMIN could make every source stale between arm and trigger and force the D49 outage close; RISK_ADMIN is trusted and should be the admin multisig before caps rise |
| `marketCapBps`, `maxCoverNotionalCNS`, pricing tables, durations, `sigmaMaxAgeBlocks`, `maxLossToDepositBps`, `maxGapBpsCap` | Quote and reserve only | Never read for a live cover |

## L-09: decision

Picked the rent floor, not a per-account or per-owner bound. Accounts are one per owner EOA and owners are free, so any per-account bound costs a sybil nothing beyond capital it gets back. Rent is the only cost that scales with capacity held over time, but the old floor was per cover, so a 4 h pinning cover paid the same 0.02 AUSD as a 1 h cover. With `minFeeCNS` per started 12,000 blocks, holding one cover slot costs at least 0.02 AUSD per hour, and the 10% share cap means pinning a market takes at least 10 slots: 4.8 AUSD per day at the canary (a 4 AUSD vault, so 120% of the vault per day, paid to LPs), and at SA1's 10,000 AUSD vault (125 slots at the 2,000 AUSD notional cap) 60 AUSD per day plus the raw rent, about 4x SA1's 15 AUSD per day. A default 1 h cover pays exactly what it paid before. `rentCNS` is unchanged, so the 400 parity vectors with backend `premium.ts` still pass; backend `quote()` must add the floor for durations over 12,000 (CR25).

## Invariants

- I14 tightened (N-05): per-fill allowance from the handlers' independent chain model; a stale or foreign `shortBlock` earns nothing.
- New scenario `touchRecoverTouch` (same touch at 1 to 3 blocks, new touch at up to 1,500 blocks) in the campaign and in `ScenarioCoverage` (now 72 rounds).
- `AdminHandler.setParams` also moves `warmupBlocks` (L-03 snapshot exercised).

## Results

| Run | Result |
|:-|:-|
| `forge test` (default) | 463 passed, 0 failed (about 42 s) |
| `FOUNDRY_PROFILE=ci forge test` | 463 passed, 0 failed (about 49 s) |
| Invariants 256 x 500 | GaplessInvariantTest: all 12 invariants (I14 tightened) pass over 8 chunks of 32 runs x 500 calls (128,000 calls), `FOUNDRY_PROFILE=deep`, `FOUNDRY_INVARIANT_RUNS=32`, `FOUNDRY_FUZZ_SEED=0x6761706c657373 + k`, four chunks in parallel; each chunk 191 to 245 s. Last-run stats per chunk: 3 to 12 touch-recover-touch scenarios, 1 to 6 fills at a widened step, 6 to 13 stop hunts with hunter PnL -2.4 to -5.6 AUSD, attacker protocol PnL -0.26 to -0.53 AUSD. GaplessOptimizationTest in the same chunks: O1 best 0, O2 best 0 |
| Coverage (src lines) | 99.76% (1,270 / 1,273); CoverManager 99.69%, GaplessAccount 99.55%, every other src file 100%. The three gas-ceiling tests fail only in the unoptimized coverage build (as before C4) |
| Sizes | CoverManager 47,554 B runtime (C4 45,327), GaplessAccount 16,450 B, factory initcode 23,432 B |
| Gas (mock) | trigger at 16 matches 1,419,990 (C4 1,419,255); arm 216,859; expire 217,049 |

## Behavior changes consumers must know

- Keeper: after a `TriggerNoFill` retry every block; the floor widens one step per block (5, 10, 20, 40, 80, 100 bps at defaults) only while the median reference stays through the stop, and a gap of more than 3 blocks restarts at step 0. Worst case per touch: 5 no-fill attempts plus `ceil(lots / 16)` fill calls. An Armed cover whose TTL lapsed now emits `Disarmed(ArmTtlElapsed)` before a fast-path close.
- Keeper and PWA: past expiry, `expire`, `cancelCover`, `voidCover` and any owner trade end the cover as `Expired`; refund unless ever armed. `isLocked` is false past expiry.
- Relay and PWA: `OperatorGrant` has a 4th field and both EIP-712 typehashes include `uint128 maxNotionalPerDay`; new error `OperatorBudgetExceeded`, view `operatorUsage()`.
- Indexer: `OperatorSet` has a 4th field (new topic0); `getCover` has 4 more trailing fields.
- Backend jobs: `premium.ts quote` must add `minFee x ceil(T / 12,000)`.
- Runbook: ListMarket runs in three sessions with three keys (`docs/CANARY_PARAMS.md`); the admin accepts the default admin transfer on both contracts.

## Backend check (no backend edits besides `sync-abi`)

`bun run sync-abi`: 3 ABIs changed. `bun run typecheck`: clean. `bun test`: 412 pass, 33 fail, two root causes, both expected from CR20 to CR22:
- Keeper suites (`test/keeper.test.ts`, 12 failures: C4 keeper cycle, H-1, M-4, keeper cycle): `test/fakeGapless.ts coverStruct()` builds the C4 `Cover` shape; viem cannot encode it against the new ABI (missing `shortSteps`, `minDistanceBps`, `warmupBlocks`, `windowBlocks`). Production `readCovers` decodes by name and is unaffected.
- Sponsor and activate suites (`test/sponsor.test.ts`, 21 failures): `createAccountFor` and `operator()` now take a 4-field grant. This is a production break, not only a fixture: `src/relay/sponsor/eip712.ts` (`CREATE_ACCOUNT_TYPE` and the typed-data types need `uint128 maxNotionalPerDay`), `src/relay/routes/sponsor.ts` (zod `grant` needs `maxNotionalPerDayCNS`), `src/relay/sponsor/service.ts` (passes the grant to `createAccountFor`), and `test/fakeGapless.ts` (operator tuple).

# C6: fixes for audit SA3 (2026-10-06)

Scope: SA3-01, SA3-02 and the cheap Info items of `audit/SA3_REPORT.md`, before the address freeze. **No ABI change**: `script/export-abi.sh` output is byte-identical to the C5 `abi/`, and `forge inspect <c> abi` is identical for CoverManager, GaplessAccount, GaplessFactory, CoverVault, GaplessCreSink and GaplessCreReceiver (checked against a rebuild of the C5 source). CR29 to CR33.

| ID | Fix | Where | Regression tests |
|:-|:-|:-|:-|
| SA3-01 | `arm` reverts `CoverExpired` at `block.number >= expiryBlock`. `trigger` applies `TooEarly` in the arm block only off the fast path. `watchList` lists no arm candidate in the expiry block (a fast-path trigger is still listed) and lists an Armed cover in its arm block as a trigger when the mark is through | `CoverManager.arm`, `trigger`, `_watchKind` | `SA3Audit: test_SA3_01_armInExpiryBlock_rejected_fastPathPays` (inverted: arm reverts, keeper's fast path pays 0.1287 AUSD), `test_SA3_01b_watchListSkipsArmInExpiryBlock` (inverted: candidate at expiry - 1, none at expiry, escrow refunded), `test_SA3_01_fastPathRunsInArmBlock`, `test_SA3_01_slowPathArmBeforeExpiry_firesInExpiryBlock`; `CoverManager: test_expire_fromArmed` now arms at expiry - 1; invariant handler flags any arm at or after `expiryBlock` (I9) |
| SA3-I1 | Fixed by the same `TooEarly` change: a third-party arm still resets the chain (trader-favorable) but no longer costs the fast path its block | as SA3-01 | `test_SA3_I1_armMidTouch_resetsChain_fastPathSameBlock` (inverted) |
| SA3-02 | A short attempt (R through, fill < requested) advances the chain only if, after the close, the closing side has no level at or better than the attempt's limit (`_bookThin`: long best bid < limit or no bids, short best ask > limit or no asks). Otherwise maxMatchesClose ran out on dust or self-matches and the chain is left unchanged (neither stepped nor reset) | `CoverManager._close`, `_bookThin` | `test_SA3_02_dustDoesNotWalkChain` (inverted: five dust rounds leave `shortSteps` 0; the atomic sweep then meets the step-0 floor and fills nothing; a genuinely thin book still steps), `test_SA3_02_matchLimited_leavesRunningChain` (step 2 kept across a dust attempt, then fills at step 2); `CoverManager: test_SA3_02_shortSide_matchLimitedDoesNotStep`; `CoverManagerGas: test_gas_triggerShortAtMaxMatches`; I14 ghost model mirrors the rule (`HandlerBase._chainAfter`) |
| SA3-I3 | Unchanged (trader-favorable, documented in SA3) | | `test_SA3_I3_*` unchanged |
| SA3-I4 | `_checkpointOperator` before every grant change and revoke: usage is decayed at the outgoing grant's rate up to now, then the new cap applies from now. While revoked the cap is 0, so usage does not decay (safe side: a re-grant never inherits refill that no grant allowed). Skipped when usage is 0 (no extra SSTORE on account creation) | `GaplessAccount._setOperator`, `revokeOperator`, `_checkpointOperator` | `test_SA3_I4_grantChangeCheckpointsDecay` (inverted: lower cap neither re-charges nor blocks for 3.3 days, higher cap does not refill); `GaplessAccount: test_N03_budget_decaysLinearly_andSurvivesGrantChange` (revoke keeps decay so far, no decay while revoked, resumes at the new rate) |
| SA3-I5 | Kept by design and documented (`GaplessAccount.cancelCover`, `IGaplessAccount` NatSpec): operators may cancel with zero budget; no notional moves, the refund stays in the account, the PWA cancel flow uses the session key; a leaked key can forfeit at most the escrow of a cover in the zone | NatSpec only | `test_SA3_I5_zeroBudgetOperatorCanStillCancelCover` (kept) |
| SA3-I6 params | `floorSlackBps >= 2 x slipAllowanceBps` else `ParamOutOfBounds(34)` (`Constants.F_FLOOR_SLACK_VS_SLIP`; 33 is `F_SIGMA_POST`). Defaults (100 vs 2 x 5) and canary pass | `CoverManager._checkParams`, `Constants` | `CoverManager: test_setMarketParams_crossFieldAndEvent` (A 50: 99 reverts, 100 passes) |
| SA3-I6 ListMarket | `_envUint(name, default, typeMax)` rejects overrides that do not fit (`ListMarket: <NAME> out of range`) for `MAX_COVER_NOTIONAL_CNS` (uint80), `MARKET_CAP_BPS` (uint16), `SIGMA_BPS_E2` (uint32); `_checkParams` still bounds the value | `script/ListMarket.s.sol` | `ListMarketScript: test_envOverride_outOfRangeReverts` (75,000 reverts instead of becoming 9,464) |

Not changed: SA3-I6 Deploy `_check` gaps and the frozen-vault note (ops), SA3-I3.

## C6 judgment calls

- SA3-02 "leave unchanged" over "reset": a reset would let a third party restart a genuine chain with one dust order per block; unchanged keeps the 3-block gap rule in charge. The book read happens only on short attempts with R through.
- SA3-02 residual: if Perpl's book-top fields include levels that cannot fill (expired orders, unverified on mainnet), the chain does not widen and the keeper retries at the current step. This errs toward liveness, never toward a looser floor; watch for repeated `TriggerNoFill` at the same limit on the canary.
- SA3-I4 revoke: no decay while revoked. Re-granting after a revoke inherits at most the old usage, which drains at the new grant's rate.

## C6 results

| Run | Result |
|:-|:-|
| `forge test` (default) | 477 passed, 0 failed (471 plus 6 new: SA3 +3 net, CoverManager +1, ListMarketScript +1, gas +1) |
| `FOUNDRY_PROFILE=ci forge test` | 477 passed, 0 failed |
| Invariants 256 x 500 | 8 chunks of 32 runs x 500 calls (`FOUNDRY_PROFILE=deep`, `FOUNDRY_INVARIANT_RUNS=32`, `FOUNDRY_FUZZ_SEED=0x6761706c657373 + k`, four in parallel): all 12 invariants of GaplessInvariantTest pass in every chunk (205 to 229 s per command), GaplessOptimizationTest O1 and O2 best 0 |
| Coverage (src lines) | 99.84% (1,284 / 1,286): CoverManager 99.85% (`_scanWindow` rotation), GaplessAccount 99.56% (`_extension` with a builder id), every other src file 100%. The four gas-ceiling tests fail only in the unoptimized coverage build |
| Sizes | CoverManager 47,937 B runtime (C5 47,554), GaplessAccount 16,571 B (C5 16,450) |
| Gas (mock, Monad pricing) | trigger at 16 matches, full fill: 1,419,933 (C5 1,419,990). Trigger at 16 matches, short, with the new book read: 1,462,049 (budget 1.5M). The read costs about 11k to 18k on the mock, whose `getPerpetualInfo` scans every resting order; Perpl's is O(1). Arm 216,856 |

## C6 behavior changes consumers must know (no ABI change)

- Keeper: `arm` at `block.number >= expiryBlock` reverts `CoverExpired` (the SA3 keeper rule is now enforced onchain). After an arm, a fast-path `trigger` may run in the same block; `watchList` lists it in `toTrigger`. A short attempt that leaves bids at or above its limit does not widen the next floor, so retry in the same block (the remainder fills from that depth).
- Backend param tooling: `ParamOutOfBounds(34)` means floorSlack < 2 x slipAllowance.
- PWA: `operatorUsage()` no longer jumps when the owner changes the daily cap; after a revoke, usage stays frozen until the next grant.

# C7: SE2-H1 contract side and the CR1 review (2026-10-06)

Scope: the contract half of SE2-H1 (`memory/security_audit_backend_se2_2026-10-06.md`) with the decided values, the Must fix and Should fix items of `audit/CODE_REVIEW.md`, and the deploy gas re-measure. **No ABI change**: `script/export-abi.sh` output is byte-identical to the C6 `abi/` (`diff -r` empty, 9 files), and `forge inspect <c> abi` is identical for CoverManager, GaplessAccount, GaplessFactory, CoverVault, GaplessCreSink and GaplessCreReceiver (hashes against a rebuild of the C6 source). Runtime bytecode is identical to C6 for every contract except CoverManager. CR34 to CR37.

## SE2-H1: step gap and hold rule

| Rule | C6 | C7 |
|:-|:-|:-|
| Max blocks between consecutive attempts of a touch | 3 (`SHORT_CHAIN_MAX_GAP_BLOCKS`) | **10** (`STEP_MAX_GAP_BLOCKS`, internal constant) |
| Gap measured from | the last thin (step-advancing) attempt | the touch's **most recent attempt** (`shortBlock`), thin or match-limited, fill or no fill |
| Match-limited attempt on a running chain | chain unchanged (`shortBlock` kept) | step kept, `shortBlock` = this block |
| Match-limited attempt with no running chain | nothing starts | unchanged |
| Same-block retry | reuses the block's step | unchanged: after a thin attempt `shortSteps - 1`, after a hold `shortSteps` |
| Reset on arm, disarm, lapsed arm, full fill, R above the stop | yes | unchanged |
| SA3-02 thin-book test, R through the stop for every step | yes | unchanged |

Implementation (`CoverManager._close`, `_step`, `_advance`, `_hold`, `_resetChain`): `getCover` cannot carry a held flag (slot 5 is full and the tuple is ABI), so an internal `mapping(bytes32 => uint256) _heldBlock` records the block of a hold. It is written only by a hold on a running chain, read only by a same-block retry, and cleared when a chain resets in the same block, so a chain restarted in that block cannot inherit it. A hold followed by a thin attempt in the same block advances once (one step per block). The keeper mirror needs only `shortBlock` and `shortSteps`: step = `shortSteps` when R is through and `landing - shortBlock <= 10`, else 0 (INTERFACES section 4).

Regression tests (`test/audit/C7Audit.t.sol`, SE2 scenario: armed long, 22 lots, stop 860,000, R 859,000, bids only at 851,000, which fills at step 5):

| Test | Shows |
|:-|:-|
| `test_SE2H1_walk_landingsUpToGapApart_closes` | landings 4, 5, ..., 10 blocks apart: steps 0 to 4 no fill, step 5 fills all 22 lots, finalize closes the cover |
| `test_SE2H1_walk_beyondGap_resets` | 11 and 12 blocks apart: every landing runs at step 0 (`R x (1 - A)`), nothing fills |
| `test_SE2H1_remainder16OneLotBids_closes` | 30 one-lot bids at 851,000: the step-5 attempt fills 16 (maxMatches, depth left), holds step 5 with `shortBlock` at the partial; the remainder 1 to 10 blocks later fills the last 6 |
| `test_SE2H1_remainder_beyondGap_resetsToTight` | the remainder 11 blocks after the partial runs at step 0 and finds nothing |
| `test_C7_sameBlockRetryAfterHold_keepsStep` | a same-block retry after the partial uses step 5, not 4, and fills the remainder |
| `test_C7_holdThenThinSameBlock_advancesOnce`, `test_C7_holdThenResetThenRestartSameBlock_noInheritance` | one step per block across hold, thin and reset in one block |
| `SA3Audit: test_SA3_02_matchLimited_holdsStep_gapFromHold` (replaces `..._leavesRunningChain`) | step 2 kept across a dust attempt; the next attempt 10 blocks after the hold (12 after the last thin one) still runs at step 2 |
| `CoverManagerGas: test_gas_triggerHoldAtMaxMatches` | hold on a running chain at 16 matches: 1,484,336 gas on the stub stack, one maker, no intrinsic gas; same-block remainder after it 578,575. Superseded by SA4-01: 1,539,268 on the real stack, about 3.0M with 16 distinct makers, about 2.4M on mainnet Perpl, so the 1.5M budget does not hold (`audit/SA4_REPORT.md`) |

Invariants: `HandlerBase._chainAfter` and `_model` implement the C7 rule independently (`Ghost.chainHeld`, `chainHolds`); `KeeperHandler.touchRecoverTouch` lands retries 1 to 12 blocks apart and sometimes rests `maxMatchesClose + 1` one-lot orders first, so holds and 11-block resets are both exercised; `ScenarioCoverage` asserts holds > 0.

## SA3-02, N-01, N-04 with the wider gap

A hunter gets up to 10 blocks between steps, but nothing about what a step requires changed. Each test below runs with attempts 10 blocks apart:

| Test | Requirement shown |
|:-|:-|
| `test_C7_hunt_refAboveStopAtAnyAttempt_resetsWalk` | for j = 1 to 4, one attempt with R above the stop (armed cover, book still crossed, any caller) ends the chain; the next attempt is step 0 and the hunter's bid at the floor stays unfilled |
| `test_C7_hunt_recoveryDisarmResetsChain` | a recovery that uncrosses the book: any caller's trigger disarms and resets |
| `test_C7_hunt_dustHoldsNeverWiden` | ten dust holds 10 blocks apart keep a step-2 chain alive for 100 blocks but never widen it; the floor bid is never reached; an 11-block pause ends the chain |
| `test_C7_hunt_SA3_02_dustAtStep0_gap10` | dust at step 0 never starts a chain; the atomic sweep then meets `R x (1 - A)` |
| `test_C7_hunt_N01_secondTouchAcrossGap` | a second touch 11 blocks later starts tight; 10 blocks later it continues one step (step 1), never the floor |
| `test_C7_hunt_N04_gap10_sameEconomicsAsGap1` | the N-04 residual (book kept empty above each step floor at 5 attempts, R through) gives the same hunter PnL at 1 and 10 blocks between attempts |

Residual change (disclosed in INTERFACES section 4): a full recovery with no executed attempt keeps a chain alive for up to 10 blocks (3 s) instead of 3; on an Armed cover any caller can end it during the recovery.

Hunter PnL after C7 (mock, marked at R = stop, CNS):

| Scenario | Hunter PnL | Note |
|:-|:-|:-|
| SA1 H-01 hunt, references at fair value (`SA1Audit`) | -9,522,702 after flattening | nothing arms or fires; trader loss 0 |
| SA2 N-01 second touch 11 blocks after the first episode | -6,937,859 | tight floor, hunter bid unfilled |
| SA2 N-04 residual, book kept empty at 5 attempts, R through | +12,970,079 at gap 1 and at gap 10 | unchanged by C7 (disclosed N-04 residual); trader shortfall vs `R x (1 - A)` 18,995,319; vault pays `A x SN` |
| SA3-02 dust at step 0, then the atomic sweep | -6,937,859 | no chain, tight floor |
| SA3-02 dust holds on a step-2 chain for 100 blocks | -6,937,859 | never widens |
| Invariant campaign stop hunts (8 chunks) | -1.50 to -5.85 AUSD per chunk (5 to 15 hunts) | O3 asserts hunter PnL <= 0 and no hunt close |

## CR1 review items

| Item | Change |
|:-|:-|
| MF-1 NatSpec | `CloseResult.realizedCNS` (CR1), `Quote.rentCNS` (L-09 floor), `Cover.shortBlock` / `shortSteps` (C7 meaning), state-machine `@dev`; `ICoverVault` `reserve`, `payCapped`, `freeAssets` (gross assets, `reserved[perpId]` cap), seed constant name; `CoverVault.utilizationBps`; `IGaplessAccount.Credited` (payouts only) and `opNonce` (CR3); `ICoverManager.arm` and `trigger` `@return` (void), `trigger` rule text shortened to the C7 rule; `PayoutMath.closeLimitPNS` (step allowance; params `refPNS`, `slackBps`); `Constants` header, cap and treasury comments, `PERPL_MAX_MATCHES` comment; CoverManager header; `IGaplessInherited` (five contracts); `IGaplessCreSink.CreReport.triggered` meaning; quote overflow and `_extension` comments |
| MF-2 | `Deploy._check` requires the keeper's SIGMA_ROLE and `vault.config().treasury == TREASURY`; `Deploy: test_checkCatchesKeeperSigmaAndTreasury` |
| MF-3, SF-6, SF-7 | INTERFACES: section 4 diagram (fast path in the arm block, TriggerNoFill self-edges, post-expiry end paths, Armed void and sync), C4 floor paragraph removed, one consolidated stepped-floor rule set with the keeper reading, CR7 rules, `isLocked`; 5.3 views, events, errors, operator checkpoint text; 5.4 full view, role, event (18) and error lists, `SCAN_LIMIT` (CR8), early-finalize `_releaseExcess`; 5.5 `owedTotal`, `updateOwed`, `OwedUpdated`, gross-asset rules, `C_*` indices; section 6 cap wording, `F_SIGMA_POST`, `STEP_MAX_GAP_BLOCKS`; section 7 floor rounding (CR6), `rentFloorCNS`, `closeLimitPNS`; section 8 keeper and indexer lists; section 9 count (58); section 12 C6 and C7 rows |
| SF-1, SF-3, CR5 | `_checkParams` uses `Constants.F_*` (one line per field, `forgefmt` disabled for the table); `CoverVault._setConfig` and `setManager` use `Constants.C_*`; `F_SIGMA_POST` moved to Constants with the CoverManager getter aliasing it; `SETTLING_SLOT = keccak256("gapless.CoverManager.settling")`. Proven bytecode-neutral: C6 source with only these edits (gap kept at 3) builds a CoverManager runtime identical to C6; CoverVault runtime identical |
| SF-2 | `short_` renamed `shortThrough` |
| SF-4 | `.env.example` lists `MANAGER`, `VAULT` and the four optional overrides (commented: an empty value fails to parse) |
| SF-5 | `CHANGE_REQUESTS.md` header rewritten, Status column for CR1 to CR8 (all applied), C7 rows CR34 to CR37 |
| SF-8, SF-9, SF-10 | README profiles; S1/S2 notes superseded banner and markers; CANARY_PARAMS sizes and MON |
| SF-13 | `GaplessInvariantTest.invariant_O1_O2_optimizationTargets` asserts the exact `GaplessOptimizationTest` targets (`_optO1`, `_optO2` in the base) are <= 0 after every call |
| Not done | SF-11 (S1 suites off `ManagerStub`, not quick), SF-12 (fixture dedup), `isLocked` v2 nit, `_watchKind` enum, unused Constants grouping, `forge fmt` on the whole tree (the frozen files were left unformatted to keep the audit diff minimal) |
| BUILD_PLAN | section 0 canary row now matches CANARY_PARAMS (4 AUSD vault, 20e6 cap, marketCap 10,000) |

## Deploy gas

Only the CoverManager CREATE changed (vault, factory and sink initcode byte-identical to C6). `cast estimate` of the CREATE on a throwaway `anvil` (`network monad`, chain id 143, no fork, nothing sent): C6 initcode 10,492,966 (equals the C6 RUNBOOK row), C7 10,543,573. Deploy total 19,951,262 raw, 20,549,805 at 103%, 2.096 MON at 102 gwei (inclusion 2.158 at 105 gwei); with listMarket 2.13 MON charged, 2.19 MON peak. Deployer funding stays **2.4 MON** (0.27 MON left at base 100, 0.21 at base 103). RUNBOOK section 4 and CANARY_PARAMS updated.

## C7 results

| Run | Result |
|:-|:-|
| ABI | `export-abi.sh` output byte-identical to C6 `abi/` (9 files); `forge inspect` ABIs identical for the six deployed contracts |
| Bytecode | runtime identical to C6 for GaplessAccount, GaplessFactory, CoverVault, GaplessCreSink, GaplessCreReceiver; initcode identical for vault, factory, sink. CoverManager 48,171 B runtime (C6 47,937), initcode 49,055 B |
| `forge test` (default) | 494 passed, 0 failed (C6: 477; new: C7Audit 13, `test_gas_triggerHoldAtMaxMatches`, `test_checkCatchesKeeperSigmaAndTreasury`, `invariant_O1_O2_optimizationTargets`) |
| `FOUNDRY_PROFILE=ci forge test` | 494 passed, 0 failed |
| Invariants 256 x 500 | 8 chunks of 32 runs x 500 calls (`FOUNDRY_PROFILE=deep`, `FOUNDRY_INVARIANT_RUNS=32`, `FOUNDRY_FUZZ_SEED=0x6761706c657373 + k`, four in parallel): all 13 invariants of GaplessInvariantTest pass in every chunk (301 to 346 s per command); GaplessOptimizationTest O1 and O2 best 0. Last-run stats per chunk: 2 to 11 match-limited holds, 2 to 15 fills at a widened step, 2 to 12 touch-recover-touch scenarios, attacker protocol PnL -0.12 to -0.61 AUSD |
| Mutants | a hold that advances the step: 5 failures incl. I14 in the scenario sweep; a same-block retry that ignores the hold: 2 failures |
| Coverage (src lines) | 99.85% (1,294 / 1,296): CoverManager 99.85% (`_scanWindow` rotation), GaplessAccount 99.56% (`_extension` with a builder id), every other src file 100%. The five gas-ceiling tests fail only in the unoptimized coverage build |
| Gas (mock, Monad pricing) | trigger at 16 matches: full fill 1,419,885, short with the book read 1,462,125, hold on a running chain 1,484,336 (stub stack, one maker, no intrinsic; not a Perpl bound, see SA4-01 in `audit/SA4_REPORT.md`); arm about 217K |

## C7 behavior changes consumers must know (no ABI change)

- Keeper: an attempt keeps the walk's step if it lands at most 10 blocks after the previous attempt of the touch (`shortBlock`), including after a match-limited partial fill; 11 or more blocks restarts at step 0. Remainders still expire `windowBlocks` (40) after `triggerBlock`, so a remainder walk at 10-block spacing fits 4 attempts. A same-block retry after a partial still uses that attempt's step.
- Indexer and PWA: `Cover.shortBlock` is the block of the chain's most recent attempt (thin or match-limited); `shortSteps` is the step a later attempt uses.
- Deploy: `_check` also fails on a missing keeper SIGMA_ROLE or a treasury that differs from `TREASURY`.

