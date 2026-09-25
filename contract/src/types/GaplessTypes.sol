// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

/// Units: CNS = AUSD 6 dec; PNS = Perpl price units (per-perp priceDecimals); LNS = Perpl lot units.

/// @notice Cover lifecycle. Terminal: Finalized, Cancelled, Expired, Voided.
/// @dev Live -> Armed -> Triggered -> Finalized; Live | Armed -> Cancelled | Expired | Voided; Armed -> Live (disarm).
/// Armed past armTtl is treated as Live lazily. Triggered never returns to Armed or Live.
enum CoverStatus {
    None,
    Live,
    Armed,
    Triggered,
    Finalized,
    Cancelled,
    Expired,
    Voided
}

enum EndReason {
    None,
    OwnerCancel,
    Expired,
    PositionReduced,
    PositionClosedOrFlipped,
    LiquidatedOrAdl
}

enum DisarmReason {
    ConditionGone,
    ArmTtlElapsed,
    VenueUnavailable
}

struct CoverParams {
    uint256 perpId;
    bool isLong;
    uint256 lots; // LNS, <= position lots
    uint256 stopPNS;
    uint16 maxGapBps; // [COVER_MAX_GAP_BPS_MIN, market.maxGapBpsCap]
    uint32 durationBlocks; // [minDurationBlocks, maxDurationBlocks]
}

struct Quote {
    uint256 notionalCNS; // lots * stop * scale
    uint256 capCNS; // notional * maxGapBps / 1e4, floor; reserved in the vault
    uint256 escrowCNS; // refundable trigger fee, ceil
    uint256 rentCNS; // non-refundable capital rent, ceil, >= minFeeCNS x ceil(T / 12,000) (L-09)
    uint256 feeBpsE2;
    uint256 utilAfterBps;
    uint256 distanceBps;
    uint256 minDistanceBps;
    uint256 expiryBlock;
}

/// @dev Six consecutive slots so one MIP-8 page usually warms the whole cover. C4 and C5 fields fill slot 5.
struct Cover {
    // slot 0
    address account;
    uint16 perpId;
    CoverStatus status;
    bool isLong;
    uint16 maxGapBps;
    bool observed;
    // slot 1
    uint40 lots;
    uint40 filledLots;
    uint32 stopPNS;
    uint48 startBlock;
    uint48 expiryBlock;
    uint48 armedBlock;
    // slot 2
    uint80 capCNS;
    uint80 escrowCNS;
    uint80 rentCNS;
    // slot 3
    uint48 triggerBlock;
    uint40 triggerTs;
    uint32 refTrigPNS;
    uint32 refPostPNS;
    uint80 paidCNS;
    // slot 4
    address armer;
    uint80 owedCNS;
    // slot 5
    uint128 gRealCumCNS;
    uint16 slipAllowanceBps; // A at purchase (L-03): every payout bound of this cover uses it
    uint16 floorSlackBps; // floorSlack at purchase (L-03)
    uint48 shortBlock; // most recent short attempt with R through the stop in the running chain (N-01, C7)
    uint8 shortSteps; // step of the next attempt in a later block: allowance min(floorSlack, A x 2^steps) (N-01)
    uint16 minDistanceBps; // minDistance at purchase: the M-03 refund zone (N-02)
    uint16 warmupBlocks; // warmup at purchase (L-03)
    uint8 windowBlocks; // observe and remainder window at purchase (L-03)
}

/// @notice Set by RISK_ADMIN at listing; immutable afterwards.
struct MarketConfig {
    bool listed;
    uint8 priceDecimals;
    uint8 lotDecimals;
    uint64 scale; // 10^(6 - pd - ld)
    address feed; // Chainlink Data Feed
    uint8 feedDecimals;
    address creRefStore; // 0 until production CRE (stretch)
}

/// @notice Per-market risk and pricing parameters. Every field is bounded onchain (see Constants).
struct MarketParams {
    uint16 slipAllowanceBps;
    uint16 maxGapBpsCap;
    uint16 floorSlackBps;
    uint16 refTolBps;
    uint16 minStopDistanceBps;
    uint16 kDistE2;
    uint16 loadBps;
    uint16 rentAprBps;
    uint16 uKinkBps;
    uint16 slope1Bps;
    uint16 slope2Bps;
    uint16 marketCapBps;
    uint16 perBlockPayoutCapBps;
    uint16 maxLossToDepositBps;
    uint16 impactBpsPerKE2;
    uint16 maxMatchesClose;
    uint32 warmupBlocks;
    uint32 armTtlBlocks;
    uint32 exclusiveBlocks;
    uint32 windowBlocks;
    uint32 minDurationBlocks;
    uint32 maxDurationBlocks;
    uint32 sigmaMaxAgeBlocks;
    uint32 refFreshSec;
    uint32 feedMaxAgeSec;
    uint80 minFeeCNS;
    uint80 maxCoverNotionalCNS;
    uint16[8] zEdgesE2;
    uint16[9] gapBpsE2;
}

struct SigmaState {
    uint32 sigmaBlkBpsE2;
    uint48 postedBlock;
}

/// @notice Owner-scoped trading key. Cannot withdraw. expiry 0 or key 0 means no operator.
struct OperatorGrant {
    address key;
    uint64 expiry; // unix seconds
    uint128 maxNotionalPerTradeCNS;
    uint128 maxNotionalPerDayCNS; // N-03: rolling budget over OPERATOR_WINDOW_SEC; 0 blocks operator trades and buys
}

/// @notice Storage deltas measured around one cover close (spec 3.3, D24).
struct CloseResult {
    uint256 filledLots; // p0.lotLNS - p1.lotLNS
    uint256 releasedDepositCNS; // p0.depositCNS - p1.depositCNS
    int256 realizedCNS; // (balance + locked)(after) - (balance + locked)(before); own resting orders cleared by the
    // close do not count (CR1)
    uint256 entryPNS; // p0.pricePNS
    int256 fundingCNS; // p0.premiumPnlCNS * filled / p0.lotLNS
    uint256 takerFeePpm; // getPerpFeeSchedule(perpId).taker[getAccountFeeTier(id)]
}

struct VaultConfig {
    address treasury;
    uint16 maxUtilizationBps;
    uint16 protocolFeeBps;
    uint80 minDepositCNS;
}

/// @notice ERC-7540-style redeem request; shares are escrowed in the vault until claimed.
struct RedeemRequest {
    address owner;
    uint96 shares;
    uint80 assetsAtRequest;
    uint48 claimableBlock;
}

/// @notice Per-market per-block payout cap, snapshotted at the first payout in a block.
struct PayoutBlockCap {
    uint48 blockNumber;
    uint80 capCNS;
    uint80 paidCNS;
}
