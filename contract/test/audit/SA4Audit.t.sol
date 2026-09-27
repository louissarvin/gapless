// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {GaplessFixture} from "../utils/GaplessFixture.sol";
import {ListMarket} from "../../script/ListMarket.s.sol";
import {CoverManager} from "../../src/CoverManager.sol";
import {GaplessAccount} from "../../src/GaplessAccount.sol";
import {ICoverManager} from "../../src/interfaces/ICoverManager.sol";
import {PerplTrader} from "../mocks/PerplTrader.sol";
import {Constants} from "../../src/Constants.sol";
import {CoverParams, Cover, CoverStatus, MarketConfig, MarketParams} from "../../src/types/GaplessTypes.sol";

/// @title SA4 (delta audit after C6 and C7): trigger gas on the real stack, hold state machine
/// @notice Real CoverManager, GaplessAccount, GaplessFactory, CoverVault over the C0 mocks (CoverManagerGas uses stubs).
/// Each top-level call starts cold under this config (probe test); tx gas adds 21,000 intrinsic plus calldata.
contract SA4AuditTest is GaplessFixture {
    CoverManager internal cm;
    address internal owner = makeAddr("owner");
    address internal griefer = makeAddr("griefer");

    uint256 internal constant M = BID;
    uint256 internal constant S_STOP = 860_000;
    uint256 internal constant S_REF = 859_000;
    uint256 internal constant S_BOOK = 851_000; // under every step limit up to 4
    uint256 internal constant LOTS = 40; // > maxMatchesClose, under the 50 AUSD default notional cap
    uint256 internal constant BUDGET = 1_500_000; // keeper GAS.trigger
    uint256 internal constant INTRINSIC = 21_000 + 36 * 16; // tx base + trigger(bytes32) calldata, all nonzero

    function setUp() public {
        useRealManager = true;
        _setUpGapless();
        cm = CoverManager(manager);
        ausd.mint(seedLp, 2e6);
        MarketConfig memory cfg = Constants.btcMarketConfig();
        cfg.feed = address(feed);
        new ListMarket()
            .list(
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
        _lp(makeAddr("lp"), 10_000e6);
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

    function _coolAll(GaplessAccount a) internal {
        vm.cool(address(cm));
        vm.cool(address(ex));
        vm.cool(address(vault));
        vm.cool(address(ausd));
        vm.cool(address(feed));
        vm.cool(address(factory));
        vm.cool(address(impl));
        vm.cool(address(a));
    }

    function _limit(uint256 ref, uint256 k) internal pure returns (uint256) {
        if (k == 0) return ref * 9995 / 10_000;
        uint256 allow = 5 << k;
        if (allow > 100) allow = 100;
        return (ref < S_STOP ? ref : S_STOP) * (10_000 - allow) / 10_000;
    }

    /// @dev Covered long of `lots`, warm-up passed, R through the stop, only bids at S_BOOK, armed by the keeper.
    function _armed(uint256 lots) internal returns (GaplessAccount a, bytes32 id) {
        _refs(M);
        a = _account(owner, 400e6, _noGrant());
        _openLong(a, lots);
        vm.prank(owner);
        id = a.buyCover(CoverParams(BTC, true, lots, S_STOP, 200, 12_000), 10e6);
        _roll(200);
        _refs(S_REF);
        _trader(200_000e6).ioc(Constants.ORDER_OPEN_SHORT, BTC, S_BOOK + 1, 600_000);
        _refs(S_REF);
        _trader(100_000e6).rest(Constants.ORDER_OPEN_LONG, BTC, S_BOOK, 100);
        vm.prank(keeper);
        assertTrue(cm.arm(id));
    }

    function _trigger(address who, bytes32 id) internal returns (uint256 used) {
        uint256 g = gasleft();
        vm.prank(who);
        cm.trigger(id);
        used = g - gasleft();
    }

    /// @dev Step-0 thin attempt (chain at 1), then 16 one-lot bids over an honest level inside the step-1 limit.
    function _setUpHold(uint256 lots) internal returns (GaplessAccount a, bytes32 id) {
        (a, id) = _armed(lots);
        _roll(1);
        _refs(S_REF);
        vm.prank(keeper);
        cm.trigger(id);
        assertEq(cm.getCover(id).shortSteps, 1);
        _roll(1);
        _refs(S_REF);
        PerplTrader duster = _trader(10_000e6);
        for (uint256 j; j < 16; ++j) {
            duster.rest(Constants.ORDER_OPEN_LONG, BTC, 859_000 - j, 1); // above the honest level, so matched first
        }
        _trader(100_000e6).rest(Constants.ORDER_OPEN_LONG, BTC, _limit(S_REF, 1) + 1, 100);
    }

    // Gas

    /// @notice SA4-01: the C7 worst case (16-match hold on a running chain, first fill) on the real stack instead of
    /// stubs. With and without `vm.cool` it measures the same; plus intrinsic it is over the keeper's 1.5M.
    function test_SA4_01_holdGas_realStack_overBudget() public {
        uint256 snap = vm.snapshotState();
        (, bytes32 id) = _setUpHold(LOTS);
        uint256 warm = _trigger(keeper, id);
        Cover memory c = cm.getCover(id);
        assertEq(c.filledLots, 16, "match-limited partial");
        assertEq(c.shortBlock, block.number, "held");

        vm.revertToState(snap);
        GaplessAccount a;
        (a, id) = _setUpHold(LOTS);
        _coolAll(a);
        uint256 cold = _trigger(keeper, id);
        assertEq(cm.getCover(id).filledLots, 16);

        emit log_named_uint("hold, real stack", warm);
        emit log_named_uint("hold, real stack, after vm.cool", cold);
        emit log_named_uint("hold, real stack, tx gas (+ intrinsic)", cold + INTRINSIC);
        emit log_named_uint("keeper GAS.trigger", BUDGET);
        assertGt(cold + INTRINSIC, BUDGET, "C7 worst case on the real stack exceeds GAS.trigger");
    }

    /// @notice SA4-01: a full 16-match fill from one maker account (no hold) and a no-fill thin step, real stack.
    function test_SA4_01_fullFillAndStepGas_realStack_cold() public {
        uint256 snap = vm.snapshotState();
        (GaplessAccount a, bytes32 id) = _armed(16);
        _roll(1);
        _refs(S_REF);
        PerplTrader mm = _trader(10_000e6);
        for (uint256 j; j < 16; ++j) {
            mm.rest(Constants.ORDER_OPEN_LONG, BTC, 859_000 - j, 1);
        }
        _coolAll(a);
        uint256 full = _trigger(keeper, id);
        assertEq(cm.getCover(id).filledLots, 16);

        vm.revertToState(snap);
        (a, id) = _armed(LOTS);
        _roll(1);
        _refs(S_REF);
        _coolAll(a);
        uint256 step = _trigger(keeper, id);
        assertEq(cm.getCover(id).shortSteps, 1);

        emit log_named_uint("full 16-match fill, one maker, tx gas", full + INTRINSIC);
        emit log_named_uint("no-fill thin step, tx gas (keeper GAS.triggerStep 700,000)", step + INTRINSIC);
    }

    /// @notice SA4-03: one honest 1-lot bid that appears between the keeper's step simulation and its landing turns a
    /// 700K step into a fill that needs more than 700K.
    function test_SA4_01_stepThatFillsOneLot_realStack_cold() public {
        (GaplessAccount a, bytes32 id) = _armed(LOTS);
        _roll(1);
        _refs(S_REF);
        _trader(10_000e6).rest(Constants.ORDER_OPEN_LONG, BTC, S_REF * 9995 / 10_000 + 1, 1);
        _coolAll(a);
        uint256 used = _trigger(keeper, id);
        assertEq(cm.getCover(id).filledLots, 1);
        emit log_named_uint("step that fills 1 lot, tx gas (keeper GAS.triggerStep 700,000)", used + INTRINSIC);
        assertGt(used + INTRINSIC, 700_000, "a step that fills runs out of GAS.triggerStep");
    }

    /// @dev Harness check: a repeated top-level call is not cheaper, so each measured call starts cold here.
    function test_SA4_probe_eachTopLevelCallStartsCold() public {
        (, bytes32 id) = _armed(LOTS);
        uint256 g = gasleft();
        cm.getCover(id);
        uint256 first = g - gasleft();
        g = gasleft();
        cm.getCover(id);
        uint256 second = g - gasleft();
        emit log_named_uint("getCover first", first);
        emit log_named_uint("getCover second", second);
        assertGe(second, first, "no warm discount between top-level calls");
    }

    function _setMaxMatches(uint16 n) internal {
        MarketParams memory p = cm.marketParams(BTC);
        p.maxMatchesClose = n;
        vm.prank(deployer);
        cm.setMarketParams(BTC, p);
    }

    /// @dev Full fill of `n` lots against `n` one-lot bids from `n` distinct accounts (no chain, pre-C7 path).
    function _fullFillDistinct(uint256 n) internal returns (uint256 used) {
        (, bytes32 id) = _armed(n);
        _roll(1);
        _refs(S_REF);
        for (uint256 j; j < n; ++j) {
            _trader(20e6).rest(Constants.ORDER_OPEN_LONG, BTC, 859_000 - j, 1);
        }
        used = _trigger(keeper, id) + INTRINSIC;
        assertEq(cm.getCover(id).filledLots, n);
    }

    /// @notice SA4-01 is not C7-specific: a plain full fill against distinct makers exceeds 1.5M on the mocks even at
    /// maxMatchesClose 8 (the onchain minimum). Mainnet Perpl: about 266K for one fill, +110K per further maker.
    function test_SA4_01_fullFill_distinctMakers_byMaxMatches() public {
        uint256 snap = vm.snapshotState();
        uint256 g16 = _fullFillDistinct(16);
        vm.revertToState(snap);
        _setMaxMatches(12);
        uint256 g12 = _fullFillDistinct(12);
        vm.revertToState(snap);
        _setMaxMatches(8);
        uint256 g8 = _fullFillDistinct(8);
        emit log_named_uint("full fill, 16 distinct makers, maxMatches 16 (tx gas)", g16);
        emit log_named_uint("full fill, 12 distinct makers, maxMatches 12 (tx gas)", g12);
        emit log_named_uint("full fill, 8 distinct makers, maxMatches 8 (tx gas)", g8);
        assertGt(g8, BUDGET, "even 8 distinct makers exceed the keeper budget on the mocks");
    }

    /// @notice SA4-01: the hunter picks the dust shape. 16 one-lot bids from 16 distinct Perpl accounts.
    function test_SA4_01_holdGas_distinctDusters() public {
        (, bytes32 id) = _armed(LOTS);
        _roll(1);
        _refs(S_REF);
        vm.prank(keeper);
        cm.trigger(id);
        _roll(1);
        _refs(S_REF);
        for (uint256 j; j < 16; ++j) {
            _trader(20e6).rest(Constants.ORDER_OPEN_LONG, BTC, 859_000 - j, 1);
        }
        _trader(100_000e6).rest(Constants.ORDER_OPEN_LONG, BTC, _limit(S_REF, 1) + 1, 100);
        uint256 used = _trigger(keeper, id);
        assertEq(cm.getCover(id).filledLots, 16);
        assertEq(cm.getCover(id).shortBlock, block.number);
        emit log_named_uint("hold, 16 distinct dust accounts, tx gas", used + INTRINSIC);
        assertGt(used + INTRINSIC, 2 * BUDGET - 100_000, "about twice GAS.trigger");
    }

    // Hold state machine

    /// @notice A stale _heldBlock from an earlier block never matches a later shortBlock: hold in B, thin advance in
    /// B + 5, then a same-block retry in B + 5 uses that attempt's step (shortSteps - 1), not shortSteps.
    function test_SA4_staleHeldBlock_ignoredInLaterBlock() public {
        (, bytes32 id) = _setUpHold(LOTS);
        vm.prank(keeper);
        cm.trigger(id); // hold at step 1 in B
        uint256 b = block.number;
        assertEq(cm.getCover(id).shortBlock, b);
        _roll(5);
        _refs(S_REF);
        _trader(200_000e6).ioc(Constants.ORDER_OPEN_SHORT, BTC, S_BOOK + 1, 600_000); // book thin over step 1
        _refs(S_REF);
        vm.expectEmit(address(cm));
        emit ICoverManager.TriggerNoFill(id, block.number, _limit(S_REF, 1));
        cm.trigger(id); // remainder at step 1, thin: advance to 2
        assertEq(cm.getCover(id).shortSteps, 2);
        vm.expectEmit(address(cm));
        emit ICoverManager.TriggerNoFill(id, block.number, _limit(S_REF, 1));
        vm.prank(griefer);
        cm.trigger(id); // same block: step 1 again, the stale hold of block B is not read
        assertEq(cm.getCover(id).shortSteps, 2, "one step per block");
    }

    /// @notice Hold, then a third party in the same block cannot turn the hold into two steps: hold (k), thin (k -> k+1),
    /// thin again (no change), and the next block runs at k + 1 only.
    function test_SA4_holdThinThin_sameBlock_oneStep() public {
        (, bytes32 id) = _setUpHold(LOTS);
        vm.prank(keeper);
        cm.trigger(id); // hold at 1
        _trader(200_000e6).ioc(Constants.ORDER_OPEN_SHORT, BTC, S_BOOK + 1, 600_000);
        _refs(S_REF);
        vm.prank(griefer);
        cm.trigger(id); // thin at 1: advance to 2
        vm.prank(griefer);
        cm.trigger(id); // thin at 1 again: no change
        assertEq(cm.getCover(id).shortSteps, 2);
        _roll(1);
        _refs(S_REF);
        vm.expectEmit(address(cm));
        emit ICoverManager.TriggerNoFill(id, block.number, _limit(S_REF, 2));
        cm.trigger(id);
        assertEq(cm.getCover(id).shortSteps, 3, "one step per block across hold and thin");
    }

    /// @notice Holds cannot carry a chain across the 40-block remainder window: after the first fill, any attempt past
    /// triggerBlock + windowBlocks reverts, so dust can keep a chain alive for at most the window.
    function test_SA4_holdChainBoundedByWindow() public {
        (, bytes32 id) = _setUpHold(LOTS);
        vm.prank(keeper);
        cm.trigger(id); // first fill (16) and hold
        Cover memory c = cm.getCover(id);
        uint256 end = uint256(c.triggerBlock) + c.windowBlocks;
        PerplTrader duster = _trader(10_000e6);
        uint256 n;
        while (block.number + Constants.STEP_MAX_GAP_BLOCKS <= end) {
            _roll(Constants.STEP_MAX_GAP_BLOCKS);
            _refs(S_REF);
            for (uint256 j; j < 16; ++j) {
                duster.rest(Constants.ORDER_OPEN_LONG, BTC, 859_000 - j, 1);
            }
            if (cm.getCover(id).filledLots + 16 >= LOTS) break;
            cm.trigger(id);
            assertEq(cm.getCover(id).shortSteps, 1, "held, never widened");
            n++;
        }
        _roll(end + 1 - block.number);
        _refs(S_REF);
        vm.expectRevert(ICoverManager.ConditionNotMet.selector);
        cm.trigger(id);
        emit log_named_uint("holds that fit the window after the first fill", n);
    }
}
