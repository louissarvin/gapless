# Canary parameters (C5, 2026-10-05; sizes and MON updated C7, trigger gas and keeper calls SA4, trigger gas and keeper MON fork rehearsal F2, 2026-10-06)

One mainnet deploy; the canary becomes v1 at the address freeze. Budget: about 15 AUSD and 5 MON (BUILD_PLAN 0). Nothing here was broadcast.

## 1. Capacity rule

Three checks bind a cover's Cap (`CoverManager._checkCapacity`, `CoverVault.reserve`), with `TA = vault.totalAssets()` (net of owed payouts, includes the 1 AUSD dead seed):

| Check | Rule | Defaults |
|:-|:-|:-|
| Utilization | `(reservedTotal + Cap) / TA <= maxUtilizationBps` | 80% |
| Market cap | `reserved[perp] + Cap <= floor(TA x marketCapBps / 1e4)` | 50% (canary 100%) |
| Per-cover share (L-09) | `Cap <= floor(floor(TA x marketCapBps / 1e4) x 1000 / 1e4)` | 10% of the market |

`Cap = floor(N x maxGapBps / 1e4)` with `N = lots x stopPNS x scale`. The share check binds first for a single cover, so the exact minimum vault is:

```
TA_min = ceil(10 x Cap x 1e4 / marketCapBps)
```

## 2. Minimum vault for the demo covers (maxGap 200 bps)

| Demo notional | Cap | TA_min at marketCap 5,000 (Constants default) | TA_min at marketCap 10,000 (canary) |
|:-|:-|:-|:-|
| (a) 20 AUSD | 0.400000 AUSD | **8.000000 AUSD** | **4.000000 AUSD** |
| (b) 7 AUSD | 0.140000 AUSD | **2.800000 AUSD** | **1.400000 AUSD** |

Pinned on the real stack by `test/audit/SA2Audit.t.sol:test_N07_canarySizing_boundary` (23 lots at stop 857,862: Cap 394,616, TA 7,892,319 reverts `CoverShareExceeded(394616, 394615)`, TA 7,892,320 quotes). Other maxGap values scale linearly: TA_min = N x maxGap x 10 / marketCapBps (for example 20 AUSD at maxGap 100: 2 AUSD at marketCap 10,000).

BTC lots: one lot is 1e-5 BTC, so a lot is worth `stop / 1e5` AUSD (0.85 AUSD at 85,000). The notional is always a whole number of lots; pick lots at buy time with `lots = floor(N_target / (stop / 1e5))` and check `quote` first (it reverts `CoverShareExceeded` with both numbers, nothing is spent).

## 3. Proposed canary

| Item | Value | Why |
|:-|:-|:-|
| `maxCoverNotionalCNS` | **20e6** (20 AUSD) | Keeps lots <= 32 while the stop is >= 62,500 USD, so the keeper's fill calls stay `ceil(lots / 8) <= 4` (demo 22 lots: 3) |
| `maxMatchesClose` | **8** (bounds [8, 200]: the onchain minimum) | SA4-01: a trigger costs about 1.73M at 8 distinct makers on Perpl, 2.86M at 16 (section 5, fork rehearsal). Read live by `_closeCall`, so RISK_ADMIN can change it after the freeze with `setMarketParams` |
| `marketCapBps` | **10,000** | One listed market: the market cap is the vault; utilization 80% still bounds the total. Halves TA_min |
| Vault | 1 AUSD dead seed (Deploy) + **3 AUSD** LP seed (ListMarket `seed()`, separate LP key) = **4 AUSD** | Exactly TA_min for 20 AUSD at maxGap 200 |
| Demo cover | **22 lots** (about 18.7 AUSD at BTC 85,000), maxGap 200, stop about 50 bps under mark, duration 12,000 (1 h) | Cap <= 0.4 AUSD up to a stop of 90,909; 1 h keeps rent at the 0.02 floor (L-09 floor is per started 12,000 blocks) |
| Demo trader | 10 AUSD (Perpl `getMinAccountOpenCNS`), leverage <= 10x | D40 buffer: loss at a 50 bps stop (0.09) + Cap (0.37) <= 40% of the 1.87 AUSD position deposit at 10x; 20x fails |
| Operator grant | per trade 25 AUSD, per day 100 AUSD, expiry a few hours | N-03: worst leaked-key drain is about 5% of the daily budget (about 5 AUSD), and the trader holds 10 |
| Sigma | 27 (calm) | `ListMarket.postSigma()` default |
| Other params | `Constants.defaultMarketParams()` | A 5, floorSlack 100, warmup 200, window 40, minFee 0.02 |

Spend (AUSD): 1.00 dead seed + 3.00 LP (recoverable after the 48,300-block lock and async redeem) + 10.00 trader (recoverable less PnL) + demo premium about 0.03 (rent 0.020, escrow about 0.010 at 5 bps x M 1.05) + Perpl taker fees about 0.013 (3.45 bps x 2 x 18.7) + price risk to the stop about 0.09 = **about 14.1 AUSD committed, 1.1 consumed at worst**, leaving about 0.9 AUSD of the 15 for a second demo cover or a retry.

MON: sizes at C7 are CoverManager 48,171 B runtime (C6 47,937, C5 47,554), GaplessAccount 16,571 B (inside the factory), CoverVault 14,571 B. Deploy is 19,951,262 raw gas (CoverManager CREATE 10,543,573; C6 19,900,655), 2.096 MON at 102 gwei with the RUNBOOK section 4 flags; with listMarket 2.128 MON. Fund the deployer 2.4 MON (RUNBOOK section 4). Keeper calls and gas per touch: section 5. The C7 figure "1,484,336 gas for one trigger at 16 matches" is the stub stack with one maker and no intrinsic gas; it is not a Perpl bound (SA4-01: 1,539,268 on the real stack, about 3.0M with 16 distinct makers on the mocks, about 2.86M on mainnet Perpl per the fork rehearsal).

## 4. Running it (simulate only)

Flags written as `flag:<name>` (repo convention for the double-dash CLI options):

| Session | Key | Env | Command |
|:-|:-|:-|:-|
| 1 | RISK_ADMIN | MANAGER, VAULT, KEEPER | `forge script script/ListMarket.s.sol` with flag:sig "run()", flag:rpc-url monad, flag:account (risk admin) |
| 2 | keeper | MANAGER, VAULT | same with flag:sig "postSigma()" and the keeper account |
| 3 | LP (must not hold RISK_ADMIN_ROLE) | MANAGER, VAULT | same with flag:sig "seed()" and the LP account |

Overrides: `MAX_COVER_NOTIONAL_CNS`, `MARKET_CAP_BPS`, `MAX_MATCHES_CLOSE` (default 8; the script rejects values outside [8, 200] before listing), `SIGMA_BPS_E2`, `SEED_DEPOSIT_CNS`. Add the broadcast flag only from the runbook.

## 5. Trigger gas and keeper calls (SA4-01, maxMatchesClose 8)

**Calls per touch.** A fill call consumes at most `maxMatchesClose` resting orders, so it closes at least `min(8, lots left)` lots when every match fills at least one lot (dust that only burns matches adds calls but never widens, SA3-02).

| Cover | Fill calls `ceil(lots / 8)` | Worst trigger calls per touch (5 no-fill steps + fills) |
|:-|:-|:-|
| Demo, 22 lots | **3** (8, 8, 6) | **8** |
| Cap, 32 lots (20 AUSD at stop 62,500) | 4 | 9 |

The 5 steps happen only when the book under the reference is thinner than each step floor (N-01). Each attempt lands at most 10 blocks after the touch's previous attempt (`STEP_MAX_GAP_BLOCKS`, C7), and every remainder lands within 40 blocks of `triggerBlock`: 3 fill calls need 2 remainders, so even at the 10-block limit they end by `triggerBlock + 20`. Pinned by `CanaryDeployTest.test_canary_demoClose_threeFillCallsAtEightMatches` (22 one-lot bids from 22 accounts: 8, 16, 22).

**Gas model** (SA4-01, mainnet Perpl 1.7.5; fork rehearsal 2026-10-06, `audit/FORK_REHEARSAL_2026-10-06.md` F2): `G(n) = O + 266K + 141K x (n - 1)` for a trigger that fills against n distinct makers, with O about 550K to 558K on the Gapless side (manager, account, vault; measured 550,347 and 557,614). Measured on real Perpl: one fill 188,936, slope 141,315 per maker on distinct levels. Perpl's IOC with no fill is 83.5K (fork no-fill frame 24,157).

| Trigger | Estimate |
|:-|:-|
| Step, no fill | about 0.33M (fork 328,649) |
| Step that meets one bid at landing (SA4-03) | about 0.75M (fork 1-maker fill 746,550) |
| Demo fill call, 1 to 3 makers (typical book) | 0.75M to 1.05M (fork 3-maker remainder 1,045,730) |
| Fill call at `maxMatchesClose` 8 (worst) | **about 1.73M** (fork 1,728,490) |
| Fill call at 16 (the code default, not listed) | about 2.86M |

Re-check 2026-10-06 (read only, rpc.monad.xyz, 3,000 blocks up to about block 110,833,900): single-order Perpl batches with 6, 8, 9 and 10 fills used 878K, 775K to 1.08M, 1.14M and 1.21M (the earlier 110K model: 816K, 1.04M, 1.15M, 1.26M). Multi-order batches cost more per fill and are not the close shape.

**Keeper limits** (backend `GAS` and `TRIGGER_GAS_MODEL`, SA4-01, fork rehearsal F2; sized at O 550K, P1 266K and 141K per fill, x1.15):

| Label | Limit | Covers | MON settled at 102 gwei / reserved at 202 |
|:-|:-|:-|:-|
| `trigger` | 2.2M | 1.15 x (550K + 266K + 7 x 141K) = 2.07M (fork 1.15 x 1,728,490 = 1.99M) | 0.2244 / 0.4444 |
| retry on a non-custom simulation revert | 3.5M | 16 matches at x1.15 (3.37M; fork 3.29M), or a slope up to 318K per fill at 8 | 0.357 / 0.707 |
| `triggerStep` | 1.1M | 1.15 x (550K + 266K) = 0.94M (fork 1-maker landing 1.15 x 746,550 = 0.86M) | 0.1122 / 0.2222 |

Worst demo touch: 5 steps + 3 fills = 5.5M + 6.6M = 12.1M gas, **1.234 MON** settled (1.632 if every fill needs the 3.5M retry; a failed simulation is not billed). Worst demo close with first arm, observe and finalize: 0.0306 + 1.234 + 0.0255 + 0.0612 = **1.352 MON** (1.321 at 2.1M; 0.780 at 1.5M and 2 fill calls). At 32 lots: 5.5M + 8.8M = 14.3M gas, 1.459 MON per touch.

## 6. Keeper funding and SE3 canary conditions

- **Keeper funding: 5.1 MON per UTC day (backend SA4/SE3 round, raised for `GAS.trigger` 2.2M: daily cap 4.6, hot reserve 2.65, low-balance alert 2.0; worst day 3.86 MON at 110 gwei with 32-lot covers).** `KEEPER_DAILY_SPEND_CAP_WEI`, `KEEPER_HOTPATH_RESERVE_WEI` and `KEEPER_LOW_BALANCE_WEI` follow from it in the backend. Cross-check: one worst demo close settles 1.352 MON (section 5), two plus 12 sigma posts 2.80 MON; the old 2 MON (cap 1.8) covers one.
- **Landing gap** (SE3-M1): before the first sold cover, every `keeper.chain_gap` of a walk after its first attempt has `path: 'lane'`, with gaps at most 2 blocks typical and 6 max. Otherwise land SE3-M1 first.
- **At most 2 live covers per perp** until SE3-M2 (lane starvation) is fixed.
- **Refill the keeper to 5.1 MON at every UTC midnight while covers are live** (SE3-L2: the governor resets per UTC day, the balance does not).
- **Keeper RPC: a private low-latency endpoint in the Singapore region** for `MONAD_HTTP_URLS` and `MONAD_WS_URL`, not a load-balanced public URL. SE3-M1 measured gaps of 1, 2 and 4 blocks at 60, 150 and 300 ms per call, and 3, 5 and 9 when a lagging read node answers the lane read.
