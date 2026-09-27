// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Vm} from "forge-std/Vm.sol";
import {GaplessFixture} from "../utils/GaplessFixture.sol";
import {ListMarket} from "../../script/ListMarket.s.sol";
import {CoverManager} from "../../src/CoverManager.sol";
import {GaplessAccount} from "../../src/GaplessAccount.sol";
import {IGaplessAccount} from "../../src/interfaces/IGaplessAccount.sol";
import {ICoverManager} from "../../src/interfaces/ICoverManager.sol";
import {IGaplessCreSink} from "../../src/interfaces/IGaplessCreSink.sol";
import {IPerplMin} from "../../src/interfaces/perpl/IPerplMin.sol";
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

/// @title SA1 proofs of concept, converted to C4 regressions
/// @notice Real stack (Deploy.s.sol, ListMarket, CoverVault, GaplessFactory, GaplessAccount, CoverManager) on the
/// C0 mocks. Finding ids match contract/audit/SA1_REPORT.md; each test asserts the fixed behavior.
contract SA1AuditTest is GaplessFixture {
    CoverManager internal cm;
    address internal owner = makeAddr("owner");
    address internal lp = makeAddr("lp");

    uint256 internal constant M = BID; // fair price; references sit here unless a test moves them
    uint256 internal constant STOP = M * (10_000 - 45) / 10_000; // 857,862: 45 bps under the mark
    uint256 internal constant FLOOR = STOP * 9900 / 10_000; // pre-C4 floor when R >= stop (slack 100 bps)
    uint256 internal constant HUNT_LOTS = 2331; // ~2,000 AUSD at the stop (spec maxCoverNotional)

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

    /// @dev Remove the fixture's 200k-lot bid wall (opens need a fresh mark).
    function _clearBids() internal {
        _refs(M);
        _trader(100_000e6).ioc(Constants.ORDER_OPEN_SHORT, BTC, BID - 1000, 200_000);
    }

    /// @dev BTC-PERP bid depth read on mainnet (getVolumeAtBookPrice walk, block ~110,777,400): about $7.4k of
    /// bids within 71 bps of the mark.
    function _mainnetBids() internal {
        _clearBids();
        PerplTrader mm = _trader(100_000e6);
        uint16[6] memory bps = [uint16(3), 6, 23, 43, 64, 71];
        uint256[6] memory lots = [uint256(6022), 1780, 163, 163, 164, 29];
        for (uint256 i; i < 6; ++i) {
            mm.rest(Constants.ORDER_OPEN_LONG, BTC, M * (10_000 - bps[i]) / 10_000, lots[i]);
        }
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

    /// @dev Account equity marked at `px`, including AUSD sitting in the clone wallet.
    function _acctEquityAt(GaplessAccount a, uint256 px) internal view returns (int256 e) {
        IPerplMin.AccountInfo memory info = ex.getAccountById(a.perplAccountId());
        IPerplMin.PositionInfo memory p = _position(a);
        e = int256(info.balanceCNS + info.lockedBalanceCNS + p.depositCNS + ausd.balanceOf(address(a)))
            + p.premiumPnlCNS;
        if (p.lotLNS > 0) {
            int256 diff = (int256(px) - int256(p.pricePNS)) * int256(p.lotLNS);
            e += p.positionType == 0 ? diff : -diff;
        }
    }

    function _setMaxNotional(uint80 cap) internal {
        MarketParams memory p = cm.marketParams(BTC);
        p.maxCoverNotionalCNS = cap;
        vm.prank(deployer);
        cm.setMarketParams(BTC, p);
    }

    /// @dev Spec-size covered long on a mainnet-depth book, past warm-up, references at M.
    function _huntTarget() internal returns (GaplessAccount a, bytes32 id) {
        _setMaxNotional(2000e6); // spec default; the canary runs 50e6
        _refs(M);
        a = _account(owner, 400e6, _noGrant());
        _openLong(a, HUNT_LOTS);
        _mainnetBids();
        vm.prank(owner);
        id = a.buyCover(CoverParams(BTC, true, HUNT_LOTS, STOP, 200, 12_000), 10e6);
        _roll(200);
        _refs(M);
    }

    /// @dev Block N: sweep the thin bid side through the stop and rest a bid one tick above the old D38 floor.
    function _huntSweep(PerplTrader hunter) internal {
        hunter.ioc(Constants.ORDER_OPEN_SHORT, BTC, FLOOR + 1, 10_000);
        hunter.rest(Constants.ORDER_OPEN_LONG, BTC, FLOOR + 1, HUNT_LOTS);
    }

    // H-01 (fixed)

    /// @notice Auditor's 2,000 AUSD scenario, re-run on the fix: references stay at fair value, a third party wicks
    /// the thin book through the stop. Arming needs the reference at or through the stop, the fast path needs the
    /// mark there, so nothing fires: the trader keeps the position and the hunter only pays for its sweep.
    function test_H01_stopHunt_noLongerProfitable() public {
        (GaplessAccount a, bytes32 id) = _huntTarget();
        address key = makeAddr("hunterKey");
        int256 trader0 = _acctEquityAt(a, M);

        PerplTrader hunter = _trader(20_000e6);
        int256 hunterBase = _equityAt(hunter, M);
        _huntSweep(hunter);
        vm.prank(key);
        vm.expectRevert(ICoverManager.ConditionNotMet.selector);
        cm.arm(id);
        (bytes32[] memory toArm, bytes32[] memory toTrig) = cm.watchList(BTC, 16);
        assertEq(toArm.length + toTrig.length, 0, "keeper sees nothing to fire");
        _roll(1);
        _refs(M);
        vm.prank(key);
        vm.expectRevert(ICoverManager.ConditionNotMet.selector);
        cm.trigger(id);

        Cover memory c = cm.getCover(id);
        assertEq(uint8(c.status), uint8(CoverStatus.Live));
        assertEq(c.filledLots, 0);
        assertEq(_position(a).lotLNS, HUNT_LOTS, "position untouched");
        int256 traderLoss = trader0 - _acctEquityAt(a, M);
        int256 hunterGain = _equityAt(hunter, M) - hunterBase;
        // Residual short from the sweep, flattened at the ask with the tier-0 taker fee.
        uint256 residual = 8321;
        int256 flatten = int256((ASK - M) * residual + (ASK * residual * 345 + 999_999) / 1e6);
        emit log_named_int("trader loss at fair value (CNS)", traderLoss);
        emit log_named_int("hunter PnL after flattening (CNS)", hunterGain - flatten);
        assertLe(traderLoss, 0, "trader loses nothing");
        assertLe(hunterGain - flatten, 0, "hunter PnL <= 0");
    }

    /// @notice Same hunt when the reference genuinely touches the stop: the first close is floored at R x (1 - A),
    /// so the hunter's bid at the old floor is not hit and the trader exits at or above R x (1 - A), made whole to
    /// the stop by the payout.
    function test_H01_genuineTouch_firstCloseTiedToReference() public {
        (GaplessAccount a, bytes32 id) = _huntTarget();
        PerplTrader hunter = _trader(20_000e6);
        _huntSweep(hunter);
        _refs(STOP); // the reference itself is at the stop
        PerplTrader mm = _trader(20_000e6);
        uint256 tight = STOP * 9995 / 10_000;
        mm.rest(Constants.ORDER_OPEN_LONG, BTC, tight, HUNT_LOTS);
        vm.prank(keeper);
        assertTrue(cm.arm(id));
        _roll(1);
        _refs(STOP);
        vm.prank(keeper);
        uint256 paid = cm.trigger(id);
        Cover memory c = cm.getCover(id);
        assertEq(c.filledLots, HUNT_LOTS);
        assertEq(hunter.snap(BTC).locked > 0, true, "hunter bid at the old floor never filled");
        assertLe(paid, STOP * HUNT_LOTS * 5 / 10_000, "vault pays at most A x SN");
        assertEq(paid, c.gRealCumCNS, "trader made whole to the stop (net of the taker fee)");
        assertEq(_position(a).lotLNS, 0);
    }

    // M-01 (fixed)

    /// @notice The off-market sell limit is rejected, in-band shorts are priced at the mark, and operator closes are
    /// band-checked and bounded by the position. The owner keeps full control.
    function test_M01_offMarketLimitRejected_capPricedAtMark() public {
        _refs(M);
        address op = makeAddr("operator");
        GaplessAccount a = _account(owner, 1000e6, _grant(op, uint64(block.timestamp + 1 days), 10e6));
        IPerplMin.OrderDesc memory d = _order(Constants.ORDER_OPEN_SHORT, 1, 10_000);
        vm.prank(op);
        vm.expectRevert(abi.encodeWithSelector(IGaplessAccount.LimitOffMarket.selector, 1, M));
        a.trade(d);
        d.pricePNS = M * 96 / 100; // in band, below the mark
        vm.prank(op);
        vm.expectRevert(abi.encodeWithSelector(IGaplessAccount.NotionalCapExceeded.selector, M * 10_000, 10e6));
        a.trade(d);
        d = _order(Constants.ORDER_CLOSE_SHORT, Constants.PERPL_MAX_PRICE_PNS, 10_000);
        vm.prank(op);
        vm.expectRevert(
            abi.encodeWithSelector(IGaplessAccount.LimitOffMarket.selector, Constants.PERPL_MAX_PRICE_PNS, M)
        );
        a.trade(d);
        assertEq(_position(a).lotLNS, 0, "no position opened");
        vm.prank(owner);
        a.trade(_order(Constants.ORDER_OPEN_SHORT, 1, 1000)); // owner unaffected
        assertEq(_position(a).lotLNS, 1000);
    }

    // M-02 (fixed)

    /// @notice With the move already in the fresh oracle and feed, the quote measures distance from the least
    /// favorable fresh source and refuses the stop as already crossed. A book top inside minDistance refuses too.
    function test_M02_coverAfterTheMove_refused() public {
        _refs(M);
        GaplessAccount a = _account(owner, 100e6, _noGrant());
        _openLong(a, 50);
        uint256 moved = M * 98 / 100;
        ex.setOracle(BTC, moved);
        feed.setAnswer(int256(moved) * 1e7);
        vm.prank(owner);
        vm.expectRevert(ICoverManager.StopWrongSide.selector);
        a.buyCover(CoverParams(BTC, true, 50, STOP, 200, 12_000), 1e6);

        _refs(M);
        _clearBids();
        _trader(10_000e6).rest(Constants.ORDER_OPEN_LONG, BTC, STOP * 10_005 / 10_000, 100); // bid 5 bps over stop
        _refs(M);
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(ICoverManager.StopTooClose.selector, 4, 11));
        a.buyCover(CoverParams(BTC, true, 50, STOP, 200, 12_000), 1e6);
    }

    // M-03 (fixed)

    /// @notice The owner's own exit just above the stop now forfeits the escrow to the vault.
    function test_M03_ownerExitAtStop_escrowKept() public {
        _refs(M);
        GaplessAccount a = _account(owner, 100e6, _noGrant());
        _openLong(a, 50);
        vm.prank(owner);
        bytes32 id = a.buyCover(CoverParams(BTC, true, 50, STOP, 200, 12_000), 1e6);
        Cover memory c = cm.getCover(id);
        _roll(200);
        uint256 px = STOP * 10_002 / 10_000; // orderly decline: book and references 2 bps above the stop
        _clearBids();
        _refs(px);
        _trader(10_000e6).rest(Constants.ORDER_OPEN_LONG, BTC, px, 1000);
        _refs(px);
        uint256 assets0 = vault.totalAssets();
        uint256 wallet0 = ausd.balanceOf(address(a));
        vm.prank(owner);
        a.trade(_order(Constants.ORDER_CLOSE_LONG, STOP, 50));
        assertEq(uint8(cm.getCover(id).status), uint8(CoverStatus.Voided));
        assertEq(ausd.balanceOf(address(a)), wallet0, "no escrow back");
        uint256 income = uint256(c.escrowCNS) + c.rentCNS;
        assertEq(vault.totalAssets() - assets0, income - income / 10, "vault keeps escrow and rent");
    }

    // L-01 (fixed)

    /// @notice A mark-only publish after the trigger no longer counts for observe; the three-source publish does,
    /// and its median ignores the low mark.
    function test_L01_markOnlyPublish_doesNotObserve() public {
        _refs(M);
        GaplessAccount a = _account(owner, 100e6, _noGrant());
        _openLong(a, 50);
        vm.prank(owner);
        bytes32 id = a.buyCover(CoverParams(BTC, true, 50, STOP, 200, 12_000), 1e6);
        _roll(200);
        uint256 r = STOP - 2000; // genuine 23 bps gap through the stop
        _clearBids();
        _refs(r);
        _trader(10_000e6).rest(Constants.ORDER_OPEN_LONG, BTC, r * 9950 / 10_000, 1000); // book hole under R
        _refs(r);
        vm.prank(keeper);
        cm.trigger(id); // tight floor R x (1 - A): no fill
        for (uint256 k; k < 4; ++k) {
            _roll(1);
            _refs(r);
            vm.prank(keeper);
            cm.trigger(id); // R through the stop: A x 2^k per block, 80 bps at step 4 reaches the hole
        }
        assertEq(cm.getCover(id).filledLots, 50);
        uint256 low = r * 9975 / 10_000;

        _roll(2);
        ex.setMark(BTC, low); // only the mark publishes after the trigger
        assertFalse(cm.observe(id));
        ex.setOracle(BTC, r);
        feed.setAnswer(int256(r) * 1e7);
        assertTrue(cm.observe(id));
        _roll(40);
        assertEq(cm.finalize(id), 0, "median ignores the low mark");
    }

    // L-02 (fixed)

    /// @notice A squatter arming two blocks before expiry no longer blocks the keeper: the fast path is open to
    /// anyone, and no exclusive window can reach the expiry block.
    function test_L02_armSquatNearExpiry_cannotBlockPayout() public {
        _refs(M);
        GaplessAccount a = _account(owner, 100e6, _noGrant());
        _openLong(a, 50);
        vm.prank(owner);
        bytes32 id = a.buyCover(CoverParams(BTC, true, 50, STOP, 200, 1000), 1e6);
        uint256 expiry = cm.getCover(id).expiryBlock;
        _roll(expiry - 2 - block.number);
        uint256 crash = STOP - 3000;
        _clearBids();
        _refs(crash);
        _trader(10_000e6).rest(Constants.ORDER_OPEN_LONG, BTC, crash, 1000);
        _refs(crash);

        address squatter = makeAddr("squatter");
        vm.prank(squatter);
        cm.arm(id);
        _roll(1);
        _refs(crash);
        vm.prank(keeper);
        assertGt(cm.trigger(id), 0, "keeper fast path pays inside the squatter's window");
        assertEq(_position(a).lotLNS, 0);
    }

    // L-03 (fixed)

    /// @notice RISK_ADMIN raising A after purchase no longer moves the live cover: the floor and the payout bound
    /// use the A snapshotted at purchase, so the payout stays within the escrow priced at A = 5.
    function test_L03_slipAllowanceSnapshottedPerCover() public {
        (, bytes32 id) = _huntTarget();
        Cover memory c = cm.getCover(id);
        assertEq(c.slipAllowanceBps, 5);
        assertEq(c.floorSlackBps, 100);
        MarketParams memory p = cm.marketParams(BTC);
        p.slipAllowanceBps = 50;
        p.floorSlackBps = 300;
        vm.prank(deployer);
        cm.setMarketParams(BTC, p);
        _huntSweep(_trader(20_000e6));
        _refs(STOP); // genuine touch: G_ref = 0
        vm.prank(keeper);
        cm.arm(id);
        _roll(1);
        _refs(STOP);
        vm.expectEmit(address(cm));
        emit ICoverManager.TriggerNoFill(id, block.number, STOP * 9995 / 10_000); // A = 5, not 50
        vm.prank(keeper);
        cm.trigger(id);
        for (uint256 k = 1; k < 5; ++k) {
            _roll(1);
            _refs(STOP);
            vm.expectEmit(address(cm));
            emit ICoverManager.TriggerNoFill(id, block.number, STOP * (10_000 - (5 << k)) / 10_000); // A = 5
            vm.prank(keeper);
            cm.trigger(id);
        }
        _roll(1);
        _refs(STOP);
        vm.prank(keeper);
        uint256 paid = cm.trigger(id); // step 5 at the snapshotted slack (100 bps): hits the bid at FLOOR + 1
        assertEq(cm.getCover(id).filledLots, HUNT_LOTS);
        assertEq(paid, STOP * HUNT_LOTS * 5 / 10_000, "bound uses A = 5");
        assertLe(paid, c.escrowCNS, "I13 holds for the live cover");
    }

    // L-04 (fixed)

    /// @notice Reports for two perps in the same second are both processed, and a forged Armed-log report at the
    /// current block no longer drops a genuine one for an earlier block.
    function test_L04_creSink_perPerpAndForgedCannotDrop() public {
        address fwd = Constants.CRE_FORWARDER_SIM;
        bytes32[] memory none = new bytes32[](0);
        bytes32 topic = IGaplessCreSink.CreReport.selector;
        uint64 sec = uint64(block.timestamp);

        vm.recordLogs();
        vm.prank(fwd);
        sink.onReport("", abi.encode(uint8(1), Constants.CHAIN_SELECTOR, sec, uint256(1), M, none, none));
        vm.prank(fwd);
        sink.onReport("", abi.encode(uint8(1), Constants.CHAIN_SELECTOR, sec, uint256(20), uint256(1), none, none));
        assertEq(_count(vm.getRecordedLogs(), topic), 2, "both perps processed");
        assertEq(sink.lastSeq(1, 1), sec);
        assertEq(sink.lastSeq(1, 20), sec);

        _roll(10);
        vm.prank(fwd);
        sink.onReport(
            "", abi.encode(uint8(3), Constants.CHAIN_SELECTOR, uint64(block.number), uint256(1), 0, none, none)
        );
        vm.recordLogs();
        vm.prank(fwd);
        sink.onReport(
            "", abi.encode(uint8(3), Constants.CHAIN_SELECTOR, uint64(block.number - 1), uint256(1), 0, none, none)
        );
        assertEq(_count(vm.getRecordedLogs(), topic), 1, "genuine Armed-log report processed");
    }

    function _count(Vm.Log[] memory logs, bytes32 topic) internal pure returns (uint256 k) {
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].topics.length > 0 && logs[i].topics[0] == topic) ++k;
        }
    }
}
