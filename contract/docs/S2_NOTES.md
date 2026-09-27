# S2 notes: libraries, CoverManager, ListMarket, invariants (2026-10-05)

> Historical S2 record. Lines marked *superseded* were replaced by C4 to C7 (`docs/C4_FIXES.md`, `docs/C5_FIXES.md`); the code and `INTERFACES.md` are current.

Scope: `src/libraries/{PremiumMath,ReferenceLib,PayoutMath}.sol`, `src/CoverManager.sol`, `script/ListMarket.s.sol`, `test/unit/{PremiumMath,ReferenceLib,PayoutMath,CoverManager*}.t.sol`, `test/unit/stubs/{AccountStub,VaultStub}.sol`, `test/fuzz/{Quote,Payout,Params}.t.sol`, `test/fixtures/{premium,payout}_vectors.json` and generators, `test/invariant/**`.
Docs read first: OZ 5.6.1 `Math` (mulDiv floor plus `Rounding.Ceil` adds 1 when `mulmod > 0`; `sqrt` rounds toward zero; `ceilDiv` panics on 0), `SafeCast` (reverts `SafeCastOverflowedUintDowncast`), `ReentrancyGuardTransient`, `TransientSlot` (pinned source; the OZ site renders client-side). Chainlink Data Feeds API reference: `answeredInRound` is deprecated, `updatedAt == 0` marks an incomplete round, staleness is the consumer's job, `minAnswer`/`maxAnswer` are not circuit breakers.

## 1. Math (brief derivations)

Units: CNS (AUSD 6 dec), PNS (price, pd), LNS (lots, ld), `scale = 10^(6 - pd - ld)`, so `price * lots * scale` is CNS.

Premium (spec 3.5), bit-exact with `backend/src/jobs/premium.ts` (400 seeded vectors, `test/fixtures/premium_vectors.json`):
- `N = lots * stop * scale`; `d = floor((mark - stop) * 1e4 / mark)` (short mirrors; stop on the gain side reverts `StopWrongSide`).
- `minDist = max(minStop, floor(kDistE2 * sigma * sqrt(warmup) / 1e4))`, `z = floor(d * 1e4 / (sigma * sqrt(T)))`, bucket = first edge above z.
- `fee = max(A * 100, ceil(min(cap * 100, gap[i] + floor(impact * N / 1e9)) * (1e4 + load) / 1e4))`.
- `Cap = floor(N * maxGap / 1e4)`; `u = ceil((reserved + Cap) * 1e4 / assets)`; `M = 1e4 + floor(s1 * min(u, kink) / 1e4) + floor(s2 * max(0, u - kink) / 1e4)`.
- `escrow = ceil(N * fee * M / 1e10)`, `rent = max(minFee, ceil(Cap * apr * T * M / (1e8 * BPY)))`.
- I13 holds by construction: `fee >= A * 100` and `M >= 1e4`, so `escrow >= A * N / 1e4`; resizes keep it (ceil on the remaining lots).
- Hand check (unit and backend test): BTC 50 lots at stop 830,825, mark 835,000, sigma 27, 1 h, 1,000 AUSD vault: N 41,541,250, Cap 830,825, u 9 bps, M 10,004, escrow 20,779, rent 20,000.

Reference (spec 3.6): fresh = `ts + maxAge + tol >= now && ts >= minTs` (mark and oracle use `refFreshSec + 2`, the feed `feedMaxAgeSec`, no tolerance). Feed to PNS divides by `10^(feedDec - pd)`, ceil for long covers and floor for short. Median of fresh values; n = 4 takes the middle least favorable to the claimant (higher for long); n = 2 takes max (long) or min (short). Perpl `ignOracle` drops the oracle source. Book and `lastPNS` are never references.

Payout (spec 3.7):
- Close limit, long: `floor(floor(R > 0 ? min(stop, R) : stop * (1 - maxGap)) * (1 - slack))`; short mirrors with max and ceil. Clamped to Perpl's `[1, uint32 max]` (*superseded*: clamp `[1, 16,777,215]` (L-06); the first attempt is floored at `R x (1 - A)` and later attempts step, C4/C5).
- `X = realized - releasedDeposit - funding`; long `G = floor(S * (1e6 - fee) / 1e6) - E_entry - X` where `S = stop * f * s`. Substituting Perpl's ceil fee gives `G = (S - ceil(S * fee)) - (Exit - ceil(Exit * fee))`: the net proceeds lost against a fill at the stop, exactly, with funding cancelling out (fuzzed). Short mirrors with ceil.
- `G_ref = max(0, stop - R) * F * scale` (0 when R = 0). Entitlement `min(G_realCum, max(G_refTrig, G_refPost) + floor(SN * A / 1e4), floor(SN * maxGap / 1e4), Cap)`.
- Escrow split at finalize: `toVault = ceil(escrow * filled / lots)` (C16), refund the rest. Resize keeps `ceil(cap * new / old)` and `ceil(escrow * new / old)`.
- Self-deal with no reference move: `G_ref = 0`, so the payout is at most `A * SN`, which is at most the escrow share kept by the vault.

## 2. CoverManager behavior worth knowing

- Lifecycle as INTERFACES section 4. Armed past `armTtl` reads as Live everywhere (`_effStatus`); re-arming a lapsed cover emits `Disarmed(ArmTtlElapsed)` first.
- `trigger`: Armed path needs `block > armedBlock` (*superseded* in C6: the fast path also runs in the arm block), the armer alone until `armedBlock + exclusiveBlocks`, venue up (else `Disarmed(VenueUnavailable)`), book crossed (empty side counts, C1) and the reference within `refTolBps` (else `Disarmed(ConditionGone)`). Live (or lapsed) uses the fast path only: past warm-up, venue up, fresh mark at or through the stop. A position that is gone, flipped or below the remainder voids the cover (`LiquidatedOrAdl`) with no payout.
- Close is measured, not trusted: the reported `filledLots` must equal the position delta the manager reads itself, else `LotsExceedPosition` (blocks a buggy account from inflating fills).
- CR1: the account measures `realized` as the delta of `balance + locked`; the manager is agnostic and `X` keeps its meaning. Tested with a trader-owned resting bid inside the IOC range (stub and real account): G_real and payout are unchanged, and the balance-only measure under-pays.
- Payouts: `vault.payCapped` and `account.creditToPerpl` in try/catch; a vault failure or block-cap shortfall becomes `owedCNS` (`PayoutDeferred`), paid by later `finalize` calls. A failed credit leaves the AUSD in the account wallet (still paid).
- Refunds in cancel, expire, void, resize and finalize are plain transfers to the clone (C6). Rent and the kept escrow go to the vault through `notifyPremium`.
- `isSettling` is a transient flag across `trigger` and `finalize` (vault blocks LP flows on it). All mutators are `nonReentrant` (transient); re-entry from the account hook reverts.
- `watchList` and `housekeeping` inspect at most 512 live covers per call (rotating by block number beyond that); `max` is capped at 512. The live set is OZ `EnumerableSet` (O(1) removal).
- `quote` mirrors the vault's utilization and market-cap checks (reverts with the vault errors) so the plugin sees the same failure as `openCover`; the vault stays authoritative.

## 3. Deviations from the spec or INTERFACES (CR5 to CR8)

| # | Deviation | Why |
|:-|:-|:-|
| 1 | `minDistanceBps` and `M` floor (INTERFACES 7 said ceil) | Spec 3.5 literal and premium.ts parity required; at most 1 bps distance and 2 bps of M (CR6) |
| 2 | Spec trigger line `owe = Pnow - paid + owed` double-counts owed | Implemented `owe = entitled - paid` (finalize's own formula) |
| 3 | Armed trigger proceeds with no fresh reference (n == 0) | D49 and the task: closes must work in an oracle outage. R_trig = 0 bounds the payout to A x SN, covered by the escrow; observe can top up once a source publishes (CR7a) |
| 4 | Early finalize needs `observed` and a full fill | Otherwise anyone could finalize after the first publish and strip the remainder retries (CR7b) |
| 5 | Liquidation buffer uses the deposit pro rata to covered lots | Equal to the spec for a full cover, stricter for a partial one (liquidation is whole-position) |
| 6 | `listMarket` checks Perpl pd/ld, `scale`, `feed.decimals()`, feed code, rejects `creRefStore != 0` | A decimals mismatch would mis-price every reference; no frozen store interface exists (CR7d) |
| 7 | `postSigma` out of bounds reverts `ParamOutOfBounds(33)` | No F_* index exists (CR5) |
| 8 | References above uint32 max are clamped when stored | Never DOS a trigger; long G_ref is 0 there, short G_ref only shrinks |
| 9 | `trigger` reverts `CoverExpired` after `expiryBlock` even if armed earlier | Spec I9 ("before expiry"); housekeeping expires it |

## 4. Tests

- Unit: PremiumMath 14 (hand vectors plus premium.ts parity), ReferenceLib 9, PayoutMath 10 (hand vectors plus 2,000 vectors from an independent Python reference, `test/fixtures/gen_payout_vectors.py`), CoverManager 63 (every transition and revert, every ParamOutOfBounds cross-field index, both book sentinels on both sides), attacks 16, gas 5, integration on S1's real stack 4.
- Fuzz: Quote 5 (monotone in lots and utilization, rent in duration, minDist in sigma, I13 and ceil/floor directions), Payout 8 (G_real closed form both sides, funding neutrality, bound below each term, split and resize rounding, limit tied to the reference), Params 2 (every field below and above its bound and at both edges).
- Escrow is not monotone in sigma or duration: z crosses buckets of a fitted, non-monotone gap table (194, 91, 101, ...). Only rent is tested against duration.
- Attack coverage: A1 self-deal (payout = A x SN, attacker PnL < 0, also with sigma at its floor), A2 first post-trigger publish only, A3 book push without reference, A4 single-source skew, A5 lock window, A6 32-match dust spam, A7 arm squatter, A9 re-entry and settling flag, A11 correlated crash with per-block cap and deferral, A12 donation inert, A13 warm-up and stressed minDist, A15 halt, liquidation race and ADL, sigma staleness gates buys only, CR1 resting order.

Invariant harness (`test/invariant/`): GaplessFixture with `useRealManager = true` (S1's Deploy.s.sol, real CoverVault, GaplessFactory, GaplessAccount), ListMarket, six handlers (LP, Trader, Keeper, Market, Attacker, Admin). Because the frozen `max_block_delay = 50000` puts a random block gap between calls, lifecycles are also exercised atomically (`armAndTrigger`, `gapAndSettle`, `freshCoverGap`, attacker `selfDeal`). Handlers model a heartbeat publisher (republish unless the market handler declares an outage) and the keeper's on-demand sigma post. CR1 is covered by `TraderHandler.restOwnBid` and the attacker's `ownBid`; CR4 is S1's sink and has no manager surface (its unit tests are S1's).

O1 is asserted on the vault-side attacker PnL (payouts received minus escrow kept minus rent, per episode and summed). The mark-to-market of both colluding accounts is reported only: it also includes trades against the harness market maker's stale quotes, which are not vault losses.

Results (2026-10-05, real S1 stack, profile 64 runs x 200 depth via inline config, fixed seed `0x6761706c657373`; `long` keeps 2048 x 500 for background runs):

| Check | Result |
|:-|:-|
| I1 solvency, I2 payout bound, I3 single active plus forward-only, I4/O2 block cap and owed == 0 at finalize, I5 custody, I6 share price on deposit and claim, I7 reserves and live set, I8 claim rules, I9 trigger preconditions, I10 cover within position, I11 isolation, I12 exclusive window, I13 escrow floor | pass (12,800 calls) |
| O1 vault-side attacker PnL <= 0 (assert) | pass; summed episodes about -0.17 AUSD in the final run |
| O1, O2 optimization mode | best 0 for both (no profitable episode, no block over its cap) |
| Scenario sweep (48 steps, checks after each) | pass: 21 covers, 11 honest triggers, 12 finalizes, 8 attack episodes (7 triggered), attacker protocol PnL -165,504 CNS, best MTM episode negative |

## 5. Open risks

*Superseded*: items 1 to 3 were closed by C4 and C5 (`maxMatchesClose` 16 with trigger 1.42M on the mock; A, floorSlack, minDistance, warmup and window snapshotted per cover; frozen-AUSD refunds become `refundOwed` plus `claimRefund`).

1. Gas: `trigger` measured 675K (one level) and 1.0M (eight levels) in the mock under Monad pricing; a 25-level walk reached 1.98M because the mock book is O(n) per level. The 1.5M budget at `maxMatchesClose = 32` must be measured on Perpl (no forks allowed here). Lower `maxMatchesClose` toward 16 if it does not fit.
2. `setMarketParams` applies to live covers (A, slack, tolerances, windows, caps). A can move a live cover's bound within [5, 50] bps. Disclose or snapshot in v2.
3. A frozen AUSD account makes refunds revert, so expire, void, cancel and finalize stay blocked for that cover (its reserve stays locked) until unfrozen. Payouts defer instead of reverting.
4. A compromised SIGMA key can post the floor sigma (5): covers get cheaper and minDist shrinks, but the fee floor keeps self-deals NPV-negative.
5. With n == 0 at trigger the payout is A x SN until a source publishes within the window; a long outage leaves the trader with a native-stop-like close.
6. AUSD is assumed fee-free (no balance-delta check on the premium pull).
7. The real account must not call `manager.syncCover` from `closeForCover` (manager lock) and must keep `perplAccountId` a plain view (the manager reads it inside the account's own lock during `openCover`). Both hold in S1's code today.
