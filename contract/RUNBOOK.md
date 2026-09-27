# Gapless mainnet canary runbook (Monad, chain 143)

One deploy; the canary becomes v1 at the address freeze (BUILD_PLAN 0). Values: `docs/CANARY_PARAMS.md`. Gate: `audit/SA3_REPORT.md` (GO) plus the C6 and C7 fixes in `docs/C5_FIXES.md` (C7: SE2-H1 step gap 10 blocks, CR1 review; no ABI change), then `audit/SA4_REPORT.md` (GO for deploy; SA4-01 and SA4-02 close before the first cover is sold: `maxMatchesClose` 8, keeper limits and section 11). Toolchain: Foundry 1.8.3 (`forge -V` shows commit cae51ad), solc 0.8.37, `network = "monad"`.

Status 2026-10-06: dry run green (`test/unit/CanaryDeploy.t.sol`), read-only preflight GO (`audit/PREFLIGHT_2026-10-06.txt`). Nothing broadcast.

**Notation.** Repo files never spell two hyphens (BUILD_PLAN notation `flag:name`). Every command below is copy-paste exact once this helper is defined in the shell:

```sh
D=$(printf '\055\055')          # "${D}broadcast" is the broadcast flag
export MONAD_RPC_URL=https://rpc.monad.xyz   # foundry.toml rpc_endpoints.monad reads it; private URL: read -rs MONAD_RPC_URL
export ETH_RPC_URL=$MONAD_RPC_URL           # cast reads it
export EX=0x34B6552d57a35a1D042CcAe1951BD1C370112a6F AUSD=0x00000000eFE302BEAA2b3e6e1b18d08D69a9012a
cd contract
```

Commands are written out in full on purpose: zsh does not word-split a variable holding several flags.

## 1. Wallets

| Wallet | Keystore name | Holds | Canary (BUILD_PLAN 0) | Recommended split (before caps rise) | MON | AUSD |
|:-|:-|:-|:-|:-|:-|:-|
| Deployer | `gapless-deployer` | sends the 11 deploy txs; DEFAULT_ADMIN until ADMIN accepts | also ADMIN, RISK_ADMIN, PAUSER, treasury | deployer only | **2.2** (2.4 recommended, section 4) | 1 (dead seed) |
| ADMIN | `gapless-admin` or a Safe | DEFAULT_ADMIN (1 h transfer delay) | = deployer | Safe multisig | 0.05 if a separate EOA | 0 |
| RISK_ADMIN | `gapless-risk` | `listMarket`, `setMarketParams` | = deployer | the ADMIN Safe or its own key | 0.05 | 0 |
| PAUSER | `gapless-pauser` | `pauseBuys`, `pauseMarket`, vault `pause` | = deployer | own hot key (fast reaction) | 0.05 | 0 |
| Keeper | `gapless-keeper` + host secret `KEEPER_KEY` | SIGMA_ROLE; CRE broadcast key only while the keeper is stopped | own key | own key | **5.1 MON** (daily cap 4.6, reserve 2.65; 5.0 before fork rehearsal F2) | 0 |
| Relay | host secret `RELAY_KEY` | sponsor creates, sweep, 0.5 MON drip | own key | own key | 1.3 | 0 |
| LP | `gapless-lp` | seeds 3 AUSD; must never hold RISK_ADMIN (SA2 N-08) | own key | own key | 0.1 | 3 |
| Demo owner | Mera passkey (PWA) | owns the GaplessAccount | own | own | 0 | 0 (10 AUSD go to `accountOf(owner)`) |
| Demo operator | PWA session key | operator grant 25 / 100 AUSD, hours | own | own | 0.5 (relay drip) | 0 |
| Cold wallet | user | funds everything, receives recoveries | | | rest | 1 buffer |

Totals for the canary (three wallets plus LP): **8.7 MON** (8.9 with the recommended 2.4 deployer; +0.15 for separate ADMIN, RISK_ADMIN and PAUSER EOAs; plus the UTC-midnight keeper refills of section 14) and **15 AUSD** (1 seed, 3 LP, 10 demo, 1 buffer). Never reuse a key across two sending processes (backend L-4); keeper and relay are always separate keys.

## 2. Keystores (no raw keys in env, files or shell history)

```sh
cast wallet new ~/.foundry/keystores gapless-deployer -p     # fresh key, hidden password prompt; prints the address
cast wallet new ~/.foundry/keystores gapless-lp -p
cast wallet import gapless-keeper ${D}interactive             # existing key: hidden prompts for key and password
cast wallet list
export DEPLOYER=$(cast wallet address ${D}account gapless-deployer)
export LP=$(cast wallet address ${D}account gapless-lp)
export KEEPER=$(cast wallet address ${D}account gapless-keeper)
export TREASURY=$DEPLOYER                                      # canary: treasury = deployer (BUILD_PLAN 6.3)
```

- Never pass `${D}private-key` or `${D}unsafe-password`; forge and cast prompt for the keystore password.
- Keeper and relay services read `KEEPER_KEY` and `RELAY_KEY` from the host secret store only. Load them through stdin into the secret store (for example `cast wallet decrypt-keystore gapless-keeper` piped into the store's import command), never into a repo `.env`, a command argument or a shell variable that lands in history.
- `ETHERSCAN_API_KEY` (Monadscan): `read -rs ETHERSCAN_API_KEY; export ETHERSCAN_API_KEY`.

## 3. Preflight (read-only, right before funding and again right before Deploy)

```sh
DEPLOYER=$DEPLOYER KEEPER=$KEEPER LP=$LP TREASURY=$TREASURY script/preflight.sh | tee audit/PREFLIGHT_$(date +%F).txt
```

GO only when it ends `RESULT: GO`. It checks: chain 143; Perpl 1.7.5 and implementation `0xa9ab97a4...1b2a` unchanged; `whitelistingEnabled` and `isHalted` false; `getMinAccountOpenCNS` 10e6; fee schedule readable; BTC perp pd 1, ld 5, status 4, `basePricePNS` 0 (ListMarket and L-06 rule), mark fresh and inside `[1, 16777215]`; demo sizing (22 lots Cap <= 0.4 AUSD, <= 32 lots at the 20 AUSD cap); AUSD decimals and `DOMAIN_SEPARATOR` against a local hash of ("Agora Dollar", "1", 143, AUSD); Chainlink BTC/USD decimals 8 and age <= 120 s; CRE sim forwarder; wallet balances and AUSD freeze state; base fee + tip <= the planned maxFee; deployer balance against the deploy budget. Also confirm: `forge -V` is 1.8.3, `forge test` green, SA3 and SE1 show no open Critical or High.

## 4. Deploy cost and gas flags (decided)

Monad bills `gas_limit x min(base + tip, maxFee)`, and inclusion requires the balance to cover `gas_limit x maxFee` for the txs in flight. On chain 143 forge 1.8.3 always sends one tx at a time, waits for its receipt and re-estimates the next tx with `eth_estimateGas` (source: `has_different_gas_calc` lists Monad), so the limits below track real usage.

| Item | Raw gas (dry run) | Limit at 103% | MON at 102 gwei |
|:-|:-|:-|:-|
| AUSD.approve (mainnet estimate) | 71,099 | 73,232 | 0.0075 |
| CoverVault (+40k real AUSD pull) | 3,625,865 | 3,734,641 | 0.3809 |
| CoverManager (C7, 48,171 B runtime) | 10,543,573 | 10,859,881 | 1.1077 |
| GaplessFactory (+ account impl) | 4,620,483 | 4,759,098 | 0.4854 |
| setFactory, setManager, 4 grantRole | 434,099 | 447,125 | 0.0456 |
| GaplessCreSink | 656,143 | 675,828 | 0.0689 |
| **Deploy total** | **19,951,262** | **20,549,805** | **2.096** (inclusion check 2.158 at 105 gwei) |
| listMarket (deployer as RISK_ADMIN) | about 300,000 | 309,000 | 0.032 |

- **Forge defaults do not fit**: 130% limits at maxFee `2 x base + tip` charge 2.65 MON, and the CoverManager tx alone needs 2.77 MON of balance to be included. Always pass the flags below.
- **Flags**: `-g 103 ${D}with-gas-price 105gwei ${D}priority-gas-price 2gwei`. 3% over an exact `eth_estimateGas` is enough for deterministic CREATEs and wiring calls.
- **2.2 MON fits only with these flags at base fee 100**: Deploy plus listMarket charge 2.13 MON, peak inclusion need 2.19 MON, about 0.07 MON left for pause and params. **Fund 2.4 MON** to keep 0.27 MON (0.21 MON if every tx is charged at the 105 gwei maxFee, i.e. base fee 103; absorbs a second param tx). Abort if the base fee is above 103 gwei.
- The forge simulation summary under-reports the wiring calls (it estimates them before the contracts exist; forge's own comment). Use the table above.

## 5. Funding (from the cold wallet)

The cold wallet will sit under 10 MON, so each of its txs (MON or AUSD) must be an emptying tx: no other tx from it in the previous 3 blocks. **Send one tx at a time, at least 4 blocks apart**, and check the receipt block before the next:

```sh
cast receipt <txhash> blockNumber            # next send only when cast block-number >= this + 4
```

Order: (1) deployer 2.2 to 2.4 MON, (2) deployer 1 AUSD, (3) LP 0.1 MON, (4) LP 3 AUSD, (5) keeper 5.1 MON, (6) relay 1.3 MON, (7) ADMIN, RISK_ADMIN, PAUSER 0.05 MON each if split. The demo's 10 AUSD go to `accountOf(owner)` after Deploy (section 10). Re-run the preflight with the addresses: every balance as planned, nothing frozen.

## 6. Deploy

Optional split roles: `export ADMIN=... RISK_ADMIN=... PAUSER=...` (unset means the deployer, logged as WARNING) and run the preflight with `SPLIT_ADMIN=1`. The deployer must send nothing else until Deploy ends (the vault address is predicted from its nonce).

Simulate (reads only), then broadcast with the same flags:

```sh
forge script script/Deploy.s.sol:Deploy ${D}rpc-url monad ${D}account gapless-deployer ${D}sender $DEPLOYER \
  -g 103 ${D}with-gas-price 105gwei ${D}priority-gas-price 2gwei
forge script script/Deploy.s.sol:Deploy ${D}rpc-url monad ${D}account gapless-deployer ${D}sender $DEPLOYER \
  -g 103 ${D}with-gas-price 105gwei ${D}priority-gas-price 2gwei ${D}broadcast ${D}slow \
  ${D}verify ${D}verifier sourcify ${D}verifier-url https://sourcify-api-monad.blockvision.org/
```

Expected: 11 txs from nonce n (approve, CoverVault, CoverManager, GaplessFactory, setFactory, setManager, 3 manager grants, vault grant, GaplessCreSink), 13 with a separate ADMIN (two `beginDefaultAdminTransfer` before the sink). The script's `_check` reverts the simulation on any wiring or role mismatch.

If it stops part way: `${D}resume` with the same command and the same Foundry 1.8.3 only, and only if no tx reverted. A reverted tx (or a version change) means a fresh deploy from scratch (SA3-I6: nothing half-wired can be finished or hijacked by others), which costs another 1 AUSD and the full MON budget: stop and get the contingency top-up (BUILD_PLAN decision 6).

Capture addresses:

```sh
RUN=broadcast/Deploy.s.sol/143/run-latest.json
for N in CoverVault CoverManager GaplessFactory GaplessCreSink; do
  jq -r ${D}arg n $N '.transactions[] | select(.transactionType=="CREATE" and .contractName==$n) | .contractAddress' $RUN
done
export VAULT=... MANAGER=... FACTORY=... SINK=...      # from the loop above, in that order
export IMPL=$(cast call $FACTORY "IMPL()(address)")
```

## 7. Verification

Sourcify ran with the broadcast. Monadscan (Etherscan v2, `foundry.toml` `[etherscan] monad`) per contract, then the account implementation (created inside the factory constructor, so it needs explicit args on both verifiers):

```sh
forge verify-contract $VAULT src/CoverVault.sol:CoverVault ${D}chain 143 ${D}verifier etherscan ${D}guess-constructor-args ${D}rpc-url monad ${D}watch
forge verify-contract $MANAGER src/CoverManager.sol:CoverManager ${D}chain 143 ${D}verifier etherscan ${D}guess-constructor-args ${D}rpc-url monad ${D}watch
forge verify-contract $FACTORY src/GaplessFactory.sol:GaplessFactory ${D}chain 143 ${D}verifier etherscan ${D}guess-constructor-args ${D}rpc-url monad ${D}watch
forge verify-contract $SINK src/cre/GaplessCreSink.sol:GaplessCreSink ${D}chain 143 ${D}verifier etherscan ${D}guess-constructor-args ${D}rpc-url monad ${D}watch
ARGS=$(cast abi-encode "f(address,address,address,address,uint8)" $EX $AUSD $MANAGER $VAULT 0)
forge verify-contract $IMPL src/GaplessAccount.sol:GaplessAccount ${D}chain 143 ${D}verifier etherscan ${D}constructor-args $ARGS ${D}watch
forge verify-contract $IMPL src/GaplessAccount.sol:GaplessAccount ${D}chain 143 ${D}verifier sourcify ${D}verifier-url https://sourcify-api-monad.blockvision.org/
```

A Sourcify miss for any contract: rerun `forge verify-contract <addr> <path:Name> ${D}chain 143 ${D}verifier sourcify ${D}verifier-url https://sourcify-api-monad.blockvision.org/`.

## 8. Read-back after Deploy (all must match before anything else)

```sh
RISK=$(cast keccak RISK_ADMIN_ROLE); SIG=$(cast keccak SIGMA_ROLE); PAU=$(cast keccak PAUSER_ROLE)
cast call $MANAGER "factory()(address)"                       # $FACTORY
cast call $MANAGER "VAULT()(address)"; cast call $MANAGER "EXCHANGE()(address)"; cast call $MANAGER "AUSD()(address)"
cast call $VAULT "manager()(address)"; cast call $VAULT "factory()(address)"   # $MANAGER, $FACTORY
cast call $VAULT "totalAssets()(uint256)"                     # 1000000
cast call $VAULT "balanceOf(address)(uint256)" 0x000000000000000000000000000000000000dEaD   # = totalSupply()
cast call $VAULT "config()((address,uint16,uint16,uint80))"   # ($TREASURY, 8000, 1000, 1000000)
cast call $AUSD "allowance(address,address)(uint256)" $DEPLOYER $VAULT       # 0
cast call $IMPL "owner()(address)"                            # 0x...dEaD (locked)
cast call $IMPL "FACTORY()(address)"; cast call $IMPL "MANAGER()(address)"; cast call $IMPL "VAULT()(address)"; cast call $IMPL "BUILDER_ID()(uint8)"   # $FACTORY $MANAGER $VAULT 0
cast call $SINK "forwarder()(address)"; cast call $SINK "manager()(address)"   # 0x9eF6...784d, $MANAGER
cast call $MANAGER "hasRole(bytes32,address)(bool)" $RISK ${RISK_ADMIN:-$DEPLOYER}   # true
cast call $MANAGER "hasRole(bytes32,address)(bool)" $PAU ${PAUSER:-$DEPLOYER}        # true
cast call $VAULT "hasRole(bytes32,address)(bool)" $PAU ${PAUSER:-$DEPLOYER}          # true
cast call $MANAGER "hasRole(bytes32,address)(bool)" $SIG $KEEPER                     # true
cast call $MANAGER "hasRole(bytes32,address)(bool)" $SIG $DEPLOYER                   # false
cast call $MANAGER "defaultAdmin()(address)"; cast call $VAULT "defaultAdmin()(address)"   # $DEPLOYER until ADMIN accepts
cast call $MANAGER "pendingDefaultAdmin()(address,uint48)"; cast call $VAULT "pendingDefaultAdmin()(address,uint48)"   # (0, 0) or ($ADMIN, deploy time + 3600)
cast call $MANAGER "paused()(bool)"; cast call $VAULT "paused()(bool)"   # false
```

Then commit the addresses (`packages/shared/addresses.143.ts`), run `script/export-abi.sh` and `bun run check-abi` in `backend/` (C6 and C7 changed no ABI).

## 9. Admin acceptance (separate ADMIN only), then ListMarket

After `ADMIN_DELAY` (3,600 s after the deploy block timestamp), from ADMIN on both contracts (a Safe: same calls from the Safe UI):

```sh
GL=$(( $(cast estimate $MANAGER "acceptDefaultAdminTransfer()" ${D}from $ADMIN) * 11 / 10 ))
cast send $MANAGER "acceptDefaultAdminTransfer()" ${D}account gapless-admin ${D}gas-limit $GL ${D}gas-price 105gwei ${D}priority-gas-price 2gwei
GL=$(( $(cast estimate $VAULT "acceptDefaultAdminTransfer()" ${D}from $ADMIN) * 11 / 10 ))
cast send $VAULT "acceptDefaultAdminTransfer()" ${D}account gapless-admin ${D}gas-limit $GL ${D}gas-price 105gwei ${D}priority-gas-price 2gwei
cast call $MANAGER "defaultAdmin()(address)"; cast call $VAULT "defaultAdmin()(address)"   # both $ADMIN (SA3 condition 5) before listing
```

ListMarket, three sessions, three keys (`docs/CANARY_PARAMS.md` section 4). Defaults are the canary values; never set the override env vars.

```sh
export MANAGER VAULT KEEPER
# Session 1, RISK_ADMIN key (canary: gapless-deployer; split: gapless-risk with its address as sender)
forge script script/ListMarket.s.sol:ListMarket -s "run()" ${D}rpc-url monad ${D}account gapless-deployer ${D}sender $DEPLOYER \
  -g 110 ${D}with-gas-price 105gwei ${D}priority-gas-price 2gwei ${D}broadcast ${D}slow
# Session 2, keeper key, before the keeper process starts
forge script script/ListMarket.s.sol:ListMarket -s "postSigma()" ${D}rpc-url monad ${D}account gapless-keeper ${D}sender $KEEPER \
  -g 110 ${D}with-gas-price 105gwei ${D}priority-gas-price 2gwei ${D}broadcast ${D}slow
# Session 3, LP key (never RISK_ADMIN)
forge script script/ListMarket.s.sol:ListMarket -s "seed()" ${D}rpc-url monad ${D}account gapless-lp ${D}sender $LP \
  -g 110 ${D}with-gas-price 105gwei ${D}priority-gas-price 2gwei ${D}broadcast ${D}slow
```

Simulate each first by dropping the last line's broadcast and slow flags. Read-back after the three sessions:

```sh
MP="marketParams(uint256)((uint16,uint16,uint16,uint16,uint16,uint16,uint16,uint16,uint16,uint16,uint16,uint16,uint16,uint16,uint16,uint16,uint32,uint32,uint32,uint32,uint32,uint32,uint32,uint32,uint32,uint80,uint80,uint16[8],uint16[9]))"
cast call $MANAGER "listedPerps()(uint256[])"                                   # [1]
cast call $MANAGER "marketConfig(uint256)((bool,uint8,uint8,uint64,address,uint8,address))" 1   # (true, 1, 5, 1, 0xc1d4...0546, 8, 0x0)
cast call $MANAGER "$MP" 1 ${D}json | jq -c '.[0] | {marketCap: .[11], maxMatchesClose: .[15], maxDuration: .[21], sigmaMaxAge: .[22], minFee: .[25], maxNotional: .[26]}'
#   {"marketCap":10000,"maxMatchesClose":8,"maxDuration":48000,"sigmaMaxAge":6000,"minFee":"20000","maxNotional":"20000000"}
cast call $MANAGER "sigmaOf(uint256)(uint32,uint48)" 1                           # (27, post block)
cast call $VAULT "totalAssets()(uint256)"                                       # 4000000
cast call $VAULT "reservedTotal()(uint256)"                                     # 0
cast call $VAULT "lockUntil(address)(uint256)" $LP                              # seed block + 48300
cast call $MANAGER "hasRole(bytes32,address)(bool)" $RISK $LP                   # false
```

## 10. Backend env, then the single demo trade and cover

Set (non-secret values; secrets come from the host store):

| Process | Values |
|:-|:-|
| Relay | `GAPLESS_FACTORY_ADDRESS=$FACTORY`, `SPONSOR_ENABLED=true` (only for the demo window), `SPONSOR_ALLOWLIST_ONLY=true`, `SPONSOR_DEMO_OWNER=<demo owner EOA>`, `DRIP_ALLOWLIST=<demo operator key>`, `DRIP_WEI=500000000000000000`, `RELAY_DAILY_SPEND_CAP_WEI=1000000000000000000`, `SPONSOR_GRANT_MAX_PER_TRADE_CNS=25000000`, `SPONSOR_GRANT_MAX_PER_DAY_CNS=100000000`, `SPONSOR_GRANT_MAX_TTL_S=21600`, `PERPL_MARKET_IDS=1,10`, `KEEPER_INTERNAL_URL`, `STRICT_RESERVE_SPACING=false` (until the M-2 check says otherwise); secrets `RELAY_KEY`, `RELAY_INTERNAL_TOKEN` |
| Keeper | `COVER_MANAGER_ADDRESS=$MANAGER`, `LISTED_PERPS=1`, `KEEPER_DAILY_SPEND_CAP_WEI`, `KEEPER_HOTPATH_RESERVE_WEI`, `KEEPER_LOW_BALANCE_WEI` (4.6 MON, 2.65 MON, 2.0 MON in wei; see backend/CLAUDE.md), `KEEPER_HEADS=monadNewHeads`, `RELAY_WS_URL`, `MONAD_HTTP_URLS` and `MONAD_WS_URL` (private low-latency endpoint in the Singapore region, SE3); secrets `KEEPER_KEY`, `RELAY_INTERNAL_TOKEN` (same as the relay) |
| Jobs | `JOBS_CURVE_NOTIONAL_AUSD=20`; secret `ENVIO_API_TOKEN` |
| PWA | factory and manager from `addresses.143.ts`; grant defaults 25 AUSD per trade, 100 per day, expiry 4 to 6 h |

Start order: jobs, relay, keeper (the keeper exits 1 until `COVER_MANAGER_ADDRESS` and its key are set; never while a forge session uses the keeper key).

Demo (BUILD_PLAN 6.4, SE1 H-2 fund-first order):

1. Phone: Mera create; the PWA shows the owner EOA and its session key. Set `SPONSOR_DEMO_OWNER` and `DRIP_ALLOWLIST` to them and restart the relay.
2. `export OWNER=<owner>; export ACCOUNT=$(cast call $FACTORY "accountOf(address)(address)" $OWNER)`; from the cold wallet: `cast send $AUSD "transfer(address,uint256)" $ACCOUNT 10000000 ${D}account <cold>` (4-block spacing rule). Check `cast call $AUSD "balanceOf(address)(uint256)" $ACCOUNT` is 10000000.
3. Owner signs `CreateAccount` (4-field grant: key, expiry, 25000000, 100000000) in the PWA, then `/sponsor/create`. Check `cast call $FACTORY "isAccount(address)(bool)" $ACCOUNT` true and `cast call $ACCOUNT "operator()((address,uint64,uint128,uint128))"`.
4. `/activate`: sweep opens Perpl (`cast call $ACCOUNT "perplAccountId()(uint256)"` > 0), then the 0.5 MON drip to the operator as a standalone emptying tx. Wait 3 blocks.
5. `/trade`: BTC, 22 lots, 3x (<= 10x for D40), stop at max(quoted `minDistanceBps`, 15 bps) under mark (about 50 bps), `maxGapBps` 200, duration 12,000. The PWA quotes first; simulate, then `tradeAndCover`. Screen-record.
6. Read-back: `export COVER=$(cast call $MANAGER "activeCoverOf(address,uint256)(bytes32)" $ACCOUNT 1)`; `getCover` fields 2 (status 1 = Live), 12 (Cap <= 400000), 13 (escrow about 9,800), 14 (rent 20000); `cast call $VAULT "reservedTotal()(uint256)"` equals Cap.
7. Then section 11.2 (estimates before a touch) and 11.3 (the pre-sale check once the cover arms), and let the keeper arm, trigger, observe and finalize. Check `Armed`, `Triggered` (`paidNowCNS > 0`) and `Finalized` on MonadVision; at most 2 re-buys if it expires untouched; never push the book.

## 11. Trigger gas (SA4-01, SA4-02)

Monad bills the gas limit, and both the receipt and the callTracer top frame report `gasUsed == gasLimit` (SA4-02, re-checked 2026-10-06). **Never calibrate from receipt `gasUsed`.** Measure with `cast estimate` on the real path and with the inner frames of `debug_traceTransaction` / `debug_traceCall` (callTracer).

Trace RPC (checked 2026-10-06): `rpc.monad.xyz` (QuickNode) and `rpc-mainnet.monadinfra.com` (Monad Foundation) serve both methods with callTracer, `withLog` and historical state, and accept `${D}from` a contract in estimates; `rpc1.monad.xyz` (Alchemy) and `rpc3.monad.xyz` (Ankr) refuse debug methods on their public tiers. `rpc.monad.xyz` limits `eth_getLogs` to 100 blocks. These reads are fine on a public URL; only the keeper needs the private one.

```sh
IMPL=0xa9ab97a404a0bca04d6a5b4a39995fea9e791b2a   # Perpl implementation (preflight)
FILL=$(cast sig-event "MakerOrderFilledV2(uint256,uint256,uint256,uint256,uint256,uint256,uint256,int256,uint256,uint256,uint256)")
TR='{"tracer":"callTracer","tracerConfig":{"withLog":true}}'
trace() { cast rpc debug_traceTransaction $1 "$TR"; }                                                 # a landed tx
tcall() { cast rpc debug_traceCall "{\"from\":\"$1\",\"to\":\"$2\",\"data\":\"$3\"}" latest "$TR"; }   # a call at the head
perpl() { jq -r ${D}arg i $IMPL '.. | objects | select(.type=="DELEGATECALL" and (.to|ascii_downcase)==$i and (.input[0:10]=="0x4d8dc985" or .input[0:10]=="0x28d18da3")) | .gasUsed' | while read g; do cast to-dec $g; done | awk '{s+=$1} END {print s}'; }   # execOrder, execOrderV2
fills() { jq ${D}arg t $FILL '[.. | objects | select(has("logs")) | .logs[] | select(.topics[0]==$t)] | length'; }   # maker orders matched
```

**Model** (SA4-01): `G(n) = O + P1 + s x (n - 1)` for a trigger matching n distinct makers. Fork rehearsal (`audit/FORK_REHEARSAL_2026-10-06.md`) measured O = 550,347 to 557,614 Gapless side, P(1) = 188,936, s = 141,315 (distinct makers on distinct levels). Model (backend `TRIGGER_GAS_MODEL`): O = 550,000, P1 = 266,000 (77K above the measured single fill, which covers the O spread), s = 141,000. `perpl` sums only the `execOrder` and `execOrderV2` frames: the first Perpl call in a trigger is a `getPerpetualInfo` read (12,816), not the order (F1). Values per case: `docs/CANARY_PARAMS.md` section 5.

### 11.1 Slope from mainnet history (any time)

```sh
H=$(cast block-number)
cast logs ${D}from-block $((H-99)) ${D}to-block $H ${D}address $EX $FILL ${D}json | jq -r 'group_by(.transactionHash) | map("\(.[0].transactionHash) \(length)") | .[]'
trace <tx> | perpl      # single-order txs only (multi-order execOrders batches cost more per fill); s = (P(k) - P(1)) / (k - 1)
```

### 11.2 Before a touch (after step 10.6)

```sh
PI='getPerpetualInfo(uint256)((string,string,uint256,uint256,bytes32,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,int16,uint256,uint8,uint256,uint256,uint256,uint256,uint256,uint256,bool))'
BID=$(cast call $EX "$PI" 1 ${D}json | jq -r '.[0][24]'); ASK=$(cast call $EX "$PI" 1 ${D}json | jq -r '.[0][27]')   # base 0, so ONS = PNS
CF=$(cast calldata "closeForCover(uint256,bool,uint256,uint256,uint256)" 1 true 22 $BID 8)   # sells into the top level, up to 8 makers
cast estimate $ACCOUNT "closeForCover(uint256,bool,uint256,uint256,uint256)" 1 true 22 $BID 8 ${D}from $MANAGER   # C_fill
tcall $MANAGER $ACCOUNT $CF | fills                                                                             # n_top
cast estimate $ACCOUNT "closeForCover(uint256,bool,uint256,uint256,uint256)" 1 true 22 $ASK 8 ${D}from $MANAGER   # C_nofill (step path)
```

Predicted worst fill call: `O + C_fill + s x (8 - n_top)`; it must be at most `GAS.trigger / 1.15`. If a node refuses `${D}from` a contract (EIP-3607), estimate `trade` with a close order from the owner EOA instead (an upper bound, it adds `syncCover`): `cast estimate $ACCOUNT "trade((uint256,uint256,uint8,uint256,uint256,uint256,uint256,bool,bool,bool,uint256,uint256,uint256,uint256,uint256))" "(0,1,2,0,$BID,22,0,false,false,true,8,0,0,0,0)" ${D}from $OWNER`.

### 11.3 Pre-sale check: estimate a trigger once the demo cover is armed

No cover beyond the demo is sold until this passes. Watch the cover; when it is Armed (status 2) and the head is past `armedBlock` (`trigger` reverts `TooEarly` in the arm block, and an `eth_call` at block N runs with `block.number == N`, so a historical estimate at the arm block cannot replace this), estimate the trigger at the head. Do not stop the keeper for it: a real touch must close. If the keeper lands first, run the same estimate on the next remainder (status 3 with `filled < lots`), or use `trace <keeper trigger tx> | perpl` and `| fills` with O = 558,000 (the higher fork measurement).

```sh
CV='getCover(bytes32)((address,uint16,uint8,bool,uint16,bool,uint40,uint40,uint32,uint48,uint48,uint48,uint80,uint80,uint80,uint48,uint40,uint32,uint32,uint80,address,uint80,uint128,uint16,uint16,uint48,uint8,uint16,uint16,uint8))'
cv() { cast call $MANAGER "$CV" $COVER ${D}json | jq -c '.[0] | {status: .[2], lots: .[6], filled: .[7], armedBlock: .[11], triggerBlock: .[15]}'; }
until [ "$(cv | jq .status)" = 2 ]; do sleep 1; done; cv
E=$(cast estimate $MANAGER "trigger(bytes32)" $COVER ${D}from $KEEPER); echo $E                 # G at the head
tcall $KEEPER $MANAGER $(cast calldata "trigger(bytes32)" $COVER) > /tmp/trig.json
perpl < /tmp/trig.json; fills < /tmp/trig.json                                                # Perpl share P, matches n
```

Pass when `1.15 x (E + s x (maxMatchesClose - n)) <= GAS.trigger` and `1.15 x (E - P + P1) <= GAS.triggerStep` (`E - P` is the measured O). Record E, P, n and the head block in `audit/` and in memory; a fail means rule 1 or 2 below before any sale.

### 11.4 Decision rule (backend `GAS`; `maxMatchesClose` by RISK_ADMIN)

1. `GAS.trigger >= 1.15 x G(maxMatchesClose)`, with measured O, P1 and s once known: **2.2M** at 8 (model 1.15 x (550K + 266K + 7 x 141K) = 2.07M; fork 1.15 x 1,728,490 = 1.99M, about 2.02M with the 1.5% live allowance, which left 2.1M only about 4% headroom).
2. `GAS.triggerStep >= 1.15 x (O + P1)`, a step that meets one bid at landing (SA4-03): **1.1M** (model 0.94M; fork 1.15 x (557,614 + 266,000) = 0.95M, a real 1-maker landing 0.86M).
3. One retry on a non-custom simulation revert at a ceiling `>= 1.15 x G(16)`: **3.5M** (model 3.37M; fork 3.29M). It absorbs a model error until rules 1 and 2 are re-run.
4. `maxMatchesClose` stays **8** (the onchain minimum) while rule 1 holds; if `1.15 x G(8)` exceeds `GAS.trigger`, raise `GAS.trigger`, since 8 cannot go lower. Raise it to n only when `GAS.trigger >= 1.15 x G(n)` (16 needs 3.37M, 0.34 MON per call at 102 gwei) and the keeper counts fill calls as `ceil(lots / n)`. Change it with `setMarketParams(1, p)` from RISK_ADMIN after reading the current `p` (section 9 read-back); `_closeCall` reads it live, so live covers' next calls use it.
5. `KEEPER_HOTPATH_RESERVE_WEI >= GAS.trigger x 102 gwei + max(GAS.trigger, retry ceiling) x 202 gwei` (one fill settled plus one reserved): 2.2M x 102 + 3.5M x 202 gwei = 0.2244 + 0.707 = 0.931 MON with the 3.5M exempt retry, 2.2M x 304 gwei = 0.669 without. Then re-check the cap table in `backend/CLAUDE.md` and the 5.1 MON funding.
6. `keeper.step_gas_low`, or a trigger that only passed at the 3.5M retry, means a limit is too low: re-measure (11.3) and raise by rules 1 to 3 at once. `keeper.trigger_undecoded_revert` (after `keeper.trigger_gas_ceiling`) is not always gas: Perpl errors are not in the manager ABI, so a Perpl rejection logs the same way (fork integration F-4: `0x7d19aaec` = `MarkPriceAgeExceedsMax(uint256,uint256,uint256,uint256)`, Perpl's 60 s mark age lapsed while the Gapless fast path, `REF_TS_TOLERANCE_SEC` 2, still held). Before raising anything, trace the call at the head and read the deepest failing frame:

   ```sh
   why() { jq -c '[.. | objects | select(has("error"))] | last | {to, error, sel: ((.output // "0x")[0:10]), gas, gasUsed}'; }
   tcall $KEEPER $MANAGER $(cast calldata "trigger(bytes32)" $COVER) | why
   cast 4byte <sel>
   ```

   `error` "out of gas" (frame `gasUsed` equal to its `gas`) is a limit: raise by rules 1 to 3. A selector from a Perpl frame (`to` the exchange or `$IMPL`) is a Perpl rejection: do not raise gas. Check Perpl state (mark age, halt, perp status) and let the keeper retry on later heads.

## 12. Pause and rollback

No upgradeability: rollback means stop new risk, let live covers end, redeploy only with the contingency budget.

Kill triggers (BUILD_PLAN 6.5): `whitelistingEnabled` flips, Exchange `Upgraded` (implementation slot changes; the preflight shows it), `isHalted`, reconciliation mismatch over 1 tick, payout above the pseudocode value, governor breach.

```sh
# PAUSER key (canary: gapless-deployer; split: gapless-pauser); keep >= 0.02 MON on it. Fixed limits: no time to estimate.
cast send $MANAGER "pauseBuys()" ${D}account gapless-deployer ${D}gas-limit 100000 ${D}gas-price 110gwei ${D}priority-gas-price 2gwei
cast send $MANAGER "pauseMarket(uint256)" 1 ${D}account gapless-deployer ${D}gas-limit 100000 ${D}gas-price 110gwei ${D}priority-gas-price 2gwei
cast send $VAULT "pause()" ${D}account gapless-deployer ${D}gas-limit 100000 ${D}gas-price 110gwei ${D}priority-gas-price 2gwei   # deposits only; redeem requests and claims stay open
cast call $MANAGER "paused()(bool)"; cast call $MANAGER "marketPaused(uint256)(bool)" 1; cast call $VAULT "paused()(bool)"
```

Then: keeper keeps running (live covers must still trigger, observe, finalize, expire), relay `SPONSOR_ENABLED=false`, PWA banner. Undo with `unpauseBuys()`, `unpauseMarket(uint256)`, `unpause()`.

## 13. Fund recovery (after judging closes, Oct 27; the product stays live until then)

1. Pause buys (section 12), wait until `cast call $MANAGER "liveCount(uint256)(uint256)" 1` is 0 and `reservedTotal()` is 0 (the keeper expires and finalizes).
2. Trader: close the position in the PWA, then `withdrawWithSig` relayed by the operator (AUSD to the owner EOA); export the phrase in `/settings` and sweep. A refund parked by a frozen account: `claimRefund(account)` (permissionless).
3. LP, once `block.number >= lockUntil(LP)`, then again after `COOLDOWN_BLOCKS` (48,300, about 4 h). Pays `min(assetsAtRequest, convertToAssets(shares))`; the 1 AUSD dead seed stays burned by design; the treasury cut was already transferred in AUSD at each premium.

```sh
SH=$(cast call $VAULT "balanceOf(address)(uint256)" $LP | awk '{print $1}')
GL=$(( $(cast estimate $VAULT "requestRedeem(uint256)" $SH ${D}from $LP) * 11 / 10 ))
cast send $VAULT "requestRedeem(uint256)" $SH ${D}account gapless-lp ${D}gas-limit $GL ${D}gas-price 105gwei ${D}priority-gas-price 2gwei
cast call $VAULT "requestIdsOf(address)(uint256[])" $LP; cast call $VAULT "getRequest(uint256)((address,uint96,uint80,uint48))" <id>   # claimable block last
GL=$(( $(cast estimate $VAULT "claimRedeem(uint256,address)" <id> $LP ${D}from $LP) * 11 / 10 ))
cast send $VAULT "claimRedeem(uint256,address)" <id> $LP ${D}account gapless-lp ${D}gas-limit $GL ${D}gas-price 105gwei ${D}priority-gas-price 2gwei
```
4. AUSD back to the cold wallet from LP, deployer and treasury (value-0 txs), then wait at least 4 blocks.
5. MON: stop keeper, relay and jobs first. Each wallet sends one emptying tx, nothing else in the previous 3 blocks: `V=$(( $(cast balance $ADDR) - 21000 * 102000000000 )); cast send <cold> ${D}value $V ${D}gas-limit 21000 ${D}gas-price 102gwei ${D}priority-gas-price 2gwei ${D}account <name>` (charged exactly 21000 x 102 gwei at base 100). Keeper first, operator MON through the exported phrase.

## 14. SA3 canary conditions and backend checklist

- [ ] SA3-01 and SA3-02 (strongly recommended before freeze): applied in C6; SE2-H1 contract side applied in C7 (`docs/C5_FIXES.md`, no ABI change); `forge test` green on the deployed commit.
- [ ] SA4-01: read-back shows `maxMatchesClose` 8 (section 9); the keeper runs `GAS.trigger` 2.2M, `GAS.triggerStep` 1.1M, the 3.5M retry and `ceil(lots / 8)` fill-call admission; hot reserve and funding per section 11.4 rule 5.
- [ ] SA4-02: section 11.3 pre-sale check passed and recorded.
- [ ] (1) Relay and PWA typed data on the 4-field grant before onboarding anyone (`CreateAccount(... uint128 maxNotionalPerDay ...)`; relay boot check of `CREATE_ACCOUNT_TYPEHASH` passes).
- [ ] (2) Keeper rules: no arm at `block.number >= expiryBlock` (onchain since C6, keeper margin `ARM_EXPIRY_MARGIN_BLOCKS`); step mirror with `STEP_MAX_GAP_BLOCKS` 10 measured from `shortBlock` (C7, INTERFACES section 4); each attempt of a walk or remainder lands at most 10 blocks after the previous one, and a remainder within the 40-block window; gas limits from estimates, attempt cap; **keeper holds 5.1 MON after deploy**.
- [ ] SE3 landing gap (SE2-H1 cadence): before selling a cover, every `keeper.chain_gap` of a walk after its first attempt shows `path: 'lane'`, gaps at most 2 blocks typical and 6 max (C7 bound 10); otherwise land SE3-M1 first. Alert on `keeper.chain_gap` above 6.
- [ ] SE3 keeper RPC: `MONAD_HTTP_URLS` and `MONAD_WS_URL` on a private low-latency endpoint in the Singapore region, not a load-balanced public URL (SE3-M1).
- [ ] SE3-M2: at most 2 live covers per perp until the lane fix lands.
- [ ] SE3-L2: refill the keeper to 5.1 MON at every UTC midnight while covers are live.
- [ ] (3) Trigger gas measured per section 11 (estimates and traces, never receipts) before relying on the first cover; `GAS.trigger` and `GAS.triggerStep` set by rule 11.4 (fork rehearsal F2: 2.2M and 1.1M; the mainnet 11.3 check still runs).
- [ ] (4) Operator grants at 25 AUSD per trade, 100 per day, expiry hours (relay `SPONSOR_GRANT_*` enforces it).
- [ ] (5) ADMIN accepted on both contracts after `ADMIN_DELAY`; `defaultAdmin()` confirmed on both before listing (canary three-wallet: deployer is ADMIN, no transfer pending).
- [ ] M-2: two value-0 keeper calls in consecutive blocks both `status 1`; else `STRICT_RESERVE_SPACING=true` on keeper and relay.
- [ ] H-1: `GAS.trigger` recalibrated from section 11 estimates and traces (receipts report the limit): 2.2M from the fork rehearsal traces (F2); watch `keeper.zero_paid_skip`, `keeper.noop_receipt`, `trigger_zero` spend.
- [ ] H-2: `SPONSOR_DEMO_OWNER` set; fund-first onboarding order (section 10).
- [ ] C5 expiry: one `expire` at the first head past `expiryBlock`.
- [ ] L-4: one machine per signer key; no forge or CRE session on the keeper key while the keeper runs. I-3: keeper `/healthz` probes send the bearer token.
- [ ] Vault headroom: TA is exactly TA_min (4 AUSD) for a 20 AUSD cover; any LP loss or owed payout makes a full-size quote revert `CoverShareExceeded` (safe). Buy 22 lots or fewer.

## 15. Evidence

- `test/unit/CanaryDeploy.t.sol`: Deploy.s.sol and ListMarket's three sessions through their env entry points on an in-memory chain 143 with the doubles etched at the Perpl, AUSD and BTC/USD feed addresses (three-wallet canary), plus the split-role path with admin acceptance before listing; asserts wiring, every role and pending admin, canary params (`maxMatchesClose` 8 within [8, 200]), sigma, `totalAssets == 4e6`, then the fund-first sponsored account and the operator's 22-lot `tradeAndCover` (Cap 373,336, rent 20,000, escrow 9,770 at BTC 85,275); `test_canary_demoClose_threeFillCallsAtEightMatches` closes it against 22 one-lot bids from 22 accounts in 3 trigger calls (8, 16, 22).
- `audit/PREFLIGHT_2026-10-06.txt`: read-only mainnet preflight, GO.
- Deploy gas: local simulation of `script/Deploy.s.sol` (forge 1.8.3, `network = "monad"`, fresh local node, no fork, no broadcast); CREATE estimates reproduce `21,000 + 32,000 + calldata + initcode words + frame` exactly. C7 re-measure: `cast estimate` of the CoverManager CREATE on a throwaway `anvil` (`network monad`, chain id 143, no fork, nothing sent) gives 10,492,966 for the C6 initcode (matches the C6 table) and 10,543,573 for C7; vault, factory and sink initcode are byte-identical to C6, so their rows stand.

## 16. Post-canary integration checklist

Bounty surfaces on the live addresses (PARALLEL_BUILD_PLAN section 11). Status 2026-10-07; `[x]` done, `[ ]` open or partial.

1. [ ] After read-back (section 8): `bun scripts/record-deployment.ts` then `bun scripts/sync-abi.ts`; commit `deployments/143.json` and generated files; verify all five contracts on Sourcify and Monadscan (also lowers Blockaid risk for the plugin).
   - Done: `deployments/143.json` equals `record-deployment.ts dry-run` output byte for byte; `sync-abi.ts` wrote the indexer, CRE and plugin targets; all five contracts are an exact match on Monadscan and a match on Sourcify (checked 2026-10-07).
   - Open: commit (the workspace has no `.git`, `gitCommit` is null). The `IPerplEvents` export (INTERFACES section 12, 2026-10-07) hands `indexer/abis/IPerplEvents.json` to the generator, so `sync-abi.ts check` reports it and `indexer/abis/README.md` until `bun scripts/sync-abi.ts` runs once (event bodies identical except `internalType` on 3 `uint8` fields; topics unchanged).
2. [ ] Envio: set Cloud env vars from `deployments/143.json`, push to `envio`, wait for sync, query `_meta` and `Market(where perpId 1)`; confirm `MarketListed`, `SigmaPosted`, vault `Deposit` (LP seed) are indexed.
   - Open: `indexer/config.yaml` marker defaults carry the deploy values; Cloud env, push and the `_meta` check not done.
3. [ ] Jobs: set the new Gapless address vars, restart jobs then relay; `/api/stats` shows the listing and the LP seed.
   - Done: the five Gapless vars (`COVER_MANAGER_ADDRESS`, `COVER_VAULT_ADDRESS`, `GAPLESS_FACTORY_ADDRESS`, `GAPLESS_CRE_SINK_ADDRESS`, `GAPLESS_START_BLOCK`) are set in `backend/DEPLOYMENT_143.md` and `backend/docker-compose.yml`, pinned by `backend/test/env.test.ts`; jobs and relay are up.
   - Open: relay still on a local dev override (`NODE_ENV=development`, `APP_ORIGIN` localhost); jobs first backfill was still running; `/api/stats` not yet confirmed to show the listing (block 111105424) and the LP seed.
4. [ ] CRE: dry run handler 1 against the live manager (expect empty `watchList` and no write).
   - Open: `config.staging.json` carries the live sink and manager; needs `cre login`, then `bun run sim:watch` in `cre/gapless-cre/gapless-ref`.
5. [ ] Plugin: `gapless:quote` against the demo account once it exists.
   - Open: no demo account yet. Quotes revert `SigmaStale` until the keeper posts sigma (stale since block 111105484).
6. [ ] After the demo cover finalizes: reconcile indexer `Stats` vs `/api/stats`; record Armed, Triggered, Finalized hashes in `deployments/143.json` notes for DEPLOYMENTS.md.
7. [ ] Keeper console shows the arm and trigger actions with tx hashes.
   - Open: keeper not started (key rotation pending; a new key needs `SIGMA_ROLE`).
8. [ ] CRE broadcast window (ADR-P5): `liveCount(1) == 0`, keeper stopped, broadcast, receipt, keeper restarted, `/healthz` green within 1 min.
   - `cast call $MANAGER "liveCount(uint256)(uint256)" 1` must print 0 right before `bun run broadcast:ref`.

Parity evidence for items 4 and 8: `test/unit/CreParity.t.sol` decodes every CRE vector (`test/fixtures/cre_report_vectors.json`, copied from `cre/gapless-cre/gapless-ref/test/fixtures/`) through `GaplessCreSink` built with the deployed constructor args, and checks the Solidity re-encoding equals the workflow bytes.
