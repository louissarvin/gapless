// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

/// @title IPerplEvents
/// @notice Perpl Exchange events Gapless tests and offchain code rely on (signatures from dex-sdk Exchange.json).
/// @dev Kept apart from IPerplErrors because `ExchangeHalted` is both an event and an error upstream.
/// TakerOrderFilledV2 carries no perpId or accountId: join it to the preceding OrderRequestV2 in the same tx.
interface IPerplEvents {
    event AccountCreated(address account, uint256 id);
    event CollateralDeposit(uint256 accountId, uint256 amountCNS, uint256 balanceCNS);
    event CollateralWithdrawal(uint256 accountId, uint256 amountCNS, uint256 balanceCNS);
    event OrderRequestV2(
        uint256 perpId,
        uint256 accountId,
        uint256 orderDescId,
        uint256 orderId,
        uint8 orderType,
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
    event PositionClosed(
        uint256 perpId, uint256 accountId, uint8 positionType, uint256 pricePNS, int256 deltaPnlCNS, int256 fundingCNS
    );
    event PositionDecreased(
        uint256 perpId,
        uint256 accountId,
        uint8 positionType,
        uint256 startDepositCNS,
        uint256 endDepositCNS,
        uint256 startLotLNS,
        uint256 endLotLNS,
        int256 deltaPnlCNS,
        int256 fundingCNS
    );
    event ImmediateOrCancelExecuted(uint256 unmatchedLotLNS, uint256 totalLotLNS);
    event ClearingSelfMatchingOrder(
        uint256 perpId,
        uint256 accountId,
        uint256 orderId,
        uint256 lockedBalanceCNS,
        uint256 recyclerAccountId,
        int256 recyclerAmountCNS,
        uint256 recyclerBalanceCNS
    );
    event MarkUpdated(uint256 perpId, uint256 pricePNS);
    event LinkPriceUpdated(uint256 perpId, uint256 oraclePricePNS, uint256 timestamp);
    event WhitelistingEnabledChanged(bool enabled);
    event ExchangeHalted(bool halted);
    event ContractPaused(uint256 perpId, bool paused);
    event TriggerOrderExecution();
    event Upgraded(address indexed implementation);
}
