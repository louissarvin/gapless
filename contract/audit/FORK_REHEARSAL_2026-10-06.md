# Canary fork rehearsal (2026-10-06)

One-time, user-approved rehearsal of the real canary deploy and a full demo lifecycle on a local anvil fork of Monad mainnet. Nothing was broadcast to Monad. No file under `src/`, `script/` or any frozen file was changed; scripts ran from a byte-identical sandbox copy (`/tmp/fr/contract`, runtime and initcode hashes equal to `contract/out` for all five contracts) so no `broadcast/` artifact for chain 143 exists in the repo.

**Verdict: GO for the real canary deploy (Deploy.s.sol and the three ListMarket sessions as written in RUNBOOK sections 4 to 9).** No bug in the audited contracts or in the deploy scripts. Before the first cover is sold, fix the RUNBOOK section 11 `perpl` helper (finding F1, it produces a false FAIL of the SA4-02 pre-sale check) and update the trigger gas model numbers (F2). F3 to F6 are doc or operational updates.

## 1. Setup

| Item | Value |
|:-|:-|
| Toolchain | forge and anvil 1.8.3 (cae51ad), solc 0.8.37, `network = "monad"` |
| Fork | `anvil` with flag:fork-url `https://rpc3.monad.xyz`, flag:chain-id 143, flag:network monad, flag:auto-impersonate; fork block 111,045,027 (ts 1791291806), killed cleanly at the end |
| Mirror check | Exchange impl `0xa9ab97a4...1b2a`, not halted, no whitelisting, min open 10e6; BTC perp pd 1, ld 5, status 4, base 0, mark 861,407, oracle 861,554, bid 861,389, ask 861,518, 227 orders, `refPriceMaxAgeSec` 60, `priceTolPer100K` 5000; feed 86,152.99, decimals 6 AUSD |
| Gas fidelity | fork vs live `eth_estimateGas` from the same sender: AUSD approve 70,464 vs 70,882 (0.6% low), transfer 71,833 vs 72,701 (1.2% low), `getPerpetualInfo` 52,480 vs 53,219 (1.4% low). Monad cold-access repricing is applied (a plain Ethereum approve is about 46k). Treat fork gas as up to 1.5% below live |
| Clock | blocks share seconds like Monad (`anvil_setBlockTimestampInterval 0`); timestamps set per block, first at 0.4 s, then re-anchored to real mainnet timestamps at the measured **0.30 s per block** (1,560 blocks in 474 s) |
| Wallets | throwaway fork-only addresses (keccak of public labels), impersonated; MON by `anvil_setBalance` at RUNBOOK amounts (deployer 2.4, LP 0.1, keeper 5, relay 1.3); AUSD by `transfer` from a real EOA holder `0x8538...2e14e` (4,093 AUSD, not frozen) standing in for the cold wallet. AUSD is an ERC-1967 proxy (impl `0xc1e3...12da`); impersonated transfers exercise the real path, no storage writes |

Limitations: anvil charges `gasUsed` at a decaying base fee and its receipts report true `gasUsed`, while Monad bills `gas_limit x min(base + tip, maxFee)` and reports the limit. Every MON figure below is computed from the measured or sent limits at 102 gwei (105 for inclusion). Backend keeper and relay processes were not run; their calls were sent with `cast` from their addresses.

## 2. Deploy.s.sol (RUNBOOK section 6 command, flag:account replaced by flag:unlocked)

Simulation passed `_check` (summary 20,197,481 gas, 2.1207 MON at 105 gwei). Broadcast with `-g 103`, maxFee 105 gwei, tip 2 gwei, flag:slow: 11 txs, nonces 0 to 10, one per block, all status 1. Forge re-estimated every tx at send time and sent exactly 1.03 x used.

| Tx | Gas used | Limit sent | RUNBOOK raw | Delta |
|:-|-:|-:|-:|-:|
| AUSD.approve(predicted vault) | 70,237 | 72,800 | 71,099 | -862 |
| CoverVault (pulls 1 AUSD seed) | 3,580,792 | 3,688,215 | 3,625,865 | -45,073 |
| CoverManager | 10,543,573 | 10,859,880 | 10,543,573 | 0 |
| GaplessFactory (+ account impl) | 4,620,483 | 4,759,097 | 4,620,483 | 0 |
| setFactory, setManager, 4 grantRole | 434,087 | 447,106 | 434,099 | -12 |
| GaplessCreSink | 656,143 | 675,827 | 656,143 | 0 |
| **Total** | **19,905,315** | **20,502,925** | 19,951,262 | -45,947 |

- MON billed on Monad: 20,502,925 x 102 gwei = **2.0913 MON** (RUNBOOK 2.096); all at 105 gwei 2.1528 (RUNBOOK 2.158). Largest inclusion need: CoverManager 10,859,880 x 105 gwei = 1.1403 MON.
- The vault row was over-budgeted by the "+40k real AUSD pull" allowance; the real pull costs less. Fork AUSD paths read up to 1.2% low, so keep the RUNBOOK figure.
- Section 8 read-back: every line matches (wiring, TA 1e6, dead shares = supply, config (treasury, 8000, 1000, 1e6), allowance 0, impl owner 0xdEaD and immutables, sink forwarder and manager, roles, admin, no pending admin, not paused). The section 6 `jq` address-capture loop works on the real artifact.

## 3. ListMarket sessions (RUNBOOK section 9 commands, `-g 110`)

| Session | Txs | Gas used | Limit sent | MON at 102 gwei |
|:-|:-|-:|-:|-:|
| 1 `run()` deployer (RISK_ADMIN) | listMarket | **361,283** | 397,411 | 0.0405 |
| 2 `postSigma()` keeper | postSigma | 68,426 | 75,268 | 0.0077 |
| 3 `seed()` LP | approve, deposit | 70,237 + 163,515 | 77,748 + 179,866 | 0.0263 |

Read-back matches section 9 exactly: `listedPerps` [1], config (true, 1, 5, 1, feed, 8, 0x0), marketCap 10000, maxMatchesClose 8, maxDuration 48000, sigmaMaxAge 6000, minFee 20000, maxNotional 20000000, sigma (27, post block), TA 4,000,000, reserved 0, `lockUntil(LP)` = seed block + 48,300, LP without RISK_ADMIN.

Deployer balance on Monad billing: 2.4 - 2.0913 - 0.0405 = **0.268 MON** left (RUNBOOK: 0.27). With 2.2 MON: 0.068.

## 4. Demo lifecycle, scenario A (RUNBOOK section 10, one maker under the stop)

| Step | Caller | Gas | Result |
|:-|:-|-:|:-|
| 10 AUSD to `accountOf(owner)` (fund first) | cold | 72,049 | balance 10,000,000 |
| `createAccountFor` with the owner's EIP-712 4-field grant (25e6, 100e6, 6 h) | relay | 194,036 | `isAccount` true, operator set |
| `sweep` (/activate) | relay | 288,538 | Perpl account 5413, 10 AUSD collateral |
| 0.5 MON drip | relay | 21,000 | |
| `tradeAndCover` 22 lots, 3x, stop 857,099 (50 bps under 861,407), maxGap 200, 12,000 blocks | operator | 1,245,297 (est 1,267,419) | Live: Cap 377,123, escrow 9,873, rent 20,000, `reservedTotal` = Cap; operator budget used 37.87 of 100 |
| RUNBOOK 11.2: `C_fill` / `C_nofill` / `n_top` | | 348,964 / 185,765 / 1 | |
| 200-block warm-up, gap (whale IOC sweeps 25 bids to 856,000; best bid 855,980), crash mark 856,000 via the real Perpl price admin | | | |
| `arm` | keeper | 250,867 | Armed, `armedBlock` 111,045,472 |
| 11.3 pre-sale check at the head | | E = 746,550, P = 188,936, n = 1 | measured O = 557,614; pass (section 6) |
| `trigger` (limit 2.1M) | keeper | 746,550 | 22/22 lots at 855,980 (maker 4203), `paidNowCNS` 24,609 |
| `observe` | | 158,346 (est) | returns false (mark-only post-trigger, L-01, as designed) |
| early `finalize` | | | reverts `TooEarly` (not observed) |
| `finalize` after the 40-block window | keeper | 239,179 | Finalized; topUp 0 |

Payout check (taker fee 345 ppm, funding 0, entry 861,518, released deposit 6,320,241, event `realizedCNS` 6,191,908):
- x = 6,191,908 - 6,320,241 = -128,333, equal to (855,980 - 861,518) x 22 - fee 6,497.
- G_real = floor(857,099 x 22 x (1 - 345e-6)) - 861,518 x 22 - x = 18,849,672 - 18,953,396 + 128,333 = **24,609**.
- G_ref + A x SN = (857,099 - 856,000) x 22 + floor(18,856,178 x 5 / 1e4) = 24,178 + 9,428 = 33,606; Cap 377,123.
- Payout = min(24,609, 33,606, 377,123) = **24,609** = `paidNowCNS` = vault AUSD delta. Finalize: escrow 9,873 + rent 20,000 to the vault, 10% (2,987) to the treasury, TA 3,975,391 to 4,002,277, `reservedTotal` 0, manager 0 AUSD.

## 5. Scenario B: worst-case fill call at maxMatchesClose 8, plus remainder

Second `tradeAndCover` (warm account) 1,038,879 gas: Cap 377,120, stop 857,093. Eleven fresh Perpl accounts each rested a 2-lot bid on its own level, 855,000 down to 854,800 (above the step-0 floor 854,572); a second whale removed every bid above 855,010; crash mark 855,000.

| Call | Gas | Perpl execOrder frame | Fills | Result |
|:-|-:|-:|-:|:-|
| `arm` | 250,867 | | | Armed |
| `trigger` fill call (limit 2.1M) | **1,728,490** | 1,178,143 | 8 | 16/22 lots, paid 34,596 |
| `trigger` remainder (next block) | 1,045,730 | 537,116 | 3 | 22/22, cumulative 48,229 |
| no-fill step (snapshot branch, book under the floor emptied) | **328,649** | 24,157 | 0 | `TriggerNoFill` |
| `finalize` after the window | 222,179 | | | Finalized, TA 3,980,934 |

Payout check: G_real = 2 x sum over k = 0..10 of (857,093 - (855,000 - 20k)) = 48,246, less 17 for the fee-at-stop term = **48,229**; G_ref + A x SN = 2,093 x 22 + 9,428 = 55,474; Cap 377,120; paid **48,229**. After the first call: G_real(16) 34,596 < G_ref + A x SN 40,344, paid 34,596.

Slope on real Perpl: s = (1,178,143 - 188,936) / 7 = **141,315 per fill** (distinct makers on distinct levels, fresh maker accounts); P(3) to P(8) gives 128,205; the whale's 25-fill opening sweep (17 makers, 22 levels) gives 143,503. Measured O = 1,728,490 - 1,178,143 = 550,347.

## 6. SA4 trigger gas rules with measured numbers

| Rule (RUNBOOK 11.4) | Measured | Limit | Status |
|:-|:-|:-|:-|
| 1. `1.15 x G(8)` | 1.15 x 1,728,490 = **1,987,764** (about 2.016M with a 1.5% live allowance) | `GAS.trigger` 2.1M | pass, 5.3% headroom (about 4% live) |
| 11.3 pass test, scenario A, s = 141,315 | 1.15 x (746,550 + 7 x 141,315) = 1,996,118 | 2.1M | pass |
| 2. `1.15 x (O + P1)` | 1.15 x (557,614 + 266,000) = 947,156; a real 1-maker landing 1.15 x 746,550 = 858,533 | `GAS.triggerStep` 1.1M | pass |
| no-fill step | 1.15 x 328,649 = 377,946 | 1.1M | pass |
| 3. retry ceiling `1.15 x G(16)` | O + P(8) + 8 x 141,315 = 2,859,010, x 1.15 = **3,287,862** | 3.5M | pass, 6% headroom |
| 5. hot reserve | billing is by limit, unchanged | 0.921 MON | unchanged |

## 7. End paths and CRE

| Path | Gas | Result |
|:-|-:|:-|
| Operator third `tradeAndCover` (sim) | | reverts `OperatorBudgetExceeded(18,851,668, about 5.6e6)` (F4) |
| Owner `trade` open / close | 328,259 / 325,793 | |
| Owner `buyCover` | 839,774 | Live |
| Operator `cancelCover` (zero budget left, SA3-I5) | 410,893 | Cancelled, escrow 9,873 refunded to the account wallet, rent to vault (18,000 net), reservation released |
| `voidCover` on an intact position | | reverts `PositionIntact` |
| Owner adds 100 lots at 15x (blended about 13.7x), mark 4.9% down via the price admin, Perpl `liquidation` (fork-only grant of position administrator by Perpl's owner Safe) | 664,102; Perpl 276,718 | position 0; `housekeeping` lists the cover in toVoid |
| `voidCover` | 376,433 | Voided, `EscrowForfeited` 9,870 (reference through the stop), vault +26,883, reserved 0 |
| `MockKeystoneForwarder.report` with 109-byte metadata + W2 kind-1 payload (seq = block time, perp 1, ref 861,211) | 133,550 | `ReportProcessed(true)`, `CreReport(1, 1, 861211, 0, 0)`, `seen` true, `lastSeq(1,1)` = seq |
| identical replay | | `ReportProcessed` only, no `CreReport` (dropped) |

End state: vault TA = AUSD balance = 4,025,817 (4,000,000 - 24,609 + 26,886 - 48,229 + 26,886 + 18,000 + 26,883, exact), reserved 0, owed 0, manager 0 AUSD, `refundOwedTotal` 0, `liveCount` 0, treasury 10,961 (2,987 + 2,987 + 2,000 + 2,987), LP 3e12 shares worth 3,019,362.

## 8. Findings

**F1 (RUNBOOK script bug, fix before the first sale).** RUNBOOK 11 `perpl()` returns the first DELEGATECALL into the Perpl implementation. In a `closeForCover` trace that is `getPosition` (32,370), and in a `trigger` trace it is `getPerpetualInfo` (12,816), not `execOrder` (188,936). With it, 11.3 reads P = 12,816, so E - P = 733,734 and rule 2 gives 1.15 x (733,734 + 266,000) = 1,149,694 > 1.1M: a **false FAIL** of the SA4-02 pre-sale check, or a wrong raise of `GAS.triggerStep`. Proposed fix (selector-filtered, summed; flagged here, not applied):

```sh
perpl() { jq -r ${D}arg i $IMPL '.. | objects | select(.type=="DELEGATECALL" and (.to|ascii_downcase)==$i and (.input[0:10]=="0x4d8dc985" or .input[0:10]=="0x28d18da3")) | .gasUsed' | while read g; do cast to-dec $g; done | awk '{s+=$1} END {print s}'; }   # execOrder, execOrderV2
```

11.1 on plain single-order txs is unaffected only when the order is the first Perpl call; use the same filter there.

**F2 (model numbers, doc update).** The real cost per maker filled across distinct levels is about 141k, not 110k to 115k, and the Gapless overhead O is about 550k to 558k, not 650k. CANARY_PARAMS section 5 should read: step no fill **0.33M** (was about 0.66M); 1-maker fill **0.75M**; 3-maker remainder 1.05M; fill at 8 **1.73M** (was about 1.62M); fill at 16 about **2.86M** (was 2.5M). Rule 1 still passes because the smaller O offsets the larger slope, but headroom is about 4% on live. Recommendation (not required by the rules): `GAS.trigger` 2.2M for 10% headroom (+0.0102 MON per fill call at 102 gwei, worst demo touch +0.031 MON). The 3.5M retry still covers 16 matches.

**F3 (RUNBOOK section 4 row).** listMarket uses 361,283 gas (row says about 300,000) and section 9 sends it at `-g 110`, 397,411, 0.0405 MON (row: 309,000, 0.032). The 2.4 MON deployer still keeps 0.268 MON. Also note: `broadcast/.../run-latest.json` `transaction.gas` keeps the stale pre-estimates for the 6 wiring calls (22,711 to 24,060 vs 59,558 to 96,341 used); read limits from `cast tx <hash> gas`, not the artifact.

**F4 (operational).** Operator `tradeAndCover` charges the trade notional and the cover notional (about 37.9 AUSD for 22 lots), so the canary grant of 100 AUSD per day allows two such pairs per rolling day; the third reverts `OperatorBudgetExceeded`. RUNBOOK 10.7 (two re-buys with `buyCover`, 18.9 each, plus one operator close) fits at about 94.6. The PWA should show `operatorUsage()` before a second demo trade.

**F5 (demo timing, design behavior).** Perpl only accepts mark updates while its Data Streams oracle is at most 60 s old (`OracleAgeExceedsMax`), within 5% of it (`MarkExceedsTol`, owner path included); BTC reports land about every 50 s. When the mark gaps through the stop but Perpl's oracle is still fresh above it, the long reference is max(mark, oracle), so nothing arms and a fast-path trigger floors at the oracle and does not fill. A cover closes once the oracle confirms or lapses (about 60 s at most). Expect that delay in the recorded demo.

**F6 (fork limits).** `observe` could not be driven to true: it needs a post-trigger non-mark source inside 40 blocks (12 s); the next real report comes about 50 s later and the Chainlink feed is frozen on a fork. The finalize-after-window path was used, as the keeper would. The Perpl liquidation needed a fork-only position-administrator grant; `voidCover`'s own logic is unaffected by that lever.

## 9. Levers used (all fork-only)

`anvil_setBalance`; impersonated real AUSD holders (EOA `0x8538...2e14e` for wallet funding, contract `0x188d...ea8e` for whale and maker collateral); Perpl price administrator `0x6906...D6AC` `execPerpOps` opType 1 (the live mark path); replay of real signed Data Streams batches from mainnet, unmodified, at their real timestamps: blocks 111,045,426 (R1, 861,347), 111,045,759 (R3, 861,552), 111,046,088 (R5, 861,211); whale IOC sweeps and fork-local makers through Perpl `createAccount` and `execOrder`; Perpl owner Safe `setPositionAdministrator(keeper)` for the liquidation only; `evm_snapshot` / `evm_revert` for the no-fill step measurement.
