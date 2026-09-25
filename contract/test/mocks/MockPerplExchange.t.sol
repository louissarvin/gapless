// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Test, Vm} from "forge-std/Test.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IPerplMin} from "../../src/interfaces/perpl/IPerplMin.sol";
import {IPerplErrors} from "../../src/interfaces/perpl/IPerplErrors.sol";
import {IPerplEvents} from "../../src/interfaces/perpl/IPerplEvents.sol";
import {MockAUSD} from "./MockAUSD.sol";
import {MockPerplExchange} from "./MockPerplExchange.sol";
import {PerplTrader} from "./PerplTrader.sol";

/// Conformance of MockPerplExchange to the G0 fork gate (perpl-fork-gate/test, Exchange 1.7.5, 2026-10-01),
/// the measured native stop rule (memory/perpl_stop_semantics_2026-10-05.md) and the onchain reads of 2026-10-05.
contract MockPerplExchangeTest is Test {
    struct TakerFill {
        uint256 entryPricePNS;
        uint256 collatPricePNS;
        uint256 pnlPricePNS;
        uint256 lotLNS;
        uint256 feeCNS;
        int256 amountCNS;
        uint256 balanceCNS;
        uint256 builderId;
        uint256 builderFeeCNS;
    }

    uint256 internal constant BTC = 1;
    uint256 internal constant MON = 10;
    uint256 internal constant TAO = 80;
    uint256 internal constant BID = 861_740;
    uint256 internal constant ASK = 861_741;
    uint256 internal constant T0 = 1_791_190_979;

    MockAUSD internal ausd;
    MockPerplExchange internal ex;
    PerplTrader internal maker;
    PerplTrader internal a;
    PerplTrader internal b;

    function setUp() public {
        vm.warp(T0);
        vm.roll(110_711_378);
        ausd = new MockAUSD();
        ex = new MockPerplExchange(ausd);
        ausd.mint(address(ex), 1_000_000e6); // float for counterparty PnL
        ex.listPerp(BTC, "BTC", 1, 5, 1500, BID);
        ex.listPerp(MON, "MON", 6, 0, 1000, 30_000);

        maker = _trader(100_000e6);
        maker.rest(0, BTC, 861_740, 590);
        maker.rest(0, BTC, 861_730, 47);
        maker.rest(0, BTC, 861_700, 1000);
        maker.rest(0, BTC, 861_000, 5000);
        maker.rest(1, BTC, 861_741, 600);
        maker.rest(1, BTC, 861_750, 100);
        maker.rest(1, BTC, 861_800, 1000);
        maker.rest(1, BTC, 862_500, 15_000);
        maker.rest(0, MON, 29_990, 100_000);
        maker.rest(1, MON, 30_010, 100_000);

        a = _trader(50e6);
        b = _trader(200e6);
    }

    // G0 fork gate behaviors (one test per fork test)

    /// G0 test_roundTripInOneCall: open and close inside one external call; balance reflects both before return.
    function test_G0_roundTripInOneCall() public {
        (PerplTrader.Snap memory s0, PerplTrader.Snap memory s1, PerplTrader.Snap memory s2) =
            a.roundTrip(BTC, 100, ASK * 101 / 100, BID * 99 / 100);
        assertEq(s1.lots, 100, "opened");
        assertEq(s2.lots, 0, "closed");
        assertGt(s2.balance, s1.balance, "deposit + pnl credited in the same call");
        uint256 deposit = Math.mulDiv(ASK * 100, 100, 1000, Math.Rounding.Ceil);
        uint256 feeOpen = Math.mulDiv(ASK * 100, 345, 1e6, Math.Rounding.Ceil);
        uint256 feeClose = Math.mulDiv(BID * 100, 345, 1e6, Math.Rounding.Ceil);
        assertEq(s1.balance, s0.balance - deposit - feeOpen);
        assertEq(int256(s2.balance) - int256(s0.balance), -100 - int256(feeOpen + feeClose));
    }

    /// G0 test_closeAndMeasure_matchesEvent: event balanceCNS == storage read; amountCNS == balance delta.
    function test_G0_closeAndMeasure_matchesEvent() public {
        a.ioc(0, BTC, ASK * 101 / 100, 100);
        vm.roll(block.number + 1);
        vm.recordLogs();
        (PerplTrader.Snap memory pre, PerplTrader.Snap memory post) = a.closeAndMeasure(BTC, 100, BID * 99 / 100);
        (bool found, TakerFill memory f) = _lastTakerFill(vm.getRecordedLogs());
        assertTrue(found, "taker fill event");
        assertEq(f.balanceCNS, post.balance, "event balance == storage balance");
        assertEq(f.amountCNS, int256(post.balance) - int256(pre.balance), "amount == delta");
        assertEq(f.collatPricePNS, BID);
        assertEq(f.lotLNS, 100);
        assertEq(f.feeCNS, Math.mulDiv(BID * 100, 345, 1e6, Math.Rounding.Ceil));
        assertEq(f.amountCNS, int256(pre.deposit) - 100 - int256(f.feeCNS), "released + pnl - fee");
        assertEq(post.lots, 0);
    }

    /// G0 test_iocNoFill: floor above the best bid returns normally, position unchanged, IOC event emitted.
    function test_G0_iocNoFill_returnsNormally() public {
        a.ioc(0, BTC, ASK * 101 / 100, 100);
        vm.roll(block.number + 1);
        vm.recordLogs();
        (PerplTrader.Snap memory pre, PerplTrader.Snap memory post) = a.closeAndMeasure(BTC, 100, ASK * 102 / 100);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(post.lots, pre.lots, "no fill");
        assertEq(post.balance, pre.balance, "no settlement");
        (bool found,) = _lastTakerFill(logs);
        assertFalse(found, "no taker fill");
        (uint256 unmatched, uint256 total) = _iocEvent(logs);
        assertEq(unmatched, 100);
        assertEq(total, 100);
    }

    /// G0 test_staleReferenceClose: a reduce-only close executes with mark and oracle 120 s old.
    function test_G0_staleReferenceClose_succeeds() public {
        a.ioc(0, BTC, ASK * 101 / 100, 100);
        vm.roll(block.number + 400);
        vm.warp(block.timestamp + 120);
        (, PerplTrader.Snap memory post) = a.closeAndMeasure(BTC, 100, BID * 99 / 100);
        assertEq(post.lots, 0);
    }

    /// G0 test_builderExtensionDirect: execOrderV2 with a builder extension from a direct contract account.
    function test_G0_builderExtensionDirect() public {
        bytes memory ext = abi.encode(uint16(1), abi.encode(uint256(1), uint256(0)));
        assertEq(ext.length, 160);
        vm.recordLogs();
        a.execV2(a.desc(0, BTC, ASK * 101 / 100, 100, true), ext);
        (, TakerFill memory f) = _lastTakerFill(vm.getRecordedLogs());
        assertEq(f.builderId, 1);
        assertEq(f.builderFeeCNS, 0);
    }

    function test_builderExtension_feeEmptyAndBadVersion() public {
        vm.recordLogs();
        a.execV2(a.desc(0, BTC, ASK * 101 / 100, 100, true), abi.encode(uint16(1), abi.encode(uint256(7), uint256(10))));
        (, TakerFill memory f) = _lastTakerFill(vm.getRecordedLogs());
        assertEq(f.builderId, 7);
        assertEq(f.builderFeeCNS, Math.mulDiv(ASK * 100, 10, 1e5, Math.Rounding.Ceil));

        vm.recordLogs();
        a.execV2(a.desc(0, BTC, ASK * 101 / 100, 100, true), "");
        (, f) = _lastTakerFill(vm.getRecordedLogs());
        assertEq(f.builderId, 0, "empty extension = no builder (BUILDER_ID 0)");

        IPerplMin.OrderDesc memory d = a.desc(0, BTC, ASK * 101 / 100, 100, true);
        vm.expectRevert(abi.encodeWithSelector(IPerplErrors.InvalidOrderExtensionVersion.selector, 2));
        a.execV2(d, abi.encode(uint16(2), abi.encode(uint256(1), uint256(0))));
    }

    /// G0 test_multiLevelFillPrices: IOC walks levels; collatPricePNS = VWAP rounded against the taker.
    function test_G0_multiLevelFillPrices() public {
        PerplTrader c = _trader(2000e6);
        vm.recordLogs();
        c.ioc(0, BTC, ASK * 1005 / 1000, 5000);
        uint256 openNotional = 600 * 861_741 + 100 * 861_750 + 1000 * 861_800 + 3300 * 862_500;
        (, TakerFill memory f) = _lastTakerFill(vm.getRecordedLogs());
        assertEq(f.lotLNS, 5000);
        assertEq(f.collatPricePNS, Math.ceilDiv(openNotional, 5000), "buyer collat rounds up");
        assertEq(f.pnlPricePNS, openNotional / 5000, "pnl price rounds the other way");
        PerplTrader.Snap memory s = c.snap(BTC);
        assertEq(s.entryPNS, openNotional / 5000);

        vm.roll(block.number + 1);
        vm.recordLogs();
        (PerplTrader.Snap memory pre, PerplTrader.Snap memory post) = c.closeAndMeasure(BTC, 5000, BID * 995 / 1000);
        uint256 closeNotional = 590 * 861_740 + 47 * 861_730 + 1000 * 861_700 + 3363 * 861_000;
        (, f) = _lastTakerFill(vm.getRecordedLogs());
        assertEq(f.collatPricePNS, closeNotional / 5000, "seller collat rounds down");
        uint256 fee = Math.mulDiv(closeNotional, 345, 1e6, Math.Rounding.Ceil);
        int256 pnl = int256(closeNotional) - int256(openNotional);
        assertEq(int256(post.balance) - int256(pre.balance), int256(pre.deposit) + pnl - int256(fee));
        assertEq(post.lots, 0);
    }

    /// G0 test_crossAccountSelfDeal: account B rests a bid inside the spread; A's close fills 100% at B's price.
    function test_G0_crossAccountSelfDeal() public {
        PerplTrader c = _trader(200e6);
        c.ioc(0, MON, 30_310, 1000);
        b.rest(0, MON, 30_000, 1000);
        vm.roll(block.number + 1);
        vm.recordLogs();
        (, PerplTrader.Snap memory post) = c.closeAndMeasure(MON, 1000, 29_690);
        (, TakerFill memory f) = _lastTakerFill(vm.getRecordedLogs());
        assertEq(post.lots, 0);
        assertEq(f.lotLNS, 1000);
        assertEq(f.collatPricePNS, 30_000, "filled at the colluding account's price");
        assertEq(b.snap(MON).lots, 1000);
    }

    /// G0 test_sameAccountSelfMatch: own resting bid on top is cleared; matching continues at the next level.
    function test_G0_sameAccountSelfMatch() public {
        PerplTrader c = _trader(200e6);
        c.ioc(0, MON, 30_310, 2000);
        c.rest(0, MON, 30_000, 1000);
        assertGt(c.snap(MON).locked, 0);
        vm.roll(block.number + 1);
        vm.recordLogs();
        c.ioc(2, MON, 29_690, 1000);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(_count(logs, IPerplEvents.ClearingSelfMatchingOrder.selector), 1);
        (, TakerFill memory f) = _lastTakerFill(logs);
        assertEq(f.collatPricePNS, 29_990, "filled at the next level");
        (uint256 bids,,,) = ex.getVolumeAtBookPrice(MON, 30_000);
        assertEq(bids, 0, "own order removed");
        PerplTrader.Snap memory s = c.snap(MON);
        assertEq(s.lots, 1000);
        assertEq(s.locked, 0, "lock released");
    }

    /// G0 test_closeLargerThanPosition: CloseLong 500 lots on a 100-lot position reverts.
    function test_G0_closeLargerThanPosition_reverts() public {
        a.ioc(0, BTC, ASK * 101 / 100, 100);
        vm.roll(block.number + 1);
        vm.expectRevert(abi.encodeWithSelector(IPerplErrors.CloseOrderExceedsPosition.selector, 100, 500));
        a.ioc(2, BTC, BID * 99 / 100, 500);
    }

    /// G0 test_openWithStaleReference: open with a mark older than refPriceMaxAgeSec (60) reverts.
    function test_G0_openWithStaleReference_reverts() public {
        vm.roll(block.number + 400);
        vm.warp(block.timestamp + 120);
        vm.expectRevert(
            abi.encodeWithSelector(IPerplErrors.MarkPriceAgeExceedsMax.selector, BTC, T0, block.timestamp, 60)
        );
        a.ioc(0, BTC, ASK * 101 / 100, 100);
    }

    /// G0 Recipe test_recipeParams: leverage 0, maxNegPnl 0, lastExecutionBlock = block.number closes.
    function test_G0_recipeParams_closeAtCurrentBlock() public {
        a.ioc(0, BTC, ASK * 101 / 100, 100);
        vm.roll(block.number + 1);
        IPerplMin.OrderDesc memory d = a.desc(2, BTC, BID * 99 / 100, 100, true);
        d.leverageHdths = 0;
        d.maxNegPnlCollatBPS = 0;
        d.lastExecutionBlock = block.number;
        d.maxMatches = 32;
        a.exec(d);
        assertEq(a.snap(BTC).lots, 0);
    }

    /// G0 Recipe test_lastExecBlockPast: lastExecutionBlock below the current block reverts.
    function test_G0_lastExecutionBlockPast_reverts() public {
        IPerplMin.OrderDesc memory d = a.desc(0, BTC, ASK * 101 / 100, 100, true);
        d.lastExecutionBlock = block.number - 1;
        vm.expectRevert(abi.encodeWithSelector(IPerplErrors.ExceedsLastExecutionBlock.selector, block.number - 1));
        a.exec(d);
    }

    // Measured native stop rule: limit = best opposing x (1 -/+ 1%), relative to the book, not the mark

    function test_nativeStop_long_fillsOnlyDepthWithin1PctOfTopBid() public {
        maker.rest(0, BTC, 850_000, 10_000); // below the 1% band
        PerplTrader c = _trader(2000e6);
        c.ioc(0, BTC, ASK * 1005 / 1000, 7000);
        ex.setMark(BTC, 840_000); // mark gapped 2.5% through
        assertEq(ex.nativeStopLimitPNS(BTC, true), BID * 9900 / 10_000);
        vm.recordLogs();
        uint256 filled = ex.execNativeStop(c.accountId(), BTC);
        assertEq(filled, 590 + 47 + 1000 + 5000, "depth within 1% of top only");
        (uint256 unmatched, uint256 total) = _iocEvent(vm.getRecordedLogs());
        assertEq(unmatched, 7000 - filled);
        assertEq(total, 7000);
        (uint256 deepBids,,,) = ex.getVolumeAtBookPrice(BTC, 850_000);
        assertEq(deepBids, 10_000, "deeper bid untouched");
    }

    function test_nativeStop_markGapBeyond1Pct_stillFillsWhenBookIsDeep() public {
        PerplTrader c = _trader(2000e6);
        c.ioc(0, BTC, ASK * 1005 / 1000, 2000);
        ex.setMark(BTC, 840_000);
        assertEq(ex.execNativeStop(c.accountId(), BTC), 2000);
    }

    function test_nativeStop_short_limitIsBestAskPlus1Pct() public {
        PerplTrader c = _trader(2000e6);
        c.ioc(1, BTC, BID * 995 / 1000, 2000);
        assertEq(c.snap(BTC).positionType, 1);
        assertEq(ex.nativeStopLimitPNS(BTC, false), ASK * 10_100 / 10_000);
        assertEq(ex.execNativeStop(c.accountId(), BTC), 2000);
    }

    function test_nativeStop_emptyOpposingSide_fillsNothing() public {
        ex.listPerp(TAO, "TAO", 3, 3, 1000, 304_891);
        maker.rest(1, TAO, 305_000, 1000);
        PerplTrader c = _trader(500e6);
        c.ioc(0, TAO, 306_000, 1000);
        assertEq(ex.nativeStopLimitPNS(TAO, true), 0);
        assertEq(ex.execNativeStop(c.accountId(), TAO), 0);
        assertEq(c.snap(TAO).lots, 1000);
    }

    // Book reads and sentinels

    /// Mainnet perp 80 (TAO, status 4, numOrders 0) at block 110,711,378 reads 0 on every book field.
    function test_emptyBookSentinelIsZero() public {
        ex.listPerp(TAO, "TAO", 3, 3, 1000, 304_891);
        IPerplMin.PerpetualInfo memory p = ex.getPerpetualInfo(TAO);
        assertEq(p.maxBidPriceONS, 0);
        assertEq(p.minBidPriceONS, 0);
        assertEq(p.maxAskPriceONS, 0);
        assertEq(p.minAskPriceONS, 0);
        assertEq(p.numOrders, 0);
        assertEq(p.status, 4);
    }

    function test_bookReads() public view {
        IPerplMin.PerpetualInfo memory p = ex.getPerpetualInfo(BTC);
        assertEq(p.basePricePNS + p.maxBidPriceONS, BID);
        assertEq(p.basePricePNS + p.minAskPriceONS, ASK);
        assertEq(p.minBidPriceONS, 861_000);
        assertEq(p.maxAskPriceONS, 862_500);
        assertEq(p.numOrders, 8);
        assertEq(p.priceDecimals, 1);
        assertEq(p.lotDecimals, 5);
        assertEq(p.refPriceMaxAgeSec, 60);
        assertEq(ex.getNextPriceBelowWithOrders(BTC, BID), 861_730);
        assertEq(ex.getNextPriceAboveWithOrders(BTC, ASK), 861_750);
        (uint256 bids, uint256 expBids, uint256 asks,) = ex.getVolumeAtBookPrice(BTC, BID);
        assertEq(bids, 590);
        assertEq(expBids, 0);
        assertEq(asks, 0);
    }

    /// @dev Mainnet bound (L-06): PriceOutOfRange(p, 1, 16777215).
    function test_limitPriceRange_matchesMainnet() public {
        IPerplMin.OrderDesc memory d = a.desc(0, BTC, 16_777_216, 1, true);
        vm.expectRevert(abi.encodeWithSelector(IPerplErrors.PriceOutOfRange.selector, 16_777_216, 1, 16_777_215));
        a.exec(d);
        d = a.desc(0, BTC, 0, 1, true);
        vm.expectRevert(abi.encodeWithSelector(IPerplErrors.PriceOutOfRange.selector, 0, 1, 16_777_215));
        a.exec(d);
        a.exec(a.desc(0, BTC, 16_777_215, 1, true)); // the top of the range is accepted
    }

    function test_ignOracleFlag() public {
        assertFalse(ex.getPerpetualInfo(BTC).ignOracle);
        ex.setIgnOracle(BTC, true);
        assertTrue(ex.getPerpetualInfo(BTC).ignOracle);
    }

    function test_basePriceShiftsOns() public {
        ex.setBasePricePNS(BTC, 800_000);
        IPerplMin.PerpetualInfo memory p = ex.getPerpetualInfo(BTC);
        assertEq(p.maxBidPriceONS, BID - 800_000);
        assertEq(p.basePricePNS + p.minAskPriceONS, ASK);
    }

    function test_maxMatchesCapsTheWalk() public {
        PerplTrader c = _trader(2000e6);
        c.ioc(0, BTC, ASK * 1005 / 1000, 5000);
        vm.roll(block.number + 1);
        IPerplMin.OrderDesc memory d = c.desc(2, BTC, BID * 99 / 100, 5000, true);
        d.maxMatches = 2;
        vm.recordLogs();
        c.exec(d);
        assertEq(c.snap(BTC).lots, 5000 - 590 - 47);
        (uint256 unmatched, uint256 total) = _iocEvent(vm.getRecordedLogs());
        assertEq(unmatched, 5000 - 637);
        assertEq(total, 5000);
    }

    function test_expiredRestingOrderIsSkipped() public {
        IPerplMin.OrderDesc memory d = maker.desc(0, BTC, 861_745, 100, false);
        d.expiryBlock = block.number + 1;
        maker.exec(d);
        assertEq(ex.getPerpetualInfo(BTC).maxBidPriceONS, 861_745);
        a.ioc(0, BTC, ASK * 101 / 100, 100);
        vm.roll(block.number + 2);
        assertEq(ex.getPerpetualInfo(BTC).maxBidPriceONS, BID, "expired order not best");
        vm.recordLogs();
        a.ioc(2, BTC, BID * 99 / 100, 100);
        (, TakerFill memory f) = _lastTakerFill(vm.getRecordedLogs());
        assertEq(f.collatPricePNS, BID);
    }

    // Account, collateral and guards

    function test_createAccount_minimumAndDuplicate() public {
        PerplTrader t = new PerplTrader(ex, ausd);
        ausd.mint(address(t), 100e6);
        vm.expectRevert(abi.encodeWithSelector(IPerplErrors.InsufficentAmountToOpenAccount.selector, address(t), 9e6));
        t.open(9e6);
        t.open(10e6);
        vm.expectRevert(abi.encodeWithSelector(IPerplErrors.AccountExists.selector, address(t), t.accountId()));
        t.open(10e6);
        assertEq(ex.getMinAccountOpenCNS(), 10e6);
    }

    function test_unknownAccountReverts() public {
        vm.expectRevert(abi.encodeWithSelector(IPerplErrors.AccountDoesNotExist.selector, address(this)));
        ex.getAccountByAddr(address(this));
        vm.expectRevert(abi.encodeWithSelector(IPerplErrors.AccountIdDoesNotExist.selector, 999));
        ex.getAccountById(999);
    }

    function test_withdraw_balanceAndRateLimit() public {
        uint256 before = ausd.balanceOf(address(a));
        a.withdraw(1e6);
        assertEq(ausd.balanceOf(address(a)), before + 1e6);
        assertEq(a.snap(BTC).balance, 49e6);
        vm.expectRevert(abi.encodeWithSelector(IPerplErrors.InsufficientFunds.selector, 49e6, 60e6));
        a.withdraw(60e6);
        ex.setWithdrawAllowanceCNS(5e5);
        vm.expectRevert(
            abi.encodeWithSelector(IPerplErrors.WithdrawRateLimitExceeded.selector, 1e6, 5e5, 0, block.number)
        );
        a.withdraw(1e6);
    }

    function test_whitelisting_blocksCreateAndOpensNotCloses() public {
        a.ioc(0, BTC, ASK * 101 / 100, 100);
        ex.setWhitelistingEnabled(true);
        assertTrue(ex.whitelistingEnabled());
        PerplTrader t = new PerplTrader(ex, ausd);
        ausd.mint(address(t), 50e6);
        vm.expectRevert(abi.encodeWithSelector(IPerplErrors.NotWhitelisted.selector, address(t)));
        t.open(50e6);
        vm.expectRevert(abi.encodeWithSelector(IPerplErrors.NotWhitelisted.selector, address(a)));
        a.ioc(0, BTC, ASK * 101 / 100, 100);
        a.ioc(2, BTC, BID * 99 / 100, 100);
        assertEq(a.snap(BTC).lots, 0, "close allowed");
        ex.setWhitelisted(address(a), true);
        assertTrue(ex.whitelisted(address(a)));
        a.ioc(0, BTC, ASK * 101 / 100, 100);
    }

    function test_halted_blocksEverything() public {
        ex.setHalted(true);
        assertTrue(ex.isHalted());
        vm.expectRevert(IPerplErrors.ExchangeHalted.selector);
        a.ioc(0, BTC, ASK * 101 / 100, 100);
        vm.expectRevert(IPerplErrors.ExchangeHalted.selector);
        a.withdraw(1e6);
    }

    function test_pausedPerp_reverts() public {
        ex.setPerpStatus(BTC, 0);
        vm.expectRevert(abi.encodeWithSelector(IPerplErrors.ContractNotOperational.selector, BTC, uint8(0)));
        a.ioc(0, BTC, ASK * 101 / 100, 100);
    }

    function test_feeScheduleAndTier() public {
        (uint256 id, uint256[8] memory taker, uint256[8] memory mk) = ex.getPerpFeeSchedule(BTC);
        assertEq(id, 1021);
        assertEq(taker[0], 345);
        assertEq(taker[1], 300);
        assertEq(taker[7], 0);
        assertEq(mk[0], 45);
        assertEq(ex.getTakerFee(BTC), 345);
        ex.setFeeTier(a.accountId(), 1);
        assertEq(ex.getAccountFeeTier(a.accountId()), 1);
        a.ioc(0, BTC, ASK * 101 / 100, 100);
        uint256 deposit = Math.mulDiv(ASK * 100, 100, 1000, Math.Rounding.Ceil);
        assertEq(a.snap(BTC).balance, 50e6 - deposit - Math.mulDiv(ASK * 100, 300, 1e6, Math.Rounding.Ceil));
    }

    function test_restingOpenLocksCollateral_cancelUnlocks() public {
        uint256 oid = a.rest(0, BTC, 861_000, 10);
        uint256 lock = 861_000 + Math.mulDiv(8_610_000, 45, 1e6, Math.Rounding.Ceil);
        PerplTrader.Snap memory s = a.snap(BTC);
        assertEq(s.locked, lock);
        assertEq(s.balance, 50e6 - lock);
        IPerplMin.OrderDesc memory d = b.desc(4, BTC, 0, 0, false);
        d.orderId = oid;
        vm.expectRevert(abi.encodeWithSelector(IPerplErrors.WrongAccountForOrder.selector, BTC, oid, b.accountId()));
        b.exec(d);
        d = a.desc(4, BTC, 0, 0, false);
        d.orderId = oid;
        a.exec(d);
        s = a.snap(BTC);
        assertEq(s.locked, 0);
        assertEq(s.balance, 50e6);
    }

    function test_fillOrKillAndPostOnly() public {
        IPerplMin.OrderDesc memory d = a.desc(0, BTC, ASK * 1005 / 1000, 100_000, false);
        d.fillOrKill = true;
        vm.expectRevert(
            abi.encodeWithSelector(
                IPerplErrors.UnmatchedLotRemainsInFillOrKill.selector, BTC, a.accountId(), 100_000 - 16_700
            )
        );
        a.exec(d);
        d = a.desc(0, BTC, ASK, 10, false);
        d.postOnly = true;
        vm.expectRevert(
            abi.encodeWithSelector(IPerplErrors.CrossesBook.selector, BTC, a.accountId(), ASK, true, ASK, false)
        );
        a.exec(d);
    }

    function test_openOppositeSide_netsThenInverts() public {
        b.ioc(0, BTC, ASK * 101 / 100, 100);
        b.ioc(1, BTC, BID * 99 / 100, 300);
        PerplTrader.Snap memory s = b.snap(BTC);
        assertEq(s.positionType, 1);
        assertEq(s.lots, 200);
    }

    function test_closeWrongSide_reverts() public {
        a.ioc(0, BTC, ASK * 101 / 100, 100);
        vm.expectRevert(abi.encodeWithSelector(IPerplErrors.CloseOrderPositionMismatch.selector, uint8(0), uint8(3)));
        a.ioc(3, BTC, ASK * 101 / 100, 100);
    }

    function test_noPositionReadsZeros_typeLong() public view {
        (IPerplMin.PositionInfo memory p, uint256 mark, bool valid) = ex.getPosition(BTC, a.accountId());
        assertEq(p.lotLNS, 0);
        assertEq(p.positionType, 0, "zero position looks Long: check lots, not type");
        assertEq(p.depositCNS, 0);
        assertEq(mark, BID);
        assertTrue(valid);
    }

    function test_fundingRealizedProRata() public {
        a.ioc(0, BTC, ASK * 101 / 100, 100);
        ex.accrueFunding(BTC, a.accountId(), 1000);
        assertEq(a.snap(BTC).premium, 1000);
        vm.roll(block.number + 1);
        (PerplTrader.Snap memory pre, PerplTrader.Snap memory post) = a.closeAndMeasure(BTC, 40, BID * 99 / 100);
        assertEq(post.lots, 60);
        assertEq(post.premium, 600);
        uint256 released = pre.deposit * 40 / 100;
        int256 pnl = int256(BID * 40) - int256(ASK * 100 * 40 / 100);
        uint256 fee = Math.mulDiv(BID * 40, 345, 1e6, Math.Rounding.Ceil);
        assertEq(int256(post.balance) - int256(pre.balance), int256(released) + pnl + 400 - int256(fee));
    }

    function test_liquidationRemovesPosition() public {
        a.ioc(0, BTC, ASK * 101 / 100, 100);
        PerplTrader.Snap memory pre = a.snap(BTC);
        ex.liquidate(BTC, a.accountId());
        (IPerplMin.PositionInfo memory p,,) = ex.getPosition(BTC, a.accountId());
        assertEq(p.lotLNS, 0);
        assertEq(p.accountId, 0);
        uint256 equity = pre.deposit - 100; // pnl at mark BID is -1 tick x 100 lots
        assertEq(a.snap(BTC).balance, pre.balance + equity * 80_000 / 100_000);
    }

    function test_adlReducesAtMarkWithoutFee() public {
        a.ioc(0, BTC, ASK * 101 / 100, 100);
        PerplTrader.Snap memory pre = a.snap(BTC);
        ex.adl(BTC, a.accountId(), 40);
        PerplTrader.Snap memory post = a.snap(BTC);
        assertEq(post.lots, 60);
        assertEq(post.balance, pre.balance + pre.deposit * 40 / 100 - 40);
    }

    function test_execOrders_revertOnFailFalseSkips() public {
        IPerplMin.OrderDesc[] memory ds = new IPerplMin.OrderDesc[](2);
        ds[0] = a.desc(0, BTC, ASK * 101 / 100, 100, true);
        ds[1] = a.desc(2, BTC, BID * 99 / 100, 500, true);
        IPerplMin.OrderSignature[] memory sigs = a.execBatch(ds, false);
        assertEq(sigs.length, 2);
        assertEq(a.snap(BTC).lots, 100);
        // revertOnFail = true runs ds[0] again (position 200), then the oversized close reverts the whole batch.
        vm.expectRevert(abi.encodeWithSelector(IPerplErrors.CloseOrderExceedsPosition.selector, 200, 500));
        a.execBatch(ds, true);
    }

    function test_staticReads() public view {
        assertEq(ex.getFundingInterval(), 8571);
        (uint256 major, uint256 minor, uint256 patch) = ex.getContractVersion();
        assertEq(major * 100 + minor * 10 + patch, 175);
        assertFalse(ex.whitelistingEnabled());
        assertFalse(ex.isHalted());
    }

    // Helpers

    function _trader(uint256 fund) internal returns (PerplTrader t) {
        t = new PerplTrader(ex, ausd);
        ausd.mint(address(t), fund);
        t.open(fund);
    }

    function _lastTakerFill(Vm.Log[] memory logs) internal view returns (bool found, TakerFill memory f) {
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == address(ex) && logs[i].topics[0] == IPerplEvents.TakerOrderFilledV2.selector) {
                f = abi.decode(logs[i].data, (TakerFill));
                found = true;
            }
        }
    }

    function _iocEvent(Vm.Log[] memory logs) internal view returns (uint256 unmatched, uint256 total) {
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == address(ex) && logs[i].topics[0] == IPerplEvents.ImmediateOrCancelExecuted.selector)
            {
                (unmatched, total) = abi.decode(logs[i].data, (uint256, uint256));
            }
        }
    }

    function _count(Vm.Log[] memory logs, bytes32 topic) internal pure returns (uint256 n) {
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].topics[0] == topic) ++n;
        }
    }
}
