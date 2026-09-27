// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Vm} from "forge-std/Vm.sol";
import {GaplessFixture} from "../utils/GaplessFixture.sol";
import {ListMarket} from "../../script/ListMarket.s.sol";
import {CoverManager} from "../../src/CoverManager.sol";
import {GaplessAccount} from "../../src/GaplessAccount.sol";
import {ICoverManager} from "../../src/interfaces/ICoverManager.sol";
import {IGaplessAccount} from "../../src/interfaces/IGaplessAccount.sol";
import {PayoutMath} from "../../src/libraries/PayoutMath.sol";
import {PerplTrader} from "../mocks/PerplTrader.sol";
import {Constants} from "../../src/Constants.sol";
import {
    CoverParams,
    Cover,
    CoverStatus,
    EndReason,
    DisarmReason,
    MarketConfig,
    MarketParams,
    OperatorGrant,
    Quote
} from "../../src/types/GaplessTypes.sol";

/// @title SA2 regressions (C5)
/// @notice The SA2 proofs of concept, inverted to assert the fixed behavior. Real stack on the C0 mocks with
/// mainnet-shaped BTC bid depth. Ids match contract/audit/SA2_REPORT.md and docs/C5_FIXES.md.
contract SA2AuditTest is GaplessFixture {
    CoverManager internal cm;
    address internal owner = makeAddr("owner");
    address internal lp = makeAddr("lp");

    uint256 internal constant M = BID; // fair price before the touch
    uint256 internal constant STOP = M * (10_000 - 45) / 10_000; // 857,862
    uint256 internal constant FLOOR = STOP * 9900 / 10_000; // min(stop, R) x (1 - floorSlack) at R = STOP
    uint256 internal constant TIGHT = STOP * 9995 / 10_000; // R x (1 - A) at R = STOP
    uint256 internal constant HUNT_LOTS = 2331; // ~2,000 AUSD at the stop (spec cap)

    function setUp() public {
        useRealManager = true;
        _setUpGapless();
        cm = CoverManager(manager);
        ausd.mint(seedLp, 2e6);
        MarketConfig memory cfg = Constants.btcMarketConfig();
        cfg.feed = address(feed);
        new ListMarket().list(
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
        // Vault is now the canary's 3 AUSD (1 seed + 2 LP); tests that need depth add LP.
    }

    // Helpers

    function _refs(uint256 px) internal {
        ex.setMark(BTC, px);
        ex.setOracle(BTC, px);
        feed.setAnswer(int256(px) * 1e7);
    }

    function _roll(uint256 n) internal {
        vm.roll(block.number + n);
        vm.warp(block.timestamp + (n * 3 + 9) / 10);
    }

    function _trader(uint256 fund) internal returns (PerplTrader t) {
        t = new PerplTrader(ex, ausd);
        ausd.mint(address(t), fund);
        t.open(fund);
    }

    /// @dev Sells into every bid at or above `px` (opens need a fresh mark, so call after _refs).
    function _sweepBidsDownTo(uint256 px) internal {
        _trader(200_000e6).ioc(Constants.ORDER_OPEN_SHORT, BTC, px, 600_000);
    }

    /// @dev BTC-PERP bid profile measured on mainnet (SA1 section 8), rebuilt under `fair`.
    function _mainnetBidsUnder(uint256 fair) internal {
        PerplTrader mm = _trader(100_000e6);
        uint16[6] memory bps = [uint16(3), 6, 23, 43, 64, 71];
        uint256[6] memory lots = [uint256(6022), 1780, 163, 163, 164, 29];
        for (uint256 i; i < 6; ++i) {
            mm.rest(Constants.ORDER_OPEN_LONG, BTC, fair * (10_000 - bps[i]) / 10_000, lots[i]);
        }
    }

    function _setMaxNotional(uint80 cap) internal {
        MarketParams memory p = cm.marketParams(BTC);
        p.maxCoverNotionalCNS = cap;
        vm.prank(deployer);
        cm.setMarketParams(BTC, p);
    }

    function _coveredLong(uint256 lots, uint32 duration) internal returns (GaplessAccount a, bytes32 id) {
        _refs(M);
        a = _account(owner, 400e6, _noGrant());
        _openLong(a, lots);
        vm.prank(owner);
        id = a.buyCover(CoverParams(BTC, true, lots, STOP, 200, duration), 10e6);
    }

    /// @dev Limit of chain step k at R = STOP (A 5, floorSlack 100).
    function _stepLimit(uint256 k) internal pure returns (uint256) {
        if (k == 0) return TIGHT;
        uint256 allow = 5 << k;
        if (allow > 100) allow = 100;
        return STOP * (10_000 - allow) / 10_000;
    }

    function _expectNoFill(bytes32 id, uint256 limit) internal {
        vm.expectEmit(address(cm));
        emit ICoverManager.TriggerNoFill(id, block.number, limit);
    }

    // N-01: a stale short close no longer widens the first close of a later touch

    /// @notice SA2 scenario: a no-fill episode, recovery, then 1,000 blocks later a second touch where a third party
    /// sweeps the mainnet-depth bids and rests one bid a tick above the old widened floor. The first attempt of the
    /// new touch is held at R x (1 - A): no fill into the hunter's bid, trader untouched.
    function test_N01_staleShortBlock_doesNotWidenLaterTouch() public {
        _lp(lp, 10_000e6);
        _setMaxNotional(2000e6);
        (, bytes32 id) = _coveredLong(HUNT_LOTS, 12_000);
        _roll(200);

        // Episode 1: genuine touch, book thin under the stop. Keeper fast path: no fill, chain starts.
        _refs(STOP);
        _sweepBidsDownTo(STOP * 98 / 100 + 1);
        _trader(100_000e6).rest(Constants.ORDER_OPEN_LONG, BTC, STOP * 98 / 100, 50_000);
        vm.prank(keeper);
        assertEq(cm.trigger(id), 0);
        Cover memory c = cm.getCover(id);
        assertEq(uint8(c.status), uint8(CoverStatus.Live));
        assertEq(c.shortBlock, block.number);
        assertEq(c.shortSteps, 1);

        _roll(1000);
        _refs(M);

        // Episode 2, same block for the hunter: sweep, rest a bid at the old widened floor, trigger.
        _refs(STOP);
        _mainnetBidsUnder(STOP);
        PerplTrader hunter = _trader(20_000e6);
        hunter.ioc(Constants.ORDER_OPEN_SHORT, BTC, FLOOR + 1, 10_000);
        hunter.rest(Constants.ORDER_OPEN_LONG, BTC, FLOOR + 1, HUNT_LOTS);
        _expectNoFill(id, TIGHT);
        assertEq(cm.trigger(id), 0, "first attempt of the new touch is tight");
        assertEq(cm.getCover(id).filledLots, 0, "hunter's bid not filled");
        assertEq(cm.getCover(id).shortSteps, 1, "new chain, step 1 next block");
    }

    /// @notice N-04 residual after the fix: to reach the old floor a third party must keep every bid above it away
    /// for five consecutive blocks while the reference itself stays through the stop; each block widens by A x 2^k.
    function test_N04_steppedFloor_needsFiveBlocksOfEmptyBook() public {
        _lp(lp, 10_000e6);
        _setMaxNotional(2000e6);
        (, bytes32 id) = _coveredLong(HUNT_LOTS, 12_000);
        _roll(200);
        _refs(STOP);
        _sweepBidsDownTo(FLOOR + 1);
        _mainnetBidsUnder(STOP);
        PerplTrader hunter = _trader(20_000e6);
        hunter.ioc(Constants.ORDER_OPEN_SHORT, BTC, FLOOR + 1, 10_000);
        hunter.rest(Constants.ORDER_OPEN_LONG, BTC, FLOOR + 1, HUNT_LOTS);
        for (uint256 k; k < 5; ++k) {
            _expectNoFill(id, _stepLimit(k));
            cm.trigger(id);
            if (k == 0) {
                _expectNoFill(id, TIGHT); // a same-block retry keeps the step and the chain
                cm.trigger(id);
            }
            _roll(1);
            _refs(STOP);
        }
        assertEq(_stepLimit(5), FLOOR);
        uint256 paid = cm.trigger(id); // step 5: min(floorSlack, A x 32) = floorSlack
        assertEq(cm.getCover(id).filledLots, HUNT_LOTS);
        assertEq(paid, STOP * HUNT_LOTS * 5 / 10_000, "R == stop: A x SN");
    }

    /// @notice N-04 mitigation: a short attempt while the median reference is above the stop (only the mark, or only
    /// the book, through) does not start a chain, so the next block's first attempt with R through is tight.
    function test_N04_shortWithRefAboveStop_doesNotStartChain() public {
        _lp(lp, 10_000e6);
        (, bytes32 id) = _coveredLong(50, 12_000);
        _roll(200);
        ex.setMark(BTC, STOP); // fast path on the mark
        ex.setOracle(BTC, STOP + 500);
        feed.setAnswer(int256(STOP + 500) * 1e7); // median R above the stop
        _sweepBidsDownTo(STOP * 97 / 100);
        cm.trigger(id);
        assertEq(cm.getCover(id).shortBlock, 0, "R not through: no chain");
        _roll(1);
        _refs(STOP);
        _expectNoFill(id, TIGHT);
        cm.trigger(id);
    }

    /// @notice A chain older than STEP_MAX_GAP_BLOCKS is a different touch.
    function test_N01_chainExpiresAfterGap() public {
        _lp(lp, 10_000e6);
        (, bytes32 id) = _coveredLong(50, 12_000);
        _roll(200);
        _refs(STOP);
        _sweepBidsDownTo(STOP * 97 / 100);
        cm.trigger(id);
        _roll(Constants.STEP_MAX_GAP_BLOCKS);
        _refs(STOP);
        _expectNoFill(id, _stepLimit(1)); // within the gap: next step
        cm.trigger(id);
        _roll(Constants.STEP_MAX_GAP_BLOCKS + 1);
        _refs(STOP);
        _expectNoFill(id, TIGHT); // beyond the gap: tight again
        cm.trigger(id);
    }

    /// @notice Same root cause through the arm path: the chain set in the last armed block is cleared when the arm
    /// lapses, so the fast path one block later starts tight (the gap bound alone would have allowed step 1).
    function test_N01_armTtlLapse_clearsChain() public {
        _lp(lp, 10_000e6);
        (, bytes32 id) = _coveredLong(50, 12_000);
        _roll(200);
        _refs(STOP);
        _sweepBidsDownTo(STOP * 98 / 100 + 1);
        _refs(STOP);
        vm.prank(keeper);
        assertTrue(cm.arm(id));
        uint256 armed = block.number;
        _roll(Constants.ARM_TTL_BLOCKS); // last armed block
        _refs(STOP);
        vm.prank(keeper);
        cm.trigger(id);
        assertEq(cm.getCover(id).shortBlock, armed + Constants.ARM_TTL_BLOCKS);
        _roll(1); // lapsed
        _refs(STOP);
        vm.expectEmit(address(cm));
        emit ICoverManager.Disarmed(id, DisarmReason.ArmTtlElapsed);
        _expectNoFill(id, TIGHT);
        cm.trigger(id);
        assertEq(uint8(cm.getCover(id).status), uint8(CoverStatus.Live));
        assertEq(cm.getCover(id).shortSteps, 1, "fresh chain from the fast-path attempt");
    }

    /// @notice A lapsed arm with no fast path just disarms and clears the chain; no watchList entry keeps it alive.
    function test_N01_armTtlLapse_noFastPath_disarmsAndClears() public {
        _lp(lp, 10_000e6);
        (, bytes32 id) = _coveredLong(50, 12_000);
        _roll(200);
        _refs(STOP);
        _sweepBidsDownTo(STOP * 98 / 100 + 1);
        _refs(STOP);
        cm.arm(id);
        _roll(1);
        _refs(STOP);
        cm.trigger(id);
        assertGt(cm.getCover(id).shortBlock, 0);
        _roll(Constants.ARM_TTL_BLOCKS + 5);
        _refs(M);
        (bytes32[] memory toArm, bytes32[] memory toTrig) = cm.watchList(BTC, 16);
        assertEq(toArm.length + toTrig.length, 0);
        assertEq(cm.trigger(id), 0);
        assertEq(cm.getCover(id).shortBlock, 0);
        assertEq(uint8(cm.getCover(id).status), uint8(CoverStatus.Live));
    }

    /// @notice Control: the same episode 2 without episode 1 is held at R x (1 - A).
    function test_N01_control_withoutEarlierEpisode_tightFloorHolds() public {
        _lp(lp, 10_000e6);
        _setMaxNotional(2000e6);
        (, bytes32 id) = _coveredLong(HUNT_LOTS, 12_000);
        _roll(1200);
        _refs(STOP);
        _sweepBidsDownTo(M * 9900 / 10_000);
        _refs(STOP);
        _mainnetBidsUnder(STOP);
        PerplTrader hunter2 = _trader(20_000e6);
        hunter2.ioc(Constants.ORDER_OPEN_SHORT, BTC, FLOOR + 1, 10_000);
        hunter2.rest(Constants.ORDER_OPEN_LONG, BTC, FLOOR + 1, HUNT_LOTS);
        assertEq(cm.trigger(id), 0);
        assertEq(cm.getCover(id).filledLots, 0, "control: tight floor holds");
    }

    // N-02: refund at expiry is timing-, sigma- and param-independent

    /// @notice SA2 branches A to D now resolve identically: once expired, a never-armed cover gets its escrow back
    /// whoever calls, whenever, whatever the price, sigma or params; a post-expiry cancel is an expiry.
    function test_N02_expiryRefund_independentOfCallTimeInputs() public {
        _lp(lp, 10_000e6);
        (GaplessAccount a, bytes32 id) = _coveredLong(50, 1000);
        uint256 escrow = cm.getCover(id).escrowCNS;
        assertGt(escrow, 0);
        _roll(1001);
        _refs(M);
        uint256 snap = vm.snapshotState();
        uint256 w0 = ausd.balanceOf(address(a));

        cm.expire(id);
        assertEq(ausd.balanceOf(address(a)) - w0, escrow, "A: prompt expire refunds");

        vm.revertToState(snap);
        _roll(500);
        _refs(STOP * 10_005 / 10_000); // drift into the zone after expiry
        cm.expire(id);
        assertEq(ausd.balanceOf(address(a)) - w0, escrow, "B: late expire in the zone refunds");

        vm.revertToState(snap);
        vm.startPrank(keeper);
        cm.postSigma(BTC, 2000);
        vm.stopPrank();
        MarketParams memory p = cm.marketParams(BTC);
        p.minStopDistanceBps = 500;
        vm.prank(deployer);
        cm.setMarketParams(BTC, p);
        cm.expire(id);
        assertEq(ausd.balanceOf(address(a)) - w0, escrow, "C: sigma 2000 and min distance 500 change nothing");

        vm.revertToState(snap);
        _roll(500);
        _refs(STOP); // owner cancels at the stop after expiry: same outcome as expire
        vm.expectEmit(address(cm));
        emit ICoverManager.CoverEnded(id, CoverStatus.Expired, EndReason.Expired, escrow);
        vm.prank(owner);
        a.cancelCover(id);
        assertEq(uint8(cm.getCover(id).status), uint8(CoverStatus.Expired), "D: cancel after expiry is an expiry");
        assertEq(ausd.balanceOf(address(a)) - w0, escrow);
    }

    /// @notice An armed cover keeps forfeiting at expiry (05 2.5: it was in the zone), regardless of the caller.
    function test_N02_armedEver_forfeitsAtExpiry_viaCancelToo() public {
        _lp(lp, 10_000e6);
        (GaplessAccount a, bytes32 id) = _coveredLong(50, 1000);
        uint256 escrow = cm.getCover(id).escrowCNS;
        uint256 expiry = cm.getCover(id).expiryBlock;
        _roll(expiry - 10 - block.number);
        _refs(STOP);
        _sweepBidsDownTo(STOP * 98 / 100 + 1);
        _refs(STOP);
        cm.arm(id);
        _roll(11);
        _refs(M);
        assertFalse(cm.isLocked(address(a), BTC), "armed past expiry cannot trigger, so no lock");
        vm.expectEmit(address(cm));
        emit ICoverManager.EscrowForfeited(id, escrow);
        vm.prank(owner);
        a.cancelCover(id); // allowed past expiry even while the arm TTL runs
        assertEq(uint8(cm.getCover(id).status), uint8(CoverStatus.Expired));
    }

    /// @notice Before expiry the zone uses the purchase-time minDistance: a sigma post of 2,000 (minDistance 848 bps
    /// live) does not turn a cancel 45 bps from the stop into a forfeit.
    function test_N02_cancelBeforeExpiry_usesPurchaseMinDistance() public {
        _lp(lp, 10_000e6);
        (GaplessAccount a, bytes32 id) = _coveredLong(50, 12_000);
        uint256 escrow = cm.getCover(id).escrowCNS;
        assertEq(cm.getCover(id).minDistanceBps, 11);
        vm.prank(keeper);
        cm.postSigma(BTC, 2000);
        _refs(M);
        uint256 w0 = ausd.balanceOf(address(a));
        vm.prank(owner);
        a.cancelCover(id);
        assertEq(ausd.balanceOf(address(a)) - w0, escrow);
    }

    /// @notice N-08: a reverting Perpl view cannot brick cancel or expire; void reverts cleanly.
    function test_N08_perplViewRevert_endPathsDoNotBrick() public {
        _lp(lp, 10_000e6);
        (GaplessAccount a, bytes32 id) = _coveredLong(50, 12_000);
        uint256 escrow = cm.getCover(id).escrowCNS;
        uint256 snap = vm.snapshotState();
        _refs(M);
        vm.mockCallRevert(address(ex), abi.encodeWithSignature("getPerpetualInfo(uint256)", BTC), "halt");
        uint256 w0 = ausd.balanceOf(address(a));
        vm.prank(owner);
        a.cancelCover(id); // mark and oracle dropped; the fresh feed still proves distance
        assertEq(ausd.balanceOf(address(a)) - w0, escrow);
        vm.clearMockedCalls();

        vm.revertToState(snap);
        vm.mockCallRevert(address(ex), abi.encodeWithSignature("getPosition(uint256,uint256)"), "halt");
        vm.expectRevert(ICoverManager.VenueUnavailable.selector);
        cm.voidCover(id);
        vm.mockCallRevert(address(ex), abi.encodeWithSignature("getPerpetualInfo(uint256)", BTC), "halt");
        (,, bytes32[] memory toExpire,) = cm.housekeeping(BTC, 8);
        assertEq(toExpire.length, 0);
        vm.roll(cm.getCover(id).expiryBlock + 1);
        (,, toExpire,) = cm.housekeeping(BTC, 8);
        assertEq(toExpire.length, 1, "housekeeping still lists expiries");
        cm.voidCover(id); // past expiry: resolves as expire without reading Perpl
        assertEq(uint8(cm.getCover(id).status), uint8(CoverStatus.Expired));
    }

    // N-03: operator round trips bounded by the rolling budget

    /// @notice The SA2 colluder scenario with a 10 AUSD per-trade cap and a 40 AUSD daily budget: the operator
    /// runs out after two round trips; the drain is bounded by about 5% of the budget, and the budget refills
    /// linearly over a day.
    function test_N03_operatorRoundTrips_boundedByBudget() public {
        _refs(M);
        address op = makeAddr("operator");
        GaplessAccount a = _account(owner, 200e6, OperatorGrant(op, uint64(block.timestamp + 3 days), 10e6, 40e6));
        _sweepBidsDownTo(M * 95 / 100);
        _trader(200_000e6).ioc(Constants.ORDER_OPEN_LONG, BTC, M * 105 / 100, 600_000);
        _refs(M);
        PerplTrader colluder = _trader(50_000e6);
        uint256 bid = M * 9510 / 10_000;
        uint256 ask = M * 10_490 / 10_000;
        colluder.rest(Constants.ORDER_OPEN_LONG, BTC, bid, 100_000);
        colluder.rest(Constants.ORDER_OPEN_SHORT, BTC, ask, 100_000);
        uint256 lots = 10e6 / M;
        uint256 e0 = _perplBalance(a);
        uint256 trades;
        for (uint256 i; i < 20; ++i) {
            vm.prank(op);
            try a.trade(_order(Constants.ORDER_OPEN_SHORT, bid, lots)) {
                ++trades;
            } catch (bytes memory err) {
                assertEq(bytes4(err), IGaplessAccount.OperatorBudgetExceeded.selector);
                break;
            }
            vm.prank(op);
            a.trade(_order(Constants.ORDER_CLOSE_SHORT, ask, lots));
            ++trades;
        }
        assertEq(trades, 4, "two round trips fit in 40 AUSD");
        uint256 drained = e0 - _perplBalance(a);
        emit log_named_uint("drained within the daily budget, CNS", drained);
        assertLt(drained, 2e6, "about 5% of the 40 AUSD budget");
        (uint256 used, uint256 avail) = a.operatorUsage();
        assertEq(used + avail, 40e6);

        vm.warp(block.timestamp + 1 days);
        _refs(M);
        (used,) = a.operatorUsage();
        assertEq(used, 0, "refilled after a day");
        vm.prank(op);
        a.trade(_order(Constants.ORDER_OPEN_SHORT, bid, lots));
    }

    /// @notice Operator cover buys are charged their notional; the owner is never charged.
    function test_N03_operatorBuyCharged_ownerFree() public {
        _lp(lp, 10_000e6);
        _refs(M);
        address op = makeAddr("operator");
        GaplessAccount a = _account(owner, 400e6, OperatorGrant(op, uint64(block.timestamp + 1 days), 100e6, 30e6));
        _openLong(a, 50);
        CoverParams memory p = CoverParams(BTC, true, 40, STOP, 200, 12_000); // 34.3 AUSD > 30 budget
        vm.prank(op);
        vm.expectRevert(abi.encodeWithSelector(IGaplessAccount.OperatorBudgetExceeded.selector, 40 * STOP, 30e6));
        a.buyCover(p, 10e6);
        p.lots = 30;
        vm.prank(op);
        a.buyCover(p, 10e6);
        (uint256 used,) = a.operatorUsage();
        assertEq(used, 30 * STOP);
        vm.prank(owner);
        a.trade(_order(Constants.ORDER_OPEN_LONG, ASK * 101 / 100, 1)); // owner unaffected
        (uint256 used2,) = a.operatorUsage();
        assertEq(used2, used);
    }

    // CRE seen-set (N-06)

    /// @notice The replay key is the canonical encoding of the decoded content: trailing bytes no longer replay.
    function test_N06_creSeenSet_trailingBytesDoNotReplay() public {
        bytes32[] memory none = new bytes32[](0);
        bytes memory r = abi.encode(uint8(1), Constants.CHAIN_SELECTOR, uint64(block.timestamp), BTC, M, none, none);
        vm.recordLogs();
        vm.startPrank(Constants.CRE_FORWARDER_SIM);
        sink.onReport("", r);
        sink.onReport("", r);
        sink.onReport("", abi.encodePacked(r, bytes1(0)));
        sink.onReport("", abi.encodePacked(r, bytes32(0)));
        vm.stopPrank();
        Vm.Log[] memory logs = vm.getRecordedLogs();
        uint256 k;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].topics[0] == keccak256("CreReport(uint8,uint256,uint256,uint256,uint256)")) ++k;
        }
        assertEq(k, 1, "content processed once");
        assertTrue(sink.seen(keccak256(r)), "canonical bytes hash equals the key");
    }

    // Canary sizing (N-07, docs/CANARY_PARAMS.md)

    /// @notice Minimum totalAssets for a cover is ceil(10 x Cap x 1e4 / marketCapBps), Cap = floor(N x maxGap / 1e4).
    /// Checked at the boundary on the real stack for a ~20 AUSD cover (23 lots, Cap 394,616).
    function test_N07_canarySizing_boundary() public {
        assertEq(vault.totalAssets(), 3e6);
        _refs(M);
        GaplessAccount a = _account(owner, 100e6, _noGrant());
        _openLong(a, 23);
        CoverParams memory p = CoverParams(BTC, true, 23, STOP, 200, 12_000);
        uint256 cap = 23 * STOP * 200 / 10_000;
        assertEq(cap, 394_616);
        uint256 need = _minVault(cap, 5000);
        assertEq(need, 7_892_320);
        uint256 snap = vm.snapshotState();
        _lp(lp, need - 3e6 - 1);
        vm.expectRevert(abi.encodeWithSelector(ICoverManager.CoverShareExceeded.selector, cap, cap - 1));
        cm.quote(address(a), p);
        vm.revertToState(snap);
        _lp(lp, need - 3e6);
        Quote memory q = cm.quote(address(a), p);
        assertEq(q.capCNS, cap);
        emit log_named_uint("20 AUSD cover: rent CNS", q.rentCNS);
        emit log_named_uint("20 AUSD cover: escrow CNS", q.escrowCNS);

        // Canary marketCap 10,000 halves it: the 3 AUSD vault fits a ~7 AUSD cover with headroom.
        vm.revertToState(snap);
        MarketParams memory canary = new ListMarket().canaryParams(20e6, 10_000, 8);
        vm.prank(deployer);
        cm.setMarketParams(BTC, canary);
        assertEq(_minVault(cap, 10_000), 3_946_160);
        p.lots = 8;
        cm.quote(address(a), p);
        assertEq(_minVault(8 * STOP * 200 / 10_000, 10_000), 1_372_570);
        // 20 AUSD notional exactly: Cap 400,000, so 4 AUSD (canary) or 8 AUSD (default marketCap 5,000).
        assertEq(_minVault(400_000, 10_000), 4e6);
        assertEq(_minVault(400_000, 5000), 8e6);
        assertEq(_minVault(140_000, 10_000), 1.4e6);
        assertEq(_minVault(140_000, 5000), 2.8e6);
    }

    function _minVault(uint256 cap, uint256 marketCapBps) internal pure returns (uint256) {
        return (cap * 10 * 10_000 + marketCapBps - 1) / marketCapBps;
    }
}
