// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Test} from "forge-std/Test.sol";
import {IPerplMin} from "../../src/interfaces/perpl/IPerplMin.sol";
import {IPerplEvents} from "../../src/interfaces/perpl/IPerplEvents.sol";
import {IPerplExchange} from "./reference/IPerplExchange.sol";

/// IPerplMin and IPerplEvents must match the full interface generated from dex-sdk Exchange.json (v1.7.5).
/// Every selector below was also found in the live implementation bytecode on 2026-10-05.
contract PerplSelectorsTest is Test {
    function test_functionSelectorsMatchDexSdk() public pure {
        assertEq(IPerplMin.createAccount.selector, IPerplExchange.createAccount.selector);
        assertEq(IPerplMin.depositCollateral.selector, IPerplExchange.depositCollateral.selector);
        assertEq(IPerplMin.withdrawCollateral.selector, IPerplExchange.withdrawCollateral.selector);
        assertEq(IPerplMin.increasePositionCollateral.selector, IPerplExchange.increasePositionCollateral.selector);
        assertEq(IPerplMin.execOrder.selector, IPerplExchange.execOrder.selector);
        assertEq(IPerplMin.execOrderV2.selector, IPerplExchange.execOrderV2.selector);
        assertEq(IPerplMin.execOrders.selector, IPerplExchange.execOrders.selector);
        assertEq(IPerplMin.getAccountByAddr.selector, IPerplExchange.getAccountByAddr.selector);
        assertEq(IPerplMin.getAccountById.selector, IPerplExchange.getAccountById.selector);
        assertEq(IPerplMin.getPosition.selector, IPerplExchange.getPosition.selector);
        assertEq(IPerplMin.getPerpetualInfo.selector, IPerplExchange.getPerpetualInfo.selector);
        assertEq(IPerplMin.getNextPriceBelowWithOrders.selector, IPerplExchange.getNextPriceBelowWithOrders.selector);
        assertEq(IPerplMin.getNextPriceAboveWithOrders.selector, IPerplExchange.getNextPriceAboveWithOrders.selector);
        assertEq(IPerplMin.getVolumeAtBookPrice.selector, IPerplExchange.getVolumeAtBookPrice.selector);
        assertEq(IPerplMin.getAccountFeeTier.selector, IPerplExchange.getAccountFeeTier.selector);
        assertEq(IPerplMin.getPerpFeeSchedule.selector, IPerplExchange.getPerpFeeSchedule.selector);
        assertEq(IPerplMin.getTakerFee.selector, IPerplExchange.getTakerFee.selector);
        assertEq(IPerplMin.getMinAccountOpenCNS.selector, IPerplExchange.getMinAccountOpenCNS.selector);
        assertEq(IPerplMin.getWithdrawAllowanceData.selector, IPerplExchange.getWithdrawAllowanceData.selector);
        assertEq(IPerplMin.getFundingInterval.selector, IPerplExchange.getFundingInterval.selector);
        assertEq(IPerplMin.getContractVersion.selector, IPerplExchange.getContractVersion.selector);
        assertEq(IPerplMin.whitelistingEnabled.selector, IPerplExchange.whitelistingEnabled.selector);
        assertEq(IPerplMin.whitelisted.selector, IPerplExchange.whitelisted.selector);
        assertEq(IPerplMin.isHalted.selector, IPerplExchange.isHalted.selector);
        assertEq(IPerplMin.execOrderV2.selector, bytes4(0x28d18da3));
        assertEq(IPerplMin.execOrder.selector, bytes4(0x4d8dc985));
        assertEq(IPerplMin.getPerpetualInfo.selector, bytes4(0x00092cce));
    }

    function test_eventTopicsMatchDexSdk() public pure {
        assertEq(IPerplEvents.TakerOrderFilledV2.selector, IPerplExchange.TakerOrderFilledV2.selector);
        assertEq(IPerplEvents.MakerOrderFilledV2.selector, IPerplExchange.MakerOrderFilledV2.selector);
        assertEq(IPerplEvents.OrderRequestV2.selector, IPerplExchange.OrderRequestV2.selector);
        assertEq(IPerplEvents.PositionClosed.selector, IPerplExchange.PositionClosed.selector);
        assertEq(IPerplEvents.PositionDecreased.selector, IPerplExchange.PositionDecreased.selector);
        assertEq(IPerplEvents.ImmediateOrCancelExecuted.selector, IPerplExchange.ImmediateOrCancelExecuted.selector);
        assertEq(IPerplEvents.ClearingSelfMatchingOrder.selector, IPerplExchange.ClearingSelfMatchingOrder.selector);
        assertEq(IPerplEvents.MarkUpdated.selector, IPerplExchange.MarkUpdated.selector);
        assertEq(IPerplEvents.LinkPriceUpdated.selector, IPerplExchange.LinkPriceUpdated.selector);
        assertEq(IPerplEvents.TriggerOrderExecution.selector, IPerplExchange.TriggerOrderExecution.selector);
        assertEq(IPerplEvents.Upgraded.selector, IPerplExchange.Upgraded.selector);
    }
}
