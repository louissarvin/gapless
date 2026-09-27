#!/usr/bin/env bash
# Gapless canary preflight: read-only checks of Monad mainnet before Deploy (RUNBOOK.md section 3).
# Sends nothing. Uses read-only cast calls only (call, storage, balance, nonce, block, base-fee, gas-price, rpc fee query).
#
# Usage (from contract/): script/preflight.sh | tee audit/PREFLIGHT_$(date +%F).txt   (local date, WIB)
# Env, all optional:
#   MONAD_RPC_URL   read endpoint (default https://rpc.monad.xyz); only its host is printed
#   DEPLOYER KEEPER LP RELAY ADMIN TREASURY   addresses to print MON, AUSD and freeze state for
#   GAS_MULT        forge flag:gas-estimate-multiplier planned for Deploy, percent (default 103)
#   MAX_FEE_GWEI    forge flag:with-gas-price (EIP-1559 maxFeePerGas) planned, gwei (default 105)
#   TIP_GWEI        forge flag:priority-gas-price planned, gwei (default 2)
#   SPLIT_ADMIN     1 if ADMIN differs from the deployer (adds the two beginDefaultAdminTransfer txs)
# Exit code: number of FAIL lines (0 = go).
set -uo pipefail

RPC="${MONAD_RPC_URL:-https://rpc.monad.xyz}"
export ETH_RPC_URL="$RPC" # every cast command below reads it
D="$(printf '\055\055')" # long-flag prefix; repo files never spell it (BUILD_PLAN notation)
RPC_HOST="$(printf '%s' "$RPC" | sed -E 's#^(https?://[^/]+).*#\1#')"
GAS_MULT="${GAS_MULT:-103}"
MAX_FEE_GWEI="${MAX_FEE_GWEI:-105}"
TIP_GWEI="${TIP_GWEI:-2}"
SPLIT_ADMIN="${SPLIT_ADMIN:-0}"

# Verified addresses (memory/tech_docs_verification_2026-10-05.md, src/Constants.sol).
EX=0x34B6552d57a35a1D042CcAe1951BD1C370112a6F
EX_IMPL_WANT=0xa9ab97a404a0bca04d6a5b4a39995fea9e791b2a
EIP1967_IMPL_SLOT=0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc
AUSD=0x00000000eFE302BEAA2b3e6e1b18d08D69a9012a
FEED_BTC=0xc1d4C3331635184fA4C3c22fb92211B2Ac9E0546
CRE_FWD_SIM=0x9eF6468C5f37b976E57d52054c693269479A784d
PERP_BTC=1

# Canary rules (docs/CANARY_PARAMS.md, Constants.sol).
REF_FRESH_SEC=60
FEED_MAX_AGE_SEC=120
MAX_COVER_NOTIONAL_CNS=20000000
DEMO_LOTS=22
DEMO_MAX_GAP_BPS=200
CANARY_VAULT_CNS=4000000

FAILS=0
pass() { printf 'PASS  %s\n' "$1"; }
fail() { printf 'FAIL  %s\n' "$1"; FAILS=$((FAILS + 1)); }
warn() { printf 'WARN  %s\n' "$1"; }
info() { printf 'INFO  %s\n' "$1"; }
check() { if [ "$2" = "$3" ]; then pass "$1 = $2"; else fail "$1 = $2 (want $3)"; fi; }
first() { awk '{print $1}'; }
lower() { tr '[:upper:]' '[:lower:]'; }
mon() { awk -v w="$1" 'BEGIN { printf "%.4f", w / 1e18 }'; }
ausd() { awk -v c="$1" 'BEGIN { printf "%.6f", c / 1e6 }'; }
c() { cast call "$@"; }

echo "Gapless canary preflight (read-only)"
echo "Generated $(date -u '+%Y-%m-%dT%H:%M:%SZ') ($(date '+%Y-%m-%d %H:%M %Z')) with $(cast -V | head -1)"
echo "RPC host: $RPC_HOST"
echo

echo "== Chain"
check "chain id" "$(cast chain-id)" "143"
HEAD_NUM=$(cast block latest -f number)
HEAD_TS=$(cast block "$HEAD_NUM" -f timestamp)
HEAD_GASLIMIT=$(cast block "$HEAD_NUM" -f gasLimit)
info "head block $HEAD_NUM, timestamp $HEAD_TS, block gas limit $HEAD_GASLIMIT"
# Every freshness check below compares against this timestamp.
if [ "${HEAD_TS:-0}" -le 0 ] 2>/dev/null; then fail "head timestamp unreadable"; echo "RESULT: NO-GO"; exit 1; fi
echo

echo "== Perpl Exchange $EX"
VER="$(c "$EX" 'getContractVersion()(uint256,uint256,uint256)' "${D}json" | jq -r 'join(".")')"
check "getContractVersion" "$VER" "1.7.5"
IMPL="0x$(cast storage "$EX" "$EIP1967_IMPL_SLOT" | cut -c27-66)"
check "EIP-1967 implementation" "$(printf '%s' "$IMPL" | lower)" "$EX_IMPL_WANT"
check "whitelistingEnabled" "$(c "$EX" 'whitelistingEnabled()(bool)')" "false"
check "isHalted" "$(c "$EX" 'isHalted()(bool)')" "false"
check "getMinAccountOpenCNS" "$(c "$EX" 'getMinAccountOpenCNS()(uint256)' | first)" "10000000"
FEES="$(c "$EX" 'getPerpFeeSchedule(uint256)(uint256,uint256[8],uint256[8])' "$PERP_BTC" "${D}json")"
if [ -n "$FEES" ]; then
    pass "getPerpFeeSchedule(1) readable: id $(printf '%s' "$FEES" | jq -r '.[0]'), taker tier 0 $(printf '%s' "$FEES" | jq -r '.[1][0]') ppm, maker tier 0 $(printf '%s' "$FEES" | jq -r '.[2][0]') ppm"
else
    fail "getPerpFeeSchedule(1) not readable"
fi
echo

echo "== BTC perp (id $PERP_BTC), ListMarket preflight and L-06 rule"
PI_SIG='getPerpetualInfo(uint256)((string,string,uint256,uint256,bytes32,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,int16,uint256,uint8,uint256,uint256,uint256,uint256,uint256,uint256,bool))'
PI="$(c "$EX" "$PI_SIG" "$PERP_BTC" "${D}json" | jq -c '.[0]')"
pi() { printf '%s' "$PI" | jq -r ".[$1]"; }
info "name $(pi 0), symbol $(pi 1)"
check "priceDecimals" "$(pi 2)" "1"
check "lotDecimals" "$(pi 3)" "5"
check "status (4 = active)" "$(pi 22)" "4"
check "basePricePNS (listMarket requires 0)" "$(pi 23)" "0"
check "ignOracle" "$(pi 29)" "false"
MARK=$(pi 11); MARK_TS=$(pi 12); ORACLE=$(pi 15); ORACLE_TS=$(pi 16)
BEST_BID=$(pi 24); BEST_ASK=$(pi 27)
MARK_AGE=$((HEAD_TS - MARK_TS)); ORACLE_AGE=$((HEAD_TS - ORACLE_TS))
info "mark $MARK (age ${MARK_AGE} s), oracle $ORACLE (age ${ORACLE_AGE} s), best bid $BEST_BID, best ask $BEST_ASK, orders $(pi 28)"
if [ "$MARK_AGE" -le "$REF_FRESH_SEC" ]; then pass "mark fresh (<= ${REF_FRESH_SEC} s refFreshSec)"; else warn "mark ${MARK_AGE} s old (> ${REF_FRESH_SEC} s): quotes revert MarkStale until it updates"; fi
if [ "$MARK" -gt 0 ] && [ "$MARK" -lt 16777215 ]; then pass "mark inside Perpl limit range [1, 16777215] (L-06)"; else fail "mark $MARK outside [1, 16777215]"; fi
STOP=$((MARK * 9950 / 10000))
CAP22=$((DEMO_LOTS * STOP * DEMO_MAX_GAP_BPS / 10000))
LOTS_AT_CAP=$((MAX_COVER_NOTIONAL_CNS / STOP))
info "1 lot = 1e-5 BTC = $(ausd "$((MARK * 1))") AUSD at mark (scale 1); demo stop 50 bps under mark = $STOP"
if [ "$CAP22" -le $((CANARY_VAULT_CNS / 10)) ]; then
    pass "demo cover 22 lots: notional $(ausd $((DEMO_LOTS * STOP))) AUSD, Cap $(ausd "$CAP22") <= TA/10 = 0.4 (4 AUSD vault)"
else
    fail "demo cover 22 lots: Cap $(ausd "$CAP22") > 0.4; buy fewer lots (CANARY_PARAMS section 3)"
fi
if [ "$LOTS_AT_CAP" -le 32 ]; then pass "max lots at the 20 AUSD cap = $LOTS_AT_CAP (<= 32, keeper fills <= 2 calls)"; else fail "max lots at the 20 AUSD cap = $LOTS_AT_CAP (> 32)"; fi
echo

echo "== AUSD $AUSD"
check "decimals" "$(c "$AUSD" 'decimals()(uint8)')" "6"
DS_ONCHAIN="$(c "$AUSD" 'DOMAIN_SEPARATOR()(bytes32)')"
DS_LOCAL="$(cast keccak "$(cast abi-encode 'f(bytes32,bytes32,bytes32,uint256,address)' \
    "$(cast keccak 'EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)')" \
    "$(cast keccak 'Agora Dollar')" "$(cast keccak '1')" 143 "$AUSD")")"
check "DOMAIN_SEPARATOR equals keccak(\"Agora Dollar\", \"1\", 143, AUSD)" "$DS_ONCHAIN" "$DS_LOCAL"
echo

echo "== Chainlink BTC/USD $FEED_BTC"
check "decimals" "$(c "$FEED_BTC" 'decimals()(uint8)')" "8"
check "description" "$(c "$FEED_BTC" 'description()(string)')" '"BTC / USD"'
RD="$(c "$FEED_BTC" 'latestRoundData()(uint80,int256,uint256,uint256,uint80)' "${D}json")"
ANSWER=$(printf '%s' "$RD" | jq -r '.[1]'); UPDATED=$(printf '%s' "$RD" | jq -r '.[3]')
FEED_AGE=$((HEAD_TS - UPDATED))
if [ "$FEED_AGE" -le "$FEED_MAX_AGE_SEC" ]; then pass "feed fresh: age ${FEED_AGE} s (<= ${FEED_MAX_AGE_SEC} s feedMaxAgeSec)"; else fail "feed ${FEED_AGE} s old (> ${FEED_MAX_AGE_SEC} s)"; fi
MARK_E8=$((MARK * 10000000))
DEV_BPS=$(awk -v a="$ANSWER" -v m="$MARK_E8" 'BEGIN { d = a - m; if (d < 0) d = -d; printf "%.1f", d * 1e4 / m }')
info "feed answer $(awk -v a="$ANSWER" 'BEGIN { printf "%.2f", a / 1e8 }') USD, Perpl mark $(awk -v m="$MARK" 'BEGIN { printf "%.1f", m / 10 }') USD, deviation ${DEV_BPS} bps"
echo

echo "== CRE simulation forwarder $CRE_FWD_SIM (GaplessCreSink constructor arg)"
check "typeAndVersion" "$(c "$CRE_FWD_SIM" 'typeAndVersion()(string)')" '"MockKeystoneForwarder 1.0.0"'
echo

echo "== Wallets"
for NAME in DEPLOYER ADMIN KEEPER LP RELAY TREASURY; do
    ADDR="${!NAME:-}"
    [ -z "$ADDR" ] && continue
    BAL=$(cast balance "$ADDR")
    AB=$(c "$AUSD" 'balanceOf(address)(uint256)' "$ADDR" | first)
    FROZEN=$(c "$AUSD" 'isAccountFrozen(address)(bool)' "$ADDR")
    NONCE=$(cast nonce "$ADDR")
    info "$NAME $ADDR: $(mon "$BAL") MON, $(ausd "$AB") AUSD, nonce $NONCE, AUSD frozen $FROZEN"
    [ "$FROZEN" = "false" ] || fail "$NAME is frozen on AUSD"
done
if [ -n "${DEPLOYER:-}" ]; then
    DN=$(cast nonce "$DEPLOYER")
    info "expected addresses if Deploy starts at deployer nonce $DN: CoverVault $(cast compute-address "$DEPLOYER" "${D}nonce" $((DN + 1)) | awk '{print $NF}'), CoverManager $(cast compute-address "$DEPLOYER" "${D}nonce" $((DN + 2)) | awk '{print $NF}'), GaplessFactory $(cast compute-address "$DEPLOYER" "${D}nonce" $((DN + 3)) | awk '{print $NF}')"
fi
echo

echo "== Gas price"
BASE_WEI=$(cast base-fee)
GP_WEI=$(cast gas-price)
TIP_RPC_WEI=$(printf '%d' "$(cast rpc eth_maxPriorityFeePerGas | tr -d '"')")
info "base fee $((BASE_WEI / 1000000000)) gwei, eth_gasPrice $((GP_WEI / 1000000000)) gwei, eth_maxPriorityFeePerGas $((TIP_RPC_WEI / 1000000000)) gwei"
MAX_FEE_WEI=$((MAX_FEE_GWEI * 1000000000)); TIP_WEI=$((TIP_GWEI * 1000000000))
EFF_WEI=$((BASE_WEI + TIP_WEI)); [ "$EFF_WEI" -gt "$MAX_FEE_WEI" ] && EFF_WEI=$MAX_FEE_WEI
if [ $((BASE_WEI + TIP_WEI)) -le "$MAX_FEE_WEI" ]; then
    pass "base + tip = $(((BASE_WEI + TIP_WEI) / 1000000000)) gwei <= planned maxFee ${MAX_FEE_GWEI} gwei"
else
    fail "base + tip = $(((BASE_WEI + TIP_WEI) / 1000000000)) gwei > planned maxFee ${MAX_FEE_GWEI} gwei: wait for the base fee to fall"
fi
echo

# Raw gas per tx from the 2026-10-06 dry run (forge 1.8.3, network monad, eth_estimateGas for CREATEs on a local
# non-fork node; wiring calls = 21,000 + calldata + simulated frame). Real AUSD approve from mainnet eth_estimateGas.
# Forge re-estimates every tx right before sending on chain 143, so these only size the budget.
echo "== Expected deploy cost (Monad bills gas limit x price; limit = raw x ${GAS_MULT}%)"
echo "   price charged = min(base + tip, maxFee) = $((EFF_WEI / 1000000000)) gwei; inclusion check uses maxFee ${MAX_FEE_GWEI} gwei"
printf '   %-42s %12s %12s %10s %10s\n' "tx" "raw gas" "gas limit" "MON paid" "MON bid"
TOT_LIMIT=0
row() {
    local lim=$(( ($2 * GAS_MULT + 99) / 100 ))
    TOT_LIMIT=$((TOT_LIMIT + lim))
    printf '   %-42s %12d %12d %10s %10s\n' "$1" "$2" "$lim" "$(mon $((lim * EFF_WEI)))" "$(mon $((lim * MAX_FEE_WEI)))"
}
row "1 AUSD.approve(predicted vault, 1e6)" 71099
row "2 new CoverVault (+40k real AUSD pull)" 3625865
row "3 new CoverManager" 10492966
row "4 new GaplessFactory (+ GaplessAccount impl)" 4620483
row "5 CoverManager.setFactory" 59570
row "6 CoverVault.setManager" 96341
row "7 CoverManager.grantRole(RISK_ADMIN)" 69520
row "8 CoverManager.grantRole(PAUSER)" 69532
row "9 CoverManager.grantRole(SIGMA, keeper)" 69532
row "10 CoverVault.grantRole(PAUSER)" 69604
if [ "$SPLIT_ADMIN" = "1" ]; then
    row "+ CoverManager.beginDefaultAdminTransfer" 70000
    row "+ CoverVault.beginDefaultAdminTransfer" 70000
fi
row "11 new GaplessCreSink" 656143
DEPLOY_LIMIT=$TOT_LIMIT
printf '   %-42s %12s %12d %10s %10s\n' "Deploy.s.sol total (deployer)" "" "$DEPLOY_LIMIT" "$(mon $((DEPLOY_LIMIT * EFF_WEI)))" "$(mon $((DEPLOY_LIMIT * MAX_FEE_WEI)))"
TOT_LIMIT=0
row "ListMarket run(): listMarket (RISK_ADMIN)" 300000
RISK_LIMIT=$TOT_LIMIT; TOT_LIMIT=0
row "ListMarket postSigma() (keeper)" 75000
row "ListMarket seed(): approve (LP)" 71099
row "ListMarket seed(): deposit 3e6 (LP)" 180000
if [ "$SPLIT_ADMIN" = "1" ]; then
    row "acceptDefaultAdminTransfer x2 (ADMIN)" 220000
fi
FORGE_DEFAULT_GAS=$(( (DEPLOY_LIMIT * 100 / GAS_MULT) * 130 / 100 ))
MGR_DEFAULT_GAS=$((10492966 * 130 / 100))
info "forge defaults (130% limits, maxFee 2 x base + tip) would charge $(mon $((FORGE_DEFAULT_GAS * (BASE_WEI + TIP_RPC_WEI)))) MON in total, and the CoverManager tx alone would need $(mon $((MGR_DEFAULT_GAS * (2 * BASE_WEI + TIP_RPC_WEI)))) MON of balance to be included: never deploy with defaults"
NEED_BID=$(( (DEPLOY_LIMIT + RISK_LIMIT) * MAX_FEE_WEI ))
NEED_PAID=$(( (DEPLOY_LIMIT + RISK_LIMIT) * EFF_WEI ))
PAUSE_RESERVE_WEI=20000000000000000 # 0.02 MON: pauseBuys, vault pause, one setMarketParams
info "deployer (also RISK_ADMIN, PAUSER in the three-wallet canary) pays $(mon "$NEED_PAID") MON for Deploy + listMarket; inclusion needs up to $(mon "$NEED_BID") MON; keep $(mon "$PAUSE_RESERVE_WEI") MON after for pause and params"
if [ -n "${DEPLOYER:-}" ]; then
    DBAL=$(cast balance "$DEPLOYER")
    NEED_MAX=$((NEED_BID > NEED_PAID + PAUSE_RESERVE_WEI ? NEED_BID : NEED_PAID + PAUSE_RESERVE_WEI))
    # awk compares as doubles: wei balances can pass 2^63.
    if awk -v b="$DBAL" -v n="$NEED_MAX" 'BEGIN { exit !(b >= n) }'; then
        pass "deployer balance $(mon "$DBAL") MON covers it (left after listing about $(awk -v b="$DBAL" -v p="$NEED_PAID" 'BEGIN { printf "%.4f", (b - p) / 1e18 }') MON)"
    else
        fail "deployer balance $(mon "$DBAL") MON is short: needs max(bid $(mon "$NEED_BID"), paid + reserve $(mon $((NEED_PAID + PAUSE_RESERVE_WEI)))) MON"
    fi
fi
echo
if [ "$FAILS" -eq 0 ]; then echo "RESULT: GO (0 FAIL)"; else echo "RESULT: NO-GO ($FAILS FAIL)"; fi
exit "$FAILS"
