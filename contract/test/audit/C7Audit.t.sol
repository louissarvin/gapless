// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {GaplessFixture} from "../utils/GaplessFixture.sol";
import {ListMarket} from "../../script/ListMarket.s.sol";
import {CoverManager} from "../../src/CoverManager.sol";
import {GaplessAccount} from "../../src/GaplessAccount.sol";
import {ICoverManager} from "../../src/interfaces/ICoverManager.sol";
import {PerplTrader} from "../mocks/PerplTrader.sol";
import {Constants} from "../../src/Constants.sol";
import {
    CoverParams,
    Cover,
    CoverStatus,
    DisarmReason,
    MarketConfig,
    MarketParams
} from "../../src/types/GaplessTypes.sol";

/// @title C7 regressions for SE2-H1 (keeper cadence) and the hunter checks after the wider step gap
/// @notice Real stack on the C0 mocks. SE2 scenario from memory/security_audit_backend_se2_2026-10-06.md: armed long,
/// 22 lots, stop 860,000, R 859,000, bids only at 851,000 (fills at step 5). C7 rules: STEP_MAX_GAP_BLOCKS = 10,
/// measured from the touch's most recent attempt; a match-limited attempt keeps its step and restarts the gap.
contract C7AuditTest is GaplessFixture {
    CoverManager internal cm;
    address internal owner = makeAddr("owner");
    address internal lp = makeAddr("lp");
    address internal griefer = makeAddr("griefer");

    uint256 internal constant M = BID;
    uint256 internal constant GAP = Constants.STEP_MAX_GAP_BLOCKS;

    // SE2 scenario
    uint256 internal constant S_STOP = 860_000;
    uint256 internal constant S_REF = 859_000;
    uint256 internal constant S_BOOK = 851_000; // under the step-4 limit 852,128, over the step-5 limit 850,410
    uint256 internal constant S_LOTS = 22;
    uint256 internal constant S_TIGHT = S_REF * 9995 / 10_000;

    // SA1/SA2/SA3 hunt scenario
    uint256 internal constant STOP = M * (10_000 - 45) / 10_000; // 857,862
    uint256 internal constant TIGHT = STOP * 9995 / 10_000;
    uint256 internal constant FLOOR = STOP * 9900 / 10_000;
    uint256 internal constant HUNT_LOTS = 2331;

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

    function _sweepBidsDownTo(uint256 px) internal {
        _trader(200_000e6).ioc(Constants.ORDER_OPEN_SHORT, BTC, px, 600_000);
    }

    function _expectNoFill(bytes32 id, uint256 limit) internal {
        vm.expectEmit(address(cm));
        emit ICoverManager.TriggerNoFill(id, block.number, limit);
    }

    /// @dev Spec step limit for a long at R through the stop (A 5, floorSlack 100).
    function _limit(uint256 stop, uint256 ref, uint256 k) internal pure returns (uint256) {
        if (k == 0) return ref * 9995 / 10_000;
        uint256 allow = 5 << k;
        if (allow > 100) allow = 100;
        return (ref < stop ? ref : stop) * (10_000 - allow) / 10_000;
    }

    /// @dev Perpl equity of a test trader marked at `px` (balance + locked + deposit + funding + uPnL).
    function _equityAt(PerplTrader t, uint256 px) internal view returns (int256 e) {
        PerplTrader.Snap memory s = t.snap(BTC);
        e = int256(s.balance + s.locked + s.deposit) + s.premium;
        if (s.lots > 0) {
            int256 diff = (int256(px) - int256(s.entryPNS)) * int256(s.lots);
            e += s.positionType == 0 ? diff : -diff;
        }
    }

    // SE2 scenario

    /// @dev Covered long, warm-up passed, R through the stop, bids only at S_BOOK, armed by the keeper.
    function _se2Armed(bool oneLotBids) internal returns (GaplessAccount a, bytes32 id) {
        _refs(M);
        a = _account(owner, 400e6, _noGrant());
        _openLong(a, S_LOTS);
        vm.prank(owner);
        id = a.buyCover(CoverParams(BTC, true, S_LOTS, S_STOP, 200, 12_000), 10e6);
        _roll(200);
        _refs(S_REF);
        _sweepBidsDownTo(S_BOOK + 1);
        _refs(S_REF);
        PerplTrader mm = _trader(100_000e6);
        if (oneLotBids) {
            for (uint256 j; j < 30; ++j) {
                mm.rest(Constants.ORDER_OPEN_LONG, BTC, S_BOOK, 1);
            }
        } else {
            mm.rest(Constants.ORDER_OPEN_LONG, BTC, S_BOOK, 100);
        }
        vm.prank(keeper);
        assertTrue(cm.arm(id));
    }

    /// @dev One keeper landing `d` blocks after the previous one.
    function _land(bytes32 id, uint256 d) internal {
        _roll(d);
        _refs(S_REF);
        vm.prank(keeper);
        cm.trigger(id);
    }

    /// @notice SE2-H1: landings 4 to 10 blocks apart walk steps 0 to 5 and close the cover at step 5 (C6 needed <= 3).
    function test_SE2H1_walk_landingsUpToGapApart_closes() public {
        (GaplessAccount a, bytes32 id) = _se2Armed(false);
        uint256 snap = vm.snapshotState();
        for (uint256 d = 4; d <= GAP; ++d) {
            vm.revertToState(snap);
            for (uint256 k; k < 5; ++k) {
                _roll(d);
                _refs(S_REF);
                _expectNoFill(id, _limit(S_STOP, S_REF, k));
                vm.prank(keeper);
                cm.trigger(id);
                assertEq(cm.getCover(id).shortSteps, k + 1, "one step per landing");
            }
            _land(id, d); // step 5: 850,410 <= 851,000
            Cover memory c = cm.getCover(id);
            assertEq(c.filledLots, S_LOTS, "walk finished");
            assertEq(uint8(c.status), uint8(CoverStatus.Triggered));
            assertEq(c.shortBlock, 0, "full fill ends the chain");
            assertEq(_position(a).lotLNS, 0);
            _roll(c.windowBlocks + 1);
            _refs(S_REF);
            cm.finalize(id);
            assertEq(uint8(cm.getCover(id).status), uint8(CoverStatus.Finalized), "cover closed");
        }
    }

    /// @notice SE2-H1: landings 11 or more blocks apart are separate touches; every attempt runs at step 0.
    function test_SE2H1_walk_beyondGap_resets() public {
        (, bytes32 id) = _se2Armed(false);
        uint256 snap = vm.snapshotState();
        for (uint256 d = GAP + 1; d <= GAP + 2; ++d) {
            vm.revertToState(snap);
            for (uint256 k; k < 7; ++k) {
                _roll(d);
                _refs(S_REF);
                _expectNoFill(id, S_TIGHT);
                vm.prank(keeper);
                cm.trigger(id);
                assertEq(cm.getCover(id).shortSteps, 1, "chain restarts at every landing");
            }
            assertEq(cm.getCover(id).filledLots, 0);
        }
    }

    /// @notice SE2-H1 remainder (C6 case): 30 one-lot bids at 851,000. The step-5 attempt fills 16 (maxMatches,
    /// depth left), holds step 5 and restarts the gap; a remainder 1 to 10 blocks later fills the last 6 at step 5.
    function test_SE2H1_remainder16OneLotBids_closes() public {
        (GaplessAccount a, bytes32 id) = _se2Armed(true);
        uint256 snap = vm.snapshotState();
        for (uint256 d = 1; d <= GAP; ++d) {
            vm.revertToState(snap);
            for (uint256 k; k < 5; ++k) {
                _land(id, d);
            }
            _land(id, d);
            Cover memory c = cm.getCover(id);
            assertEq(c.filledLots, 16, "match-limited partial");
            assertEq(c.shortBlock, block.number, "gap timed from the partial");
            assertEq(c.shortSteps, 5, "step held");
            _land(id, d);
            assertEq(cm.getCover(id).filledLots, S_LOTS, "remainder closes at step 5");
            assertEq(_position(a).lotLNS, 0);
        }
    }

    /// @notice The remainder 11 blocks after the partial is a new chain: step 0 at R_trig x (1 - A) finds nothing.
    function test_SE2H1_remainder_beyondGap_resetsToTight() public {
        (, bytes32 id) = _se2Armed(true);
        for (uint256 k; k < 6; ++k) {
            _land(id, 8);
        }
        assertEq(cm.getCover(id).filledLots, 16);
        _roll(GAP + 1);
        _refs(S_REF);
        _expectNoFill(id, S_TIGHT);
        cm.trigger(id);
        assertEq(cm.getCover(id).shortSteps, 1);
    }

    /// @notice A same-block retry after a hold keeps the held step (not one below).
    function test_C7_sameBlockRetryAfterHold_keepsStep() public {
        (, bytes32 id) = _se2Armed(true);
        for (uint256 k; k < 6; ++k) {
            _land(id, 3);
        }
        assertEq(cm.getCover(id).filledLots, 16);
        vm.prank(griefer);
        cm.trigger(id); // same block: step 5 again, fills the remaining 6 from the 14 one-lot bids
        assertEq(cm.getCover(id).filledLots, S_LOTS);
    }

    /// @notice Hold, then a thin retry in the same block: the chain advances once (one step per block), and a third
    /// attempt in that block still uses the block's step.
    function test_C7_holdThenThinSameBlock_advancesOnce() public {
        (, bytes32 id) = _se2Armed(true);
        for (uint256 k; k < 6; ++k) {
            _land(id, 3);
        }
        assertEq(cm.getCover(id).shortSteps, 5);
        _sweepBidsDownTo(S_BOOK); // the 14 one-lot bids left at 851,000 go
        _refs(S_REF);
        uint256 step5 = _limit(S_STOP, S_REF, 5);
        _expectNoFill(id, step5);
        cm.trigger(id);
        assertEq(cm.getCover(id).shortSteps, 6, "thin after the hold: advances");
        assertEq(cm.getCover(id).shortBlock, block.number);
        _expectNoFill(id, step5);
        cm.trigger(id);
        assertEq(cm.getCover(id).shortSteps, 6, "one step per block");
    }

    /// @notice Hold, then the chain ends and restarts in the same block: the restarted chain does not inherit the hold.
    function test_C7_holdThenResetThenRestartSameBlock_noInheritance() public {
        (, bytes32 id) = _se2Armed(true);
        for (uint256 k; k < 6; ++k) {
            _land(id, 3);
        }
        uint256 above = S_STOP * 10_010 / 10_000;
        _refs(above); // R above the stop: the remainder attempt is not through, the chain ends
        cm.trigger(id);
        assertEq(cm.getCover(id).shortBlock, 0);
        _sweepBidsDownTo(S_BOOK);
        _refs(S_REF);
        _expectNoFill(id, S_TIGHT); // step 0, thin: a new chain starts in this block
        cm.trigger(id);
        assertEq(cm.getCover(id).shortSteps, 1);
        _expectNoFill(id, S_TIGHT); // same block: step 0, not the held step
        cm.trigger(id);
    }

    // Hunter checks with the wider gap (SA1 H-01, SA2 N-01/N-04, SA3-02)

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

    /// @dev Widest remainder window (200 blocks), so many 10-block attempts fit after the first fill.
    function _setMaxWindow() internal {
        MarketParams memory p = cm.marketParams(BTC);
        p.windowBlocks = 200;
        p.maxDurationBlocks = 40_000; // keeps maxDuration + window + armTtl <= COOLDOWN_BLOCKS
        vm.prank(deployer);
        cm.setMarketParams(BTC, p);
    }

    /// @dev Spec-size covered long past warm-up; references at the stop; mainnet-shaped honest bids under R.
    function _bigCoverAtTouch() internal returns (GaplessAccount a, bytes32 id) {
        _setMaxNotional(2000e6);
        _refs(M);
        a = _account(owner, 400e6, _noGrant());
        _openLong(a, HUNT_LOTS);
        vm.prank(owner);
        id = a.buyCover(CoverParams(BTC, true, HUNT_LOTS, STOP, 200, 12_000), 10e6);
        _roll(200);
        _refs(STOP);
        _sweepBidsDownTo(M * 9900 / 10_000);
        _refs(STOP);
        _mainnetBidsUnder(STOP);
    }

    /// @dev The hunter sells into every bid above the floor and rests the whole cover one tick above it.
    function _hunterSweep() internal returns (PerplTrader h, int256 base) {
        h = _trader(20_000e6);
        base = _equityAt(h, STOP);
        h.ioc(Constants.ORDER_OPEN_SHORT, BTC, FLOOR + 1, 10_000);
        h.rest(Constants.ORDER_OPEN_LONG, BTC, FLOOR + 1, HUNT_LOTS);
    }

    /// @dev N-04 walk with `d` blocks between attempts: five no-fill steps, then the floor. Returns hunter PnL at R.
    function _n04Walk(uint256 d) internal returns (int256 pnl, uint256 paid) {
        (, bytes32 id) = _bigCoverAtTouch();
        (PerplTrader h, int256 base) = _hunterSweep();
        for (uint256 k; k < 5; ++k) {
            _expectNoFill(id, _limit(STOP, STOP, k));
            cm.trigger(id);
            _roll(d);
            _refs(STOP);
        }
        paid = cm.trigger(id);
        assertEq(cm.getCover(id).filledLots, HUNT_LOTS, "fills at the floor after five thin attempts");
        pnl = _equityAt(h, STOP) - base;
    }

    /// @notice N-04 residual is the same at 1 and at 10 blocks between attempts: the hunter still needs the book empty
    /// above each step's limit at five attempts with R through; only the time between them grows (about 3 s each).
    function test_C7_hunt_N04_gap10_sameEconomicsAsGap1() public {
        uint256 snap = vm.snapshotState();
        (int256 pnl1, uint256 paid1) = _n04Walk(1);
        vm.revertToState(snap);
        (int256 pnl10, uint256 paid10) = _n04Walk(GAP);
        emit log_named_int("SA2 N-04 hunter PnL at R, attempts 1 block apart (CNS)", pnl1);
        emit log_named_int("SA2 N-04 hunter PnL at R, attempts 10 blocks apart (CNS)", pnl10);
        emit log_named_uint("trader shortfall vs R x (1 - A) (CNS)", (TIGHT - FLOOR - 1) * HUNT_LOTS);
        assertEq(pnl10, pnl1, "gap does not change the hunt");
        assertEq(paid10, paid1);
        assertEq(paid10, STOP * HUNT_LOTS * 5 / 10_000, "vault still pays A x SN at most");
    }

    /// @notice Forcing the widest floor needs R through the stop at every attempt of the walk: an attempt while R is
    /// back above the stop (armed cover, book still crossed) ends the chain, whoever calls.
    function test_C7_hunt_refAboveStopAtAnyAttempt_resetsWalk() public {
        (, bytes32 id) = _bigCoverAtTouch();
        _hunterSweep();
        vm.prank(keeper);
        assertTrue(cm.arm(id));
        uint256 snap = vm.snapshotState();
        for (uint256 j = 1; j < 5; ++j) {
            vm.revertToState(snap);
            for (uint256 k; k < j; ++k) {
                _roll(GAP);
                _refs(STOP);
                vm.prank(keeper);
                cm.trigger(id);
            }
            assertEq(cm.getCover(id).shortSteps, j);
            _roll(GAP);
            uint256 above = STOP * 10_010 / 10_000; // within refTol, so the armed re-check closes at step 0
            _refs(above);
            _expectNoFill(id, above * 9995 / 10_000);
            vm.prank(griefer);
            cm.trigger(id);
            assertEq(cm.getCover(id).shortBlock, 0, "R above the stop ends the chain");
            _roll(1);
            _refs(STOP);
            _expectNoFill(id, TIGHT); // back through: step 0 again
            vm.prank(keeper);
            cm.trigger(id);
            assertEq(cm.getCover(id).filledLots, 0, "hunter bid untouched");
        }
    }

    /// @notice A recovery that uncrosses the book lets anyone end the chain with one call (disarm); the chain cannot
    /// be carried across a recovery that a keeper or the trader observes.
    function test_C7_hunt_recoveryDisarmResetsChain() public {
        (, bytes32 id) = _bigCoverAtTouch();
        _hunterSweep();
        vm.prank(keeper);
        assertTrue(cm.arm(id));
        for (uint256 k; k < 3; ++k) {
            _roll(GAP);
            _refs(STOP);
            vm.prank(keeper);
            cm.trigger(id);
        }
        assertEq(cm.getCover(id).shortSteps, 3);
        _roll(1);
        _refs(M);
        _trader(100_000e6).rest(Constants.ORDER_OPEN_LONG, BTC, STOP + 100, 10); // bids back above the stop
        vm.expectEmit(address(cm));
        emit ICoverManager.Disarmed(id, DisarmReason.ConditionGone);
        vm.prank(griefer);
        cm.trigger(id);
        assertEq(cm.getCover(id).shortBlock, 0);
    }

    /// @notice Holds keep a chain alive but never widen it: dust every 10 blocks for 100 blocks leaves the chain at
    /// step 2, the hunter's bid at the floor is never reached, and an 11-block pause still ends the chain.
    function test_C7_hunt_dustHoldsNeverWiden() public {
        _setMaxWindow();
        (, bytes32 id) = _bigCoverAtTouch();
        (PerplTrader h, int256 base) = _hunterSweep();
        uint256 hunterLots = h.snap(BTC).lots; // short from the sweep
        cm.trigger(id); // step 0, thin
        _roll(GAP);
        _refs(STOP);
        cm.trigger(id); // step 1, thin
        assertEq(cm.getCover(id).shortSteps, 2);
        PerplTrader duster = _trader(10_000e6);
        for (uint256 r; r < 10; ++r) {
            _roll(GAP);
            _refs(STOP);
            for (uint256 j; j < 17; ++j) {
                duster.rest(Constants.ORDER_OPEN_LONG, BTC, STOP, 1);
            }
            cm.trigger(id);
            Cover memory c = cm.getCover(id);
            assertEq(c.shortSteps, 2, "a hold never widens");
            assertEq(c.shortBlock, block.number);
            assertEq(c.filledLots, 16 * (r + 1), "dust only, at the stop");
        }
        assertEq(h.snap(BTC).lots, hunterLots, "hunter bid at the floor untouched");
        _roll(GAP + 1);
        _refs(STOP);
        _sweepBidsDownTo(FLOOR + 2); // dust leftovers gone, hunter bid stays
        _expectNoFill(id, TIGHT);
        cm.trigger(id);
        emit log_named_int("SA3-02 dust holds: hunter PnL at R (CNS)", _equityAt(h, STOP) - base);
        assertLe(_equityAt(h, STOP) - base, 0, "hunter does not profit");
    }

    /// @notice SA2 N-01 with the wider gap: a second touch 11 blocks after the last attempt starts tight; inside the
    /// gap it continues the same chain one step per landing, never jumping to the floor.
    function test_C7_hunt_N01_secondTouchAcrossGap() public {
        (, bytes32 id) = _bigCoverAtTouch();
        _sweepBidsDownTo(STOP * 98 / 100 + 1);
        _trader(100_000e6).rest(Constants.ORDER_OPEN_LONG, BTC, STOP * 98 / 100, 50_000);
        cm.trigger(id); // episode 1: no fill, chain at 1
        assertEq(cm.getCover(id).shortSteps, 1);
        uint256 snap = vm.snapshotState();

        _roll(GAP + 1);
        _refs(STOP);
        _mainnetBidsUnder(STOP);
        (PerplTrader h, int256 base) = _hunterSweep();
        _expectNoFill(id, TIGHT);
        cm.trigger(id);
        assertEq(cm.getCover(id).filledLots, 0, "hunter bid not filled");
        emit log_named_int("SA2 N-01 second touch at 11 blocks: hunter PnL at R (CNS)", _equityAt(h, STOP) - base);
        assertLe(_equityAt(h, STOP) - base, 0);

        vm.revertToState(snap);
        _roll(GAP);
        _refs(STOP);
        _mainnetBidsUnder(STOP);
        _hunterSweep();
        _expectNoFill(id, _limit(STOP, STOP, 1)); // same touch: step 1, not the floor
        cm.trigger(id);
    }

    /// @notice SA3-02 with the wider gap: dust at step 0 never starts a chain, so attempts 10 blocks apart stay
    /// tight and the atomic sweep meets R x (1 - A). Four dust rounds plus the sweep fit the 40-block window.
    function test_C7_hunt_SA3_02_dustAtStep0_gap10() public {
        (, bytes32 id) = _bigCoverAtTouch();
        PerplTrader duster = _trader(10_000e6);
        for (uint256 k; k < 4; ++k) {
            for (uint256 j; j < 16; ++j) {
                duster.rest(Constants.ORDER_OPEN_LONG, BTC, STOP, 1);
            }
            cm.trigger(id);
            assertEq(cm.getCover(id).shortBlock, 0, "match-limited at step 0: no chain");
            _roll(GAP);
            _refs(STOP);
        }
        (PerplTrader h, int256 base) = _hunterSweep();
        _expectNoFill(id, TIGHT);
        cm.trigger(id);
        assertEq(cm.getCover(id).filledLots, 64);
        emit log_named_int("SA3-02 dust then sweep: hunter PnL at R (CNS)", _equityAt(h, STOP) - base);
        assertLe(_equityAt(h, STOP) - base, 0);
    }
}
