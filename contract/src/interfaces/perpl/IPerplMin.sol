// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

/// @title IPerplMin
/// @notice Curated Perpl Exchange surface used by Gapless. Every selector is checked against
/// dex-sdk `abi/dex/Exchange.json` (Exchange v1.7.5) by test/mocks/PerplSelectors.t.sol.
/// @dev Units: CNS collateral (AUSD, 6 dec), PNS price, LNS lots, ONS book slot (PNS = basePricePNS + ONS).
/// Empty book side reads 0 for its ONS fields (mainnet, perp 80, block 110,711,378).
interface IPerplMin {
    struct OrderDesc {
        uint256 orderDescId; // client tag; free-form on the direct path
        uint256 perpId;
        uint8 orderType; // 0 OpenLong, 1 OpenShort, 2 CloseLong, 3 CloseShort, 4 Cancel, 5 IncreasePositionCollateral, 6 Change
        uint256 orderId; // only for Cancel/Change
        uint256 pricePNS; // limit; bid side max price, ask side min price
        uint256 lotLNS;
        uint256 expiryBlock; // resting order expiry, 0 = never
        bool postOnly;
        bool fillOrKill;
        bool immediateOrCancel; // zero fill returns normally
        uint256 maxMatches; // 0 or > 1000 means 1000
        uint256 leverageHdths; // 1000 = 10x; 0 = perp max
        uint256 lastExecutionBlock; // 0 = none; block.number > it reverts
        uint256 amountCNS; // only for IncreasePositionCollateral
        uint256 maxNegPnlCollatBPS; // only on fills that open, increase or invert
    }

    struct OrderSignature {
        uint256 perpId;
        uint256 orderId; // 0 when nothing rests
    }

    struct PositionBitMap {
        uint256 bank1;
        uint256 bank2;
        uint256 bank3;
        uint256 bank4;
    }

    struct AccountInfo {
        uint256 accountId;
        uint256 balanceCNS; // free balance, settled within the same call as a fill
        uint256 lockedBalanceCNS;
        uint8 frozen;
        address accountAddr;
        PositionBitMap positions;
    }

    /// @dev No position reads all zeros, so positionType 0 (Long) with lotLNS 0. Check lots, not type.
    struct PositionInfo {
        uint256 accountId;
        uint256 nextNodeId;
        uint256 prevNodeId;
        uint8 positionType; // 0 Long, 1 Short
        uint256 depositCNS;
        uint256 pricePNS; // entry
        uint256 lotLNS;
        uint256 entryBlock;
        int256 pnlCNS; // unrealized vs mark
        int256 deltaPnlCNS;
        int256 premiumPnlCNS; // accrued funding, realized pro rata on reduce
    }

    struct PerpetualInfo {
        string name;
        string symbol;
        uint256 priceDecimals;
        uint256 lotDecimals;
        bytes32 linkFeedId;
        uint256 priceTolPer100K;
        uint256 marginTol;
        uint256 marginTolDecimals;
        uint256 refPriceMaxAgeSec;
        uint256 positionBalanceCNS;
        uint256 insuranceBalanceCNS;
        uint256 markPNS;
        uint256 markTimestamp;
        uint256 lastPNS;
        uint256 lastTimestamp;
        uint256 oraclePNS;
        uint256 oracleTimestampSec;
        uint256 longOpenInterestLNS;
        uint256 shortOpenInterestLNS;
        uint256 fundingStartBlock;
        int16 fundingRatePct100k;
        uint256 absFundingClampPctPer100K;
        uint8 status; // 0 paused, 4 active
        uint256 basePricePNS;
        uint256 maxBidPriceONS; // best bid, 0 if no bids
        uint256 minBidPriceONS;
        uint256 maxAskPriceONS;
        uint256 minAskPriceONS; // best ask, 0 if no asks
        uint256 numOrders;
        bool ignOracle;
    }

    function createAccount(uint256 amountCNS) external returns (uint256 accountId);
    function depositCollateral(uint256 amountCNS) external;
    function withdrawCollateral(uint256 amountCNS) external;
    function increasePositionCollateral(uint256 perpId, uint256 amountCNS) external;
    function execOrder(OrderDesc memory orderDesc) external returns (OrderSignature memory signature);
    function execOrderV2(OrderDesc memory orderDesc, bytes memory extension)
        external
        returns (OrderSignature memory signature);
    function execOrders(OrderDesc[] memory orderDescs, bool revertOnFail)
        external
        returns (OrderSignature[] memory signatures);

    function getAccountByAddr(address accountAddress) external view returns (AccountInfo memory accountInfo);
    function getAccountById(uint256 accountId) external view returns (AccountInfo memory accountInfo);
    function getPosition(uint256 perpId, uint256 accountId)
        external
        view
        returns (PositionInfo memory positionInfo, uint256 markPricePNS, bool markPriceValid);
    function getPerpetualInfo(uint256 perpId) external view returns (PerpetualInfo memory perpetualInfo);
    function getNextPriceBelowWithOrders(uint256 perpId, uint256 priceONS)
        external
        view
        returns (uint256 priceBelowONS);
    function getNextPriceAboveWithOrders(uint256 perpId, uint256 priceONS)
        external
        view
        returns (uint256 priceAboveONS);
    function getVolumeAtBookPrice(uint256 perpId, uint256 priceONS)
        external
        view
        returns (uint256 bids, uint256 expBids, uint256 asks, uint256 expAsks);

    /// @return tier Index into the fee schedule arrays.
    function getAccountFeeTier(uint256 accountId) external view returns (uint256 tier);
    /// @dev Values are ppm since 1.7.5 despite the ABI names (mainnet schedule 1021: taker[0] = 345).
    function getPerpFeeSchedule(uint256 perpId)
        external
        view
        returns (uint256 feeSchedId, uint256[8] memory takerFeesPer100K, uint256[8] memory makerFeesPer100K);
    function getTakerFee(uint256 perpId) external view returns (uint256);
    function getMinAccountOpenCNS() external view returns (uint256 minAccountOpenCNS);
    function getWithdrawAllowanceData(uint256 blockNumber)
        external
        view
        returns (uint256 allowanceCNS, uint256 expiryBlock, uint256 lastAllowanceBlock, uint256 cnsPerBlock);
    /// @dev 8,571 blocks on mainnet; never hardcode it.
    function getFundingInterval() external pure returns (uint256 fundingInterval);
    function getContractVersion() external view returns (uint256 major, uint256 minor, uint256 patch);

    function whitelistingEnabled() external view returns (bool);
    function whitelisted(address) external view returns (bool);
    function isHalted() external view returns (bool halted);
}
