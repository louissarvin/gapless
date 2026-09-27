# SA3: Gapless contracts re-audit after the C5 fix round

Date 2026-10-06. Target: Monad mainnet (chain 143), real AUSD, Perpl Exchange 1.7.5. Final contract gate before the single canary deploy (addresses freeze afterward; the canary becomes v1).
Auditor: solidity-auditor (SA3). `src/` unmodified. New PoCs: `test/audit/SA3Audit.t.sol` (8 tests). SA1 and SA2 regression suites re-run as-is.

## 1. Scope and method

| Item | Value |
|:-|:-|
| In scope | Every C5 change: stepped close floor (`_step`, `_chain`, `_resetChain`, `_closeLimit`, `_allowanceBps`, lapsed-arm path in `trigger`), unified post-expiry `Expired` path (`_end`, `cancelCover`, `syncCover`, `voidCover`, `isLocked`), per-cover snapshots (`minDistanceBps`, `warmupBlocks`, `windowBlocks`), operator leaky bucket (`_checkOperator`, `_chargeOperator`, `_opUsed`, `operatorUsage`, `_buyCover`, both typehashes, factory digest), `PremiumMath.rentFloorCNS`, `_marketSoft` / `_tryPosition` / `VenueUnavailable`, CRE canonical seen-set key, `Deploy.s.sol`, `ListMarket.s.sol` three sessions |
| Docs read | `audit/SA2_REPORT.md`, `docs/C5_FIXES.md`, `docs/CANARY_PARAMS.md`, `CHANGE_REQUESTS.md` CR20 to CR28, `INTERFACES.md` sections 4 and 5, `memory/solidity_audit_sa1_2026-10-05.md`, `gapless/05` section 10 |
| Toolchain | Foundry 1.8.3, solc 0.8.37, OZ 5.6.1 |
| Tests | `forge test`: **471 passed, 0 failed** (C5's 463 plus SA3's 8). Independent invariant campaign `GaplessInvariantTest`, profile deep, 32 runs x 500 calls, fresh seed `0x53413301`: pass (88 s) |
| Static analysis | Aderyn 0.1.9 on a cancun copy: the six "High" detectors are the same false positives as SA1/SA2 (premium `transferFrom` from the calling account, factory-only `initialize`, `uint40(newLots)` below old lots, ignored `_disarm` / `execOrder` returns by design) |
| Mainnet evidence (read-only) | rpc1.monad.xyz block 110,808,266: gas price 102 gwei; Chainlink BTC/USD 85,268.99 (29 s old). Monad docs: 128 KB code limit (CoverManager 47.5 KB fits), gas charged on gas limit, no global mempool |

Run: `forge test` with flag:match-path `test/audit/SA3Audit.t.sol` and `-vv` for the logged numbers.

## 2. Summary

### SA2 findings

| ID | Verdict | Evidence |
|:-|:-|:-|
| N-01 | **Fixed.** A short attempt only widens attempts within 3 blocks; arm, disarm and a lapsed arm clear the chain; one step per block regardless of callers | `SA2Audit: test_N01_*` (5) now assert the safe behavior; `SA3Audit: test_SA3_I2` (direct calls plus the CRE sink with the same id three times per block: one step per block) |
| N-02 | **Fixed.** Past expiry every end path is `Expired`, refund iff `armedBlock == 0`, no Perpl, price, sigma or param read. `armedBlock` is written only by `arm` and never cleared, so nobody can make an armed cover look unarmed. Pre-expiry zone uses the purchase-time `minDistanceBps` | `test_N02_*` (3); review of `_end`, `cancelCover`, `syncCover`, `voidCover`, `expire`. Residual: SA3-01 |
| N-03 | **Fixed.** Leaky bucket charged on every operator order except types 4 and 5 and on operator cover buys; math checked (no overflow, decay rounds down, `used <= cap` after every charge); both typehashes and the factory digest carry the 4th field; replay bound by `opNonce` (account) and `AccountAlreadyExists` (factory) | `test_N03_*` (2), `GaplessAccount: test_N03_budget_*` (4). Info: SA3-I4, SA3-I5 |
| N-04 | **Mitigated as documented**, but the "k consecutive blocks of empty book" premise does not hold for covers larger than `maxMatchesClose` lots (SA3-02) | `test_N04_*` (2); `test_SA3_02` |
| N-05 | **Fixed.** I14 no longer reads `shortBlock`; the campaign passes on a fresh seed | invariant run above |
| N-06 | **Fixed.** Key is `keccak256(abi.encode(decoded fields))`; `abi.decode` rejects dirty `uint8`/`uint64`, so the encoding is canonical | `test_N06_creSeenSet_trailingBytesDoNotReplay` |
| N-07 | **Fixed.** Numbers re-derived (section 4) | `test_N07_canarySizing_boundary` |
| N-08 | **Fixed.** `cancelCover` and `syncCover` refunds and `housekeeping` read Perpl softly; `voidCover` reverts `VenueUnavailable` before expiry and needs no Perpl after; `expire` reads nothing external but AUSD. OOG grief on the new try paths is not viable (the catch path still does two transfers, two vault calls and set edits, so it needs about 150k of the 1/64 left, which implies more than 9M forwarded). Frozen-account payouts unchanged and accepted | `test_N08_perplViewRevert_endPathsDoNotBrick`; review |
| L-03 remainder | **Fixed.** `warmupBlocks` (max 2,000, fits `uint16`), `windowBlocks` (max 200, fits `uint8`), `minDistanceBps` (max 8,800 at kDist 1,000, sigma 2,000, warmup 2,000; fits `uint16`) snapshotted; no live reads left besides the C5 table, which I agree with | grep of `CoverManager.sol`; `test_L03_warmupAndWindowSnapshotted` |
| L-09 | **Fixed.** `rentFloorCNS = minFee x ceil(T / 12,000)`, integer, no rounding against the vault, max 4e6 | `PremiumMath: test_rentFloor_perStartedPeriod`. Backend `premium.ts` still lacks the floor (section 6) |
| Info (I-01 Deploy, ListMarket key) | **Fixed.** Pending admin asserted on both contracts; LP session refuses a RISK_ADMIN key | `Deploy: test_splitRoles`, `ListMarketScript: *` |

### New findings

| ID | Severity | Title | PoC |
|:-|:-|:-|:-|
| SA3-01 | Low | An arm in the expiry block can never lead to a trigger, yet it blocks that block's fast path and forfeits the escrow; the keeper's own `watchList` recommends it | `test_SA3_01_armInExpiryBlock_blocksFastPath_unpaidAndForfeited`, `test_SA3_01b_watchListRecommendsArmInExpiryBlock` |
| SA3-02 | Low | A match-limited attempt counts as "short": 1-lot dust at the top of the book walks the chain to floorSlack while honest depth stays untouched | `test_SA3_02_dustWalksChain_thenAtomicSweepAtFloorSlack` |
| SA3-I1 | Info | A third-party arm mid-touch resets the chain and costs the fast path one block (trader-favorable floor, liveness only) | `test_SA3_I1_armMidTouch_resetsChainAndDelaysFastPathOneBlock` |
| SA3-I2 | Info | One step per block holds for any caller mix | `test_SA3_I2_chain_oneStepPerBlock_viaSinkAndDirect` |
| SA3-I3 | Info | Capped chain: a same-block retry at k = 6 falls back to k = 5 (`shortSteps` stored capped) | `test_SA3_I3_cappedChain_sameBlockRetryDropsOneStep` |
| SA3-I4 | Info | Operator decay is recomputed with the current cap over the whole elapsed time, so a grant change rewrites history | `test_SA3_I4_budgetDecayRetroactiveOnGrantChange` |
| SA3-I5 | Info | Operators (even with a zero budget) can still `cancelCover` (SA2 N-03 recommendation not applied) | `test_SA3_I5_zeroBudgetOperatorCanStillCancelCover` |
| SA3-I6 | Info | Params and ops notes (floorSlack < 2A allowed, ListMarket env truncation, Deploy `_check` gaps, keeper MON at gas-limit pricing) | section 5 |

No Critical, High or Medium. The vault-side bound `min(G_real, G_ref + A x SN, maxGap x SN, Cap)` holds on every path; both Lows are trader-side and bounded by the cover.

## 3. New findings

### SA3-01 Low: arming in the expiry block blocks the fast path and forfeits the escrow, with no possible trigger

**Location**: `src/CoverManager.sol:310` (`arm` accepts `block.number == expiryBlock`), `:340-341` (`trigger` reverts `TooEarly` whenever `block.number <= armedBlock`, before looking at the fast path), `:335` (`trigger` reverts `CoverExpired` past expiry), `:780` (expiry refund iff never armed), `:1025-1031` (`_watchKind` lists arm candidates in the expiry block).

**Description**: `trigger` needs `block.number > armedBlock` and `block.number <= expiryBlock`, so an arm at `expiryBlock` can never be followed by a trigger. It still (a) makes any fast-path trigger in the same block revert `TooEarly`, and (b) sets `armedBlock`, which C5 made the sole criterion for forfeiting the escrow at expiry.

**Attack path** (PoC, 50 lots, R 30 bps through the stop, honest bid at R, `block.number == expiryBlock`):
1. Control: the keeper's fast-path `trigger` fills 50 lots at R and pays 0.1287 AUSD.
2. Attack: a third party calls `arm` first in the same block (genuine touch, book at R, so `crossed && _through`). The keeper's `trigger` reverts `TooEarly(expiry + 1)`; one block later `trigger` reverts `CoverExpired`; `expire` emits `EscrowForfeited`. Payout 0, position still 50 lots, 30 bps through the stop, uncovered.
3. Honest variant (`test_SA3_01b`): with the mark lagging above the stop (common on mainnet, BTC mark ages to 45 s), `watchList` returns the cover in `toArm` in the expiry block. The protocol keeper arms it, which can never trigger, and the never-armed refund becomes a forfeit.

The same `TooEarly` ordering costs one block of fast path at any time (SA3-I1); only in the expiry block is it final.

**Impact**: trader loses the payout for a touch in the last block (bounded by Cap) and the escrow (canary: about 0.01 AUSD). Needs a genuine touch exactly in the expiry block and, for the hostile variant, ordering ahead of the keeper (Monad has no global mempool, so this is leader or priority-fee ordering). Vault unaffected (it gains).

**Recommended mitigation** (two lines):
```solidity
// arm: an arm in the last block can never be followed by a trigger.
if (block.number >= c.expiryBlock) revert CoverExpired(c.expiryBlock);

// trigger: the fast path is single-block by design, so the arm block must not block it.
if (!fast && block.number <= c.armedBlock) revert TooEarly(uint256(c.armedBlock) + 1);
```
Mirror the first in `_watchKind` (no arm candidates at `block.number >= expiryBlock`). Without the code change, the keeper must never arm in the expiry block (one-line keeper rule).

**References**: SWC-114 (ordering), OWASP SC03 (business logic); sibling of SA1 L-02.

### SA3-02 Low: match-limited attempts extend the chain, so dust replaces "k blocks of empty book"

**Location**: `src/CoverManager.sol:633` (`_chain(c, through && r.filledLots < lots, k)`), `:664` (`maxMatchesClose` per close), `INTERFACES.md` section 4 residual and `gapless/05` section 10 A3.

**Description**: An attempt is "short" when it fills fewer lots than requested. That happens either because the book above the step floor is thin (the case the stepped floor is meant for) or because the IOC used up `maxMatchesClose` (16) matches. A third party can produce the second case without touching honest liquidity: rest 16 one-lot bids at the top of the book before the keeper's attempt. The trader fills 16 lots at R (good fills), the attempt is short, the chain advances one step. Repeat for 5 blocks, then in one transaction sweep the honest bids above floorSlack, rest a bid just above it and call `trigger`: the remainder fills at `min(stop, R) x (1 - floorSlack)`.

**PoC** (2,331 lots, about 2,000 AUSD at the stop; mainnet-shaped honest book with 6,022 lots 3 bps under R): control fills everything at R minus 3 bps on the first attempt. With dust: steps 1 to 5 in five blocks, 80 lots filled at R, honest depth never touched; step 5 fills the remaining 2,251 lots at the 100 bps floor. Trader shortfall against `R x (1 - A)`: **18.34 AUSD** (payout stays `A x SN` because R == stop). This is the SA2 N-01 economics, reached without keeping the book empty for five blocks, which is the premise the A3 residual relies on.

**Conditions**: the dust must land before the keeper's attempt in each of 5 blocks and survive other sellers in a falling market; the keeper must not retry in the same block after the dust is consumed (a same-block retry reuses the step and fills from honest depth). Reaching step k needs `lots > 16 x k`, so step 5 needs more than 80 lots. Canary (`maxCoverNotionalCNS` 20 AUSD, at most 32 lots): at most step 1, shortfall under 0.01 AUSD. In the mock (and per Perpl's `ClearingSelfMatchingOrder`) a self-match also counts as a match with no fill, so the trader can stall his own close the same way (option value only, bounded by Cap).

**Recommended mitigation**: extend the chain only for liquidity-limited attempts; leave it unchanged for match-limited ones.
```solidity
// N-04: only a thin book (nothing left at or above the limit) advances the chain; dust or self-match does not.
bool short_ = r.filledLots < lots;
if (!(short_ && through && !_bookThin(c, limit))) _chain(c, through && short_, k);

function _bookThin(Cover storage c, uint256 limit) internal view returns (bool) {
    (uint256 book, bool empty) = ReferenceLib.bookPNS(IPerplMin(EXCHANGE).getPerpetualInfo(c.perpId), c.isLong);
    return empty || (c.isLong ? book < limit : book > limit);
}
```
If expired levels show in `maxBidPriceONS` (still unverified on Perpl), this errs toward not widening (liveness, never trader loss). Without the code change: keep `lots per cover <= 5 x maxMatchesClose` when raising caps (at BTC 85,000 and 16 matches that is about 68 AUSD of notional; `maxMatchesClose` 200 moves it to about 850 AUSD at higher trigger gas), and have the keeper retry once in the same block after a partial fill.

**References**: OWASP SC03; SA2 N-04; SA1 L-07 (same match budget).

## 4. Canary configuration check (`docs/CANARY_PARAMS.md`)

| Claim | Check | Verdict |
|:-|:-|:-|
| `TA_min = ceil(10 x Cap x 1e4 / marketCapBps)` | `_checkCapacity`: `shareLimit = floor(floor(TA x mc / 1e4) x 1000 / 1e4)`; at mc 10,000 this is `floor(TA / 10)`, so Cap <= floor(TA / 10) iff TA >= 10 x Cap. The vault's own `reserve` checks gross `_assets` and has no share rule, so the manager is the binding check | Correct |
| 20 AUSD at maxGap 200: Cap 0.4, TA_min 4 AUSD at mc 10,000 | 20e6 x 200 / 1e4 = 400,000; 10 x 400,000 = 4e6; vault 1 seed + 3 LP = 4e6 | Correct, zero headroom: any LP loss or a later owed payout (net `totalAssets`) makes a full 20 AUSD quote revert `CoverShareExceeded` (safe) |
| <= 32 lots while stop >= 62,500 | `lots <= floor(20e6 / stopPNS)`; 32 lots up to stopPNS 625,000; 33 lots first possible below 606,061 (60,606 USD) | Correct and conservative. BTC is 85,269 (36% headroom) |
| Demo 22 lots, stop 50 bps under, Cap <= 0.4 up to stop 90,909 | 22 x stopPNS x 200 / 1e4 <= 400,000 iff stopPNS <= 909,090 | Correct; above about 91,370 BTC pick fewer lots (quote reverts, nothing spent) |
| Escrow about 0.010, rent 0.020 | stop 84,575: N 18.61 AUSD, d 50 bps, minDistance 11, z 169 (bucket 3, 1.43 bps loaded below A), fee = A = 5 bps, util 9.3%, M 1.0465: escrow 0.0097; raw rent about 0.0000085, floor 0.02 | Correct |
| D40 at 10x passes, 20x fails | loss 0.0935 + Cap 0.372 = 0.466; limit 40% of 1.87 = 0.748 (10x) vs 0.374 (20x) | Correct |
| Keeper: up to 5 no-fill steps plus ceil(22 / 16) = 2 fill calls | Steps 5, 10, 20, 40, 80, 100 bps. Holds when the book has depth at the step-5 floor; otherwise retries continue every block at floorSlack until the book refills, and the remainder must finish within the 40-block window | Correct as a best case; see MON note |
| Operator grant 25 per trade, 100 per day, hours | Colluder drain about 4.9% of charged notional: at most about 5 AUSD per day of the trader's 10 | Correct |

**MON at gas-limit pricing.** Monad charges `gas_bid x gas_limit`. At the observed 102 gwei, a trigger sent with a 2M limit costs 0.204 MON whether it fills or not; the worst case above (7 calls) is about 1.4 MON, and an empty book at floorSlack burns 0.2 MON per block. With about 3 MON left after deploy, set per-call limits from `eth_estimateGas` plus a small margin, cap attempts per touch, and keep retries no further apart than 3 blocks (the chain gap) rather than every block once at floorSlack.

**Residual risk at the canary configuration**

| Risk | Max impact | Likelihood | Rating |
|:-|:-|:-|:-|
| LP loss in a gap (all capacity used) | utilization 80% of 4 AUSD = 3.2 AUSD (8 covers at Cap 0.4; any user can buy) | Low | Low |
| Trader exit under `R x (1 - A)` (N-04 / SA3-02) | steps need empty book (SA3-02 gives at most step 1 at 32 lots): at most 95 bps of 20 AUSD = 0.19 AUSD | Low, not hunter-profitable at this size | Low |
| SA3-01 last-block arm | Cap of one touch (<= 0.4) plus escrow 0.01 | Very low (touch in the expiry block) | Low |
| Leaked operator key | about 5 AUSD per day of a 10 AUSD account | Low | Low |
| D49 outage close at `stop x 0.98 x 0.99` | about 3% of 20 AUSD = 0.6 AUSD trader-side | Very low (Chainlink stale 120 s plus Perpl refs stale) | Low |
| Keeper out of MON mid-touch | cover unpaid until refunded; trader exposed | Medium (gas-limit pricing, 3 MON) | **Medium (operational)** |
| Trigger gas on real Perpl unmeasured (SA2 condition 4) | a reverting trigger leaves the cover unclosed | Unknown | Medium (operational), unchanged |

## 5. Info

**SA3-I1** (`CoverManager.sol:324`, `:341`): `arm` resets the chain and its block blocks the fast path (`TooEarly`), then the armer holds a 3-block exclusive window on the non-fast path. A third party can reset a running chain once per armTtl; this tightens the trader's floor and delays the close by up to 1 + `exclusiveBlocks` blocks. The trader arming its own cover gets a 1 s look-ahead option bounded by Cap. Fixed together with SA3-01 by letting the fast path run in the arm block.

**SA3-I2**: verified that steps only advance when `shortBlock != block.number`: three direct calls plus a sink report carrying the same id three times give one step per block.

**SA3-I3** (`_step`, `:694`, and `_chain`, `:702`): `shortSteps` is stored as `min(k + 1, 6)`, so a same-block retry after an attempt at k = 6 reads k = 5. With floorSlack 300 and A 5, the retry's floor is 160 bps instead of 300. Trader-favorable; store the attempt's k separately or document.

**SA3-I4** (`GaplessAccount._opUsed`, `:316`): decay is `cap x (now - _opUsedAt) / 1 day` with the *current* cap. A new grant with a lower cap re-decays the elapsed time at the lower rate (PoC: 12 h after an 86 AUSD charge, used drops to 36 under the old 100/day grant, jumps back to 76 under a 20/day grant, so the new key is blocked for about 3.3 days); a higher cap refills retroactively. Owner-only, not exploitable. Checkpoint in `_setOperator`: `_opUsedCNS = _opUsed(old cap); _opUsedAt = now` before replacing the grant.

**SA3-I5** (`GaplessAccount.cancelCover`, `:130`): operators can still cancel covers (no budget charge; works at budget 0). A leaked key can strip protection before a move and forfeit the escrow in the zone. Restrict `cancelCover` to the owner or accept and disclose.

**SA3-I6 (params, scripts, ops)**
- `_checkParams` allows `floorSlackBps` (min 10) below `2 x slipAllowanceBps` (max 50): step 1 is then tighter than step 0. Add `floorSlack >= 2 x A` or document.
- `ListMarket._envConfig` casts env overrides with `uint16(...)` / `uint80(...)`: a mistyped `MARKET_CAP_BPS=75000` truncates to 9,464 and passes `_checkParams`. Use `SafeCast` or `require` on the raw value.
- `Deploy._check` does not assert `SIGMA_ROLE` on the keeper or `config().treasury`; `ListMarket.run` preflight covers SIGMA. Wiring order is safe: every wiring call is DEFAULT_ADMIN-only and one-time (`setFactory`, `setManager`), so a broadcast that stops part way leaves nothing anyone else can finish or hijack; re-run from scratch (costs another 1 AUSD seed and the MON). `deployCode` is broadcast as a normal CREATE (Foundry cheatcode reference).
- Chain persistence: an intervening recovery with no executed attempt does not end a chain within the 3-block gap (accepted, about 1 s).
- `_end` and `_resize` still revert if AUSD freezes the vault itself (`_toVault`): every end path and owner trades with an active cover would brick. Issuer trust assumption; monitor.

## 6. Outside `src/` but gating the canary

| Item | State | Effect if not done |
|:-|:-|:-|
| Relay EIP-712 `CREATE_ACCOUNT_TYPE` (`backend/src/relay/sponsor/eip712.ts:8`), zod grant schema, sponsor service, PWA SetOperator | Still the 4-field C4 type without `maxNotionalPerDay` | Every sponsored `createAccountFor` reverts `BadSig`; demo onboarding broken (safe, not exploitable) |
| `backend/src/jobs/premium.ts` rent floor (CR25) | Missing `minFee x ceil(T / 12,000)` | Backend quotes lower than onchain for T > 12,000; buys with that `maxPremium` revert `PremiumTooHigh` (safe). Demo uses 12,000 |
| Keeper rules | New | Never arm at `block.number >= expiryBlock` (SA3-01); retry once in the same block after a partial fill (SA3-02); gas limits from estimates and an attempt cap (MON) |

## 7. Go / no-go

**GO for the single canary deploy.** No Critical, High or Medium in the contracts; every SA2 item is fixed or mitigated as documented, and the C5 changes introduce two trader-side Lows bounded at canary size (SA3-01 needs a touch in the last block; SA3-02 reaches at most step 1 at <= 32 lots).

**Must-fix in contracts before deploy**: none.

**Strongly recommended before the address freeze** (small, isolated, cannot be added after v1 is frozen):
1. SA3-01: reject `arm` at `block.number >= expiryBlock` and let the fast path run in the arm block (2 lines plus the `_watchKind` mirror).
2. SA3-02: advance the chain only when the book is thin at the limit (one extra Perpl view per short attempt).
If either is applied, invert the matching `SA3Audit` tests and re-run the suite and one deep invariant chunk. If neither is applied, the v1 constraint is: lots per cover <= 5 x `maxMatchesClose` when raising caps, plus the keeper rules in section 6.

**Canary conditions**:
1. Relay and PWA typed data updated to the 4-field grant before onboarding anyone (section 6).
2. Keeper: no arm in the expiry block, same-block retry after a partial fill, gas limits from estimates, attempt cap; keep at least 2 MON for the keeper after deploy.
3. Measure trigger gas on Perpl with `eth_estimateGas` from a real account before the first cover (SA2 condition 4, still open).
4. Operator grants at the CANARY_PARAMS values (25 per trade, 100 per day, hours).
5. ADMIN accepts the default admin transfer on both contracts after `ADMIN_DELAY`; confirm `defaultAdmin()` on both before listing.
