// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IPerplMin} from "../../src/interfaces/perpl/IPerplMin.sol";
import {ICoverManager} from "../../src/interfaces/ICoverManager.sol";
import {Constants} from "../../src/Constants.sol";
import {CoverParams, Cover, CoverStatus, MarketParams, Quote} from "../../src/types/GaplessTypes.sol";
import {PerplTrader} from "../mocks/PerplTrader.sol";
import {CoverManagerBase} from "./CoverManagerBase.t.sol";
import {AccountStub} from "./stubs/AccountStub.sol";

/// @notice Attack scenarios from 05 section 4 that the manager must withstand (A1 to A15 where applicable).
contract CoverManagerAttackTest is CoverManagerBase {
    AccountStub internal atk;
    PerplTrader internal col;

    function setUp() public override {
        super.setUp();
        atk = _newAccount(100e6);
        col = new PerplTrader(IPerplMin(address(ex)), IERC20(address(ausd)));
        ausd.mint(address(col), 100e6);
        col.open(100e6);
    }

    /// @dev Equity of a Perpl account marked at the current mark: free + locked + deposit + uPnL + funding.
    function _equity(uint256 accountId) internal view returns (int256 e) {
        IPerplMin.AccountInfo memory a = ex.getAccountById(accountId);
        (IPerplMin.PositionInfo memory p,,) = ex.getPosition(PERP, accountId);
        e = int256(a.balanceCNS + a.lockedBalanceCNS + p.depositCNS) + p.pnlCNS + p.premiumPnlCNS;
    }

    function _attackerValue() internal view returns (int256) {
        return int256(ausd.balanceOf(address(atk)) + ausd.balanceOf(address(col))) + _equity(atk.perplAccountId())
            + _equity(col.accountId());
    }

    /// @dev A1 self-deal: cover at the minimum distance, empty bids (C1 reads as crossed), the reference at `ref`.
    /// The colluder rests a bid at the first-close floor R x (1 - A) and the trigger fills into it.
    function _selfDeal(uint32 sigma, uint256 stop, uint256 ref) internal returns (int256 pnl, uint256 paid) {
        vm.prank(keeper);
        cm.postSigma(PERP, sigma);
        int256 v0 = _attackerValue();
        _openLong(atk, LOTS);
        CoverParams memory p = _params();
        p.stopPNS = stop;
        bytes32 id = _buy(atk, p);
        _roll(200);
        _setRefs(ref);
        try cm.arm(id) {} catch {} // H-01: refused unless the reference is at or through the stop
        _roll(1);
        _setRefs(ref);
        col.rest(0, PERP, ref * 9995 / 10_000, LOTS);
        try cm.trigger(id) returns (uint256 x) {
            paid = x;
        } catch {}
        _roll(41);
        _setRefs(MARK);
        if (_status(id) == CoverStatus.Triggered) cm.finalize(id);
        else atk.cancelCover(id);
        // Colluder unwinds at the reference against the maker
        _setRefs(ref);
        (IPerplMin.PositionInfo memory pc,,) = ex.getPosition(PERP, col.accountId());
        if (pc.lotLNS > 0) {
            maker.rest(1, PERP, ref, pc.lotLNS);
            col.ioc(2, PERP, ref * 97 / 100, pc.lotLNS);
        }
        pnl = _attackerValue() - v0;
    }

    /// @dev H-01: with no reference move the self-dealer cannot even arm; the vault pays nothing.
    function test_A1_selfDeal_noMove_cannotArm_andLoses() public {
        (int256 pnl, uint256 paid) = _selfDeal(27, 834_000, MARK); // 11 bps, at minDist for sigma 27
        assertEq(paid, 0, "no arm, no fast path, no payout");
        assertEq(vault.paidOut(), 0);
        assertLt(pnl, 0, "attacker PnL must be negative");
    }

    /// @dev On a genuine touch of the stop, the colluder can only buy at R x (1 - A): payout <= A x SN <= escrow.
    function test_A1_selfDeal_onRealTouch_paysAtMostAllowance_andLoses() public {
        uint256 stop = 834_000;
        (int256 pnl, uint256 paid) = _selfDeal(27, stop, stop);
        assertGt(paid, 0);
        assertLe(paid, stop * LOTS * 5 / 10_000, "payout <= A x SN");
        assertLt(pnl, 0, "attacker PnL must be negative");
        assertGe(vault.premiumIn(), vault.paidOut(), "vault nets the escrow over the allowance");
    }

    /// @dev Sigma manipulation: a compromised SIGMA key posts the floor (5). The fee floor A still makes
    /// escrow >= A x N, so the self-deal stays NPV-negative.
    function test_A1_withMinimumSigma_stillLoses() public {
        (int256 pnl, uint256 paid) = _selfDeal(5, 834_100, 834_100); // 10 bps = minStopDistanceBps floor
        assertLe(paid, uint256(834_100) * LOTS * 5 / 10_000);
        assertLt(pnl, 0);
    }

    /// @dev A3 stop hunt by a third party: sweeping the bids below the stop without moving the reference
    /// cannot arm (reference outside refTol), so no IOC flow is created.
    function test_A3_bookPushWithoutReference_cannotArm() public {
        bytes32 id = _buy();
        _pastWarmup();
        _restBid(820_000, LOTS); // book far below, ref at the mark
        vm.expectRevert(ICoverManager.ConditionNotMet.selector);
        cm.arm(id);
        (bytes32[] memory toArm,) = cm.watchList(PERP, 16);
        assertEq(toArm.length, 0);
    }

    /// @dev A4 reference manipulation: one corrupted source cannot move the median (n = 3), and with n = 2 the
    /// long takes the higher (least favorable) value.
    function test_A4_singleSourceManipulation() public {
        bytes32 id = _buy();
        _pastWarmup();
        feed.setAnswer(800_000e7); // feed pushed 4% low
        (uint256 r, uint8 n) = cm.referencePrice(PERP, true, 0);
        assertEq(n, 3);
        assertEq(r, MARK);
        vm.expectRevert(ICoverManager.ConditionNotMet.selector);
        cm.arm(id);
        vm.warp(block.timestamp + 63);
        ex.setOracle(PERP, MARK); // mark stale; oracle fresh; feed still within 120 s
        (r, n) = cm.referencePrice(PERP, true, 0);
        assertEq(n, 2);
        assertEq(r, MARK);
    }

    /// @dev A2 window option: only the first fresh post-trigger publish counts; later lows are ignored.
    function test_A2_observeIsFirstPublishOnly() public {
        bytes32 id = _buy();
        _pastWarmup();
        _crash(830_000, 829_600, LOTS);
        cm.arm(id);
        _roll(1);
        cm.trigger(id);
        _roll(2);
        _setRefs(830_500);
        assertTrue(cm.observe(id));
        _roll(1);
        _setRefs(800_000); // a later crash is not this cover's gap
        vm.expectRevert(abi.encodeWithSelector(ICoverManager.BadStatus.selector, id, CoverStatus.Triggered));
        cm.observe(id);
        cm.finalize(id);
        // min(G_real 61,229, max(gRefTrig 41,250, gRefPost 16,250) + 20,770 = 62,020)
        assertEq(_cover(id).paidCNS, 61_229);
    }

    /// @dev A5 griefing by the owner: Armed and Triggered lock the perp (the account enforces PerpLocked);
    /// trigger closes min(remaining, position).
    function test_A5_lockWindow() public {
        bytes32 id = _buy();
        _pastWarmup();
        _crash(830_000, 829_600, LOTS);
        assertFalse(cm.isLocked(address(acct), PERP));
        cm.arm(id);
        assertTrue(cm.isLocked(address(acct), PERP));
        vm.expectRevert(abi.encodeWithSelector(ICoverManager.BadStatus.selector, id, CoverStatus.Armed));
        acct.cancelCover(id);
        _roll(1);
        cm.trigger(id);
        assertTrue(cm.isLocked(address(acct), PERP));
        _roll(41);
        cm.finalize(id);
        assertFalse(cm.isLocked(address(acct), PERP));
    }

    /// @dev A6 and L-07 book spam: 40 one-lot dust bids above the floor. maxMatches 16 bounds each walk; every
    /// call consumes the dust it matches and the remainder can be retried in the same block, so the cover is fully
    /// closed after ceil(40 / 16) + 1 = 4 calls at most. Gas is logged here; budgets live in CoverManagerGas.
    function test_A6_L07_dustSpam_boundedCallsToFullClose() public {
        bytes32 id = _buy();
        _pastWarmup();
        _setRefs(830_000);
        PerplTrader spam = new PerplTrader(IPerplMin(address(ex)), IERC20(address(ausd)));
        ausd.mint(address(spam), 100e6);
        spam.open(100e6);
        for (uint256 i; i < 40; ++i) {
            spam.rest(0, PERP, 829_990 - i * 5, 1);
        }
        _restBid(829_600, LOTS);
        cm.arm(id);
        _roll(1);
        _setRefs(830_000);
        uint256 g = gasleft();
        cm.trigger(id);
        uint256 used = g - gasleft();
        emit log_named_uint("trigger gas, 16 dust matches, mock book included", used);
        emit log_named_uint("close call gas (account + mock Perpl)", acct.lastCloseGas());
        assertEq(_cover(id).filledLots, 16);
        uint256 calls = 1;
        while (_cover(id).filledLots < LOTS) {
            cm.trigger(id); // same block: the dust it walks is consumed
            ++calls;
        }
        assertLe(calls, 4, "L-07 bound: ceil(40 / 16) + 1");
        Cover memory c = _cover(id);
        assertEq(c.filledLots, LOTS);
        assertLe(c.paidCNS, uint256(STOP) * LOTS * 5 / 10_000 + (STOP - 830_000) * LOTS);
    }

    function _splitRefs(uint256 markPx, uint256 otherPx) internal {
        ex.setMark(PERP, markPx);
        ex.setOracle(PERP, otherPx);
        feed.setAnswer(int256(otherPx) * 1e7);
    }

    /// @dev A7 arm griefing: an outsider arms and sits on the exclusive window (book path only, no fast path); the
    /// keeper fires after it. With the mark through the stop the keeper is never blocked (L-02).
    function test_A7_armSquatter_delayIsBounded() public {
        bytes32 id = _buy();
        _pastWarmup();
        _splitRefs(831_000, 830_000);
        _restBid(829_600, LOTS);
        address squatter = makeAddr("squatter");
        vm.prank(squatter);
        cm.arm(id);
        for (uint256 i = 1; i <= 3; ++i) {
            _roll(1);
            _splitRefs(831_000, 830_000);
            vm.prank(keeper);
            vm.expectRevert(abi.encodeWithSelector(ICoverManager.NotArmer.selector, keeper, squatter));
            cm.trigger(id);
        }
        _roll(1);
        _splitRefs(831_000, 830_000);
        vm.prank(keeper);
        assertEq(cm.trigger(id), 61_229);
    }

    /// @dev A9: the manager's lock blocks re-entry from the account hook, and the settling flag is visible to the
    /// vault during the payout (it blocks LP flows there).
    function test_A9_reentrancyAndSettlingFlag() public {
        bytes32 id = _buy();
        _pastWarmup();
        _crash(830_000, 829_600, LOTS);
        cm.arm(id);
        _roll(1);
        acct.setReenter(id);
        vm.expectRevert();
        cm.trigger(id);
        acct.setReenter(bytes32(0));
        assertFalse(cm.isSettling());
        cm.trigger(id);
        assertTrue(vault.sawSettling());
        assertFalse(cm.isSettling());
    }

    /// @dev A11 / O2: correlated crash, three covers trigger in one block; payouts per block never exceed the
    /// snapshot cap and the overflow is owed, then paid by finalize.
    function test_A11_correlatedCrash_perBlockCap() public {
        AccountStub[3] memory as_;
        bytes32[3] memory ids;
        for (uint256 i; i < 3; ++i) {
            as_[i] = i == 0 ? acct : _newAccount(100e6);
            if (i > 0) _openLong(as_[i], LOTS);
            ids[i] = _buy(as_[i], _params());
        }
        vault.setTotalAssets(10e6);
        MarketParams memory p = Constants.defaultMarketParams();
        p.perBlockPayoutCapBps = 1000; // 1 AUSD per block
        vm.prank(admin);
        cm.setMarketParams(PERP, p);
        _pastWarmup();
        _crash(820_000, 819_600, 3 * LOTS); // deep gap: each cover is owed G_real 561,057
        for (uint256 i; i < 3; ++i) {
            cm.arm(ids[i]);
        }
        _roll(1);
        _setRefs(820_000);
        uint256 before = vault.paidOut();
        for (uint256 i; i < 3; ++i) {
            cm.trigger(ids[i]);
        }
        uint256 inBlock = vault.paidOut() - before;
        assertLe(inBlock, 1e6, "O2: single-block drawdown <= cap");
        assertGt(_cover(ids[2]).owedCNS, 0, "overflow deferred, not denied");
        _roll(41);
        for (uint256 k; k < 3; ++k) {
            for (uint256 i; i < 3; ++i) {
                if (_status(ids[i]) == CoverStatus.Triggered) cm.finalize(ids[i]);
            }
            _roll(1);
        }
        for (uint256 i; i < 3; ++i) {
            Cover memory c = _cover(ids[i]);
            assertEq(uint8(c.status), uint8(CoverStatus.Finalized));
            assertEq(c.owedCNS, 0);
            assertEq(c.paidCNS, 561_057); // G_real < G_ref (830,825 - 820,000) x 50 + A x SN 20,770
        }
    }

    /// @dev A12 donation: AUSD sent straight to the manager is inert; accounting and end paths are unaffected.
    function test_A12_donationToManagerIsInert() public {
        bytes32 id = _buy();
        ausd.mint(address(cm), 1e6);
        _roll(12_001);
        cm.expire(id);
        assertEq(ausd.balanceOf(address(cm)), 1e6); // only the donation remains
        assertEq(vault.reservedTotal(), 0);
    }

    /// @dev A13 buying into a known move: no arm and no fast path inside the warm-up.
    function test_A13_warmupBlocksKnownMove() public {
        // Near stops are refused when sigma is stressed (volatility-scaled minimum distance)
        AccountStub b = _newAccount(100e6);
        _openLong(b, LOTS);
        vm.prank(keeper);
        cm.postSigma(PERP, 163);
        vm.expectRevert(abi.encodeWithSelector(ICoverManager.StopTooClose.selector, 50, 68));
        _buy(b, _params());
        vm.prank(keeper);
        cm.postSigma(PERP, 27);
        bytes32 id = _buy();
        _crash(820_000, 819_000, LOTS);
        vm.expectRevert(abi.encodeWithSelector(ICoverManager.TooEarly.selector, B0 + 200));
        cm.arm(id);
        vm.expectRevert(ICoverManager.ConditionNotMet.selector);
        cm.trigger(id);
    }

    /// @dev A15 venue events and the liquidation race: halt disarms, liquidation between arm and trigger voids
    /// with no payout, ADL voids.
    function test_A15_venueEventsAndLiquidationRace() public {
        bytes32 id = _buy();
        _pastWarmup();
        _crash(830_000, 829_600, LOTS);
        ex.setHalted(true);
        assertFalse(cm.arm(id));
        ex.setHalted(false);
        cm.arm(id);
        _roll(1);
        _setRefs(830_000);
        ex.liquidate(PERP, acct.perplAccountId());
        assertEq(cm.trigger(id), 0);
        assertEq(uint8(_status(id)), uint8(CoverStatus.Voided));
        assertEq(vault.paidOut(), 0);
        assertEq(vault.reservedTotal(), 0);
        assertEq(ausd.balanceOf(address(cm)), 0);
    }

    /// @dev CR1: the trader's own resting bid on the covered perp is cleared by Perpl's self-match rule during the
    /// close, unlocking its collateral. Measured as balance + locked, the payout is unchanged (62,020); a
    /// balance-only measure would book the unlock as proceeds and under-pay.
    function test_CR1_traderRestingBid_doesNotDistortPayout() public {
        bytes32 id = _buy();
        _pastWarmup();
        _crash(830_000, 829_600, LOTS);
        acct.rest(0, PERP, 829_700, 20); // trader's own bid above the maker's, inside the IOC range
        uint256 locked = ex.getAccountById(acct.perplAccountId()).lockedBalanceCNS;
        assertGt(locked, 0);
        cm.arm(id);
        _roll(1);
        _setRefs(830_000);
        assertEq(cm.trigger(id), 61_229);
        assertEq(_cover(id).gRealCumCNS, 61_229, "G_real identical to the no-resting-order case");
        assertEq(ex.getAccountById(acct.perplAccountId()).lockedBalanceCNS, 0, "self-match cleared the bid");
    }

    function test_CR1_balanceOnlyMeasure_wouldUnderpay() public {
        bytes32 id = _buy();
        _pastWarmup();
        _crash(830_000, 829_600, LOTS);
        acct.rest(0, PERP, 829_700, 20);
        acct.setMeasureBalanceOnly(true);
        cm.arm(id);
        _roll(1);
        _setRefs(830_000);
        uint256 paid = cm.trigger(id);
        assertLt(_cover(id).gRealCumCNS, 61_229);
        assertLt(paid, 61_229);
    }

    /// @dev Sigma staleness gates buys only; live covers keep their guarantee.
    function test_sigmaStale_blocksBuysNotTriggers() public {
        bytes32 id = _buy();
        vm.roll(block.number + 6001);
        _crash(830_000, 829_600, LOTS);
        AccountStub b = _newAccount(100e6);
        _setRefs(MARK);
        _openLong(b, LOTS);
        vm.expectRevert(abi.encodeWithSelector(ICoverManager.SigmaStale.selector, B0));
        _buy(b, _params());
        _setRefs(830_000);
        cm.arm(id);
        _roll(1);
        _setRefs(830_000);
        assertEq(cm.trigger(id), 61_229);
    }
}
