# SA2: Gapless contracts re-audit after the C4 fix round

Date 2026-10-05. Target: Monad mainnet (chain 143), real AUSD, Perpl Exchange 1.7.5. Canary: vault 3 AUSD, `maxCoverNotionalCNS` 50 AUSD.
Auditor: solidity-auditor (SA2). `src/` unmodified. New PoCs: `test/audit/SA2Audit.t.sol` (7 tests). The C4 round rewrote `test/audit/SA1Audit.t.sol` into regressions; they were re-run as-is.

## 1. Scope and method

| Item | Value |
|:-|:-|
| In scope | Every C4 change: `CoverManager` (arm rule, tight and widened floors, `shortBlock`, `_worstPx`, `_escrowRefundable`, `_postRef`, `_exclusive`, `claimRefund`, `_releaseExcess`, per-market pause, 10% share cap), `CoverVault` (`owedTotal`, `updateOwed`, net `totalAssets`, treasury check), `GaplessAccount._checkOperator`, `GaplessCreReceiver` (hash seen-set, age window), `PayoutMath.tightLimitPNS`, `Constants`, `script/Deploy.s.sol`, `script/ListMarket.s.sol`, mock range fix |
| Docs read | `audit/SA1_REPORT.md`, `docs/C4_FIXES.md`, `CHANGE_REQUESTS.md` CR9 to CR19, `INTERFACES.md`, `memory/solidity_audit_sa1_2026-10-05.md`, `memory/perpl_stop_semantics_2026-10-05.md`, `gapless/05` sections 2.5, 4 and 9 |
| Toolchain | Foundry 1.8.3, solc 0.8.37, OZ 5.6.1 (`trySafeTransfer` read from `lib/`: returns false on any revert, no bubble) |
| Tests | `forge test`: 439 passed, 0 failed (C4's 432 plus SA2's 7). Build has no warnings |
| Mainnet evidence | Read-only `eth_call` on rpc1.monad.xyz, blocks 110,795,538 to 110,795,790 (section 8). No transactions, no forks |

Run: `forge test` with flag:match-path `test/audit/SA2Audit.t.sol` and `-vv` for the logged numbers.

## 2. Summary

### SA1 findings

| ID | Verdict | Evidence |
|:-|:-|:-|
| H-01 | Fixed for wick-only hunts; **bypass found** (N-01), residual documented (N-04) | `test_H01_stopHunt_noLongerProfitable` (hunter -9.52 AUSD, trader 0, mainnet depth); `test_N01_*` |
| M-01 | Partially fixed: the 1 PNS bypass is closed; no cumulative bound (N-03) | `test_M01_offMarketLimitRejected_capPricedAtMark`; `test_M01r_operatorRoundTrips_unbounded` |
| M-02 | Fixed | `test_M02_coverAfterTheMove_refused`; review of `_worstPx` (section 3) |
| M-03 | Fixed for the owner-exit channel; the refund decision uses call-time inputs (N-02); residual selection at the zone edge (section 5) | `test_M03_ownerExitAtStop_escrowKept`; `test_N02_expiryRefund_dependsOnCallTimeInputs` |
| L-01 | Fixed | `test_L01_markOnlyPublish_doesNotObserve` |
| L-02 | Fixed | `test_L02_armSquatNearExpiry_cannotBlockPayout` |
| L-03 | Fixed for A and floorSlack; other params (refTol, window, perBlock cap, maxMatches, M-03 threshold) still live (N-02) | `test_L03_slipAllowanceSnapshottedPerCover` |
| L-04 | Fixed (seen-set bypassable with trailing bytes, harmless today: N-06) | `test_L04_creSink_perPerpAndForgedCannotDrop`, `test_I_creSeenSet_trailingByteReplays` |
| L-05 | Fixed for refunds; payouts to a frozen account stay owed and reserved (N-08) | code review; C4 unit tests |
| L-06 | Fixed | code review (`_closeLimit` clamp, `basePricePNS == 0`, mock range) |
| L-07 | Accepted as documented (window kept at 40 blocks; bounded by calls per block) | `test_A6_L07_dustSpam_boundedCallsToFullClose` |
| L-08 | Fixed | code review (section 3) |
| L-09 | Partially fixed: one cover holds at most 10%, but accounts are free to sybil, so cost is unchanged | arithmetic |
| I-01 | Fixed in the script; canary will still default every role to the deployer | `script/Deploy.s.sol` |
| I-02 | Fixed (buys only; triggers unaffected, as A14 requires) | code review |
| I-03 | Fixed | code review |

### New findings

| ID | Severity | Title | PoC |
|:-|:-|:-|:-|
| N-01 | Medium | `shortBlock` is never cleared after a no-fill episode, so the first close of a later touch uses the widened floor | `test_N01_staleShortBlock_widensFirstCloseOfLaterTouch`, `test_N01_armTtlLapse_keepsShortBlock`, control `test_N01_control_withoutEarlierEpisode_tightFloorHolds` |
| N-02 | Medium | M-03 refund vs forfeit is decided at call time on live prices, live sigma and live params; `expire` is permissionless and timing-free | `test_N02_expiryRefund_dependsOnCallTimeInputs` |
| N-03 | Low | Operator band is per trade with no cumulative bound; a leaked key plus a colluder drains the account in capped steps | `test_M01r_operatorRoundTrips_unbounded` |
| N-04 | Low | The same-episode widened fallback can be forced by a third party in two blocks; docs describe it as a thin-book event | reasoning on `_widen` (same economics as N-01, needs book persistence) |
| N-05 | Info | Invariant I14 accepts any nonzero `shortBlock`, which is why N-01 passes the suite | `test/invariant/GaplessInvariant.t.sol:124` |
| N-06 | Info | CRE seen-set keyed by raw report bytes; one appended byte replays the same content | `test_I_creSeenSet_trailingByteReplays` |
| N-07 | Info | Canary sizing: the 10% share cap limits a cover to Cap 0.15 AUSD (about 7.5 AUSD notional at maxGap 200); rent floor dominates price | `test_I_canaryVault_coverShareCapBinds` |
| N-08 | Info | Ops and liveness items (Perpl view in every end path, frozen-account payouts, Deploy check, ListMarket key, mark staleness) | section 4 |

No Critical or High. The vault-side bound `min(G_real, G_ref + A x SN, maxGap x SN, Cap)` still holds on every path reviewed; both Mediums are trader-side.

## 3. Verification of the SA1 fixes

**H-01.** `arm` now needs `crossed && _through(c, ref)` with `ref` the aggregated fresh reference (median; for longs ties pick the higher value), so a wick with honest references cannot arm, and `watchList` mirrors it (`_watchKind`). The first close uses `tightLimitPNS(R, A)`; with `R >= stop` that limit sits above the stop, so no fill under `R x (1 - A)` is possible. The armed re-check still accepts `R` within `refTolBps` above the stop, which only closes at `R x (1 - A)` above the stop (no payout, native-stop behaviour). Re-run on mainnet depth: `test_H01_stopHunt_noLongerProfitable` hunter -9.52 AUSD, trader 0; `test_H01_genuineTouch_firstCloseTiedToReference` hunter's bid at the old floor never fills. The fix does not hold across episodes (N-01) and the same-episode fallback is forceable (N-04).

**M-01.** `_checkOperator` rejects limits more than 500 bps from mark (mark 0 rejected) on types 0, 1, 2, 3, 6, prices opens and Change at `max(limit, mark)`, and bounds closes by the position. The 1 PNS bypass is closed. Remaining: no cumulative notional (N-03), operator may still call `buyCover` and `cancelCover` (escrow burn with M-03, N-03), the band is relative to a mark that is routinely 40 to 50 s old on mainnet (section 8).

**M-02.** `_quote` measures distance from `_worstPx(m, isLong, true)`: the least favorable fresh source among mark, oracle and feed (feed floored for longs through `collect(..., !isLong, ...)`) and the cover-side book top. Checked DoS angles: a stale source is excluded, not counted; the book top cannot be lowered (long) or raised (short) by adding orders, only by sweeping real liquidity; an empty side (ONS 0 or max) is skipped; expired levels in `maxBidPriceONS` can only make the book look better for the buyer, so they never block a buy. Feed decimals are checked at listing. A manipulated mark (Perpl clamp 25 bps) can refuse long buys near the mark, which is protective. Fixed.

**M-03.** `_end` and `_resize` refund only when `armedBlock == 0` and the least favorable fresh reference (mark, oracle, feed, no book) is at least `minDistanceBps(current params, current sigma)` from the stop. The owner-exit channel of SA1 is closed (`test_M03_ownerExitAtStop_escrowKept`). Inputs and timing are the problem (N-02); scope is judged in section 5.

**L-01.** `_postRef` needs two post-trigger sources or one that is not the mark; mark alone only when the market has no feed and Perpl ignores its oracle. `housekeeping` mirrors it. Fixed.

**L-02.** `trigger` lets anyone use the fast path inside the armer's window, and `_exclusive` drops the window when `armedBlock + exclusiveBlocks >= expiryBlock`. Fixed.

**L-03.** `Cover.slipAllowanceBps` and `floorSlackBps` are snapshotted at `openCover`; `_settle`, `_closeLimit` and I13 use them; owed can no longer be forgiven by lowering A. Other parameters remain live by design.

**L-04.** Seen-set over `keccak256(report)`, seq window `[now - 120 s, now + 2 s]` (kinds 1, 2) and `[block - 400, block]` (kind 3), `lastSeq(kind, perpId)` for monitoring. A forged report can no longer drop a different genuine one. N-06 is cosmetic today.

**L-05.** `_refund` uses `trySafeTransfer` (OZ 5.6.1 `_safeTransfer(..., bubble = false)` returns false on revert) and books `refundOwed`; `claimRefund` zeroes before transfer, is `nonReentrant`, pays only the account, and reverts harmlessly while the account is still frozen. No double claim, no reentrancy, funds are never stranded while AUSD keeps its freeze semantics. An OOG grief on the try path is not viable: everything after it (two SSTOREs, `_toVault`, `release`) needs far more than the 1/64 left. Payouts are a separate path (N-08).

**L-06.** `_closeLimit` clamps to `[1, 16,777,215]`, `listMarket` rejects `basePricePNS != 0`, the mock now reverts outside the mainnet range. Fixed.

**L-07.** Unchanged design, now documented: each remainder call fills or consumes 16 matches, and calls can repeat in a block. Accepted for the canary (covers are a few lots).

**L-08.** `totalAssets = _assets - owedTotal` (floored at 0); `updateOwed(from, to)` computes `owedTotal + to - from`, so it cannot underflow (from was added before); every write to `c.owedCNS` is in `_settle`, which reports the delta; entitlement is monotone (`gRealCum` only grows, `max(gTrig, gPost)`, A snapshotted), so owed only falls by payment. Owed is inside `reservedTotal` (`_releaseExcess` keeps exactly `owed` reserved), so `freeAssets` and the redeem min rule stay consistent; a depositor during a deferral buys at the net price and the later payment leaves `totalAssets` unchanged. The manager's `_checkCapacity` divides by the net figure while the vault's `reserve` uses gross `_assets`, so quotes are slightly stricter than the vault; harmless.

**L-09.** `CoverShareExceeded` caps one cover at 10% of the market cap. One live cover per (account, perp) and free accounts mean ten sybil accounts pin the market at the same total rent. Accepted for the canary.

**I-01 to I-03.** Role split implemented with logged fallbacks; per-market buy pause; `treasury != manager`. Fixed.

## 4. New findings

### N-01 Medium: `shortBlock` survives a no-fill episode, so the first close of a later touch uses the widened floor

**Location**: `src/CoverManager.sol:618` (set on any short close), `:820-822` (`_widen`), `:317` and `:781` (the only resets: `arm`, `_disarm`), `:345-348` (fast path skips both).

**Description**: C4 promises that the first close of a touch is floored at `R x (1 - A)` and that `min(stop, R) x (1 - floorSlack)` applies only after a short close in an earlier block of the same event. `_widen` checks `shortBlock != 0 && block.number > shortBlock`, with no age limit and no episode binding. `shortBlock` is reset only in `arm` and `_disarm`. Two common paths leave it set:
1. A fast-path trigger (mark through the stop) that comes up short on a Live cover. Status stays Live, no disarm ever runs.
2. An armed cover whose arm TTL lapses lazily (`_effStatus` reads Live, stored status stays Armed). Nobody needs to call `trigger` again, and `watchList` does not list it.

Any later touch that reaches `trigger` through the fast path (the mark through the stop, which is the normal case in a real move because the mark publishes on 5 bps steps) then closes at the widened floor on its first attempt. The fast path is single-block, so a hunter can sweep, rest its bid and trigger atomically.

**Exploit scenario** (PoC, spec cap 2,000 AUSD, mainnet bid profile rebuilt under the touch price):
- Episode 1: the reference touches the stop, the book is thin under it, the keeper's fast-path trigger emits `TriggerNoFill`. The market recovers.
- 1,000 blocks later, episode 2: the reference touches the stop again with honest depth under it. In one block the hunter sells into the 8,321 lots above `stop x 0.99`, rests a bid one tick above it and calls `trigger`.
- Measured: trader shortfall against `R x (1 - A)` net of the payout **17.99 AUSD** (0.9% of notional; payout is `A x SN` because `R == stop`). Hunter **+10.68 AUSD** marked at the touch price after a conservative flatten of its residual short.
- Control: the same episode 2 without episode 1 emits `TriggerNoFill` at `R x (1 - A)` and the hunter's bid never fills.

Episode 1 can also be primed deliberately: any moment the mark is through the stop, a hunter can sweep the few bids above `R x (1 - A)` and fast-trigger in the same transaction.

**Impact**: trader-side loss up to `(floorSlack - A) x N` (95 bps at defaults) per touch, captured by whoever holds the best bid in the hole. Vault unaffected. Canary: at most about 0.06 AUSD per cover (Cap-limited notional about 7 AUSD, see N-07), and not profitable for a hunter on BTC at that size (the sweep costs several AUSD), but a natural resting bid in the hole produces the same trader loss without an attacker.

**Recommended fix**:
```solidity
// Widen only right after a short close of the same touch.
function _widen(Cover storage c, uint256 ref, uint8 n) internal view returns (bool) {
    uint256 sb = c.shortBlock;
    return sb != 0 && block.number > sb && block.number <= sb + WIDEN_WINDOW_BLOCKS && n > 0 && _through(c, ref);
}
```
Also clear `shortBlock` in `trigger` when the fast path or arm condition is absent (the Live branch currently reverts `ConditionNotMet` without touching it), and in `_close` overwrite it only while the touch persists. Consider a stepped floor (`A`, `2A`, `4A`, capped at slack) instead of a jump to slack. Tighten I14 to use the same window (N-05).

**References**: OWASP SC03 (business logic), SC02; SWC-114; SA1 H-01.

### N-02 Medium: the M-03 refund is decided on call-time prices, sigma and params, and `expire` has no deadline

**Location**: `src/CoverManager.sol:394-400` (`expire`, permissionless, any time after expiry), `:283-290` (`cancelCover`, allowed after expiry), `:826-834` (`_escrowRefundable`: current `_sigma`, current `m.p`, no staleness check on sigma, `n == 0` forfeits).

**Description**: An expired cover protects nothing (`arm` and `trigger` revert `CoverExpired`), yet it stays Live in storage until someone calls `expire`, and the refund test runs at that moment. The inputs are whatever holds then:
- **Timing**: anyone (the protocol keeper, an LP) can wait until the price drifts within `minDistance` of the stop, or until every reference is stale, and then call `expire`. The owner can race with `cancelCover`, which still works after expiry and records `Cancelled` instead of `Expired`.
- **Sigma**: `postSigma` (SIGMA_ROLE, the keeper hot key) changes `minDistance` for every live and expired cover. Sigma 2,000 gives 848 bps, so every non-trigger end forfeits at unchanged prices.
- **Params**: RISK_ADMIN raising `minStopDistanceBps` (up to 500) or `kDistE2` has the same effect. L-03 snapshotted A and slack only.

**PoC**: 50-lot long, stop 45 bps under fair, minDistance 11 bps. After expiry with the price still 45 bps away: (A) prompt `expire` refunds; (B) waiting 500 blocks for a drift to 5 bps above the stop, then `expire`: `EscrowForfeited`; (C) keeper posts sigma 2,000, prices unchanged, `expire`: forfeited; (D) the owner's `cancelCover` after expiry refunds.

**Impact**: the trader's escrow moves to LPs (90%) and the treasury (10%) on inputs the protocol side controls. Bounded by the escrow (the trigger fee, `feeBps x N x M`). Canary: 0.0035 AUSD on the largest allowed cover. At the spec cap it is several AUSD per cover across every expiring cover.

**Recommended fix**:
```solidity
// Expiry is exogenous: refund unless the cover was armed (section 5).
uint256 refund = (reason == EndReason.Expired ? c.armedBlock == 0 : _escrowRefundable(c)) ? escrow : 0;
```
Snapshot `minDistanceBps` at purchase (a `uint16` fits in slot 5) and use it in `_escrowRefundable`. Reject `cancelCover` once `block.number > expiryBlock` so the end state is `Expired`. If the product keeps forfeiture at expiry, record the zone state at the last pre-expiry interaction instead of evaluating it later.

**References**: OWASP SC01, SC03; SA1 L-03.

### N-03 Low: operator scope is per trade; no cumulative bound (M-01 residual)

**Location**: `src/GaplessAccount.sol:263-286` (`_checkOperator`), `:121-130` (`buyCover`, `cancelCover` open to the operator).

**Description**: Each operator order must sit within 5% of mark and under `maxNotionalPerTradeCNS`, but nothing limits the count. With honest liquidity inside the band cleared (a thin-market moment, or a colluder sweeping it), a colluder quoting at the band edges collects about 4.9% of each capped trade. The operator can also buy covers and cancel them in the zone, burning escrow plus rent into the vault (M-03 makes cancels costly).

**PoC**: 10 AUSD per-trade cap, colluder bid at mark x 0.951 and ask at mark x 1.049; 20 round trips (40 trades) drain **18.71 AUSD** to the colluder.

**Impact**: needs a leaked operator key (the PWA's derived key) and a colluding counterparty. Canary exposure is the account balance, independent of the vault, and the default grant is 500 AUSD per trade for 24 h.

**Recommended fix**: a rolling notional budget per grant (sum of `lots x max(limit, mark)` over the grant, or per block window), a per-grant loss or premium budget, and no `cancelCover` for operators. For the canary, issue grants with a cap of a few AUSD and an expiry of hours.

### N-04 Low: the same-touch widened fallback is forceable by a third party

**Location**: `src/CoverManager.sol:618`, `:820-822`; `gapless/05` section 9, A8 residual.

**Description**: 05 section 9 states the trader can be filled up to `floorSlack` under the reference "after a short first attempt in a genuinely thin book". A third party can manufacture the short attempt: in block N of a genuine touch it sweeps the bids above `R x (1 - A)` and triggers (no fill, `shortBlock = N`); in block N+1 it rests a bid just above `min(stop, R) x (1 - slack)` and triggers again. Unlike N-01 this needs the swept book to stay empty for one block, so honest refills defeat it. Economics match N-01 (about 90 bps of notional moved from trader to hunter).

**Recommended fix**: the stepped floor from N-01, and correct the A8 wording so the disclosed residual is "forceable during a genuine touch", not "thin-book only".

### N-05 Info: I14 accepts any nonzero `shortBlock`

`test/invariant/GaplessInvariant.t.sol:124` uses `c.shortBlock != 0 ? c.floorSlackBps : c.slipAllowanceBps`. Once N-01 is fixed, compute the allowance with the same episode window as `_widen`, and add a handler that interleaves a no-fill touch, a recovery and a later fast-path touch.

### N-06 Info: CRE seen-set keyed on raw bytes

`abi.decode` ignores trailing bytes, so `report ++ 0x00` decodes to the same content with a different hash and is processed again (`test_I_creSeenSet_trailingByteReplays`). Harmless for the simulation sink (it only calls state-checked `arm` and `trigger`). For a production receiver that acts on content, key the set on `keccak256(abi.encode(decoded fields))` or require `report.length` to equal the canonical length.

### N-07 Info: canary sizing

With the vault at 3 AUSD: market cap 50% = 1.5 AUSD, per-cover share 10% = **0.15 AUSD of Cap**, so the largest cover at maxGap 200 bps is about 7.5 AUSD of notional (8 BTC lots); `maxCoverNotionalCNS = 50 AUSD` is unreachable until the vault holds about 20 AUSD. The largest allowed quote: Cap 0.137 AUSD, escrow 0.0035 AUSD, rent 0.02 AUSD (the `minFeeCNS` floor, about 29 bps of notional). The UI should show `CoverShareExceeded` as a capacity message, and the canary should expect rent, not escrow, to dominate premium income.

### N-08 Info: ops and liveness

| Item | Location | Note |
|:-|:-|:-|
| End paths now call Perpl | `_escrowRefundable` via `_market` | `cancelCover`, `expire`, `voidCover`, `syncCover` revert if `getPerpetualInfo` reverts (Perpl upgrade or halt behaviour). Before C4 `expire` and `cancelCover` did not depend on Perpl |
| Payouts to a frozen account | `_settle`, `finalize` | `payCapped` reverts inside the try, the amount stays `owedCNS`, reserved and netted from `totalAssets` until unfreeze; the perp stays `PerpLocked`. No ledger like `refundOwed` for payouts. Accept and monitor |
| Deploy check | `script/Deploy.s.sol:_check` | verifies the pending admin on the vault only, not the manager |
| ListMarket key | `script/ListMarket.s.sol` | the RISK_ADMIN broadcaster also makes the 2 AUSD LP deposit, so the role that sets the M-03 threshold is an LP (N-02), and the script cannot run from a Safe |
| Mark staleness | mainnet, section 8 | BTC mark aged 18 to 45 s within one minute; at more than 62 s `quote` reverts `MarkStale` and the fast path is off. Feed refreshes every 5 to 20 s, so `n == 0` (D49 outage close at `stop x 0.98 x 0.99`) needs a Chainlink outage too |
| `maxMatchesClose` bound | `Constants.MAX_MATCHES_CLOSE_MAX = 200` | RISK_ADMIN can set 200; trigger gas at 16 is 1.42M on the mock and still unmeasured on Perpl |

## 5. M-03 scope judgment (05 section 2.5)

Section 2.5 argues the vault's expected P&L per cover, `P(trigger) x (escrow - E[payout | trigger]) + rent`, is positive whatever `P(trigger)` is, provided `gap[z]` is right. That only holds when the owner cannot choose which touches become triggers.

| End path | Owner can select? | Zone rule needed | Verdict |
|:-|:-|:-|:-|
| `cancelCover`, own close or shrink (`syncCover`) | Yes: this is the SA1 channel (exit at stop + 2 bps, keep the cover for gaps) | Yes | **Agree** |
| `voidCover` and `arm` on `_broken` | Partly: `_broken` cannot tell liquidation or ADL from fills of the owner's own resting orders placed through `trade()` (those shrink the position without `syncCover`) | Yes, while the void path cannot distinguish them | **Agree**, and disclose that a true liquidation near or through the stop keeps the escrow |
| `expire` | No: the cover stays in force until `expiryBlock`, so the vault bears every touch up to the end and the owner holds no option | No | **Disagree** as implemented. Forfeiting at expiry charges near-miss traders a fee that 2.5 never priced, and the decision is taken on call-time inputs (N-02). Refund at expiry unless the cover was armed |

Residual selection after the rule: an owner can cancel at the zone edge (stop + minDistance, about 11 bps calm) and exit by itself. The vault then bears only touches that cross the zone faster than the owner reacts, which are the large-gap events, while the fee is fitted on the bucket average (05 2.3: mean 1.94 bps, p99 23.9 bps in the lowest bucket). The trader pays for this by being uncovered inside the zone, so the strategy is costly, but it is not closed. Not a canary blocker; before raising caps either re-fit `gap[z]` conditional on a zone traverse within a few blocks, or add a small non-refundable cancel fee. Also disclose that a cover bought at exactly `minDistance` sits on the zone edge from the first block.

## 6. Residual risk for the canary (vault 3 AUSD, maxCoverNotional 50 AUSD)

| Risk | Max impact at canary | Likelihood | Rating |
|:-|:-|:-|:-|
| LP loss in a crash (A11) | 1.5 AUSD (BTC market cap 50% of 3 AUSD; Cap per cover 0.15) | Low | Low |
| N-01 / N-04 trader exit under `R x (1 - A)` | about 0.06 AUSD per cover | Medium (natural thin book suffices), not hunter-profitable at this size | Low |
| N-02 escrow forfeited by call timing or sigma | 0.0035 AUSD per cover | Medium (keeper decides when to expire) | Low |
| N-03 leaked operator key | the account balance, independent of the vault; about 4.9% of the per-trade cap per trade | Low (key leak plus colluder plus cleared book) | **Medium** at the default 500 AUSD grant; Low with a small cap and short expiry |
| D49 outage close at `stop x 0.98 x 0.99` paid `A x SN` | about 3% of 7 AUSD | Very low (needs Chainlink stale for 120 s plus Perpl refs stale) | Low |
| Trigger gas unmeasured on Perpl | a reverting trigger at 16 matches leaves the cover unpaid until retried | Unknown | Medium (operational) |
| RISK_ADMIN, SIGMA and PAUSER on the deployer hot key | params, sigma (N-02) and pauses; no fund theft path found | Low | Low |
| Mark staleness blocking buys | buys revert `MarkStale` in quiet minutes | Medium | Info |

## 7. Go / no-go

**GO for the canary**, with these conditions:
1. Keep the vault at canary size and `maxCoverNotionalCNS` at 50 AUSD (N-07 makes the effective cap about 7.5 AUSD anyway).
2. Issue operator grants with a small per-trade cap (a few AUSD) and an expiry of hours, or disable operator trading for the canary (N-03).
3. Keeper calls `expire` in the first block it can (housekeeping already lists it) and posts only fitted sigma values (N-02).
4. Measure trigger gas on Perpl with `eth_estimateGas` from a real account before the first cover.

Fix before raising caps: N-01 (and the I14 tightening), N-02, then N-03 and N-04.

## 8. Mainnet read-only evidence (2026-10-05)

Sampled every 5 to 7 s over 76 s, blocks 110,795,538 to 110,795,790 (252 blocks, about 0.30 s per block):

| Perp | Mark age | Oracle age | Feed age | Book vs mark |
|:-|:-|:-|:-|:-|
| BTC (1) | 1 to 45 s (852,086 unchanged for 35 s) | 6 to 50 s | 3 to 20 s | best bid above the stale mark in 3 of 12 samples (852,700 vs 852,513) |
| ETH (20) | 1 to 33 s | 2 to 51 s | 1 to 30 s | |
| MON (10) | 0 to 19 s | 1 to 39 s | 1 to 29 s | |

`ignOracle = false`, `refPriceMaxAgeSec = 60` on BTC. Consequences: `n == 0` needs the Chainlink feed stale for 120 s as well; the mark is usually the stalest source, so `_worstPx` and the M-03 test lean on the feed; the operator band (N-03) is measured against a mark that is often tens of seconds old.
