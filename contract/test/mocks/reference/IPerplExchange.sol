// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.37;

library Exchange {
    struct PerpScalingConfig {
        uint256 perpId;
        uint256 fundingSumScalingExp;
    }

    struct ResidueTransfer {
        uint256 perpId;
        uint256 residueAmountCNS;
    }
}

interface IPerplExchange {
    type FreezeStatusEnum is uint8;
    type OpDescEnum is uint8;
    type OrderDescEnum is uint8;
    type OrderEnum is uint8;
    type PerpStatusEnum is uint8;
    type PositionEnum is uint8;
    type TriggerPriceConditionEnum is uint8;

    struct AccountFeeTier {
        uint256 accountId;
        uint256 tier;
    }

    struct AccountInfo {
        uint256 accountId;
        uint256 balanceCNS;
        uint256 lockedBalanceCNS;
        FreezeStatusEnum frozen;
        address accountAddr;
        PositionBitMap positions;
    }

    struct AdlDesc {
        uint256 perpId;
        uint256 posAccountId;
        uint256[] sortedPositionIds;
    }

    struct BuyToLiquidateDesc {
        uint256 perpId;
        uint256 posAccountId;
        uint256 lotLNS;
        uint256 leverageHdths;
        uint256 limitPricePNS;
        uint256 maxNegPnlCollatBPS;
    }

    struct FwdOrderDesc {
        uint256 accountId;
        uint256 feePer100K;
        OrderDesc orderDesc;
        bool execTriggerOrder;
        uint256 triggerPricePNS;
        TriggerPriceConditionEnum triggerPriceCondition;
        uint256 triggerRequestId;
        uint256 triggerPositionId;
    }

    struct FznOrderDesc {
        uint256 accountId;
        OrderDesc orderDesc;
    }

    struct LiquidationDesc {
        uint256 perpId;
        uint256 posAccountId;
        uint256 lotLNS;
        bool userProceedsToPosition;
    }

    struct LiquidationInfo {
        uint256 liqInsAmtPer100K;
        uint256 liqUserAmtPer100K;
        uint256 liqProtocolAmtPer100K;
        uint256 btlPriceThreshPer100K;
        uint256 btlInsAmtPer100K;
        uint256 btlUserAmtPer100K;
        uint256 btlBuyerAmtPer100K;
        uint256 btlProtocolAmtPer100K;
        bool btlRestrictBuyers;
    }

    struct OpDesc {
        uint256 opDescId;
        uint256 perpId;
        OpDescEnum opType;
        uint32 pricePNS;
        int256 fundingRatePct100k;
        bool allowOverwrite;
        bytes unverifiedReport;
    }

    struct Order {
        uint32 accountId;
        OrderEnum orderType;
        uint24 priceONS;
        uint40 lotLNS;
        uint16 recycleFeeRaw;
        uint32 expiryBlock;
        uint16 leverageHdths;
        uint16 orderId;
        uint16 prevOrderId;
        uint16 nextOrderId;
        uint16 maxNegPnlCollatBPS;
    }

    struct OrderDesc {
        uint256 orderDescId;
        uint256 perpId;
        OrderDescEnum orderType;
        uint256 orderId;
        uint256 pricePNS;
        uint256 lotLNS;
        uint256 expiryBlock;
        bool postOnly;
        bool fillOrKill;
        bool immediateOrCancel;
        uint256 maxMatches;
        uint256 leverageHdths;
        uint256 lastExecutionBlock;
        uint256 amountCNS;
        uint256 maxNegPnlCollatBPS;
    }

    struct OrderLock {
        uint32 orderLockId;
        uint32 nextOrderLockId;
        uint32 prevOrderLockId;
        OrderEnum orderType;
        uint40 lotLNS;
        uint80 amountCNS;
    }

    struct OrderSignature {
        uint256 perpId;
        uint256 orderId;
    }

    struct OrderV2 {
        uint32 accountId;
        OrderEnum orderType;
        uint24 priceONS;
        uint40 lotLNS;
        uint16 recycleFeeRaw;
        uint32 expiryBlock;
        uint16 leverageHdths;
        uint16 orderId;
        uint16 prevOrderId;
        uint16 nextOrderId;
        uint16 maxNegPnlCollatBPS;
        uint8 builderId;
        uint16 builderFeePer100K;
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
        PerpStatusEnum status;
        uint256 basePricePNS;
        uint256 maxBidPriceONS;
        uint256 minBidPriceONS;
        uint256 maxAskPriceONS;
        uint256 minAskPriceONS;
        uint256 numOrders;
        bool ignOracle;
    }

    struct PerpetualInfoV2 {
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
        PerpStatusEnum status;
        uint256 basePricePNS;
        uint256 maxBidPriceONS;
        uint256 minBidPriceONS;
        uint256 maxAskPriceONS;
        uint256 minAskPriceONS;
        uint256 numOrders;
        bool ignOracle;
        uint256 fundingSumScalingExp;
    }

    struct PositionBitMap {
        uint256 bank1;
        uint256 bank2;
        uint256 bank3;
        uint256 bank4;
    }

    struct PositionInfo {
        uint256 accountId;
        uint256 nextNodeId;
        uint256 prevNodeId;
        PositionEnum positionType;
        uint256 depositCNS;
        uint256 pricePNS;
        uint256 lotLNS;
        uint256 entryBlock;
        int256 pnlCNS;
        int256 deltaPnlCNS;
        int256 premiumPnlCNS;
    }

    struct PositionInfoV2 {
        uint256 accountId;
        uint256 nextNodeId;
        uint256 prevNodeId;
        PositionEnum positionType;
        uint256 depositCNS;
        uint256 pricePNS;
        uint256 lotLNS;
        uint256 entryBlock;
        int256 pnlCNS;
        int256 deltaPnlCNS;
        int256 premiumPnlCNS;
        uint256 priceResiduePNSQ16;
    }

    event AccountCreated(address account, uint256 id);
    event AccountFeeTierSet(uint256 indexed accountId, uint256 tier);
    event AccountFreeze(uint256 accountId, FreezeStatusEnum status);
    event AccountFrozen(FreezeStatusEnum status);
    event AccountLiquidationCredit(uint256 perpId, uint256 accountId, uint256 startBalanceCNS, uint256 endBalanceCNS);
    event AdminChanged(address previousAdmin, address newAdmin);
    event AdministratorUpdated(address administrator, bool added);
    event AmountExceedsAvailableBalance(uint256 amountCNS, uint256 availableBalanceCNS, uint256 balanceCNS);
    event BankruptcyPricePreventsDeleverage(
        uint256 perpId, uint256 accountId, PositionEnum positionType, uint256 bankruptcyPricePNS, uint256 markPricePNS
    );
    event BeaconUpgraded(address indexed beacon);
    event BlockStatusChanged(address indexed addr, bool blocked);
    event BorrowMarginNotMetAfterDecCollateral(uint256 perpId, uint256 accountId, int256 bmrCNS, int256 fmvAfterCNS);
    event BuyToLiquidateBuyerRestricted(uint256 perpId, address buyer);
    event BuyToLiquidateParamsUpdated(
        uint256 perpId, uint256 insAmtPer100K, uint256 userAmtPer100K, uint256 buyerAmtPer100K, uint256 protAmtPer100K
    );
    event BuyToLiquidateRestrictionUpdated(uint256 perpId, bool restrictBuyers);
    event BuyToLiquidateSettled(
        uint256 perpId,
        uint256 accountId,
        OrderEnum orderType,
        uint256 realizedPricePNS,
        uint256 lotLNS,
        int256 amountCNS,
        uint256 balanceCNS
    );
    event BuyToLiquidateSlippageExceeded(
        uint256 perpId, uint256 posAccountId, PositionEnum positionType, uint256 markPricePNS, uint256 limitPricePNS
    );
    event BuyToLiquidateStarted(
        uint256 perpId,
        uint256 posAccountId,
        uint256 liquidatorId,
        uint256 requestedLotLNS,
        uint256 leverageHdths,
        uint256 limitPricePNS,
        uint256 maxNegPnlCollatBPS
    );
    event BuyToLiquidateThresholdUpdated(uint256 perpId, uint256 thresholdPer100K);
    event CancelExistingInvalidCloseOrders(
        uint256 lockedLotLNS, PositionEnum lockedPositionType, PositionEnum newPositionType
    );
    event CannotAdjustEntryPriceToDecCollateral(
        uint256 perpId,
        uint256 accountId,
        uint256 amountCNS,
        uint256 adjustmentAmountCNS,
        uint256 entryPricePNS,
        int256 adjustedEntryPricePNS,
        PositionEnum positionType
    );
    event CantBuyToLiquidate(
        uint256 perpId,
        uint256 posAccountId,
        PositionEnum positionType,
        uint256 markPricePNS,
        uint256 bsLiqPricePNS,
        uint256 liqPricePNS,
        uint256 bkptPricePNS
    );
    event CantChangeCloseOrder(uint256 perpId, uint256 orderId, uint256 accountId);
    event CantDeleverageAgainstOpposingPositions(
        uint256 perpId,
        uint256 accountId,
        bool forceClose,
        PositionEnum positionType,
        uint256 deleveragePricePNS,
        uint256[] sortedPositionIds
    );
    event CantLiquidatePosAboveMMR(
        uint256 perpId, uint256 posAccountId, PositionEnum positionType, uint256 markPricePNS, uint256 liqPricePNS
    );
    event ChangeExpiredOrderNeedsNewExpiry(uint256 perpId, uint256 orderId, uint256 accountId, uint256 expiryBlock);
    event ClearingExpiredOrder(
        uint256 perpId,
        uint256 accountId,
        uint256 orderId,
        uint256 lockedBalanceCNS,
        uint256 recyclerAccountId,
        int256 recyclerAmountCNS,
        uint256 recyclerBalanceCNS
    );
    event ClearingFrozenAccountOrder(
        uint256 perpId,
        uint256 accountId,
        uint256 orderId,
        uint256 lockedBalanceCNS,
        uint256 recyclerAccountId,
        int256 recyclerAmountCNS,
        uint256 recyclerBalanceCNS
    );
    event ClearingInvalidCloseOrder(
        uint256 perpId,
        uint256 accountId,
        uint256 orderId,
        uint256 lockedBalanceCNS,
        uint256 recyclerAccountId,
        int256 recyclerAmountCNS,
        uint256 recyclerBalanceCNS
    );
    event ClearingRemainingOrderLockBeyondBalance(
        uint256 perpId,
        uint256 accountId,
        uint256 orderId,
        uint256 pricePNS,
        uint256 remainingLotLNS,
        uint256 lockedBalanceCNS,
        uint256 excessiveLockedBalCNS,
        uint256 recyclerAccountId,
        int256 recyclerAmountCNS,
        uint256 recyclerBalanceCNS
    );
    event ClearingSelfMatchingOrder(
        uint256 perpId,
        uint256 accountId,
        uint256 orderId,
        uint256 lockedBalanceCNS,
        uint256 recyclerAccountId,
        int256 recyclerAmountCNS,
        uint256 recyclerBalanceCNS
    );
    event CloseOrderExceedsPosition(uint256 posLotLNS, uint256 orderLotLNS);
    event CloseOrderPositionMismatch(PositionEnum positionType, OrderEnum orderType);
    event CollateralDecreaseDeclined(uint256 perpId, uint256 accountId, string reason);
    event CollateralDecreaseRequestCancelled(uint256 perpId, uint256 accountId);
    event CollateralDecreaseRequestExpired(uint256 perpId, uint256 accountId, uint256 expiryTS, uint256 blockTS);
    event CollateralDecreaseRequested(
        uint256 perpId,
        uint256 accountId,
        uint256 expiryTS,
        uint256 amountCNS,
        bool clampToMaximum,
        PositionEnum positionType,
        uint256 entryPricePNS,
        uint256 lotLNS
    );
    event CollateralDeposit(uint256 accountId, uint256 amountCNS, uint256 balanceCNS);
    event CollateralWithdrawal(uint256 accountId, uint256 amountCNS, uint256 balanceCNS);
    event ContractAdded(
        uint256 perpId,
        string name,
        string symbol,
        PerpStatusEnum status,
        uint256 basePricePNS,
        uint256 priceDecimals,
        uint256 lotDecimals,
        uint256 takerFeePer100K,
        uint256 makerFeePer100K,
        uint256 initMarginFracHdths,
        uint256 maintMarginFracHdths,
        uint256 maxOpenInterestLNS,
        uint256 unityDescentThreshHdths,
        uint256 overColDescentThreshHdths,
        uint256 dcpBorrowThreshHdths,
        uint256 priceTolPer100K,
        uint256 marginTol,
        uint256 marginTolDecimals,
        uint256 refPriceMaxAgeSec,
        uint256 absFundingClampPctPer100K,
        uint256 permCancelMinOrders,
        uint256 permCancelSegment,
        uint256 insAmtPer100K,
        uint256 liqInsAmtPer100K,
        uint256 liqUserAmtPer100K,
        bool btlRestrictBuyers,
        uint256 btlPriceThreshPer100K,
        uint256 btlInsAmtPer100K,
        uint256 btlUserAmtPer100K,
        uint256 btlBuyerAmtPer100K,
        uint256 numPerpetuals
    );
    event ContractAddedV2(
        uint256 perpId,
        string name,
        string symbol,
        PerpStatusEnum status,
        uint256 basePricePNS,
        uint256 priceDecimals,
        uint256 lotDecimals,
        uint256 initMarginFracHdths,
        uint256 maintMarginFracHdths,
        uint256 maxOpenInterestLNS,
        uint256 unityDescentThreshHdths,
        uint256 overColDescentThreshHdths,
        uint256 dcpBorrowThreshHdths,
        uint256 priceTolPer100K,
        uint256 marginTol,
        uint256 marginTolDecimals,
        uint256 refPriceMaxAgeSec,
        uint256 absFundingClampPctPer100K,
        uint256 permCancelMinOrders,
        uint256 permCancelSegment,
        uint256 insAmtPer100K,
        uint256 liqInsAmtPer100K,
        uint256 liqUserAmtPer100K,
        bool btlRestrictBuyers,
        uint256 btlPriceThreshPer100K,
        uint256 btlInsAmtPer100K,
        uint256 btlUserAmtPer100K,
        uint256 btlBuyerAmtPer100K,
        uint256 numPerpetuals,
        uint256 perpFeeSchedId
    );
    event ContractLinkFeedUpdated(uint256 perpId, bytes32 feedId);
    event ContractNotOperational(uint256 perpId, PerpStatusEnum status);
    event ContractPaused(uint256 perpId, bool paused);
    event ContractRemoved(uint256 perpId);
    event ContractVersionSet(uint256 major, uint256 minor, uint256 patch);
    event CrossesBook(uint256 minAskOrMaxBidPNS, bool maxOrdersChecked);
    event DcpBorrowThreshUpdated(uint256 perpId, uint256 threshHdths);
    event DecreaseCollateralBeyondMarkPrice(
        uint256 perpId, uint256 accountId, PositionEnum positionType, uint256 impactAdjPricePNS, uint256 markPricePNS
    );
    event DefaultPerpFeeScheduleSet(
        uint256 indexed feeSchedId, uint256[8] takerFeesPer100K, uint256[8] makerFeesPer100K
    );
    event DefaultRwaFeeScheduleSet(
        uint256 indexed feeSchedId, uint256[8] takerFeesPer100K, uint256[8] makerFeesPer100K
    );
    event DeleveragePositionListEmpty(uint256 perpId, uint256 accountId);
    event ExceedsLastExecutionBlock(uint256 lastExecutionBlock);
    event ExchangeHalted(bool halted);
    event ExchangeInitialized(
        address sender,
        address collateralToken,
        uint256 collateralDecimals,
        uint256 minAccountOpenCNS,
        uint256 wrlsThousandthsTvl,
        uint256 wrlsMinWithdrawLimitCNS,
        uint256 recycleFeeCNS,
        bool whitelistingEnabled
    );
    event FeeParamsUpdated(uint256 perpId, uint256 insAmtPer100K);
    event FeeScheduleMigrated(
        uint256 indexed feeSchedId,
        uint256[8] oldTakerFees,
        uint256[8] oldMakerFees,
        uint256[8] newTakerFees,
        uint256[8] newMakerFees
    );
    event FeeScheduleSet(uint256 indexed feeSchedId, uint256[8] takerFeesPer100K, uint256[8] makerFeesPer100K);
    event FeeUnitRedenominated(
        uint256 oldDenominator,
        uint256 newDenominator,
        uint256 unitScale,
        uint256 rateDiv,
        uint256 migratedScheduleCount
    );
    event FundingClampPctUpdated(uint256 perpId, uint256 clampPctPer100k);
    event FundingEventCompleted(
        uint256 perpId,
        uint256 fundingEventBlock,
        int256 specifiedRatePct100k,
        int256 actualRatePct100k,
        uint256 fundingPricePNS,
        int48 fundingPaymentPNS,
        int48 fundingSumPNS,
        bool allowOverwrite
    );
    event FundingEventSetTooEarly(uint256 perpId, uint256 blockNumber, uint256 fundingEventBlock);
    event FundingPriceExceedsTol(uint256 perpId, uint256 fundingPricePNS, uint256 oraclePNS, uint256 tolerancePer100k);
    event FundingSumAlreadySet(
        uint256 perpId, uint256 fundingEventBlock, uint256 storageIndex, uint256 fundingSumOffset
    );
    event FundingSumScalingExpUpdated(uint256 perpId, uint256 newExp);
    event IgnoreOracleUpdated(uint256 perpId, bool ignOracle);
    event ImmediateOrCancelExecuted(uint256 unmatchedLotLNS, uint256 totalLotLNS);
    event IncreasePositionCollateral(
        uint256 perpId, uint256 accountId, uint256 positionDepositCNS, uint256 amountCNS, uint256 balanceCNS
    );
    event InitialMarginFractionUpdated(uint256 perpId, uint256 initMarginFracHdths);
    event Initialized(uint8 version);
    event InsolventPositionCannotBeForcedClose(
        uint256 perpId,
        uint256 posAccountId,
        PositionEnum positionType,
        uint256 bankruptcyPricePNS,
        uint256 markPricePNS
    );
    event InsufficientFundsToDecCollateral(
        uint256 perpId, uint256 accountId, uint256 amountCNS, uint256 withdrawMaxCNS
    );
    event InsuficientFundsForRecycleFee(
        uint256 perpId, uint256 accountId, uint256 balanceCNS, uint256 lockedCNS, uint256 recycleFeeCNS
    );
    event InsurancePaymentForSettlement(uint256 perpId, uint256 accountId, uint256 insPaymentCNS);
    event InvalidAccountFrozenOrder(OrderDescEnum orderType, bool immediateOrCancel);
    event InvalidBankruptcyPrice(
        uint256 perpId,
        uint256 accountId,
        uint256 depositCNS,
        uint256 posPricePNS,
        uint256 liqLotLNS,
        int256 premiumPnlCNS
    );
    event InvalidExpiryBlock(uint256 expiryBlock, uint256 blockNumber);
    event InvalidLinkReportForContract(uint256 perpId, bytes32 perpFeedId, bytes32 reportFeedId);
    event InvalidLinkReportVersion(uint256 perpId, uint256 reportVersion);
    event InvalidLiquidationPrice(
        uint256 perpId,
        uint256 accountId,
        uint256 depositCNS,
        uint256 posPricePNS,
        uint256 liqLotLNS,
        int256 premiumPnlCNS
    );
    event InvalidOrderId(uint256 orderId, uint256 min, uint256 max);
    event LastForwardedDescIdReset(uint256 accountId, uint256 newDescId);
    event LastTriggeredDescIdReset(uint256 accountId, uint256 newDescId);
    event LinkDatastreamConfigured(address verifierProxy);
    event LinkDsError(uint256 perpId, string reason);
    event LinkDsError(uint256 perpId, bytes lowLevelData);
    event LinkDsPanic(uint256 perpId, uint256 errorCode);
    event LinkPriceUpdated(uint256 perpId, uint256 oraclePricePNS, uint256 timestamp);
    event LiquidationBuyerUpdated(address liquidationBuyer, uint256 accountId, bool added);
    event LiquidationParamsUpdated(
        uint256 perpId, uint256 insAmtPer100K, uint256 liqAmtPer100K, uint256 userAmtPer100K
    );
    event LotOutOfRange(uint256 minLotLNS, uint256 maxLotLNS);
    event MaintenanceMarginFractionUpdated(uint256 perpId, uint256 maintMarginFracHdths);
    event MakerFeeUpdated(uint256 perpId, uint256 makerFeePer100K);
    event MakerOrderFilled(
        uint256 perpId,
        uint256 accountId,
        uint256 orderId,
        uint256 pricePNS,
        uint256 lotLNS,
        uint256 feeCNS,
        uint256 lockedBalanceCNS,
        int256 amountCNS,
        uint256 balanceCNS
    );
    event MakerOrderFilledV2(
        uint256 perpId,
        uint256 accountId,
        uint256 orderId,
        uint256 pricePNS,
        uint256 lotLNS,
        uint256 feeCNS,
        uint256 lockedBalanceCNS,
        int256 amountCNS,
        uint256 balanceCNS,
        uint256 builderId,
        uint256 builderFeeCNS
    );
    event MakerOrderSettlementFailed(
        uint256 perpId,
        uint256 accountId,
        uint256 orderId,
        OrderEnum orderType,
        uint256 pricePNS,
        uint256 lotLNS,
        uint256 maxNegPnlCollatBPS,
        uint256 reason,
        uint256 lockedBalanceCNS,
        uint256 recyclerAccountId,
        int256 recyclerAmountCNS,
        uint256 recyclerBalanceCNS
    );
    event MarginTolUpdated(uint256 perpId, uint256 tolerance, uint256 decimals);
    event MarkExceedsTol(uint256 perpId, uint256 markPNS, uint256 spotOraclePricePNS, uint256 tolerancePer100k);
    event MarkPriceAgeExceedsMax(uint256 perpId, uint256 markTimestamp, uint256 timestamp, uint256 maxAgeSec);
    event MarkUpdated(uint256 perpId, uint256 pricePNS);
    event MaxMatchesReached();
    event MaxOpenInterestUpdated(uint256 perpId, uint256 maxOpenInterestLNS);
    event MaximumAccountOrders(uint256 perpId, uint256 accountId);
    event MinAccountOpenAmountUpdated(uint256 minAccountOpenCNS);
    event MinPostUpdated(uint256 minPostCNS);
    event MinSettleUpdated(uint256 minSettleCNS);
    event MonitorAdministratorUpdated(address monitorAdministrator, bool added);
    event MonitorPauseAttempted(uint256 perpId, PerpStatusEnum actualStatus, bool transitioned);
    event OracleAgeExceedsMax(uint256 perpId, uint256 oracleTimestamp, uint256 timestamp, uint256 maxAgeSec);
    event OracleDisabled(uint256 perpId);
    event OrderBatchCompleted(uint256 gasLeft);
    event OrderCancelled(uint256 lockedBalanceCNS, int256 amountCNS, uint256 balanceCNS);
    event OrderCancelledByAdmin(uint256 perpId, uint256 accountId, uint256 orderId, uint256 lockedBalanceCNS);
    event OrderCancelledByLiquidator(uint256 perpId, uint256 accountId, uint256 orderId, uint256 lockedBalanceCNS);
    event OrderChanged(
        uint256 orderId,
        uint256 pricePNS,
        uint256 lotLNS,
        uint256 expiryBlock,
        uint256 lockedBalanceCNS,
        uint256 balanceCNS
    );
    event OrderDescIdTooLow(uint256 lastOrderDescId);
    event OrderDoesNotExist(uint256 perpId, uint256 orderId);
    event OrderExtensionRejected(uint256 perpId, uint256 accountId);
    event OrderForwardingNotAllowed();
    event OrderForwardingUpdated(uint256 accountId, bool allowed);
    event OrderPlaced(uint256 orderId, uint256 lotLNS, uint256 lockedBalanceCNS, int256 amountCNS, uint256 balanceCNS);
    event OrderPostFailed(uint256 reason);
    event OrderRequest(
        uint256 perpId,
        uint256 accountId,
        uint256 orderDescId,
        uint256 orderId,
        OrderDescEnum orderType,
        uint256 pricePNS,
        uint256 lotLNS,
        uint256 expiryBlock,
        bool postOnly,
        bool fillOrKill,
        bool immediateOrCancel,
        uint256 maxMatches,
        uint256 leverageHdths,
        uint256 lastExecutionBlock,
        uint256 amountCNS,
        uint256 maxNegPnlCollatBPS,
        uint256 gasLeft
    );
    event OrderRequestV2(
        uint256 perpId,
        uint256 accountId,
        uint256 orderDescId,
        uint256 orderId,
        OrderDescEnum orderType,
        uint256 pricePNS,
        uint256 lotLNS,
        uint256 expiryBlock,
        bool postOnly,
        bool fillOrKill,
        bool immediateOrCancel,
        uint256 maxMatches,
        uint256 leverageHdths,
        uint256 lastExecutionBlock,
        uint256 amountCNS,
        uint256 maxNegPnlCollatBPS,
        uint256 gasLeft,
        bytes extension
    );
    event OrderSettlementImpliesInsolvent(
        uint256 perpId,
        uint256 accountId,
        OrderEnum orderType,
        uint256 pricePNS,
        uint256 lotLNS,
        uint256 perpPositionBalCNS,
        uint256 perpInsuranceBalCNS,
        uint256 addedPosCollatReqCNS,
        uint256 requestedAmountCNS
    );
    event OrderSizeExceedsAvailableSize(uint256 orderLotLNS, uint256 availableLotLNS, uint256 positionLotLNS);
    event OverCollatDescentThreshUpdated(uint256 perpId, uint256 threshHdths);
    event OwnershipTransferStarted(address indexed previousOwner, address indexed newOwner);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event PermissonedCancelParamsUpdated(uint256 cancelMinOrders, uint256 cancelSegment);
    event PerpFeeSchedIdSet(uint256 indexed perpId, uint256 feeSchedId);
    event PerpPositionBalCreditPositiveSevere(
        uint256 perpId,
        uint256 accountId,
        uint256 realizedPricePNS,
        uint256 lotLNS,
        bool userProceedsToPosition,
        bool buyToLiquidate,
        int256 creditPerpBalCNS
    );
    event PositionAdministratorUpdated(address positionAdministrator, bool added);
    event PositionClosed(
        uint256 perpId,
        uint256 accountId,
        PositionEnum positionType,
        uint256 pricePNS,
        int256 deltaPnlCNS,
        int256 fundingCNS
    );
    event PositionCollateralDecreased(
        uint256 perpId,
        uint256 accountId,
        PositionEnum positionType,
        uint256 markPricePNS,
        uint256 impactAdjPricePNS,
        uint256 startDepositCNS,
        uint256 endDepositCNS,
        uint256 startEntryPricePNS,
        uint256 endEntryPricePNS,
        uint256 effBmfHdths,
        uint256 decreaseCNS,
        uint256 balanceCNS
    );
    event PositionDecreased(
        uint256 perpId,
        uint256 accountId,
        PositionEnum positionType,
        uint256 startDepositCNS,
        uint256 endDepositCNS,
        uint256 startLotLNS,
        uint256 endLotLNS,
        int256 deltaPnlCNS,
        int256 fundingCNS
    );
    event PositionDeleveraged(
        uint256 perpId,
        uint256 accountId,
        bool forceClose,
        PositionEnum positionType,
        uint256 entryPricePNS,
        uint256 markPricePNS,
        uint256 deleveragePricePNS,
        int256 deltaPnlCNS,
        int256 fundingCNS,
        uint256 startDepositCNS,
        uint256 endDepositCNS,
        uint256 startLotLNS,
        uint256 endLotLNS,
        uint256 amountCNS,
        uint256 balanceCNS
    );
    event PositionDeleveragedV2(
        uint256 perpId,
        uint256 accountId,
        bool forceClose,
        PositionEnum positionType,
        uint256 entryPricePNS,
        uint256 markPricePNS,
        uint256 deleveragePricePNS,
        int256 deltaPnlCNS,
        int256 fundingCNS,
        uint256 startDepositCNS,
        uint256 endDepositCNS,
        uint256 startLotLNS,
        uint256 endLotLNS,
        uint256 amountCNS,
        uint256 balanceCNS,
        uint256 priceResiduePNSQ16
    );
    event PositionDoesNotExist(uint256 perpId, uint256 accountId);
    event PositionIncreased(
        uint256 perpId,
        uint256 accountId,
        PositionEnum positionType,
        uint256 leverageHdths,
        uint256 startDepositCNS,
        uint256 endDepositCNS,
        int256 pnlCollateralizedCNS,
        int256 premiumPnlSettledCNS,
        uint256 maxNegPnlCollatBPS,
        uint256 pricePNS,
        uint256 startLotLNS,
        uint256 endLotLNS,
        uint256 insFeeCNS,
        uint256 protFeeCNS
    );
    event PositionIncreasedV2(
        uint256 perpId,
        uint256 accountId,
        PositionEnum positionType,
        uint256 leverageHdths,
        uint256 startDepositCNS,
        uint256 endDepositCNS,
        int256 pnlCollateralizedCNS,
        int256 premiumPnlSettledCNS,
        uint256 maxNegPnlCollatBPS,
        uint256 pricePNS,
        uint256 startLotLNS,
        uint256 endLotLNS,
        uint256 insFeeCNS,
        uint256 protFeeCNS,
        uint256 priceResiduePNSQ16
    );
    event PositionInverted(
        uint256 perpId,
        uint256 accountId,
        PositionEnum positionType,
        uint256 leverageHdths,
        uint256 startDepositCNS,
        uint256 endDepositCNS,
        int256 pnlCollateralizedCNS,
        uint256 pricePNS,
        uint256 startLotLNS,
        uint256 endLotLNS,
        int256 deltaPnlCNS,
        int256 fundingCNS,
        uint256 insFeeCNS,
        uint256 protFeeCNS
    );
    event PositionLiquidated(
        uint256 perpId,
        uint256 posAccountId,
        PositionEnum positionType,
        uint256 markPricePNS,
        uint256 liqPricePNS,
        uint256 liqLotLNS,
        uint256 posLotLNS,
        int256 deltaPnlCNS,
        int256 fundingCNS,
        int256 posAmountCNS,
        uint256 posDepositCNS,
        int256 accAmountCNS,
        uint256 accBalanceCNS,
        bool onOrderBook
    );
    event PositionLiquidationCredit(uint256 perpId, uint256 accountId, uint256 startDepositCNS, uint256 endDepositCNS);
    event PositionOpened(
        uint256 perpId,
        uint256 accountId,
        PositionEnum positionType,
        uint256 leverageHdths,
        uint256 depositCNS,
        int256 pnlCollateralizedCNS,
        uint256 pricePNS,
        uint256 lotLNS,
        uint256 insFeeCNS,
        uint256 protFeeCNS
    );
    event PositionOpenedV2(
        uint256 perpId,
        uint256 accountId,
        PositionEnum positionType,
        uint256 leverageHdths,
        uint256 depositCNS,
        int256 pnlCollateralizedCNS,
        uint256 pricePNS,
        uint256 lotLNS,
        uint256 insFeeCNS,
        uint256 protFeeCNS,
        uint256 priceResiduePNSQ16
    );
    event PositionUnwound(
        uint256 perpId,
        uint256 accountId,
        uint256 markPricePNS,
        PositionEnum positionType,
        uint256 pricePNS,
        uint256 lotLNS,
        uint256 depositCNS,
        int256 positionFmvCNS,
        uint256 paymentCNS,
        uint256 balanceCNS
    );
    event PositionUnwoundV2(
        uint256 perpId,
        uint256 accountId,
        uint256 markPricePNS,
        PositionEnum positionType,
        uint256 pricePNS,
        uint256 lotLNS,
        uint256 depositCNS,
        int256 positionFmvCNS,
        uint256 paymentCNS,
        uint256 balanceCNS,
        uint256 priceResiduePNSQ16
    );
    event PositionUnwoundWithoutPayment(
        uint256 perpId,
        uint256 accountId,
        uint256 markPricePNS,
        PositionEnum positionType,
        uint256 pricePNS,
        uint256 lotLNS,
        uint256 depositCNS,
        int256 positionFmvCNS,
        uint256 amountOwedCNS
    );
    event PositionUnwoundWithoutPaymentV2(
        uint256 perpId,
        uint256 accountId,
        uint256 markPricePNS,
        PositionEnum positionType,
        uint256 pricePNS,
        uint256 lotLNS,
        uint256 depositCNS,
        int256 positionFmvCNS,
        uint256 amountOwedCNS,
        uint256 priceResiduePNSQ16
    );
    event PostOrderUnderMinimum(uint256 orderAmountCNS, uint256 minAmountCNS);
    event PriceAdministratorUpdated(address priceAdministrator, bool added);
    event PriceMaxAgeUpdated(uint256 perpId, uint256 maxAgeSec);
    event PriceOutOfRange(uint256 minPricePNS, uint256 maxPricePNS);
    event PriceSetDuringTriggerExec(uint256 triggerPricePNS);
    event PriceTolUpdated(uint256 perpId, uint256 tolPer100k);
    event ProtocolBalanceDeposit(uint256 amountCNS);
    event ProtocolBalanceWithdraw(uint256 amountCNS);
    event RecycleBalanceInsufficientSevere(
        uint256 accountId, uint256 perpId, uint256 orderId, uint256 recycleFeeCNS, uint256 recycleBalanceCNS
    );
    event RecycleFeeToAccount(
        uint256 accountId, uint256 perpId, uint256 orderId, uint256 recycleFeeCNS, uint256 recycleBalanceCNS
    );
    event RecycleFeeToProtocol(uint256 perpId, uint256 orderId, uint256 recycleFeeCNS, uint256 recycleBalanceCNS);
    event RecycleFeeUpdated(uint256 recycleFeeCNS);
    event ReportAgeExceedsLastUpdate(uint256 perpId, uint256 lastUpdateTimestamp, uint256 reportValidFromTimestamp);
    event ReportExpiresTooSoon(uint256 perpId, uint256 expiresAt, uint256 minRequired);
    event ReportFromFuture(uint256 perpId, uint256 reportTimestamp, uint256 blockTimestamp);
    event ReportPriceIsNegative(uint256 perpId, int256 reportPrice);
    event ResidueBalanceInsufficient(uint256 perpId, uint256 requestedAmountCNS, uint256 positionBalanceCNS);
    event ResidueTransferred(uint256 perpId, uint256 residueAmountCNS, uint256 positionBalanceCNS);
    event TakerFeeUpdated(uint256 perpId, uint256 takerFeePer100K);
    event TakerOrderFilled(
        uint256 entryPricePNS,
        uint256 collatPricePNS,
        uint256 pnlPricePNS,
        uint256 lotLNS,
        uint256 feeCNS,
        int256 amountCNS,
        uint256 balanceCNS
    );
    event TakerOrderFilledV2(
        uint256 entryPricePNS,
        uint256 collatPricePNS,
        uint256 pnlPricePNS,
        uint256 lotLNS,
        uint256 feeCNS,
        int256 amountCNS,
        uint256 balanceCNS,
        uint256 builderId,
        uint256 builderFeeCNS
    );
    event ToleranceAdministratorUpdated(address toleranceAdministrator, bool added);
    event TransferAccountToProtocol(uint256 accountId, uint256 amountCNS, uint256 balanceCNS);
    event TransferPerpInsToProtocol(uint256 perpId, uint256 amountCNS);
    event TransferPerpPosToProtocol(uint256 perpId, uint256 amountCNS);
    event TransferProtocolToAccount(uint256 accountId, uint256 amountCNS, uint256 balanceCNS);
    event TransferProtocolToPerp(uint256 perpId, uint256 amountCNS, bool toInsuranceFund);
    event TransferProtocolToRecycleBal(uint256 amountCNS);
    event TriggerDescIdTooLow(uint256 lastTriggerDescId);
    event TriggerOrderExecution();
    event TriggerOrderRequest(
        uint256 triggerPricePNS,
        TriggerPriceConditionEnum triggerPriceCondition,
        uint256 triggerRequestId,
        uint256 triggerPositionId
    );
    event UnableToCancelOrder(uint256 perpId, uint256 orderId);
    event UnityDescentThreshUpdated(uint256 perpId, uint256 threshHdths);
    event UnspecifiedCollateral();
    event UnwindCompleted(
        uint256 perpId, uint256 positionsUnwound, uint256 perpPositionBalanceCNS, uint256 insuranceBalanceCNS
    );
    event UnwindContractTrigger(uint256 perpId);
    event UnwindInitializationCleared(uint256 perpId);
    event UnwindInitialized(uint256 perpId, uint256 sumPositiveFmvCNS);
    event UnwindInsufficientBalance(
        uint256 perpId, uint256 accountId, uint256 perpPositionBalanceCNS, uint256 paymentCNS
    );
    event UnwindIterationCompleted(
        uint256 perpId, uint256 positionsUnwound, uint256 perpPositionBalanceCNS, uint256 insuranceBalanceCNS
    );
    event UnwindPreparationCleared(uint256 perpId);
    event UnwindPrepared(uint256 perpId);
    event UnwindProcessInProgress(uint256 perpId);
    event UpdateOracleFailed(uint256 perpId);
    event Upgraded(address indexed implementation);
    event ValueExceedsMaximum(uint256 value, uint256 maximum);
    event WRLSMinWithdrawLimitUpdated(uint256 limitCNS);
    event WRLSThousandthsTvlUpdated(uint256 thousandthsTvl);
    event WhitelistAddress(address indexed addr, bool whitelisted);
    event WhitelistingEnabledChanged(bool enabled);
    event WithdrawRateLimitBypassSet(address indexed addr, bool enabled);
    event WithdrawRateLimitForceReset(uint256 newExpiryBlock, uint256 newLimitCNS, uint256 perBlockCNS);
    event WithdrawRateLimitReset(uint256 newExpiryBlock, uint256 newLimitCNS, uint256 perBlockCNS);
    event WrongAccountForOrder(uint256 perpId, uint256 orderId, uint256 accountId);

    function acceptOwnership() external;
    function addContract(
        string memory name,
        string memory symbol,
        uint256 perpId,
        uint256 basePricePNS,
        uint256 priceDecimals,
        uint256 lotDecimals,
        uint256 initMarginFracHdths,
        uint256 maintMarginFracHdths
    ) external;
    function addressBlocked(address) external view returns (bool);
    function adminCancelOrders(OrderSignature[] memory signatures) external;
    function allowOrderForwarding(bool allow) external;
    function autoDeleverage(AdlDesc[] memory adlDescs, bool revertOnFail) external;
    function buyLiquidations(BuyToLiquidateDesc[] memory liquidationDescs, bool revertOnFail) external;
    function cancelDecreaseCollateralRequest(uint256 perpId) external;
    function clearInitUnwindContract(uint256 perpId) external;
    function clearOrderSlots(uint256 perpId, uint256[] memory orderIds) external;
    function clearPrepareUnwindContract(uint256 perpId) external;
    function clearPricePointerSlots(uint256 perpId, uint256[] memory pricesONS) external;
    function createAccount(uint256 amountCNS) external returns (uint256 accountId);
    function declineDecreaseCollateralRequest(uint256 perpId, uint256 accountId, string memory reason) external;
    function decreasePositionCollateral(
        uint256 perpId,
        uint256 accountId,
        uint32 impactAdjPricePNS,
        uint16 borrowMarginFracHdths,
        PositionEnum positionType
    ) external;
    function depositCollateral(uint256 amountCNS) external;
    function depositToProtocol(uint256 amountCNS) external;
    function execFwdPositionOps(FwdOrderDesc[] memory forwardedOrders)
        external
        returns (OrderSignature[] memory signatures);
    function execFwdPositionOpsV2(FwdOrderDesc[] memory forwardedOrders, bytes[] memory extensions)
        external
        returns (OrderSignature[] memory signatures);
    function execFznAccountPosOps(FznOrderDesc[] memory fznAccountCloseOrders) external;
    function execOrder(OrderDesc memory orderDesc) external returns (OrderSignature memory signature);
    function execOrderV2(OrderDesc memory orderDesc, bytes memory extension)
        external
        returns (OrderSignature memory signature);
    function execOrders(OrderDesc[] memory orderDescs, bool revertOnFail)
        external
        returns (OrderSignature[] memory signatures);
    function execOrdersV2(OrderDesc[] memory orderDescs, bool revertOnFail, bytes[] memory extensions)
        external
        returns (OrderSignature[] memory signatures);
    function execPerpOps(OpDesc[] memory operations) external;
    function forceClose(uint256 perpId, uint256 posAccountId, uint256[] memory sortedPositionIds, bool revertOnFail)
        external
        returns (bool success);
    function forceResetWithdrawRateLimit() external;
    function getAccountByAddr(address accountAddress) external view returns (AccountInfo memory accountInfo);
    function getAccountById(uint256 accountId) external view returns (AccountInfo memory accountInfo);
    function getAccountFeeTier(uint256 accountId) external view returns (uint256 tier);
    function getContractVersion() external view returns (uint256 major, uint256 minor, uint256 patch);
    function getDefaultPerpFeeSchedule()
        external
        view
        returns (uint256[8] memory takerFeesPer100K, uint256[8] memory makerFeesPer100K);
    function getExchangeInfo()
        external
        view
        returns (
            uint256 balanceCNS,
            uint256 protocolBalanceCNS,
            uint256 recycleBalanceCNS,
            uint256 collateralDecimals,
            address collateralToken,
            address verifierProxy
        );
    function getFeeScheduleById(uint256 feeSchedId)
        external
        view
        returns (uint256[8] memory takerFeesPer100K, uint256[8] memory makerFeesPer100K);
    function getFundingInterval() external pure returns (uint256 fundingInterval);
    function getFundingSumAtBlock(uint256 perpId, uint256 blockNumber)
        external
        view
        returns (int48 fundingSumPNS, uint256 fundingEventBlock);
    function getInsuranceProtocolSplit(uint256 perpId)
        external
        view
        returns (uint256 insAmtPer100K, uint256 protAmtPer100K);
    function getLiquidationInfo(uint256 perpId) external view returns (LiquidationInfo memory liquidationInfo);
    function getMakerFee(uint256 perpId) external view returns (uint256);
    function getMarginFractions(uint256 perpId, uint256 lotLNS)
        external
        view
        returns (
            uint256 perpInitMarginFracHdths,
            uint256 perpMaintMarginFracHdths,
            uint256 dynamicInitMarginFracHdths,
            uint256 oiMaxLNS,
            uint256 unityDescentThreshHdths,
            uint256 overColDescentThreshHdths
        );
    function getMinAccountOpenCNS() external view returns (uint256 minAccountOpenCNS);
    function getMinimumPostCNS() external view returns (uint256 minimumPostCNS);
    function getMinimumSettleCNS() external view returns (uint256 minimumSettleCNS);
    function getNextPriceAboveWithOrders(uint256 perpId, uint256 priceONS) external view returns (uint256 priceAboveONS);
    function getNextPriceBelowWithOrders(uint256 perpId, uint256 priceONS) external view returns (uint256 priceBelowONS);
    function getOrder(uint256 perpId, uint256 orderId) external view returns (Order memory order);
    function getOrderIdIndex(uint256 perpId)
        external
        view
        returns (uint256 root, uint256[] memory leaves, uint256 numOrders);
    function getOrderLocks(uint256 accountId) external view returns (OrderLock[] memory orderLocks);
    function getOrderV2(uint256 perpId, uint256 orderId) external view returns (OrderV2 memory order);
    function getOrdersAtPriceLevel(uint256 perpId, uint256 priceONS, uint256 pageStartOrderId, uint256 ordersPerPage)
        external
        view
        returns (Order[] memory ordersAtPriceLevel, uint256 numOrders);
    function getOwner() external view returns (address);
    function getPermissionedCancelParams(uint256 perpId)
        external
        view
        returns (uint256 permCancelMinOrders, uint256 permCancelSegment);
    function getPerpFeeSchedule(uint256 perpId)
        external
        view
        returns (uint256 feeSchedId, uint256[8] memory takerFeesPer100K, uint256[8] memory makerFeesPer100K);
    function getPerpOrderLocks(uint256 accountId, uint256 perpId)
        external
        view
        returns (OrderLock[] memory perpOrderLocks);
    function getPerpetualExistsBitmap() external view returns (uint256[4] memory bitmap);
    function getPerpetualInfo(uint256 perpId) external view returns (PerpetualInfo memory perpetualInfo);
    function getPerpetualInfoV2(uint256 perpId) external view returns (PerpetualInfoV2 memory perpetualInfo);
    function getPosition(uint256 perpId, uint256 accountId)
        external
        view
        returns (PositionInfo memory positionInfo, uint256 markPricePNS, bool markPriceValid);
    function getPositionIds(uint256 perpId) external view returns (uint256 startNodeId, uint256 endNodeId);
    function getPositionV2(uint256 perpId, uint256 accountId)
        external
        view
        returns (PositionInfoV2 memory positionInfo, uint256 markPricePNS, bool markPriceValid);
    function getPositions(uint256 perpId, uint256 pageStartPositionId, uint256 positionsPerPage)
        external
        view
        returns (PositionInfo[] memory positions, uint256 numPositions, uint256 markPricePNS, bool markPriceValid);
    function getPositionsV2(uint256 perpId, uint256 pageStartPositionId, uint256 positionsPerPage)
        external
        view
        returns (PositionInfoV2[] memory positions, uint256 numPositions, uint256 markPricePNS, bool markPriceValid);
    function getPriceLevelOrderIds(uint256 perpId, uint256 priceONS)
        external
        view
        returns (uint256 startOrderId, uint256 endOrderId);
    function getProtocolBalanceCNS() external view returns (uint256 protocolBalanceCNS);
    function getRecycleBalanceCNS() external view returns (uint256 recycleBalanceCNS);
    function getRecycleFeeCNS() external view returns (uint256 recycleFeeCNS);
    function getTakerFee(uint256 perpId) external view returns (uint256);
    function getUnwindInfo(uint256 perpId)
        external
        view
        returns (PerpStatusEnum status, uint256 unwindSumPositiveFmvCNS, uint256 unwindInitPosBalCNS);
    function getVolumeAtBookPrice(uint256 perpId, uint256 priceONS)
        external
        view
        returns (uint256 bids, uint256 expBids, uint256 asks, uint256 expAsks);
    function getWithdrawAllowanceData(uint256 blockNumber)
        external
        view
        returns (uint256 allowanceCNS, uint256 expiryBlock, uint256 lastAllowanceBlock, uint256 cnsPerBlock);
    function increasePositionCollateral(uint256 perpId, uint256 amountCNS) external;
    function initUnwindContract(uint256 perpId, uint256 sumPositiveFmvCNS) external;
    function initialize(address collateralToken) external;
    function initializeV2(
        Exchange.PerpScalingConfig[] memory configs,
        Exchange.ResidueTransfer[] memory residueTransfers
    ) external;
    function initializeV3(
        uint256[8] memory defaultTakerFeesPer100K,
        uint256[8] memory defaultMakerFeesPer100K,
        uint256[8] memory rwaTakerFeesPer100K,
        uint256[8] memory rwaMakerFeesPer100K,
        uint256[] memory existingPerpIds
    ) external;
    function initializeV4(
        uint256[8] memory expectedOldTakerFees,
        uint256[8] memory expectedOldMakerFees,
        uint256 expectedNonZeroSchedCount
    ) external;
    function isAdministrator(address anAddress) external view returns (bool);
    function isHalted() external view returns (bool halted);
    function isLiquidationBuyer(address anAddress) external view returns (bool);
    function isPositionAdministrator(address anAddress) external view returns (bool);
    function isPriceAdministrator(address anAddress) external view returns (bool);
    function isToleranceAdministrator(address anAddress) external view returns (bool);
    function liquidation(LiquidationDesc memory liquidationDesc) external;
    function liquidations(LiquidationDesc[] memory liquidationDescs, bool revertOnFail) external;
    function numberOfAccounts() external view returns (uint256 numAccounts);
    function owner() external view returns (address);
    function pauseContract(uint256 perpId) external;
    function pauseContractByMonitor(uint256 perpId) external;
    function pendingOwner() external view returns (address);
    function perpetualExists(uint256 perpId) external view returns (bool perpExists);
    function prepareUnwindContract(uint256 perpId) external;
    function proxiableUUID() external view returns (bytes32);
    function removeContract(uint256 perpId) external;
    function renounceOwnership() external;
    function requestDecreasePositionCollateral(uint256 perpId, uint256 amountCNS, bool clampToMaximum) external;
    function setAccountFeeTiers(AccountFeeTier[] memory accountFeeTiers) external;
    function setAddressBlockStatus(address[] memory addresses, bool blocked) external;
    function setAddressWhitelisted(address[] memory addresses, bool whitelisted_) external;
    function setAdministrator(address administrator, bool add) external;
    function setBuyToLiquidateBuyerRestriction(uint256 perpId, bool restrictBuyers) external;
    function setBuyToLiquidateParams(
        uint256 perpId,
        uint256 insAmtPer100K,
        uint256 userAmtPer100K,
        uint256 buyerAmtPer100K
    ) external;
    function setBuyToLiquidatePriceThreshold(uint256 perpId, uint256 thresholdPer100K) external;
    function setContractPaused(uint256 perpId, bool paused) external;
    function setDcpBorrowThreshold(uint256 perpId, uint256 threshHdths) external;
    function setDefaultPerpFeeSchedValues(uint256[8] memory takerFeesPPM, uint256[8] memory makerFeesPPM) external;
    function setDefaultRwaFeeSchedValues(uint256[8] memory takerFeesPPM, uint256[8] memory makerFeesPPM) external;
    function setExchangeHalted(bool halted) external;
    function setFeeParams(uint256 perpId, uint256 insAmtPer100K) external;
    function setFeeSchedValues(uint256 feeSchedId, uint256[8] memory takerFeesPPM, uint256[8] memory makerFeesPPM)
        external;
    function setFreezeStatus(address account, FreezeStatusEnum status) external;
    function setFrozen(address account, FreezeStatusEnum status) external;
    function setFundingClampPct(uint256 perpId, uint256 absFundingClampPctPer100K) external;
    function setFundingSum(
        uint256 perpId,
        int256 fundingRatePct100k,
        uint32 pricePNS,
        bool allowOverwrite,
        bool revertOnFail
    ) external;
    function setFundingSumScalingExp(uint256 perpId, uint256 fundingSumScalingExp) external;
    function setIgnOracle(uint256 perpId, bool ignOracle) external;
    function setInitialMarginFraction(uint256 perpId, uint256 initMarginFracHdths) external;
    function setLastForwardedDescId(uint256 accountId, uint256 newDescId) external;
    function setLastForwardedDescIdAsOwner(uint256 accountId, uint256 newDescId) external;
    function setLastTriggeredDescId(uint256 accountId, uint256 newDescId) external;
    function setLastTriggeredDescIdAsOwner(uint256 accountId, uint256 newDescId) external;
    function setLinkDsVerifier(address verifierProxy) external;
    function setLiquidationBuyer(address liquidationBuyer, bool add) external;
    function setLiquidationParams(uint256 perpId, uint256 insAmtPer100K, uint256 userAmtPer100K) external;
    function setMaintenanceMarginFraction(uint256 perpId, uint256 maintMarginFracHdths) external;
    function setMarginTol(uint256 perpId, uint256 tolerance, uint256 decimals) external;
    function setMaxOpenInterest(uint256 perpId, uint256 maxOpenInterestLNS) external;
    function setMinAccountOpenAmount(uint256 amountCNS) external;
    function setMinPost(uint256 minPostCNS) external;
    function setMinSettle(uint256 minSettleCNS) external;
    function setMinWithdrawLimit(uint256 limitCNS) external;
    function setMonitorAdministrator(address monitorAdministrator, bool add) external;
    function setOverCollatDescentThreshold(uint256 perpId, uint256 threshHdths) external;
    function setPermissionedCancelParams(uint256 perpId, uint256 permCancelMinOrders, uint256 permCancelSegment)
        external;
    function setPerpLinkDsFeedId(uint256 perpId, bytes32 feedId) external;
    function setPerpToDefaultPerpFeeSched(uint256 perpId) external;
    function setPerpToDefaultRwaFeeSched(uint256 perpId) external;
    function setPerpToFeeSchedule(uint256 perpId, uint256 feeSchedId) external;
    function setPositionAdministrator(address positionAdministrator, bool add) external;
    function setPriceAdministrator(address priceAdministrator, bool add) external;
    function setPriceMaxAge(uint256 perpId, uint256 maxAgeSec) external;
    function setPriceTolPer100K(uint256 perpId, uint256 tolerancePer100K) external;
    function setPriceTolPer100KByOwner(uint256 perpId, uint256 tolerancePer100K) external;
    function setRecycleFee(uint256 recycleFeeCNS) external;
    function setThousandthsTvlWRLS(uint256 thousandthsTvl) external;
    function setToleranceAdministrator(address toleranceAdministrator, bool add) external;
    function setUnityDescentThreshold(uint256 perpId, uint256 threshHdths) external;
    function setWhitelistingEnabled(bool enabled) external;
    function setWithdrawBypass(address addr, bool enabled) external;
    function transferOwnership(address newOwner) external;
    function triggerUnwindContract(uint256 perpId) external;
    function unwindContract(uint256 perpId, uint256 maxPosToUnwind, bool allowWithoutPayment) external;
    function unwindContractByOwner(uint256 perpId, uint256 maxPosToUnwind, bool allowWithoutPayment) external;
    function updateMarkPricePNS(uint256 perpId, uint32 markPricePNS) external;
    function updateMarkPricePNSByOwner(uint256 perpId, uint32 markPricePNS) external;
    function updateOraclePrice(uint256 perpId, bytes memory unverifiedReport) external;
    function upgradeTo(address newImplementation) external;
    function upgradeToAndCall(address newImplementation, bytes memory data) external payable;
    function whitelisted(address) external view returns (bool);
    function whitelistingEnabled() external view returns (bool);
    function withdrawCollateral(uint256 amountCNS) external;
    function withdrawFromProtocol(uint256 amountCNS) external;
    function xferAcctToProtocol(uint256 amountCNS) external;
    function xferPerpInsToProtocol(uint256 perpId, uint256 amountCNS) external;
    function xferProtocolToAcct(uint256 accountId, uint256 amountCNS) external;
    function xferProtocolToPerp(uint256 perpId, uint256 amountCNS, bool insurance) external;
    function xferProtocolToRecycleBal(uint256 amountCNS) external;
}
