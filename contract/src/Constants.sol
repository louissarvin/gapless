// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {MarketConfig, MarketParams, VaultConfig} from "./types/GaplessTypes.sol";

/// @title Constants
/// @notice Every Gapless constant, default and onchain bound (spec 3.2 with BUILD_PLAN 0 overrides).
/// @dev Bounds are inclusive. Defaults are the code defaults; the canary listing overrides two fields
/// (docs/CANARY_PARAMS.md).
library Constants {
    // Monad mainnet

    uint256 internal constant CHAIN_ID = 143;
    uint64 internal constant CHAIN_SELECTOR = 8_481_857_512_324_358_265;
    address internal constant PERPL_EXCHANGE = 0x34B6552d57a35a1D042CcAe1951BD1C370112a6F;
    address internal constant PERPL_OWNER_SAFE = 0xd0a0205e9188998E0bE7F2600a715aD3CD289Cb1;
    address internal constant AUSD = 0x00000000eFE302BEAA2b3e6e1b18d08D69a9012a;
    address internal constant FEED_BTC_USD = 0xc1d4C3331635184fA4C3c22fb92211B2Ac9E0546;
    address internal constant FEED_ETH_USD = 0x1B1414782B859871781bA3E4B0979b9ca57A0A04;
    address internal constant FEED_MON_USD = 0xBcD78f76005B7515837af6b50c7C52BCf73822fb;
    uint8 internal constant FEED_DECIMALS = 8;
    address internal constant CRE_FORWARDER_SIM = 0x9eF6468C5f37b976E57d52054c693269479A784d;
    address internal constant CRE_FORWARDER_PROD = 0x76c9cf548b4179F8901cda1f8623568b58215E62;
    address internal constant DEAD = 0x000000000000000000000000000000000000dEaD;

    // Perpl (Exchange 1.7.5)

    uint256 internal constant PERP_BTC = 1;
    uint256 internal constant PERP_MON = 10;
    uint256 internal constant PERP_ETH = 20;
    uint8 internal constant PERP_STATUS_ACTIVE = 4;
    uint8 internal constant ORDER_OPEN_LONG = 0;
    uint8 internal constant ORDER_OPEN_SHORT = 1;
    uint8 internal constant ORDER_CLOSE_LONG = 2;
    uint8 internal constant ORDER_CLOSE_SHORT = 3;
    uint8 internal constant ORDER_CANCEL = 4;
    uint8 internal constant ORDER_INCREASE_COLLATERAL = 5;
    uint8 internal constant ORDER_CHANGE = 6;
    uint8 internal constant POSITION_LONG = 0;
    uint8 internal constant POSITION_SHORT = 1;
    uint256 internal constant PERPL_MAX_MATCHES = 1000; // 0 or above 1000 means 1000
    uint256 internal constant PERPL_MAX_PD_PLUS_LD = 6; // AUSD has 6 decimals
    /// @dev Limit price range accepted by execOrder on mainnet (PriceOutOfRange(p, 1, 16777215), base 0, L-06).
    uint256 internal constant PERPL_MIN_PRICE_PNS = 1;
    uint256 internal constant PERPL_MAX_PRICE_PNS = 16_777_215;
    uint16 internal constant PERPL_EXT_VERSION = 1;
    /// @dev Builder attribution is impossible on direct onchain orders (Perpl docs), so ext = "".
    uint8 internal constant BUILDER_ID = 0;
    uint256 internal constant BUILDER_FEE_PER_100K = 0;
    /// @dev Cover close recipe (Recipe.t.sol): leverage 0, maxNegPnl 0, lastExecutionBlock = block.number.
    uint256 internal constant CLOSE_LEVERAGE_HDTHS = 0;
    uint256 internal constant CLOSE_MAX_NEG_PNL_BPS = 0;
    /// @dev User market open defaults (client side, mirrors Perpl app settings).
    uint256 internal constant USER_MAX_NEG_PNL_BPS = 300;
    uint256 internal constant USER_TTL_BLOCKS = 20;
    uint256 internal constant USER_MAX_MATCHES = 100;
    /// @dev Measured 2026-10-05: native stop IOC limit = best opposing book price x (1 -/+ 1%), fired on mark.
    uint256 internal constant PERPL_NATIVE_STOP_SLIPPAGE_BPS = 100;

    // Math

    uint256 internal constant BPS = 1e4;
    uint256 internal constant BPS_E2 = 1e6; // bps x 100
    uint256 internal constant PPM = 1e6;
    uint256 internal constant BLOCKS_PER_YEAR = 105_120_000; // 300 ms blocks
    uint256 internal constant NOTIONAL_PER_IMPACT_UNIT_CNS = 1e9; // 1,000 AUSD

    // Roles (OZ AccessControlDefaultAdminRules)

    bytes32 internal constant RISK_ADMIN_ROLE = keccak256("RISK_ADMIN_ROLE");
    bytes32 internal constant SIGMA_ROLE = keccak256("SIGMA_ROLE");
    bytes32 internal constant PAUSER_ROLE = keccak256("PAUSER_ROLE");
    uint48 internal constant ADMIN_DELAY = 1 hours;

    // EIP-712

    string internal constant FACTORY_EIP712_NAME = "GaplessFactory";
    string internal constant ACCOUNT_EIP712_NAME = "GaplessAccount";
    string internal constant EIP712_VERSION = "1";
    string internal constant AUSD_EIP712_NAME = "Agora Dollar";
    string internal constant AUSD_EIP712_VERSION = "1";
    bytes32 internal constant CREATE_ACCOUNT_TYPEHASH =
        keccak256(
            "CreateAccount(address owner,address key,uint64 expiry,uint128 maxNotional,uint128 maxNotionalPerDay,uint256 deadline)"
        );
    bytes32 internal constant WITHDRAW_TYPEHASH =
        keccak256("Withdraw(address account,uint256 amount,uint256 nonce,uint256 deadline)");
    bytes32 internal constant SET_OPERATOR_TYPEHASH = keccak256(
        "SetOperator(address account,address key,uint64 expiry,uint128 maxNotional,uint128 maxNotionalPerDay,uint256 nonce,uint256 deadline)"
    );

    // Vault

    uint8 internal constant VAULT_DECIMALS_OFFSET = 6;
    uint256 internal constant VAULT_SEED_CNS = 1e6; // 1 AUSD to DEAD at construction
    /// @dev Must be >= max over markets of maxDurationBlocks + windowBlocks + armTtlBlocks (enforced in setMarketParams).
    uint256 internal constant COOLDOWN_BLOCKS = 48_300;
    uint256 internal constant DEPOSIT_LOCK_BLOCKS = 48_300;
    uint16 internal constant MAX_UTILIZATION_BPS = 8000;
    uint16 internal constant MAX_UTILIZATION_BPS_MIN = 1000;
    uint16 internal constant MAX_UTILIZATION_BPS_MAX = 9000;
    uint16 internal constant PROTOCOL_FEE_BPS = 1000;
    uint16 internal constant PROTOCOL_FEE_BPS_MIN = 0;
    uint16 internal constant PROTOCOL_FEE_BPS_MAX = 3000;
    uint80 internal constant MIN_DEPOSIT_CNS = 1e6;
    uint80 internal constant MIN_DEPOSIT_CNS_MIN = 1e6;
    uint80 internal constant MIN_DEPOSIT_CNS_MAX = 100e6;

    // Per cover

    uint16 internal constant COVER_MAX_GAP_BPS_MIN = 50; // upper bound is market.maxGapBpsCap
    uint16 internal constant COVER_MAX_GAP_BPS_DEFAULT = 200;
    uint32 internal constant COVER_DURATION_DEFAULT = 12_000; // UI and plugin default, about 1 h
    uint256 internal constant REF_TS_TOLERANCE_SEC = 2; // Monad timestamps have 1 s granularity
    /// @dev N-01, C7 (SE2-H1): a close-floor chain survives only while each attempt lands within this many blocks of
    /// the touch's previous attempt (3 s at Monad's 0.3 s blocks).
    uint256 internal constant STEP_MAX_GAP_BLOCKS = 10;
    /// @dev N-01/N-04: floor allowance after k short attempts is min(floorSlack, A x 2^k); 5 x 2^6 > FLOOR_SLACK_BPS_MAX.
    uint256 internal constant CLOSE_FLOOR_MAX_STEPS = 6;
    /// @dev L-09: rent is at least minFeeCNS per started period of this many blocks (one default cover, about 1 h).
    uint256 internal constant RENT_FLOOR_PERIOD_BLOCKS = 12_000;
    uint256 internal constant CRE_REF_MAX_DEVIATION_BPS = 300; // stretch: CreRefStore vs oracle

    // Sigma (posted on demand by SIGMA_ROLE)

    uint32 internal constant SIGMA_BPS_E2_MIN = 5;
    uint32 internal constant SIGMA_BPS_E2_MAX = 2000;
    uint32 internal constant SIGMA_BPS_E2_CALM = 27;
    uint32 internal constant SIGMA_BPS_E2_STRESSED = 163;

    // CRE

    uint256 internal constant CRE_MAX_IDS = 3;
    /// @dev L-04: reports older than this are dropped (kinds 1, 2 in seconds; kind 3 in blocks).
    uint256 internal constant CRE_REPORT_MAX_AGE_SEC = 120;
    uint256 internal constant CRE_REPORT_MAX_AGE_BLOCKS = 400;
    uint8 internal constant CRE_KIND_REF = 1;
    uint8 internal constant CRE_KIND_WATCH = 2;
    uint8 internal constant CRE_KIND_ARMED_LOG = 3;

    // Operator defaults (client side; the owner sets the real grant)

    uint64 internal constant OPERATOR_EXPIRY_DEFAULT_SEC = 24 hours;
    uint128 internal constant OPERATOR_MAX_NOTIONAL_DEFAULT_CNS = 500e6;
    uint128 internal constant OPERATOR_MAX_NOTIONAL_PER_DAY_DEFAULT_CNS = 1000e6;
    /// @dev N-03: operator notional budget refills linearly over this window (leaky bucket).
    uint256 internal constant OPERATOR_WINDOW_SEC = 1 days;
    /// @dev M-01: operator limits further than this from Perpl's mark are rejected (both sides).
    uint256 internal constant OPERATOR_MAX_LIMIT_DEVIATION_BPS = 500;

    // Capacity (L-09)

    /// @dev One cover's Cap may use at most this share of its market's capacity (totalAssets x marketCapBps).
    uint256 internal constant MAX_COVER_CAP_SHARE_BPS = 1000;

    // MarketParams defaults and bounds (spec 3.2)

    uint16 internal constant SLIP_ALLOWANCE_BPS = 5;
    uint16 internal constant SLIP_ALLOWANCE_BPS_MIN = 5;
    uint16 internal constant SLIP_ALLOWANCE_BPS_MAX = 50;
    uint16 internal constant MAX_GAP_BPS_CAP = 200;
    uint16 internal constant MAX_GAP_BPS_CAP_MIN = 50;
    uint16 internal constant MAX_GAP_BPS_CAP_MAX = 500;
    uint16 internal constant FLOOR_SLACK_BPS = 100;
    uint16 internal constant FLOOR_SLACK_BPS_MIN = 10;
    uint16 internal constant FLOOR_SLACK_BPS_MAX = 300;
    uint16 internal constant REF_TOL_BPS = 50;
    uint16 internal constant REF_TOL_BPS_MIN = 0;
    uint16 internal constant REF_TOL_BPS_MAX = 200;
    uint16 internal constant MIN_STOP_DISTANCE_BPS = 10;
    uint16 internal constant MIN_STOP_DISTANCE_BPS_MIN = 5;
    uint16 internal constant MIN_STOP_DISTANCE_BPS_MAX = 500;
    uint16 internal constant K_DIST_E2 = 300;
    uint16 internal constant K_DIST_E2_MIN = 100;
    uint16 internal constant K_DIST_E2_MAX = 1000;
    uint16 internal constant LOAD_BPS = 5000;
    uint16 internal constant LOAD_BPS_MIN = 0;
    uint16 internal constant LOAD_BPS_MAX = 20_000;
    uint16 internal constant RENT_APR_BPS = 2000;
    uint16 internal constant RENT_APR_BPS_MIN = 0;
    uint16 internal constant RENT_APR_BPS_MAX = 10_000;
    uint16 internal constant U_KINK_BPS = 5000;
    uint16 internal constant U_KINK_BPS_MIN = 1000;
    uint16 internal constant U_KINK_BPS_MAX = 9000;
    uint16 internal constant SLOPE1_BPS = 5000;
    uint16 internal constant SLOPE1_BPS_MIN = 0;
    uint16 internal constant SLOPE1_BPS_MAX = 20_000;
    uint16 internal constant SLOPE2_BPS = 40_000;
    uint16 internal constant SLOPE2_BPS_MIN = 0;
    uint16 internal constant SLOPE2_BPS_MAX = 60_000;
    uint16 internal constant MARKET_CAP_BPS = 5000;
    uint16 internal constant MARKET_CAP_BPS_MIN = 500;
    uint16 internal constant MARKET_CAP_BPS_MAX = 10_000;
    uint16 internal constant PER_BLOCK_PAYOUT_CAP_BPS = 2500;
    uint16 internal constant PER_BLOCK_PAYOUT_CAP_BPS_MIN = 100;
    uint16 internal constant PER_BLOCK_PAYOUT_CAP_BPS_MAX = 10_000;
    uint16 internal constant MAX_LOSS_TO_DEPOSIT_BPS = 4000;
    uint16 internal constant MAX_LOSS_TO_DEPOSIT_BPS_MIN = 1000;
    uint16 internal constant MAX_LOSS_TO_DEPOSIT_BPS_MAX = 6000;
    uint16 internal constant IMPACT_BPS_PER_K_E2 = 10;
    uint16 internal constant IMPACT_BPS_PER_K_E2_MIN = 0;
    uint16 internal constant IMPACT_BPS_PER_K_E2_MAX = 1000;
    uint16 internal constant MAX_MATCHES_CLOSE = 16; // SA4-01: about 2.4M trigger gas on Perpl; canary lists 8
    uint16 internal constant MAX_MATCHES_CLOSE_MIN = 8;
    uint16 internal constant MAX_MATCHES_CLOSE_MAX = 200;
    uint32 internal constant WARMUP_BLOCKS = 200;
    uint32 internal constant WARMUP_BLOCKS_MIN = 100;
    uint32 internal constant WARMUP_BLOCKS_MAX = 2000;
    uint32 internal constant ARM_TTL_BLOCKS = 200;
    uint32 internal constant ARM_TTL_BLOCKS_MIN = 10;
    uint32 internal constant ARM_TTL_BLOCKS_MAX = 400;
    uint32 internal constant EXCLUSIVE_BLOCKS = 3;
    uint32 internal constant EXCLUSIVE_BLOCKS_MIN = 0;
    uint32 internal constant EXCLUSIVE_BLOCKS_MAX = 10;
    uint32 internal constant WINDOW_BLOCKS = 40;
    uint32 internal constant WINDOW_BLOCKS_MIN = 10;
    uint32 internal constant WINDOW_BLOCKS_MAX = 200;
    uint32 internal constant MIN_DURATION_BLOCKS = 1000;
    uint32 internal constant MAX_DURATION_BLOCKS = 48_000;
    uint32 internal constant DURATION_BLOCKS_MIN = 500; // bound for both min and max duration
    uint32 internal constant DURATION_BLOCKS_MAX = 48_000;
    /// @dev BUILD_PLAN override: sigma is posted on demand, so the age sits at its bound (spec default 600).
    uint32 internal constant SIGMA_MAX_AGE_BLOCKS = 6000;
    uint32 internal constant SIGMA_MAX_AGE_BLOCKS_MIN = 100;
    uint32 internal constant SIGMA_MAX_AGE_BLOCKS_MAX = 6000;
    uint32 internal constant REF_FRESH_SEC = 60;
    uint32 internal constant REF_FRESH_SEC_MIN = 10;
    uint32 internal constant REF_FRESH_SEC_MAX = 120;
    uint32 internal constant FEED_MAX_AGE_SEC = 120;
    uint32 internal constant FEED_MAX_AGE_SEC_MIN = 30;
    uint32 internal constant FEED_MAX_AGE_SEC_MAX = 3600;
    uint80 internal constant MIN_FEE_CNS = 20_000; // 0.02 AUSD
    uint80 internal constant MIN_FEE_CNS_MIN = 0;
    uint80 internal constant MIN_FEE_CNS_MAX = 1e6;
    /// @dev BUILD_PLAN override: default cap 50 AUSD, spec default 2,000e6 (canary lists 20e6, ListMarket).
    uint80 internal constant MAX_COVER_NOTIONAL_CNS = 50e6;
    uint80 internal constant MAX_COVER_NOTIONAL_CNS_MIN = 10e6;
    uint80 internal constant MAX_COVER_NOTIONAL_CNS_MAX = 100_000e6;

    // ParamOutOfBounds field indices: MarketParams declaration order, then cross-field rules.

    uint8 internal constant F_SLIP_ALLOWANCE = 0;
    uint8 internal constant F_MAX_GAP_CAP = 1;
    uint8 internal constant F_FLOOR_SLACK = 2;
    uint8 internal constant F_REF_TOL = 3;
    uint8 internal constant F_MIN_STOP_DISTANCE = 4;
    uint8 internal constant F_K_DIST = 5;
    uint8 internal constant F_LOAD = 6;
    uint8 internal constant F_RENT_APR = 7;
    uint8 internal constant F_U_KINK = 8;
    uint8 internal constant F_SLOPE1 = 9;
    uint8 internal constant F_SLOPE2 = 10;
    uint8 internal constant F_MARKET_CAP = 11;
    uint8 internal constant F_PER_BLOCK_PAYOUT_CAP = 12;
    uint8 internal constant F_MAX_LOSS_TO_DEPOSIT = 13;
    uint8 internal constant F_IMPACT = 14;
    uint8 internal constant F_MAX_MATCHES_CLOSE = 15;
    uint8 internal constant F_WARMUP = 16;
    uint8 internal constant F_ARM_TTL = 17;
    uint8 internal constant F_EXCLUSIVE = 18;
    uint8 internal constant F_WINDOW = 19;
    uint8 internal constant F_MIN_DURATION = 20;
    uint8 internal constant F_MAX_DURATION = 21;
    uint8 internal constant F_SIGMA_MAX_AGE = 22;
    uint8 internal constant F_REF_FRESH = 23;
    uint8 internal constant F_FEED_MAX_AGE = 24;
    uint8 internal constant F_MIN_FEE = 25;
    uint8 internal constant F_MAX_COVER_NOTIONAL = 26;
    uint8 internal constant F_Z_EDGES = 27; // strictly increasing, first > 0
    uint8 internal constant F_GAP_TABLE = 28; // each <= maxGapBpsCap * 100
    uint8 internal constant F_DURATION_ORDER = 29; // minDuration <= maxDuration
    uint8 internal constant F_COOLDOWN_COVERAGE = 30; // maxDuration + window + armTtl <= COOLDOWN_BLOCKS
    uint8 internal constant F_WARMUP_VS_DURATION = 31; // warmup < minDuration
    uint8 internal constant F_MARKET_CONFIG = 32; // listMarket: pd + ld <= 6, feedDecimals >= pd, perpId fits uint16
    uint8 internal constant F_SIGMA_POST = 33; // postSigma outside [SIGMA_BPS_E2_MIN, SIGMA_BPS_E2_MAX] (CR5)
    uint8 internal constant F_FLOOR_SLACK_VS_SLIP = 34; // floorSlack >= 2 x slipAllowance

    // CoverVault ConfigOutOfBounds field indices (VaultConfig declaration order).

    uint8 internal constant C_TREASURY = 0; // nonzero, not the vault, not the manager
    uint8 internal constant C_MAX_UTILIZATION = 1;
    uint8 internal constant C_PROTOCOL_FEE = 2;
    uint8 internal constant C_MIN_DEPOSIT = 3;

    /// @notice Code defaults (spec 3.2 plus BUILD_PLAN overrides); ListMarket applies the canary overrides.
    function defaultMarketParams() internal pure returns (MarketParams memory p) {
        p.slipAllowanceBps = SLIP_ALLOWANCE_BPS;
        p.maxGapBpsCap = MAX_GAP_BPS_CAP;
        p.floorSlackBps = FLOOR_SLACK_BPS;
        p.refTolBps = REF_TOL_BPS;
        p.minStopDistanceBps = MIN_STOP_DISTANCE_BPS;
        p.kDistE2 = K_DIST_E2;
        p.loadBps = LOAD_BPS;
        p.rentAprBps = RENT_APR_BPS;
        p.uKinkBps = U_KINK_BPS;
        p.slope1Bps = SLOPE1_BPS;
        p.slope2Bps = SLOPE2_BPS;
        p.marketCapBps = MARKET_CAP_BPS;
        p.perBlockPayoutCapBps = PER_BLOCK_PAYOUT_CAP_BPS;
        p.maxLossToDepositBps = MAX_LOSS_TO_DEPOSIT_BPS;
        p.impactBpsPerKE2 = IMPACT_BPS_PER_K_E2;
        p.maxMatchesClose = MAX_MATCHES_CLOSE;
        p.warmupBlocks = WARMUP_BLOCKS;
        p.armTtlBlocks = ARM_TTL_BLOCKS;
        p.exclusiveBlocks = EXCLUSIVE_BLOCKS;
        p.windowBlocks = WINDOW_BLOCKS;
        p.minDurationBlocks = MIN_DURATION_BLOCKS;
        p.maxDurationBlocks = MAX_DURATION_BLOCKS;
        p.sigmaMaxAgeBlocks = SIGMA_MAX_AGE_BLOCKS;
        p.refFreshSec = REF_FRESH_SEC;
        p.feedMaxAgeSec = FEED_MAX_AGE_SEC;
        p.minFeeCNS = MIN_FEE_CNS;
        p.maxCoverNotionalCNS = MAX_COVER_NOTIONAL_CNS;
        p.zEdgesE2 = [uint16(50), 100, 150, 200, 250, 300, 400, 600];
        p.gapBpsE2 = [uint16(194), 91, 101, 143, 229, 452, 492, 999, 950];
    }

    /// @notice BTC-PERP listing config (pd 1, ld 5, scale 1, BTC/USD feed).
    function btcMarketConfig() internal pure returns (MarketConfig memory c) {
        c = MarketConfig({
            listed: true,
            priceDecimals: 1,
            lotDecimals: 5,
            scale: 1,
            feed: FEED_BTC_USD,
            feedDecimals: FEED_DECIMALS,
            creRefStore: address(0)
        });
    }

    /// @notice Vault config at deploy; treasury from Deploy's TREASURY env.
    function defaultVaultConfig(address treasury) internal pure returns (VaultConfig memory c) {
        c = VaultConfig({
            treasury: treasury,
            maxUtilizationBps: MAX_UTILIZATION_BPS,
            protocolFeeBps: PROTOCOL_FEE_BPS,
            minDepositCNS: MIN_DEPOSIT_CNS
        });
    }
}
