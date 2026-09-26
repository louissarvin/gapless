// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {GaplessFixture} from "../utils/GaplessFixture.sol";
import {ListMarket} from "../../script/ListMarket.s.sol";
import {CoverManager} from "../../src/CoverManager.sol";
import {GaplessAccount} from "../../src/GaplessAccount.sol";
import {IGaplessAccount} from "../../src/interfaces/IGaplessAccount.sol";
import {ICoverManager} from "../../src/interfaces/ICoverManager.sol";
import {ICoverVault} from "../../src/interfaces/ICoverVault.sol";
import {PerplTrader} from "../mocks/PerplTrader.sol";
import {IPerplMin} from "../../src/interfaces/perpl/IPerplMin.sol";
import {Constants} from "../../src/Constants.sol";
import {CoverParams, Cover, CoverStatus, MarketConfig, Quote} from "../../src/types/GaplessTypes.sol";

/// @notice End to end on S1's real stack (Deploy.s.sol order, real vault, factory and account) plus ListMarket.
contract CoverManagerIntegrationTest is GaplessFixture {
    CoverManager internal cm;
    GaplessAccount internal acct;
    address internal owner = makeAddr("owner");
    uint256 internal constant LOTS = 50;
    uint256 internal constant STOP = 857_431; // 50 bps under the 861,740 mark

    function setUp() public {
        useRealManager = true;
        _setUpGapless();
        cm = CoverManager(manager);
        ausd.mint(seedLp, 2e6);
        ListMarket lm = new ListMarket();
        MarketConfig memory cfg = Constants.btcMarketConfig();
        cfg.feed = address(feed);
        lm.list(
            ListMarket.Config({
                manager: manager,
                vault: address(vault),
                riskAdmin: deployer,
                keeper: keeper,
                lp: seedLp,
                perpId: BTC,
                cfg: cfg,
                params: Constants.defaultMarketParams(),
                sigmaBlkBpsE2: 27,
                seedDepositCNS: 2e6
            })
        );
        _lp(makeAddr("lp"), 1000e6);
        acct = _account(owner, 100e6, _noGrant());
        _openLong(acct, LOTS);
    }

    function _p() internal pure returns (CoverParams memory p) {
        p = CoverParams(BTC, true, LOTS, STOP, 200, 12_000);
    }

    function _refs(uint256 px) internal {
        ex.setMark(BTC, px);
        ex.setOracle(BTC, px);
        feed.setAnswer(int256(px) * 1e7);
    }

    function _roll(uint256 n) internal {
        vm.roll(block.number + n);
        vm.warp(block.timestamp + (n * 3 + 9) / 10);
    }

    /// @dev Sweep the maker's bids so the best bid can sit below the stop.
    function _sweepBids() internal {
        _refs(BID); // opens need a fresh mark
        PerplTrader dumper = new PerplTrader(ex, ausd);
        ausd.mint(address(dumper), 100_000e6);
        dumper.open(100_000e6);
        dumper.ioc(Constants.ORDER_OPEN_SHORT, BTC, BID - 1000, 200_000);
    }

    function test_listMarketScript() public view {
        assertTrue(cm.marketConfig(BTC).listed);
        (uint32 s,) = cm.sigmaOf(BTC);
        assertEq(s, 27);
        assertEq(vault.balanceOf(seedLp), vault.convertToShares(2e6));
        assertEq(vault.balanceOf(deployer), 0, "RISK_ADMIN is not an LP");
    }

    function test_e2e_buyArmTriggerObserveFinalize() public {
        vm.prank(owner);
        bytes32 id = acct.buyCover(_p(), 1e6);
        Cover memory c = cm.getCover(id);
        assertEq(c.account, address(acct));
        assertEq(vault.reserved(BTC), c.capCNS);
        uint256 assets0 = vault.totalAssets();

        _roll(200);
        _sweepBids();
        _refs(856_500);
        maker.rest(Constants.ORDER_OPEN_LONG, BTC, 855_000, LOTS);
        vm.prank(keeper);
        assertTrue(cm.arm(id));
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(IGaplessAccount.PerpLocked.selector, BTC));
        acct.trade(_order(Constants.ORDER_CLOSE_LONG, BID / 2, 1));

        _roll(1);
        _refs(856_500);
        // H-01: the best bid sits 17.5 bps under R, below the first-close floor R x (1 - A) = 856,071
        vm.expectEmit(address(cm));
        emit ICoverManager.TriggerNoFill(id, block.number, 856_071);
        vm.prank(keeper);
        assertEq(cm.trigger(id), 0);
        _roll(1);
        _refs(856_500);
        vm.expectEmit(address(cm));
        emit ICoverManager.TriggerNoFill(id, block.number, 855_643); // step 1: R x (1 - 2A)
        vm.prank(keeper);
        assertEq(cm.trigger(id), 0);
        _roll(1);
        _refs(856_500);
        uint256 perpl0 = _perplBalance(acct);
        vm.prank(keeper);
        uint256 paid = cm.trigger(id); // step 2: R x (1 - 4A) = 854,787 reaches the bid at 855,000
        c = cm.getCover(id);
        // G_ref (857,431 - 856,500) x 50 = 46,550; A x SN = floor(42,871,550 x 5 / 1e4) = 21,435
        assertEq(paid, 46_550 + 21_435);
        assertEq(c.filledLots, LOTS);
        assertGt(c.gRealCumCNS, paid);
        assertGe(_perplBalance(acct) - perpl0, paid);

        _roll(2);
        _refs(856_000);
        assertTrue(cm.observe(id));
        uint256 topUp = cm.finalize(id);
        assertEq(topUp, (856_500 - 856_000) * LOTS);
        c = cm.getCover(id);
        assertEq(uint8(c.status), uint8(CoverStatus.Finalized));
        assertEq(vault.reservedTotal(), 0);
        assertEq(ausd.balanceOf(manager), 0);
        // LPs: + 90% of (escrow + rent) - payouts
        uint256 income = c.escrowCNS + c.rentCNS;
        assertEq(int256(vault.totalAssets()) - int256(assets0), int256(income - income / 10) - int256(uint256(c.paidCNS)));
        assertFalse(cm.isLocked(address(acct), BTC));
    }

    function test_e2e_cancelAndSyncThroughRealAccount() public {
        vm.prank(owner);
        bytes32 id = acct.buyCover(_p(), 1e6);
        uint256 w0 = ausd.balanceOf(address(acct));
        // Reduce through the account: trade() calls syncCover, which resizes the cover
        vm.prank(owner);
        acct.trade(_order(Constants.ORDER_CLOSE_LONG, BID - 1000, 20));
        Cover memory c = cm.getCover(id);
        assertEq(c.lots, 30);
        assertGt(ausd.balanceOf(address(acct)), w0);
        vm.prank(owner);
        acct.cancelCover(id);
        assertEq(uint8(cm.getCover(id).status), uint8(CoverStatus.Cancelled));
        assertEq(vault.reservedTotal(), 0);
        assertEq(ausd.balanceOf(manager), 0);
    }

    /// @dev CR1 on the real account: the trader's own resting bid between the stop and the maker is self-match
    /// cleared during the close; its unlocked collateral is not booked as proceeds.
    function test_e2e_restingBidOnCoveredPerp() public {
        vm.prank(owner);
        bytes32 id = acct.buyCover(_p(), 1e6);
        _roll(200);
        _sweepBids();
        _refs(856_500);
        maker.rest(Constants.ORDER_OPEN_LONG, BTC, 855_000, LOTS);
        IPerplMin.OrderDesc memory d = _order(Constants.ORDER_OPEN_LONG, 856_000, 10);
        d.immediateOrCancel = false;
        vm.prank(owner);
        acct.trade(d); // placed before arming (the lock blocks trades while Armed)
        assertGt(ex.getAccountById(acct.perplAccountId()).lockedBalanceCNS, 0);
        vm.prank(keeper);
        cm.arm(id);
        _roll(1);
        _refs(856_500);
        vm.prank(keeper);
        cm.trigger(id); // tight floor: no fill, own bid untouched
        assertGt(ex.getAccountById(acct.perplAccountId()).lockedBalanceCNS, 0);
        _roll(1);
        _refs(856_500);
        vm.prank(keeper);
        cm.trigger(id); // step 1 (855,643): the own bid at 856,000 self-match clears, maker still out of reach
        _roll(1);
        _refs(856_500);
        vm.prank(keeper);
        uint256 paid = cm.trigger(id);
        assertEq(paid, 46_550 + 21_435, "payout unaffected by the unlocked collateral");
        assertEq(ex.getAccountById(acct.perplAccountId()).lockedBalanceCNS, 0);
        Cover memory c = cm.getCover(id);
        assertEq(c.filledLots, LOTS);
    }
}
