# C4: fixes for audit SA1 (2026-10-05)

Scope: every finding in `audit/SA1_REPORT.md` plus the test-runner items in `audit/TEST_REPORT.md`. One owner for all contract files this round. Interface changes are recorded as CR9 to CR19 in `CHANGE_REQUESTS.md`; ABIs re-exported with `script/export-abi.sh`.

Toolchain unchanged: Foundry 1.8.3, solc 0.8.37, OZ 5.6.1 (`SafeERC20.trySafeTransfer`, `AccessControlDefaultAdminRules.beginDefaultAdminTransfer` read from the pinned source), `ReentrancyGuardTransient`, CEI, no `transfer`/`send`.

## Finding to fix to test

| ID | Fix | Where | Regression tests |
|:-|:-|:-|:-|
| H-01 | Book-path arm needs a fresh reference at or through the stop (`_through`), not merely within `refTolBps`. First close floored at `R x (1 - A)` (`PayoutMath.tightLimitPNS`); the D38 floor `min(stop, R) x (1 - floorSlack)` only after a close came up short in an earlier block (`Cover.shortBlock`) with the fresh reference still through the stop; `shortBlock` resets on arm and disarm. `watchList` mirrors the arm rule | `CoverManager.arm`, `trigger`, `_triggerRemainder`, `_close`, `_closeLimit`, `_widen`, `_watchKind`; `PayoutMath` | `SA1Audit: test_H01_stopHunt_noLongerProfitable` (auditor's 2,000 AUSD scenario on mainnet bid depth: hunter -9.52 AUSD, trader 0), `test_H01_genuineTouch_firstCloseTiedToReference`; `CoverManager: test_arm_conditionNotMet_bookAndRef`, `test_arm_bookCrossedAtStop`, `test_trigger_noFill_staysArmed_thenFills`, `test_trigger_noWidenWhenRefAboveStop`, `test_disarm_resetsShortBlock`; `CoverManagerAttack: test_A1_selfDeal_noMove_cannotArm_andLoses`, `test_A1_selfDeal_onRealTouch_paysAtMostAllowance_andLoses`; `PayoutMath: test_tightLimit_bothSides`; `Payout fuzz: testFuzz_tightLimit_withinAOfReference`; invariants I14 and O3 (below) |
| M-01 | Operator orders: limit within 500 bps of mark (types 0, 1, 2, 3, 6; mark 0 rejected), notional priced at `max(limit, mark)` for opens and Change, closes bounded by the position. Owner unaffected | `GaplessAccount._checkOperator` | `SA1Audit: test_M01_offMarketLimitRejected_capPricedAtMark`; `GaplessAccount: test_trade_operatorOffMarketLimitRejected`, `test_trade_operatorShortCappedAtMark`, `test_trade_operatorCloseBoundedByPosition_ownerUnaffected`, `test_trade_operatorZeroMarkRejected`, `testFuzz_operatorNotionalBoundary` (both sides, in band) |
| M-02 | Quote distance from the least favorable fresh source among mark, oracle, feed (floored for longs) and the book top; a source through the stop reverts `StopWrongSide`, inside minDistance `StopTooClose` | `CoverManager._quote`, `_worstPx` | `SA1Audit: test_M02_coverAfterTheMove_refused`; `CoverManager: test_M02_quote_leastFavorableFreshSource`, `test_M02_quote_bookTopCounts` |
| M-03 | Decision applied: on every non-trigger end (cancel, expire, void, own close or shrink via `syncCover`) the escrow is refunded only if the cover was never armed and the least favorable fresh reference is at least `minDistanceBps(sigma)` from the stop; else the vault keeps it (`EscrowForfeited`). No fresh reference counts as not provably far. Triggered covers keep C16 (unfilled-lot share refunded) | `CoverManager._end`, `_resize`, `_escrowRefundable` | `SA1Audit: test_M03_ownerExitAtStop_escrowKept`; `CoverManager: test_M03_cancelNearStop_forfeits_farRefunds`, `test_M03_leastFavorableSourceDecides`, `test_M03_ownTradeExitNearStop_keepsEscrow`, `test_M03_resizeNearStop_keepsFreedEscrow`, `test_M03_expire_staleRefs_forfeits`, `test_expire_fromArmed`, `test_cancelCover`, `test_arm_voidsLiquidatedPosition` |
| L-01 | `observe` needs two fresh post-trigger sources or one non-mark source; mark alone only when the market has no other source (no feed and Perpl `ignOracle`). `housekeeping` mirrors it | `CoverManager._postRef` | `SA1Audit: test_L01_markOnlyPublish_doesNotObserve`; `CoverManager: test_L01_markOnlyAccepted_whenNoOtherSourceExists`, `test_L01_markOnly_fallbackOnMarketWithoutFeed` |
| L-02 | Fast path open to anyone inside the armer's window; the window applies only if `armedBlock + exclusiveBlocks < expiryBlock` | `CoverManager.trigger`, `_exclusive`; keeper handler I12 updated | `SA1Audit: test_L02_armSquatNearExpiry_cannotBlockPayout`; `CoverManager: test_trigger_fastPathIgnoresExclusiveWindow`, `test_trigger_noExclusiveWindowNearExpiry`, `test_trigger_sameBlockAndExclusiveWindow`; `CoverManagerAttack: test_A7_armSquatter_delayIsBounded` |
| L-03 | A and floorSlack snapshotted in the cover at purchase (`Cover.slipAllowanceBps`, `floorSlackBps`); payout bound, floors and I13 use them | `CoverManager.openCover`, `_settle`, `_closeLimit` | `SA1Audit: test_L03_slipAllowanceSnapshottedPerCover` (A raised 5 to 50 and slack 100 to 300 after purchase: payout stays `5 bps x SN` <= escrow); invariant I2 asserts the snapshot equals A at buy |
| L-04 | Sink replay protection keyed by `keccak256(report)` (`seen`), seq accepted within `[now - max age, now]`, `lastSeq(kind, perpId)` monitoring only | `GaplessCreReceiver.onReport`, `_seqWindow` | `SA1Audit: test_L04_creSink_perPerpAndForgedCannotDrop`; `GaplessCreSink: test_replayedAndTooOldReturnSilently`, `test_futureSeqIgnored_cannotBrickAKind`, `test_armedLogKindUsesBlockNumber` |
| L-05 | Refunds use `trySafeTransfer`; a failure is recorded in `refundOwed[account]` and paid by permissionless `claimRefund`; end paths finish and release the reserve. A final but still-owed cover releases its reserve above `paid + owed` | `CoverManager._refund`, `claimRefund`, `_releaseExcess` | `CoverManager: test_L05_frozenAccount_refundBecomesClaim`, `test_L05_frozenAccount_syncAndFinalizeDoNotBrick`, `test_finalize_owed_releasesExcessReserve`; invariant I5 counts `refundOwedTotal` |
| L-06 | Close limit clamped to `[1, 16,777,215]`; `listMarket` rejects `basePricePNS != 0`; mock bound fixed to mainnet's | `CoverManager._closeLimit`, `_checkConfig`; `MockPerplExchange` | `CoverManager: test_L06_closeLimitClampedToPerplMax`, `test_L06_listMarket_rejectsNonzeroBase`; `MockPerplExchange: test_limitPriceRange_matchesMainnet` |
| L-07 | Bound documented and tested: each call fills `min(remaining, position)` or consumes `maxMatchesClose` orders of at least one lot, and calls may repeat in a block, so dust costs at most `ceil(lots / maxMatches)` calls | `CoverManager._triggerRemainder` NatSpec, INTERFACES 5.4 | `CoverManagerAttack: test_A6_L07_dustSpam_boundedCallsToFullClose` (40 dust bids: full close in <= 4 calls in one block) |
| L-08 | Vault `totalAssets` is net of `owedTotal`; the manager reports every `owedCNS` change through `updateOwed` | `CoverVault.totalAssets`, `updateOwed`; `CoverManager._settle` | `CoverVault: test_owedNetsOutOfTotalAssetsAndRedeems`, `test_totalAssetsFloorsAtZero`; `CoverManager: test_trigger_perBlockCap_defersToFinalize`; invariant I1 |
| L-09 | One cover may hold at most 10% of its market's capacity (`MAX_COVER_CAP_SHARE_BPS`), so pinning a market takes many hedged positions | `CoverManager._checkCapacity` | `CoverManager: test_L09_coverShareCapped` |
| I-01 | `Deploy.s.sol`: separate `ADMIN`, `RISK_ADMIN`, `PAUSER` env addresses, each defaulting to the deployer with a logged warning; a separate admin gets a scheduled default-admin transfer | `script/Deploy.s.sol` | `Deploy: test_splitRoles`, `test_runDefaultsRolesToDeployer` |
| I-02 | Per-market pause (`pauseMarket`, `unpauseMarket`, `marketPaused`) for buys | `CoverManager` | `CoverManager: test_pauseMarket_blocksBuysOnThatMarketOnly` |
| I-03 | `setConfig` and `setManager` reject `treasury == manager` | `CoverVault` | `CoverVault: test_treasuryCannotBeManager` |

Not changed (accepted or out of scope this round): I-04 is moot (both closes clamp to the same Perpl range); I-05 to I-07 and I-10 are ops or product items (I-10: trigger gas at 16 matches now measured on the mock, still to measure on Perpl).

## Test-runner items (TEST_REPORT)

| Item | Done | Test |
|:-|:-|:-|
| U1 stale or zero mark on the Live fast path | yes | `CoverManager: test_trigger_live_staleOrZeroMark_reverts` (63 s old mark and zero mark: `ConditionNotMet`, not on `watchList`; the 62 s edge is fresh) |
| U2 remainder after liquidation or flip | yes | `CoverManager: test_trigger_remainderAfterLiquidationOrFlip_reverts` |
| U3 `syncCover` on Triggered | yes | `CoverManager: test_syncCover_onTriggered_noop` |
| Inline invariant config | moved to `foundry.toml`: default and ci 64 x 200, `deep` 256 x 500, `long` 2048 x 500 (`forge config` per profile verified) | |
| Assertion-less gas tests | `test_gas_openCover` asserts < 700K; the 25-level case became `test_gas_trigger25Levels_walkBounded` (walk stops at 16 matches, < 1.8M mock bound, remainder < 1.5M) | `CoverManagerGas` |
| `maxMatchesClose` 16, trigger < 1.5M | default 16; full 16-match trigger 1,419,255 gas on the mock | `CoverManagerGas: test_gas_triggerAtMaxMatches` |
| Compiler warnings (`at`, pure) | fixed; build has no warnings | |

## Invariants added

- I14 trader exit (H-01): with a fresh reference R at trigger, `G_realCum <= paid + owed + G_ref + allowance x min(stop, R) x F + rounding`, allowance A for first-attempt closes and floorSlack only after a short close. Equivalent to "trader exit net of the payout >= min(stop, R) x (1 - allowance)". Outage closes (R = 0, D49) are excluded.
- O3 stop hunting: `AttackerHandler.stopHunt` buys a canary-size cover for a victim, rebuilds a thin bid book shaped like the measured BTC-PERP profile (3 to 71 bps, 0.5x to 4x of the mainnet-to-cover ratio), lets a hunter sell through the stop, rest a bid under it, arm and trigger, with references honest at fair value. Asserted: no hunt closes a covered lot and hunter PnL (marked at fair, before its flattening fee) is never positive.
- `selfDealOnTouch`: the A1 self-dealer during a genuine touch of the stop; O1 (vault-side PnL <= 0) still holds.
- I2 now uses the per-cover A and checks it equals A at buy; I1 allows for the netted `owedTotal`; I5 counts `refundOwedTotal`.
- Harness: a market maker that follows the reference keeps a quote near the mark between scenarios (M-02 refuses buys when the book top is already through a stop, which a stale harness book produced constantly).

## Results

| Run | Result |
|:-|:-|
| `forge test` (default) | 432 passed, 0 failed (about 41 s) |
| `FOUNDRY_PROFILE=ci forge test` | 432 passed, 0 failed (about 41 s) |
| Invariants 256 x 500 (`deep`) | GaplessInvariantTest: all 14 invariants pass over 256 runs x 500 calls (128,000 calls), run as 8 chunks of 32 runs with seeds `0x6761706c657373` + k (chunk 0 on the pinned seed), about 2 minutes each. One 256-run command would take about 16 minutes. Last-run stats per chunk: 5 to 18 stop hunts, hunter PnL -1.7 to -6.9 AUSD, attacker protocol PnL -0.28 to -0.69 AUSD. GaplessOptimizationTest at the same 8 x 32 x 500: O1 best 0, O2 best 0 |
| Coverage, src lines | 99.75% total; every src file >= 99.5%; branches 95.97% |
| Sizes | CoverManager 45,327 B runtime (limit 131,072) |
| Scenario sweep | 40 covers, 11 honest triggers, 8 hunts (hunter PnL -4.01 AUSD), 7 touch self-deals, attacker protocol PnL -0.32 AUSD |

## Behavior changes consumers must know

- Keeper: a `TriggerNoFill` on the first attempt is expected when the book sits more than A under the reference; retry in the next block (the floor widens only then, and only with the reference through the stop). Trigger is open to anyone when the mark is through the stop; the armer's window never reaches expiry. Trigger gas at 16 matches is about 1.42M on the mock.
- PWA and plugin: escrow is refunded on cancel or expiry only when the cover was never armed and the price is at least minDistance from the stop; show `EscrowForfeited`. A refund to a frozen account becomes `refundOwed`, claimable with `claimRefund`. Quotes measure distance from the least favorable fresh source and the book top. Operator keys get `LimitOffMarket` and `CloseExceedsPosition`.
- Indexer: new events `EscrowForfeited`, `RefundOwed`, `RefundClaimed`, `MarketPauseSet` (manager) and `OwedUpdated` (vault); `getCover` has three trailing fields; the vault share price nets deferred payouts.
- Deploy runbook: set `ADMIN`, `RISK_ADMIN`, `PAUSER`; the admin calls `acceptDefaultAdminTransfer` on both contracts after 1 h; ListMarket runs from the RISK_ADMIN key.
