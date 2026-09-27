# SA1: Gapless contracts security audit (pass 1, pre-mainnet)

Date 2026-10-05. Target: Monad mainnet (chain 143), real AUSD, Perpl Exchange 1.7.5.
Auditor: solidity-auditor (SA1). Source is unmodified; PoCs live in `test/audit/SA1Audit.t.sol`.

## 1. Scope and method

| Item | Value |
|:-|:-|
| In scope | `src/CoverManager.sol`, `src/CoverVault.sol`, `src/GaplessAccount.sol`, `src/GaplessFactory.sol`, `src/libraries/*`, `src/cre/*`, `src/Constants.sol`, `src/types/*`, `src/interfaces/*`, `script/Deploy.s.sol`, `script/ListMarket.s.sol`, mock fidelity of `test/mocks/*` |
| Toolchain | Foundry 1.8.3, solc 0.8.37 (via-IR off, osaka), OZ 5.6.1, `network = "monad"` |
| Docs read | INTERFACES.md, CHANGE_REQUESTS.md (CR1 to CR8), S1_NOTES, S2_NOTES, spec 00 (decisions, section 3, invariants), 05 (attack table A1 to A15, section 2.3 to 3.4), 01 (Perpl), memory notes on C0, native stops, AUSD |
| Tests | 381 unit/fuzz pass, 4 invariant suites pass (re-run today), 8 new SA1 PoCs pass |
| Static analysis | Aderyn 0.1.9 (on a temp copy with `cancun`, since 0.1.9 rejects `osaka`); all six "High" detectors triaged as false positives (section 7). Slither not installed |
| Mainnet evidence | Read-only `eth_call`/`cast call` on rpc1.monad.xyz, blocks 110,777,371 to 110,780,610. No transactions, no forks |

Run the PoCs: `forge test` with flag:match-path `test/audit/SA1Audit.t.sol` and `-vv` for the logged numbers.

## 2. Summary

| ID | Severity | Title | PoC |
|:-|:-|:-|:-|
| H-01 | High | Book wick lets a third party force-close covered positions about 1.4% under fair value; vault pays only A | `test_H01_stopHunt_bookWickForcesCloseAtFloor` |
| M-01 | Medium | Operator notional cap bypassed with an off-market sell limit; closes never capped | `test_M01_operatorCap_bypassedByOffMarketSellLimit` |
| M-02 | Medium | Quote checks stop distance against Perpl mark only; covers can be bought after the move is in the oracle, feed or book | `test_M02_quoteUsesMarkOnly_coverBoughtAfterTheMove` |
| M-03 | Medium | Refundable escrow lets owners exit at the stop themselves and keep the cover as free gap insurance (adverse selection) | `test_M03_escrowFullyRefundedWhenOwnerExitsAtTheStop` |
| L-01 | Low | `observe` accepts a single post-trigger source, usually Perpl's mark | `test_L01_observeAcceptsSingleSource` |
| L-02 | Low | Arm squatting blocks the fast path; near expiry it cancels the payout | `test_L02_armSquatNearExpiry_blocksPayout` |
| L-03 | Low | `setMarketParams` applies to live covers; raising A breaks I13 | `test_L03_slipAllowanceChangeAppliesToLiveCover` |
| L-04 | Low | CRE sink `lastSeq` is per kind, shared across perps; one forged kind-3 report drops genuine ones | `test_L04_creSinkSeqCollisionsAndArmedLogGrief` |
| L-05 | Low | A frozen AUSD account bricks expire, void, cancel and finalize for its cover | code review |
| L-06 | Low | Close limit clamped to `uint32` max; Perpl accepts only [1, 16,777,215] (mock hides it) | mainnet `eth_call` |
| L-07 | Low | Remainder retries end at `windowBlocks`; `maxMatches` dust can leave lots uncovered | code review (extends A6 test) |
| L-08 | Low | Owed and triggered liabilities are not in the share price | code review |
| L-09 | Low | Cover capacity can be monopolized cheaply at default rent | arithmetic |
| I-01 to I-10 | Info | Centralization, no per-market pause, stuck donations, cosmetic and ops items | |

No Critical. No path found that drains the vault beyond `min(G_real, max(G_refTrig, G_refPost) + A x SN, maxGap x SN, Cap)` while references are honest. The material risks are to traders (H-01, M-01) and to LP economics (M-02, M-03).

## 3. Findings

### H-01 High: Book wick lets a third party force-close covered positions about 1.4% under fair value; the vault pays only A

**Location**: `src/CoverManager.sol:288-311` (`arm`), `src/CoverManager.sol:323-333` (Armed trigger re-check), `src/CoverManager.sol:700-715` (`_bookCrossed`, `_refWithinTol`), `src/libraries/PayoutMath.sol:16-30` (`closeLimitPNS`), `src/libraries/PayoutMath.sol:67-75` (`boundCNS`).

**Description**: Arming needs only (a) best bid at or below the stop and (b) the reference within `refTolBps` (50) of the stop, which includes references above the stop. The close then sells down to `min(stop, R) x (1 - floorSlack)`, 100 bps under the stop when `R >= stop`. The payout is `min(G_real, G_ref + A x SN, ...)` and `G_ref = 0` when `R >= stop`, so the trader receives only A (5 bps). Anyone who controls the top of Perpl's bid book for two blocks can therefore buy a covered position at the floor. The docs size this residual at `A x N` (05 A3 and A8), but that bound assumed the original floor `R x (1 - A)`; D38 widened the floor to `floorSlack` (100 bps), so the real residual is about 20x larger. A native Perpl stop would not have fired at all (it triggers on mark).

**Exploit scenario** (PoC, spec cap 2,000 AUSD, mainnet BTC bid depth): references stay at fair value 861,740, stop 45 bps under. Block N: the hunter sells about 8,300 lots (~$7.2k) into the bids above the floor, rests a bid one tick above the floor (849,284) and calls `arm` (it is now the exclusive armer). Block N+1: it calls `trigger`; the IOC fills 2,331 lots into the hunter's bid. Measured: trader loss at fair value 28.72 AUSD (1.44% of notional), vault payout 1.00 AUSD (A x SN), hunter +21.98 AUSD marked at fair value and +20.14 AUSD after flattening its residual short and paying fees. The owner cannot react: `arm` sets `PerpLocked`.

Mainnet feasibility: BTC-PERP bids measured today total about $7.1k within 23 bps and $7.4k within 71 bps of the mark (getVolumeAtBookPrice walk at block ~110,777,400), so a sub-$10k sweep moves the best bid through any stop the quote allows (minDist about 11 bps at sigma 27). At the canary cap (50 AUSD per cover) one cover is not worth it; clustered stops or the spec cap are.

**PoC**: `test_H01_stopHunt_bookWickForcesCloseAtFloor`.

**Recommended fix** (pick per product decision; 1 and 2 together are the minimal change):
1. Arm only when the reference is at or through the stop for the book path (`refTolBps` applies to the loss side only), so `G_ref > 0` whenever a book-path close happens.
2. Tie the first close attempt to the reference, not the stop: limit `R x (1 - A)` (05 A1's original floor). Widen to `min(stop, R) x (1 - floorSlack)` only after a `TriggerNoFill` in an earlier block and only if the reference itself is still through the stop.
3. Add a user-side invariant: with honest references, `exit proceeds + payout >= stop x F x s x (1 - fee) - A x SN` (the suite asserts vault-side O1 only, which is why this was not caught).
4. Correct the documented residual in 05 A3/A8 and MECHANISM disclosures.

**References**: OWASP SC02 (price oracle manipulation) and SC03 (logic); SWC-114 (transaction order dependence); Mango Markets 2022 (thin-book manipulation against a payout rule); 05 A3, A8 and C3 in INTERFACES.md.

### M-01 Medium: Operator notional cap bypassed with an off-market sell limit; closes never capped

**Location**: `src/GaplessAccount.sol:252` (cap applied to types 0, 1, 6 only), `src/GaplessAccount.sol:262-267` (`_checkNotional` uses the limit price).

**Description**: The cap is `lotLNS x pricePNS x scale`. For an ask-side order (OpenShort, and Change of an ask) the limit is a floor, so the fill price is at or above the limit and the order's real notional is unbounded by the check. Setting `pricePNS = 1` makes any short pass a cap of 1 CNS per 1 BTC. Closes (types 2 and 3) are uncapped, so the same key can dump a position at any limit. The cap is also per trade, not cumulative.

**Mainnet evidence**: Perpl accepts `pricePNS = 1` for a sell. `eth_call` from account 1's address: OpenShort IOC at 1 PNS succeeds (296,686 gas); the same order with `postOnly` reverts `CrossesBook(1, 1, 1, false, 855634, false)`, proving the 1 PNS limit crosses the best bid; `pricePNS = 0` reverts `PriceOutOfRange(0, 1, 16777215)`. The live BTC book also shows `minBidPriceONS = 1` (a resting bid at 1 PNS), so there is no price band on limits.

**Exploit scenario**: a leaked operator key (Mera-derived `/1` key in a PWA) with a 10 AUSD cap opens a ~8,617 AUSD short at max leverage, or dumps the whole position into a colluding resting bid on a thin book. With a colluder providing the other side at off-market prices, account equity transfers to the attacker in a few transactions; the cap that is meant to bound this does not apply.

**PoC**: `test_M01_operatorCap_bypassedByOffMarketSellLimit` (10 AUSD cap, 10,000-lot short filled at 861,740, then an uncapped close).

**Recommended fix**:
- Price the cap at the worse of the limit and the current mark for ask-side orders: `px = isAsk ? max(limit, markPNS) : limit`, and reject operator orders whose limit is more than X bps from mark (both sides).
- Apply the cap to closes too (or a separate close-slippage bound against mark), and track a rolling cumulative notional per operator (per block window or per expiry).

**References**: OWASP SC01 (access control) and SC04 (input validation); session-key scoping practice in ERC-4337 and ERC-7710 delegations.

### M-02 Medium: Quote checks the stop only against Perpl's mark; covers can be bought after the move

**Location**: `src/CoverManager.sol:474-485` (`_quote`: freshness and `distanceBps` use `info.markPNS` only), `src/libraries/PremiumMath.sol:118-120`.

**Description**: The purchase gate ignores the fresh oracle, the Chainlink feed and the book, all of which the manager already reads for triggers. When any of them already shows the price through the stop while the mark lags (mark publishes on 0.05% moves; Perpl oracle, Perpl mark and the Chainlink Data Feed are pushed by separate actors), the buyer gets a calm-priced cover on a move that has already happened. Warm-up does not help: after 200 blocks the payout is measured against the reference at trigger, so a move that persists is paid in full.

**Exploit scenario** (PoC): long 50 lots; oracle and feed already 2% lower and fresh, mark still at 861,740. Quote accepts a stop 45 bps under the mark although the aggregated reference (`referencePrice`) is 155 bps under the stop. Premium 41,447 CNS; after warm-up the fast path pays 667,619 CNS (16x). Across sybil accounts the exposure per event is bounded only by `marketCapBps` (50% of the vault) times `maxGap`.

**Feasibility**: requires a one-block or longer lag between the mark and another fresh reference, or a book that has already crossed. [NEEDS VERIFICATION] of the typical lag on mainnet; the fix is cheap either way.

**PoC**: `test_M02_quoteUsesMarkOnly_coverBoughtAfterTheMove`.

**Recommended fix**: in `_quote`, compute distance against the least favorable fresh source for the buyer (long: `min(mark, oracle, feed)`; short: max), require `n >= 2` fresh sources, and refuse when the book is already within `minDist` of the stop (long: `bestBid <= stop x (1 + minDist)`).

**References**: OWASP SC02; GMX v1 2022-09 stale price arbitrage (DeFiLlama); 05 A13.

### M-03 Medium: Refundable escrow creates adverse selection against the vault

**Location**: `src/CoverManager.sol:261-273` (`syncCover` voids or resizes with refund), `src/CoverManager.sol:651-669` (`_end`: full escrow refund), `src/CoverManager.sol:671-681` (`_resize`), `src/CoverManager.sol:276-283` (`cancelCover`).

**Description**: The escrow (the only material premium; rent is near `minFeeCNS`) is kept only when the cover triggers. An owner, or the owner's bot, can close the position itself just above the stop in an orderly decline and receive the whole escrow back; the cover then fires only when the market gaps through the stop in one block. 05 section 2.5 justifies the pricing with "vault expected P&L = P(trigger) x (escrow - E[payout | trigger]) + rent, positive whatever the true P(trigger) is, as long as gap[z] is right". That holds only if triggers are exogenous. With owner selection, `E[payout | trigger]` is the mean of gapped hits, not `gap[z]` (05 section 2.3: mean gap given hit 1.94 bps but p99 23.9 bps in the 0 to 0.5 z bucket), while the fee is floored at 5 bps. The vault is underpaid whenever fewer than about two thirds of hits gap.

**Exploit scenario**: buy cover; run a native-style exit at stop + 2 bps; in orderly markets the exit fires first (before the book crosses, so no arm lock) and the escrow is refunded in full; in gaps the cover pays. PoC: book and references 2 bps above the stop, owner closes, cover `Voided`, full escrow back, vault income is 90% of rent only.

**PoC**: `test_M03_escrowFullyRefundedWhenOwnerExitsAtTheStop`.

**Recommended fix**: make part of the escrow non-refundable once the cover is "in the zone": on cancel, void or resize while the reference or best bid is within `refTolBps` (or a new `zoneBps`) of the stop, keep the escrow pro rata as if triggered. Alternatively convert to an upfront premium (05 section 2.5 alternative) priced with `pHit`. Re-run the fit with an owner-exit model before raising caps.

**References**: insurance adverse selection; Nexus Mutual pricing notes (05 section 3.4); OWASP SC03.

### L-01 Low: `observe` accepts a single post-trigger source, usually Perpl's mark

**Location**: `src/CoverManager.sol:348-360`, `src/libraries/ReferenceLib.sol:74-90` (n = 1 returns the value).

**Description**: Observe filters sources by `ts >= triggerTs + 1`, so the first publish after a trigger is typically one source (the mark publishes on 0.05% moves, more often than the oracle). The median protection (D17) therefore rarely applies at observe, and whoever calls `observe` chooses the block. The mark is computed by Perpl's bot from four inputs, two of them Perpl's own book, clamped within 25 bps of spot.

**Exploit scenario**: a claimant with a genuine trigger and a fill below R (book hole or self-deal) pushes Perpl's book after the trigger and calls `observe` in the block where only the mark has republished. PoC: mark-only publish 25 bps lower tops up 107,000 CNS on 50 lots; with all three sources republished the median ignores it (top-up 0). Gain bounded by the 25 bps clamp; requires moving the mark bot. [NEEDS VERIFICATION] of how far book pressure moves Perpl's mark.

**PoC**: `test_L01_observeAcceptsSingleSource`.

**Recommended fix**: require `n >= 2` post-trigger sources for `refPost`, or cap `G_refPost - G_refTrig` at `refTolBps x SN` when `n == 1`.

**References**: OWASP SC02; 05 A2, A4.

### L-02 Low: Arm squatting blocks the fast path; near expiry it cancels the payout

**Location**: `src/CoverManager.sol:319` (expiry check), `src/CoverManager.sol:323-327` (exclusive window applies even when the fast path holds).

**Description**: Once armed, every non-armer trigger reverts `NotArmer` for `exclusiveBlocks`, including when the mark is through the stop (fast path). Arming within `exclusiveBlocks` of `expiryBlock` lets the squatter run the window past expiry; afterwards `trigger` reverts `CoverExpired` and `expire` refunds the escrow with no payout. An LP has a motive (a payout avoided).

**PoC**: `test_L02_armSquatNearExpiry_blocksPayout` (keeper fast path would pay; squatter arms at expiry minus 2; cover expires unpaid with the position through the stop).

**Recommended fix**: let anyone trigger when the fast-path condition holds even inside the exclusive window, and end the window at `min(armedBlock + exclusiveBlocks, expiryBlock - 1)`.

**References**: 05 A7; OWASP SC10.

### L-03 Low: `setMarketParams` applies to live covers; raising A breaks I13

**Location**: `src/CoverManager.sol:425-431`; read at use in `_settle` (`:607-627`), `_closeCall` (`:586-598`), `_effStatus` (`:692-697`), `finalize` (`:363-377`).

**Description**: A, floorSlack, refTol, window, armTtl, exclusive, maxMatches and the per-block cap are read when used. A RISK_ADMIN (deployer hot key) change from A = 5 to 50 lets every live cover pay up to 50 bps x SN on escrow priced at 5 bps, so self-dealing turns profitable (I13 broken for existing covers). Lowering A after a trigger silently forgives `owedCNS` (finalize recomputes `entitled`).

**PoC**: `test_L03_slipAllowanceChangeAppliesToLiveCover` (payout 50 bps x SN, about 9x the escrow).

**Recommended fix**: snapshot A and floorSlack in the cover (slot 0 has 5 free bytes: two `uint16`), and never let a parameter change reduce an already-owed amount. Put RISK_ADMIN behind a timelock or multisig.

**References**: Drift 2022 and dYdX 2023 risk-parameter abuse (05 section 3.4); OWASP SC01.

### L-04 Low: CRE sink `lastSeq` is per kind and shared across perps; kind-3 griefing

**Location**: `src/cre/GaplessCreReceiver.sol:39-41`, `:53-56`.

**Description**: Two kind-1 or kind-2 reports for different perps in the same cron second carry the same `seq`; the second is dropped silently. For kind 3, `seq` is the Armed block, which is always in the past when a DON report lands, while anyone can post `seq = block.number` through the permissionless simulation forwarder; that drops every genuine Armed-log report up to that block. Liveness only (arm and trigger stay permissionless).

**PoC**: `test_L04_creSinkSeqCollisionsAndArmedLogGrief`.

**Recommended fix**: key replay protection by `(kind, perpId)`, and for kind 3 by Armed block plus coverId (a seen-set) rather than a monotonic counter.

**References**: Chainlink CRE consumer guidance (04 section 1.7); OWASP SC10.

### L-05 Low: A frozen AUSD account bricks end paths for its cover

**Location**: `src/CoverManager.sol:646` (`_closeOut` refund), `:663` (`_end` refund), `:679` (`_resize` refund).

**Description**: Refunds are plain `safeTransfer` to the clone. If Agora freezes that clone, `expire`, `voidCover`, `cancelCover`, `finalize` (when a refund is due) and the account's own trades (through `syncCover`) revert. The cover stays in `_live`, its `Cap` stays reserved (LP capacity lost), rent and escrow stay in the manager, and a Triggered cover keeps the perp `PerpLocked`. Not attacker-triggerable (issuer action), but one frozen account pins vault capacity indefinitely.

**Recommended fix**: credit failed refunds to a `refundOwed[account]` ledger (pull) with `trySafeTransfer`, and complete the state transition and `release` regardless.

**References**: SWC-113 (DoS with failed call); OZ `SafeERC20.trySafeTransfer`.

### L-06 Low: Close limit clamped to `uint32` max, but Perpl accepts only [1, 16,777,215]

**Location**: `src/CoverManager.sol:592`; mock `test/mocks/MockPerplExchange.sol:535`.

**Description**: Mainnet `eth_call` on BTC-PERP: limit 16,777,215 accepted, 16,777,216 and 4,294,967,295 revert `PriceOutOfRange(price, 1, 16777215)` (all three perps have `basePricePNS = 0`). A short cover whose close limit `ceil(max(stop, R) x (1 + slack))` exceeds 2^24 - 1 makes every trigger revert deterministically. Not reachable at today's BTC, ETH or MON prices, but the clamp comment is wrong and the mock models the wrong bound, so tests can never catch it (for example a future perp with a high price, or a nonzero base with a range relative to base).

**Recommended fix**: read Perpl's bounds (or `basePricePNS` plus the uint24 ONS range) and clamp to them; reject `listMarket` when the cover price range cannot be expressed. Fix the mock bound.

**References**: 01 section 3.3 (ONS uint24); OWASP SC04.

### L-07 Low: Remainder retries end at `windowBlocks`; dust can leave lots uncovered

**Location**: `src/CoverManager.sol:541-549`.

**Description**: Each close walks at most `maxMatchesClose` (32) resting orders. A spammer who reposts 32 one-lot bids above the real book each block caps fills at 32 lots per trigger call. After 40 blocks the remainder can no longer be triggered and `finalize` refunds escrow for the unfilled lots: the trader is left with an uncovered position through the stop. The keeper can out-trigger the spam (several remainder calls per block), so this is a gas race rather than a free attack, and the existing A6 test only covers a one-shot 40-order spam. Only relevant for covers above about 32 x 41 lots (BTC: about 1,300 lots, ~1,100 AUSD).

**Recommended fix**: keep remainder retries open until expiry while the reference stays through the stop (window only bounds `observe`), and size `maxMatchesClose` against measured Perpl gas.

**References**: 05 A6; SWC-128.

### L-08 Low: Owed and triggered liabilities are not in the share price

**Location**: `src/CoverVault.sol:254-256` (`totalAssets`), `:142` (claim at current value).

**Description**: When the per-block cap defers a payout (`owedCNS`), the liability is known onchain but `totalAssets` does not reflect it until `finalize` pays. A matured redeem request can claim at the pre-payout value (bounded by `freeAssets`) and a new depositor buys shares at an inflated price. Same for premium income recognized only at cover end (rent not vested, S1 risk). Bounded by the deposit lock and the cooldown.

**Recommended fix**: track `owedTotal` in the vault (manager reports deferrals) and subtract it in `totalAssets`; optionally block `claimRedeem` while `owedTotal > 0`.

**References**: EIP-4626 share accounting; 05 A12.

### L-09 Low: Cover capacity can be monopolized cheaply at default rent

**Location**: `src/libraries/PremiumMath.sol:94-106` (`rentCNS`), `src/CoverVault.sol:156-168` (`reserve`).

**Description**: Escrow is refundable on cancel or expiry, so the cost of holding capacity is rent: about 20% APR on Cap times M (up to 2.45 at 80% utilization), floored at 0.02 AUSD per cover. Pinning a 10,000 AUSD vault's 50% market cap costs roughly 15 AUSD per day at the spec cap (125 covers of 2,000 AUSD, renewed every 4 h) plus hedged positions, and blocks all honest cover sales (`UtilizationExceeded`). LPs earn the rent, so it is griefing rather than theft.

**Recommended fix**: a per-owner or per-block cap on new reservations, a higher `minFeeCNS` for long durations, or a cancel fee on escrow.

**References**: OWASP SC10.

### Informational

| ID | Item | Location |
|:-|:-|:-|
| I-01 | One deployer key holds DEFAULT_ADMIN, RISK_ADMIN and PAUSER on both contracts and is the canary treasury; move to a multisig with a timelock before raising caps | `script/Deploy.s.sol:79-82` |
| I-02 | No per-market pause or delist; `MarketConfig.feed` is immutable after listing (a deprecated feed is only tolerated via try/catch) | `src/CoverManager.sol:407-431` |
| I-03 | AUSD donated to the vault or the manager is unrecoverable; `setConfig` accepts `treasury == manager` (breaks I5 equality, harmless) | `src/CoverVault.sol:345`, `src/CoverManager.sol` |
| I-04 | First close uses the raw reference for the limit, remainder closes use the stored `uint32`-clamped `refTrigPNS` | `src/CoverManager.sol:344`, `:548` |
| I-05 | Operators may move free balance into margin (type 5) and the account has no `requestDecreasePositionCollateral` path; margin returns only by closing | `src/GaplessAccount.sol:245-260` |
| I-06 | `housekeeping` makes two external calls per live cover; at 512 covers the `eth_call` may exceed public RPC gas caps under Monad cold-access pricing | `src/CoverManager.sol:156-190` |
| I-07 | `claimRedeem` is all-or-nothing per request; LPs must split requests to exit while utilization is high | `src/CoverVault.sol:143-144` |
| I-08 | CR6 floors in `minDistanceBps` and M are vault-unfavorable by at most 1 bps of distance and 2 bps of M; acceptable | `src/libraries/PremiumMath.sol:44-47`, `:82-86` |
| I-09 | Invariant suite asserts vault-side attacker PnL (O1) only; no trader-protection invariant, which is why H-01 passed | `test/invariant/*` |
| I-10 | Trigger gas at 32 matches is unmeasured on Perpl; Monad bills the limit, so keepers will set tight limits (see section 7: OOG cannot be turned into silent deferral) | S2 risk 1 |

## 4. S2 open risks (S2_NOTES section 5), verified and rated

| # | Risk | Verdict | Rating |
|:-|:-|:-|:-|
| 1 | Trigger gas at 32 matches unmeasured on Perpl | Valid. Must be measured with `eth_estimateGas` before raising caps; an OOG reverts the whole trigger (good) rather than deferring | Medium (operational) |
| 2 | `setMarketParams` applies to live covers | Confirmed and proven (L-03); also forgives owed on a lowered A | Low |
| 3 | Frozen AUSD account blocks end paths | Confirmed (L-05); also pins Cap and the live set | Low |
| 4 | Compromised SIGMA key | Bounded. Sigma 5 drops minDist to the 10 bps floor but pushes z into bucket 8 (fee 14.25 bps), so covers do not get cheaper; sigma 2000 sets minDist about 848 bps (buy DoS). Interacts with M-02 (near stops) | Low |
| 5 | n == 0 at trigger pays at most A x SN | Holds by design (D49). Trader can be closed down to `stop x 0.98 x 0.99` with 5 bps compensation if no source publishes inside the window | Info |
| 6 | AUSD assumed fee-free | Holds for the current implementation; AUSD is an upgradeable proxy, so monitor `Upgraded` | Info |
| 7 | Account must not call `syncCover` from `closeForCover`; `perplAccountId` must stay a view | Both hold in `src/GaplessAccount.sol:180-206` and `:39` | Info |

## 5. S1 open risks (S1_NOTES), verified and rated

| Risk | Verdict | Rating |
|:-|:-|:-|
| Operator trading power within the cap | Worse than stated: the cap is bypassable (M-01) and per trade only | Medium (M-01) |
| `depositWithPermit` with a standing allowance | Confirmed; funds stay the owner's but are forced into Perpl (global withdraw limiter) | Info |
| EIP-7702 owners | Confirmed: OZ 5.6.1 `SignatureChecker` branches on `code.length`, so delegated EOAs go through ERC-1271 | Info |
| Perpl revert in `closeForCover` blocks the trigger | Confirmed; L-06 is a concrete deterministic instance; see mock gaps below | Low |
| Rent not vested | Confirmed; folded into L-08 | Low |
| CRE sink liveness | Confirmed and extended (L-04: cross-perp collisions, kind-3 grief) | Low |
| AUSD assumptions (no fee, no hooks) | Hold today | Info |
| Fee tier index clamp | Holds (8 tiers on schedule 1021) | Info |
| Mainnet deploy cost unmeasured | Still open | Info |

## 6. Mock fidelity (Perpl, AUSD, feed)

| Behavior | Mock | Mainnet evidence (read-only) | Verdict |
|:-|:-|:-|:-|
| Limit price range | [1, uint32 max] (`MockPerplExchange.sol:535`) | [1, 16,777,215], `PriceOutOfRange(p, 1, 16777215)` | Gap; hides L-06 |
| Off-market limits | Accepted | OpenShort at 1 PNS fills; resting bid at 1 PNS exists (`minBidPriceONS = 1`) | Faithful; confirms M-01 |
| Funding sign (`premiumPnlCNS`) | Positive credits the trader | `pnlCNS = deltaPnlCNS + premiumPnlCNS` on live positions (acct 6 perp 1: 34,559,709 = 28,173,884 + 6,385,825; acct 12 perp 10 negative premium reduces pnl) | Faithful; closes the INTERFACES section 11 open item |
| Book depth in fixtures | 200,000-lot walls at the touch | BTC: about $7.1k within 23 bps, $7.4k within 71 bps | Gap; attack suites never model thin books, which hid H-01 |
| Self-match clearing counts toward `maxMatches` | Counts | Unknown | [NEEDS VERIFICATION]; if true, an owner's resting bids can stall its own close |
| Close loss beyond released deposit | Debits free balance, reverts if short | Unknown | [NEEDS VERIFICATION]; a revert would block triggers in deep gaps |
| Resting reduce-only orders vs `CloseOrderExceedsPosition` | Ignored | Unknown | [NEEDS VERIFICATION]; a resting take-profit could make cover closes revert |
| Whitelisting on closes | Closes allowed | Unknown | [NEEDS VERIFICATION] |
| Expired orders in `maxBidPriceONS` | Skipped | Book walk returns levels with zero live volume | [NEEDS VERIFICATION]; if best-bid fields include expired levels, `_bookCrossed` under-arms longs |
| Liquidation | Whole position at mark | Partial liquidation semantics unknown | [NEEDS VERIFICATION] |
| MockAUSD freeze, pause, zero-address credit, "Agora Dollar" domain, ERC-1271 permit | Modeled | Matches memory notes | Faithful; issuer seizure from frozen accounts is not modeled (would break `notifyPremium`'s balance check) |
| MockFeed | Settable answer, timestamp, revert | n/a | Faithful |

## 7. Checked and dismissed

- **OOG griefing through the try/catch around `payCapped` and `creditToPerpl`** (`src/CoverManager.sol:617-622`): not exploitable. Starving `payCapped` (well under 200k gas) leaves at most 1/64 for the remaining SSTOREs and events (tens of thousands of gas), so the whole trigger reverts instead of deferring.
- **ERC-4626 inflation and donation**: internal `_assets`, offset 6 and a 1 AUSD dead seed; donations never move the price. Rounding favors the vault on every path.
- **Async redeem**: `min(assetsAtRequest, valueAtClaim)` holds; escrowed shares keep absorbing losses; claims capped at `freeAssets`; free assets are at least `1 - maxUtilization` at every reservation.
- **Share transferability**: `_update` blocks transfers; request escrow uses `ERC20._update`; vault-held shares cannot be moved.
- **Reentrancy**: per-contract transient guards; AUSD, Perpl and the vault make no callbacks; the manager never calls account hooks inside account frames (C6); LP flows revert on `isSettling` within trigger and finalize.
- **Double payout**: `entitled - paidCNS` with forward-only status; owed recomputed, never added (S2 deviation 2 is correct).
- **Fill inflation**: `filledLots` must equal the measured position delta (`src/CoverManager.sol:596-597`).
- **Signatures**: per-clone EIP-712 domain with chain id, shared `opNonce`, deadlines, low-s ECDSA or ERC-1271 by staticcall; `createAccountFor` replay blocked by one account per owner; CR3 nonce bumps verified.
- **Deploy and init**: constructor-time wiring, admin-only one-time setters, the vault seed approval targets the deployer's own next CREATE address, the implementation is locked (`owner = 0xdEaD`), clones are initialized in the creating call.
- **D13**: `payCapped` requires `isAccount`; refunds only to `cover.account`; `claimRedeem` rejects `address(0)`; withdrawals pay the owner only.
- **Chainlink**: `updatedAt == 0` rejected, answer `<= 0` dropped, staleness per `feedMaxAgeSec`, decimals checked at listing, revert caught; no L2 sequencer feed applies on Monad.
- **Aderyn High detectors**: H-1 arbitrary `from` (`from` is `msg.sender`-checked account or the owner), H-2 unprotected initializer (factory-gated), H-3 unsafe cast (`newLots < c.lots`), H-4 uninitialized state (zero by design), H-5 tautology (analyzer artifact), H-6 unchecked returns (IOC results are re-read by design, D3).
- **Monad specifics**: code sizes far below 128 KB; no payable functions or native value handling; timestamps compared with a 2 s tolerance.

## 8. Mainnet read-only evidence (2026-10-05)

| Call | Result |
|:-|:-|
| `getPerpetualInfo(1)` | pd 1, ld 5, base 0, mark 855,233, best bid ONS 854,535, `minBidPriceONS = 1`, `ignOracle = false` |
| `getPerpetualInfo(10)`, `(20)` | MON pd 6 ld 0 base 0; ETH pd 2 ld 3 base 0 |
| `execOrder` OpenShort 100 lots at 1 PNS, IOC (from account 1) | Success, 296,686 gas |
| Same with `postOnly` | `CrossesBook(1, 1, 1, false, 855634, false)` |
| Limit 0 / 16,777,216 / 2^32 - 1 | `PriceOutOfRange(p, 1, 16777215)` |
| BTC bid walk (getVolumeAtBookPrice, getNextPriceBelowWithOrders) | 6,022 lots at 3 bps, 1,780 at 6, 163 at 23, 163 at 43, 164 at 64, 29 at 71 |
| `getPosition` on accounts 6, 8, 10, 12 | `pnlCNS == deltaPnlCNS + premiumPnlCNS` |

## 9. Priority before mainnet

1. H-01: book-path arm only when the reference is through the stop, and a reference-tied first close floor. Add the trader-protection invariant.
2. M-01: price the operator cap against mark and cap closes; keep operator expiry short meanwhile.
3. M-02: least-favorable multi-source distance check in `_quote`.
4. M-03: decide the escrow model (in-zone retention or upfront premium) before lifting the canary cap.
5. L-06 and the mock price range; L-05 pull-based refunds; L-03 snapshot A and slack.
6. Measure trigger gas on Perpl and resolve the [NEEDS VERIFICATION] mock items with read-only `eth_call` probes.
