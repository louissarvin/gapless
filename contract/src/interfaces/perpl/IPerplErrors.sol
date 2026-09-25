// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.37;

interface IPerplErrors {
    type FreezeStatusEnum is uint8;
    type OrderEnum is uint8;
    type PerpStatusEnum is uint8;
    type PositionEnum is uint8;

    error AccountDoesNotExist(address accountAddress);
    error AccountExists(address sender, uint256 accountId);
    error AccountFrozen(FreezeStatusEnum status);
    error AccountIdDoesNotExist(uint256 accountId);
    error AddressBlocked(address addr);
    error AmountExceedsAvailableBalance(uint256 amountCNS, uint256 availableBalanceCNS, uint256 balanceCNS);
    error BankruptcyPricePreventsDeleverage(
        uint256 perpId, uint256 accountId, PositionEnum positionType, uint256 bankruptcyPricePNS, uint256 markPricePNS
    );
    error BuyToLiquidateBuyerRestricted(uint256 perpId, address buyer);
    error BuyToLiquidateParamsExceedUnity(
        uint256 perpId, uint256 insAmtPer100K, uint256 userAmtPer100K, uint256 buyerAmtPer100K
    );
    error BuyToLiquidateSlippageExceeded(
        uint256 perpId, uint256 posAccountId, PositionEnum positionType, uint256 markPricePNS, uint256 limitPricePNS
    );
    error CancelExistingInvalidCloseOrders(
        uint256 perpId,
        uint256 accountId,
        uint256 lockedLotLNS,
        PositionEnum lockedPositionType,
        PositionEnum newPositionType
    );
    error CancelOrdersBeforeRemovingContract(uint256 perpId, uint256 numOrders);
    error CannotChangeCloseOrderLocks(uint256 perpId, uint256 orderId);
    error CantBuyToLiquidate(
        uint256 perpId,
        uint256 posAccountId,
        PositionEnum positionType,
        uint256 markPricePNS,
        uint256 bsLiqPricePNS,
        uint256 liqPricePNS,
        uint256 bkptPricePNS
    );
    error CantChangeCloseOrder(uint256 perpId, uint256 orderId, uint256 accountId);
    error CantClearNullOrderId();
    error CantClearSlotsOnExistingPerp(uint256 perpId);
    error CantDeleverageAgainstOpposingPositions(
        uint256 perpId,
        uint256 accountId,
        bool forceClose,
        PositionEnum positionType,
        uint256 deleveragePricePNS,
        uint256[] sortedPositionIds
    );
    error CantLiquidateInsolventPos(
        uint256 perpId,
        uint256 posAccountId,
        PositionEnum positionType,
        uint256 lotSize,
        uint256 realizedPricePNS,
        int256 realizedFmvCNS
    );
    error CantLiquidatePosAboveMMR(
        uint256 perpId, uint256 posAccountId, PositionEnum positionType, uint256 markPricePNS, uint256 liqPricePNS
    );
    error CantLiquidatePosOnBookSevere(
        uint256 perpId,
        uint256 posAccountId,
        PositionEnum positionType,
        uint256 fillPricePNS,
        uint256 liqPricePNS,
        uint256 bkptPricePNS
    );
    error CantPostOrder(
        uint256 perpId, uint256 accountId, OrderEnum orderType, uint256 pricePNS, uint256 lotLNS, uint256 reason
    );
    error ChangeExpiredOrderNeedsNewExpiry(uint256 perpId, uint256 orderId, uint256 accountId, uint256 expiryBlock);
    error CloseOrderExceedsPosition(uint256 posLotLNS, uint256 orderLotLNS);
    error CloseOrderPositionMismatch(PositionEnum positionType, OrderEnum orderType);
    error ConfigEntryLimit(uint256 requested, uint256 max);
    error ContractCannotBeRemoved(uint256 perpId);
    error ContractDecimalsExceedResolution(
        uint256 perpId, uint256 collateralDecimals, uint256 priceDecimals, uint256 lotDecimals
    );
    error ContractDoesNotExist(uint256 perpId);
    error ContractIdExceedsMaximum(uint256 perpId);
    error ContractIdInUse(uint256 perpId);
    error ContractInsufficientFunds(uint256 balanceCNS, uint256 requestCNS);
    error ContractNotOperational(uint256 perpId, PerpStatusEnum status);
    error ContractNotPaused(uint256 perpId, PerpStatusEnum status);
    error ContractNotUnwindPrepared(uint256 perpId, PerpStatusEnum status);
    error CriticalPerpetualInsolvent(
        uint256 perpId, uint256 perpPositionBalCNS, uint256 perpInsuranceBalCNS, uint256 amountCNS
    );
    error CrossesBook(
        uint256 perpId,
        uint256 accountId,
        uint256 pricePNS,
        bool isBid,
        uint256 minAskOrMaxBidPNS,
        bool maxOrdersChecked
    );
    error DcpBorrowMustBeLessThanUnityDescent(uint256 dcpBorrowThreshHdths, uint256 unityDescentThreshHdths);
    error DecreaseCollateralRequestDoesNotExist(uint256 perpId, uint256 accountId);
    error DecrementUnderflows(uint256 decrement, uint256 minuend);
    error DeleveragePositionListEmpty(uint256 perpId, uint256 accountId);
    error DepositExceedsCNS64(uint256 perpId, uint256 accountId, uint80 depositCNS);
    error DifferenceExceedsInt256(uint256 value1, uint256 value2);
    error DifferenceExceedsMaximum(uint256 value, uint256 decrement, uint256 maximum);
    error DuplicatePerpIdInConfig(uint256 perpId);
    error DuplicatePerpIdInResidueXfers(uint256 perpId);
    error ExceedsLastExecutionBlock(uint256 lastExecutionBlock);
    error ExchangeHalted();
    error FeeMigrationFactorNotExact(uint256 unitScale, uint256 rateDiv);
    error FeeMigrationFromStateMismatch(uint256 tier, uint256 got, uint256 expected);
    error FeeMigrationPackingMismatch(uint256 feeSchedId, uint256 tier, uint256 got, uint256 expected);
    error FeeScheduleCountMismatch(uint256 got, uint256 expected);
    error FundingEventSetTooEarly(uint256 perpId, uint256 blockNumber, uint256 fundingEventBlock);
    error FundingExitBlockPreceedsEntryBlock(uint256 perpId, uint256 entryBlock, uint256 exitBlock);
    error FundingPriceExceedsTol(uint256 perpId, uint256 fundingPricePNS, uint256 oraclePNS, uint256 tolerancePer100k);
    error FundingSumAlreadySet(
        uint256 perpId, uint256 fundingEventBlock, uint256 storageIndex, uint256 fundingSumOffset
    );
    error ImmediateOrderUnderMinimum(uint256 perpId, uint256 accountId, uint256 orderAmountCNS, uint256 minAmountCNS);
    error IncompatibleCollateralToken(address tokenAddress, uint256 tokenDecimals, uint256 expectedTokenDecimals);
    error InitialMarginFractionEqualsOrExceedsMaintenance(uint256 initMarginFracHdths, uint256 maintMarginFracHdths);
    error InsolventPositionCannotBeForcedClose(
        uint256 perpId,
        uint256 posAccountId,
        PositionEnum positionType,
        uint256 bankruptcyPricePNS,
        uint256 markPricePNS
    );
    error InsufficentAmountToOpenAccount(address sender, uint256 amountCNS);
    error InsufficientFunds(uint256 balanceCNS, uint256 amountCNS);
    error InsuficientFundsForRecycleFee(
        uint256 perpId, uint256 accountId, uint256 balanceCNS, uint256 lockedCNS, uint256 recycleFeeCNS
    );
    error InvalidBankruptcyPrice(
        uint256 perpId,
        uint256 accountId,
        uint256 depositCNS,
        uint256 posPricePNS,
        uint256 liqLotLNS,
        int256 premiumPnlCNS
    );
    error InvalidBorrowFraction(
        uint256 perpId, uint256 proposedBorrowFracHdths, uint256 minMarginFracHdths, uint256 initMarginFracHdths
    );
    error InvalidDenominatorDecimals(uint256 denominatorDecimals, uint256 minimum, uint256 maximum);
    error InvalidExpiryBlock(uint256 expiryBlock, uint256 blockNumber);
    error InvalidFundingSumScalingExp(uint256 perpId, uint256 newExp, uint256 maxExp);
    error InvalidLinkReportForContract(uint256 perpId, bytes32 perpFeedId, bytes32 reportFeedId);
    error InvalidLinkReportVersion(uint256 perpId, uint256 reportVersion);
    error InvalidLiquidationPrice(
        uint256 perpId,
        uint256 accountId,
        uint256 depositCNS,
        uint256 posPricePNS,
        uint256 liqLotLNS,
        int256 premiumPnlCNS
    );
    error InvalidMinWithdrawLimit(uint256 minCNS, uint256 maxCNS, uint256 proposedCNS);
    error InvalidOrderExtensionVersion(uint256 version);
    error InvalidOrderId(uint256 orderId, uint256 min, uint256 max);
    error InvalidOrderLock(OrderEnum orderType, uint256 amountCNS, uint256 lotLNS);
    error InvalidProposedInitFraction(
        uint256 perpId, uint256 proposedInitMarginFracHdths, uint256 initMarginFracHdths, uint256 maintMarginFracHdths
    );
    error InvalidProposedMaintFraction(
        uint256 perpId, uint256 proposedMaintMarginFracHdths, uint256 maintMarginFracHdths, uint256 initMarginFracHdths
    );
    error InvalidWithdrawLimitThousandths(uint256 minThousandths, uint256 maxThousandths, uint256 proposedThousandths);
    error LinkDsOracleNotConfigured(uint256 perpId, address verifierProxy, bytes32 linkDsFeedId);
    error LinkDsPriceUninitialized(uint256 perpId);
    error LiquidationBuyerSettlementFailed(
        uint256 perpId,
        uint256 accountId,
        OrderEnum liquidationType,
        uint256 pricePNS,
        uint256 lotLNS,
        uint256 resultCode
    );
    error LiquidationParamsExceedUnity(
        uint256 perpId, uint256 insAmtPer100K, uint256 liqAmtPer100K, uint256 userAmtPer100K
    );
    error LotOutOfRange(uint256 lotLNS, uint256 minLotLNS, uint256 maxLotLNS);
    error MarkExceedsTol(uint256 perpId, uint256 markPNS, uint256 spotOraclePricePNS, uint256 tolerancePer100k);
    error MarkPriceAgeExceedsMax(uint256 perpId, uint256 markTimestamp, uint256 timestamp, uint256 maxAgeSec);
    error MarkPriceUninitialized(uint256 perpId);
    error MaximumAccountOrders(uint256 perpId, uint256 accountId);
    error NegativeDepositCheckFailedSevere();
    error NoAccountsRemain();
    error NotWhitelisted(address addr);
    error NullOrderIdSpecifiedSevere(uint256 perpId, uint256 accountId);
    error OpenInterestInequalSevere(uint256 longOiLNS, uint256 shortOiLNS);
    error OpenInterestTooHighForDcp(uint256 perpId, uint256 currentOiLNS, uint256 thresholdOiLNS);
    error OracleAgeExceedsMax(uint256 perpId, uint256 oracleTimestamp, uint256 timestamp, uint256 maxAgeSec);
    error OrderBookFull(uint256 perpId);
    error OrderBookPriceOutOfRange(uint256 specifiedPriceONS, uint256 maxONS);
    error OrderDoesNotExist(uint256 perpId, uint256 orderId);
    error OrderDoesntExistSevere(uint256 perpId, uint256 orderId);
    error OrderExtensionsLengthMismatch(uint256 ordersLength, uint256 extensionsLength);
    error OrderIdIsNotAtSpecifiedPriceLevel(
        uint256 perpId, uint256 specifiedPriceONS, uint256 orderId, uint256 orderPriceONS
    );
    error OrderLockDoesntExistSevere(uint256 perpId, uint256 orderId, uint256 accountId);
    error OrderLockExistsSevere(uint256 perpId, uint256 orderId, uint256 accountId);
    error OrderPostFailed(
        uint256 perpId, uint256 accountId, OrderEnum orderType, uint256 priceONS, uint256 lotLNS, bool isBid
    );
    error OrderSizeExceedsAvailableSize(uint256 orderLotLNS, uint256 availableLotLNS, uint256 positionLotLNS);
    error OverflowPremiumCnsSevere(int256 premiumPnlCNS);
    error PermissionlessCancelOrdersOutOfRange(uint256 permissionlessCancelMinOrders, uint256 minimum, uint256 maximum);
    error PerpIdListIncomplete(uint256 provided, uint256 expected);
    error PerpInsolvencyCheckFailedSevere(
        uint256 perpId, uint256 positionBalanceCNS, uint256 insuranceBalanceCNS, uint256 amountCNS
    );
    error PerpetualActivated(uint256 perpId);
    error PerpetualNotActivated(uint256 perpId);
    error PositionAlreadyInListSevere(uint256 perpId, uint256 accountId);
    error PositionCannotBeDeleveraged(
        uint256 perpId,
        uint256 accountId,
        bool forceClose,
        PositionEnum positionType,
        uint256 adlLotLNS,
        uint256 delevPricePNS,
        uint256 markPricePNS
    );
    error PositionDoesNotExist(uint256 perpId, uint256 accountId);
    error PositionTypeMismatch(uint256 perpId, uint256 accountId, PositionEnum expected, PositionEnum actual);
    error PostOrderUnderMinimum(uint256 orderAmountCNS, uint256 minAmountCNS);
    error PriceLotDecimalSumExceedsCollateralSevere(uint256 priceDecimals, uint256 lotDecimals);
    error PriceOutOfRange(uint256 pricePNS, uint256 minPricePNS, uint256 maxPricePNS);
    error ProposedFundingRateClampExceedsMax(
        uint256 perpId, uint256 proposedClampPctPer100k, uint256 maxClampPctPer100k
    );
    error ProposedMarginTolExceedsMax(uint256 perpId, uint256 proposedTol, uint256 maxTol);
    error ProposedPriceAgeExceedsMax(uint256 perpId, uint256 proposedAgeSec, uint256 maxAgeSec);
    error ProposedPriceTolExceedsMax(uint256 perpId, uint256 proposedTol, uint256 maxTolPer100k);
    error ReportAgeExceedsLastUpdate(uint256 perpId, uint256 lastUpdateTimestamp, uint256 reportValidFromTimestamp);
    error ReportExpiresTooSoon(uint256 perpId, uint256 expiresAt, uint256 minRequired);
    error ReportFromFuture(uint256 perpId, uint256 reportTimestamp, uint256 blockTimestamp);
    error ReportPriceIsNegative(uint256 perpId, int256 reportPrice);
    error ResidueTransferEntryLimit(uint256 requested, uint256 max);
    error SenderIsNotAdministrator(address sender);
    error SenderIsNotMonitorAdministrator(address sender);
    error SenderIsNotPositionAdministrator(address sender);
    error SenderIsNotPriceAdministrator(address sender);
    error SenderIsNotToleranceAdministrator(address sender);
    error SumExceedsMaximum(uint256 existingValue, uint256 increment, uint256 maximum);
    error TakerOrderSettlementFailed(
        uint256 perpId,
        uint256 accountId,
        uint256 entryPricePNS,
        uint256 collatPricePNS,
        uint256 pnlPricePNS,
        uint256 filledLotLNS,
        uint256 unfillableLotLNS,
        uint256 resultCode
    );
    error TooManyBytesInName(string name, uint256 numBytes, uint256 maxBytes);
    error TooManyBytesInSymbol(string symbol, uint256 numBytes, uint256 maxBytes);
    error UnfreezeAccountNotPermitted();
    error UnityMustBeLessThanOverColDescent(uint256 unityDescentThreshHdths, uint256 overColDescentThreshHdths);
    error UnmatchedLotRemainsInFillOrKill(uint256 perpId, uint256 accountId, uint256 unmatchedLotLNS);
    error UnspecifiedCollateral();
    error UnwindAlreadyInitialized(uint256 perpId);
    error UnwindNotInitialized(uint256 perpId, PerpStatusEnum perpStatus);
    error UnwindNotPrepared(uint256 perpId, PerpStatusEnum perpStatus);
    error UnwindProcessInProgress(uint256 perpId);
    error UnwindProcessStarted(uint256 perpId);
    error UpdateOracleFailed(uint256 perpId);
    error ValueExceedsMaximum(uint256 value, uint256 maximum);
    error ValueOutsideRange(uint256 value, uint256 minimum, uint256 maximum);
    error WithdrawRateLimitExceeded(
        uint256 amountCNS, uint256 allowanceCNS, uint256 amountPerBlockCNS, uint256 expiryBlock
    );
    error WrongAccountForOrder(uint256 perpId, uint256 orderId, uint256 accountId);
}
