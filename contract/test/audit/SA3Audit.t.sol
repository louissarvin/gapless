// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {GaplessFixture} from "../utils/GaplessFixture.sol";
import {ListMarket} from "../../script/ListMarket.s.sol";
import {CoverManager} from "../../src/CoverManager.sol";
import {GaplessAccount} from "../../src/GaplessAccount.sol";
import {ICoverManager} from "../../src/interfaces/ICoverManager.sol";
import {IGaplessAccount} from "../../src/interfaces/IGaplessAccount.sol";
import {PerplTrader} from "../mocks/PerplTrader.sol";
import {Constants} from "../../src/Constants.sol";
import {
    CoverParams,
    Cover,
    CoverStatus,
    MarketConfig,
    MarketParams,
    OperatorGrant
} from "../../src/types/GaplessTypes.sol";

/// @title SA3 proofs of concept (after C5), inverted in C6 where the finding was fixed
/// @notice Real stack on the C0 mocks. Ids match contract/audit/SA3_REPORT.md; fixes in docs/C5_FIXES.md (C6).
contract SA3AuditTest is GaplessFixture {
    CoverManager internal cm;
    address internal owner = makeAddr("owner");
    address internal lp = makeAddr("lp");
    address internal griefer = makeAddr("griefer");

    uint256 internal constant M = BID;
    uint256 internal constant STOP = M * (10_000 - 45) / 10_000;
    uint256 internal constant TIGHT = STOP * 9995 / 10_000;

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
        _lp(lp, 10_000e6);
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

    function _trader(uint256 fund) internal returns (PerplTrader t) {
        t = new PerplTrader(ex, ausd);
        ausd.mint(address(t), fund);
        t.open(fund);
    }

    function _sweepBidsDownTo(uint256 px) internal {
        _trader(200_000e6).ioc(Constants.ORDER_OPEN_SHORT, BTC, px, 600_000);
    }

    function _coveredLong(uint256 lots, uint32 duration) internal returns (GaplessAccount a, bytes32 id) {
        _refs(M);
        a = _account(owner, 400e6, _noGrant());
        _openLong(a, lots);
        vm.prank(owner);
        id = a.buyCover(CoverParams(BTC, true, lots, STOP, 200, duration), 10e6);
    }

    function _expectNoFill(bytes32 id, uint256 limit) internal {
        vm.expectEmit(address(cm));
        emit ICoverManager.TriggerNoFill(id, block.number, limit);
    }

    // SA3-01 (fixed in C6): arm rejects the expiry block, and the fast path runs in the arm block.

    function test_SA3_01_armInExpiryBlock_rejected_fastPathPays() public {
        (GaplessAccount a, bytes32 id) = _coveredLong(50, 1000);
        Cover memory c0 = cm.getCover(id);
        _roll(c0.expiryBlock - block.number); // block == expiryBlock: cover still in force
        uint256 r = STOP * 9970 / 10_000; // genuine touch, 30 bps through the stop
        _refs(r);
        _sweepBidsDownTo(r + 1);
        _trader(100_000e6).rest(Constants.ORDER_OPEN_LONG, BTC, r, 1000); // honest depth at R

        vm.prank(griefer);
        vm.expectRevert(abi.encodeWithSelector(ICoverManager.CoverExpired.selector, c0.expiryBlock));
        cm.arm(id);
        vm.prank(keeper);
        uint256 paid = cm.trigger(id);
        emit log_named_uint("payout CNS", paid);
        assertGt(paid, 0, "touch paid");
        assertEq(cm.getCover(id).filledLots, 50);
        assertEq(_position(a).lotLNS, 0);
    }

    /// @notice An arm one block before expiry still works, and a third-party arm no longer blocks the fast path
    /// in its own block.
    function test_SA3_01_fastPathRunsInArmBlock() public {
        (, bytes32 id) = _coveredLong(50, 1000);
        Cover memory c0 = cm.getCover(id);
        _roll(c0.expiryBlock - 1 - block.number);
        uint256 r = STOP * 9970 / 10_000;
        _refs(r);
        _sweepBidsDownTo(r + 1);
        _trader(100_000e6).rest(Constants.ORDER_OPEN_LONG, BTC, r, 1000);
        vm.prank(griefer);
        assertTrue(cm.arm(id));
        (, bytes32[] memory toTrigger) = cm.watchList(BTC, 8);
        assertEq(toTrigger.length, 1, "armed in this block with the mark through: fast path listed");
        vm.prank(keeper);
        assertGt(cm.trigger(id), 0);
        assertEq(cm.getCover(id).filledLots, 50);
    }

    /// @notice Off the fast path the arm block still waits one block, and an arm at expiry - 1 can fire at expiry.
    function test_SA3_01_slowPathArmBeforeExpiry_firesInExpiryBlock() public {
        (, bytes32 id) = _coveredLong(50, 1000);
        Cover memory c0 = cm.getCover(id);
        _roll(c0.expiryBlock - 1 - block.number);
        uint256 r = STOP * 9970 / 10_000;
        _refs(r);
        _sweepBidsDownTo(r + 1);
        _trader(100_000e6).rest(Constants.ORDER_OPEN_LONG, BTC, r, 1000);
        ex.setMark(BTC, M); // mark lags above the stop: no fast path
        vm.prank(griefer);
        assertTrue(cm.arm(id));
        (, bytes32[] memory toTrigger) = cm.watchList(BTC, 8);
        assertEq(toTrigger.length, 0);
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(ICoverManager.TooEarly.selector, block.number + 1));
        cm.trigger(id);
        _roll(1);
        _refs(r);
        ex.setMark(BTC, M);
        vm.prank(keeper); // the armer's window never reaches the expiry block (L-02)
        assertGt(cm.trigger(id), 0);
    }

    /// @notice watchList no longer proposes an arm in the expiry block; the never-armed cover keeps its refund.
    function test_SA3_01b_watchListSkipsArmInExpiryBlock() public {
        (GaplessAccount a, bytes32 id) = _coveredLong(50, 1000);
        Cover memory c0 = cm.getCover(id);
        _roll(c0.expiryBlock - 1 - block.number);
        uint256 r = STOP * 9970 / 10_000;
        _refs(r);
        _sweepBidsDownTo(r + 1);
        ex.setMark(BTC, M); // mark lags above the stop: no fast path
        (bytes32[] memory toArm,) = cm.watchList(BTC, 8);
        assertEq(toArm.length, 1, "expiry - 1: still an arm candidate");
        _roll(1);
        _refs(r);
        ex.setMark(BTC, M);
        (bytes32[] memory toArm2, bytes32[] memory toTrig2) = cm.watchList(BTC, 8);
        assertEq(toArm2.length + toTrig2.length, 0, "expiry block: no arm candidate");
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(ICoverManager.CoverExpired.selector, c0.expiryBlock));
        cm.arm(id);
        _roll(1);
        uint256 w0 = ausd.balanceOf(address(a));
        cm.expire(id);
        assertEq(ausd.balanceOf(address(a)), w0 + c0.escrowCNS, "never armed: escrow refunded");
    }

    // SA3-02: "short" counts match-limited attempts, so 1-lot dust at the top of the book walks the chain to
    // floorSlack while honest depth above every step floor stays untouched; one atomic sweep at step 5 cashes it.

    uint256 internal constant HUNT_LOTS = 2331; // ~2,000 AUSD at the stop (spec cap)
    uint256 internal constant FLOOR = STOP * 9900 / 10_000;

    function _mainnetBidsUnder(uint256 fair) internal {
        PerplTrader mm = _trader(100_000e6);
        uint16[6] memory bps = [uint16(3), 6, 23, 43, 64, 71];
        uint256[6] memory lots = [uint256(6022), 1780, 163, 163, 164, 29];
        for (uint256 i; i < 6; ++i) {
            mm.rest(Constants.ORDER_OPEN_LONG, BTC, fair * (10_000 - bps[i]) / 10_000, lots[i]);
        }
    }

    function _bigCoverAtTouch() internal returns (GaplessAccount a, bytes32 id) {
        MarketParams memory p = cm.marketParams(BTC);
        p.maxCoverNotionalCNS = 2000e6;
        vm.prank(deployer);
        cm.setMarketParams(BTC, p);
        (a, id) = _coveredLong(HUNT_LOTS, 12_000);
        _roll(200);
        _refs(STOP);
        _sweepBidsDownTo(M * 9900 / 10_000);
        _refs(STOP);
        _mainnetBidsUnder(STOP); // honest: 6,022 lots 3 bps under R, more below
    }

    /// @notice SA3-02 (fixed in C6): dust that only uses up maxMatches no longer steps the chain; the hunter is
    /// back to the N-04 premise (keep the book empty above each step floor for k blocks).
    function test_SA3_02_dustDoesNotWalkChain() public {
        (, bytes32 id) = _bigCoverAtTouch();
        PerplTrader duster = _trader(10_000e6);
        for (uint256 k; k < 5; ++k) {
            for (uint256 j; j < 16; ++j) {
                duster.rest(Constants.ORDER_OPEN_LONG, BTC, STOP, 1); // 16 one-lot bids at the top
            }
            vm.prank(keeper);
            cm.trigger(id); // 16 lots at R; honest bids remain at or above the limit
            assertEq(cm.getCover(id).shortSteps, 0, "match-limited attempt does not step");
            assertEq(cm.getCover(id).shortBlock, 0);
            _roll(1);
            _refs(STOP);
        }
        uint256 left = HUNT_LOTS - cm.getCover(id).filledLots;
        assertEq(left, HUNT_LOTS - 80);

        // The atomic sweep now meets the step-0 floor R x (1 - A): nothing fills under it.
        PerplTrader hunter = _trader(20_000e6);
        hunter.ioc(Constants.ORDER_OPEN_SHORT, BTC, FLOOR + 1, 10_000);
        hunter.rest(Constants.ORDER_OPEN_LONG, BTC, FLOOR + 1, left);
        _expectNoFill(id, TIGHT);
        cm.trigger(id);
        assertEq(cm.getCover(id).filledLots, 80, "no fill under R x (1 - A)");
        assertEq(cm.getCover(id).shortSteps, 1, "a genuinely thin book still steps");
    }

    /// @notice A match-limited attempt keeps a running chain's step; C7 (SE2-H1) times the next gap from it.
    function test_SA3_02_matchLimited_holdsStep_gapFromHold() public {
        (, bytes32 id) = _coveredLong(50, 12_000);
        _roll(200);
        _refs(STOP);
        _sweepBidsDownTo(STOP * 97 / 100);
        cm.trigger(id); // step 0, thin book
        _roll(1);
        _refs(STOP);
        cm.trigger(id); // step 1, thin book
        assertEq(cm.getCover(id).shortSteps, 2);

        _roll(1);
        _refs(STOP);
        PerplTrader duster = _trader(10_000e6);
        for (uint256 j; j < 17; ++j) {
            duster.rest(Constants.ORDER_OPEN_LONG, BTC, STOP, 1);
        }
        cm.trigger(id); // step 2: 16 dust lots, then maxMatches; a 17th dust lot stays at or above the limit
        uint256 held = block.number;
        assertEq(cm.getCover(id).filledLots, 16);
        assertEq(cm.getCover(id).shortSteps, 2, "step kept");
        assertEq(cm.getCover(id).shortBlock, held, "gap restarts at the held attempt");

        _roll(Constants.STEP_MAX_GAP_BLOCKS); // 12 blocks after the last thin attempt, 10 after the hold
        _refs(STOP);
        _trader(100_000e6).rest(Constants.ORDER_OPEN_LONG, BTC, STOP * 9990 / 10_000, 100); // above the step-2 floor
        cm.trigger(id); // still step 2: fills from the honest bid
        assertEq(cm.getCover(id).filledLots, 50);
        assertEq(cm.getCover(id).shortBlock, 0, "full fill ends the chain");
    }

    /// @notice SA3-I1 (fixed with SA3-01): a third-party arm mid-touch still resets the chain (trader-favorable),
    /// but no longer costs the fast path its block.
    function test_SA3_I1_armMidTouch_resetsChain_fastPathSameBlock() public {
        (, bytes32 id) = _coveredLong(50, 12_000);
        _roll(200);
        _refs(STOP);
        _sweepBidsDownTo(STOP * 97 / 100);
        vm.prank(keeper);
        cm.trigger(id);
        _roll(1);
        _refs(STOP);
        vm.prank(keeper);
        cm.trigger(id);
        assertEq(cm.getCover(id).shortSteps, 2);

        _roll(1);
        _refs(STOP);
        vm.prank(griefer);
        assertTrue(cm.arm(id));
        assertEq(cm.getCover(id).shortBlock, 0, "arm reset the chain");
        _expectNoFill(id, TIGHT); // same block, fast path, step 0 again
        vm.prank(keeper);
        cm.trigger(id);
        assertEq(cm.getCover(id).shortSteps, 1);
    }

    /// @notice One step per block whoever calls and however often: direct calls plus the CRE sink with the same id
    /// three times in one report.
    function test_SA3_I2_chain_oneStepPerBlock_viaSinkAndDirect() public {
        (, bytes32 id) = _coveredLong(50, 12_000);
        _roll(200);
        _refs(STOP);
        _sweepBidsDownTo(STOP * 97 / 100);
        bytes32[] memory none = new bytes32[](0);
        bytes32[] memory ids = new bytes32[](3);
        (ids[0], ids[1], ids[2]) = (id, id, id);
        for (uint256 b = 1; b <= 3; ++b) {
            cm.trigger(id);
            vm.prank(Constants.CRE_FORWARDER_SIM);
            sink.onReport(
                "", abi.encode(uint8(2), Constants.CHAIN_SELECTOR, uint64(block.timestamp), BTC, STOP, none, ids)
            );
            vm.prank(griefer);
            cm.trigger(id);
            assertEq(cm.getCover(id).shortSteps, b, "one step per block");
            _roll(1);
            _refs(STOP);
        }
    }

    /// @notice Capped chain: the attempt at k = 6 uses floorSlack, a same-block retry falls back to k = 5
    /// (shortSteps is stored capped at 6, and the retry reads shortSteps - 1). Trader-favorable inconsistency.
    function test_SA3_I3_cappedChain_sameBlockRetryDropsOneStep() public {
        MarketParams memory p = cm.marketParams(BTC);
        p.floorSlackBps = 300;
        vm.prank(deployer);
        cm.setMarketParams(BTC, p);
        (, bytes32 id) = _coveredLong(50, 12_000);
        _roll(200);
        _refs(STOP);
        _sweepBidsDownTo(STOP * 95 / 100);
        for (uint256 k; k < 6; ++k) {
            cm.trigger(id);
            _roll(1);
            _refs(STOP);
        }
        assertEq(cm.getCover(id).shortSteps, 6);
        _expectNoFill(id, STOP * (10_000 - 300) / 10_000); // k = 6: min(300, 5 x 64)
        cm.trigger(id);
        _expectNoFill(id, STOP * (10_000 - 160) / 10_000); // same block retry: k = 5
        cm.trigger(id);
    }

    /// @notice SA3-I4 (fixed in C6): a grant change checkpoints the bucket at the outgoing rate, so the new cap
    /// neither re-charges nor refills the time already elapsed.
    function test_SA3_I4_grantChangeCheckpointsDecay() public {
        _refs(M);
        address op = makeAddr("operator");
        GaplessAccount a = _account(owner, 400e6, OperatorGrant(op, uint64(block.timestamp + 7 days), 500e6, 100e6));
        vm.prank(op);
        a.trade(_order(Constants.ORDER_OPEN_LONG, ASK, 100)); // 86.175 AUSD charged
        vm.warp(block.timestamp + 12 hours);
        (uint256 usedOld,) = a.operatorUsage();
        assertEq(usedOld, 100 * ASK - 50e6);
        uint256 snap = vm.snapshotState();

        // Lower cap: no re-charge of the 12 h, the rest decays at 20 per day from now.
        address op2 = makeAddr("operator2");
        vm.prank(owner);
        a.setOperator(OperatorGrant(op2, uint64(block.timestamp + 7 days), 500e6, 20e6));
        (uint256 usedNew, uint256 availNew) = a.operatorUsage();
        assertEq(usedNew, usedOld, "no retroactive re-charge");
        assertEq(availNew, 0);
        vm.warp(block.timestamp + 1 days);
        _refs(M);
        (usedNew, availNew) = a.operatorUsage();
        assertEq(usedNew, usedOld - 20e6);
        vm.prank(op2);
        a.trade(_order(Constants.ORDER_OPEN_LONG, ASK, 1)); // fits after one day, not 3.3

        // Higher cap: no retroactive refill either.
        vm.revertToState(snap);
        vm.prank(owner);
        a.setOperator(OperatorGrant(op2, uint64(block.timestamp + 7 days), 500e6, 200e6));
        (usedNew,) = a.operatorUsage();
        assertEq(usedNew, usedOld, "no retroactive refill");
    }

    /// @notice SA3-I5 (kept by design, documented in GaplessAccount.cancelCover): an operator with a zero budget can
    /// still cancel covers; nothing leaves the account.
    function test_SA3_I5_zeroBudgetOperatorCanStillCancelCover() public {
        _refs(M);
        address op = makeAddr("operator");
        GaplessAccount a = _account(owner, 400e6, OperatorGrant(op, uint64(block.timestamp + 1 days), 0, 0));
        _openLong(a, 50);
        vm.prank(owner);
        bytes32 id = a.buyCover(CoverParams(BTC, true, 50, STOP, 200, 12_000), 10e6);
        vm.prank(op);
        a.cancelCover(id);
        assertEq(uint8(cm.getCover(id).status), uint8(CoverStatus.Cancelled));
    }
}
