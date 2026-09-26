// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IPerplMin} from "../../src/interfaces/perpl/IPerplMin.sol";
import {ICoverManager} from "../../src/interfaces/ICoverManager.sol";
import {ICoverVault} from "../../src/interfaces/ICoverVault.sol";
import {CoverManager} from "../../src/CoverManager.sol";
import {Constants} from "../../src/Constants.sol";
import {
    CoverParams,
    Cover,
    CoverStatus,
    EndReason,
    DisarmReason,
    MarketConfig,
    MarketParams,
    Quote
} from "../../src/types/GaplessTypes.sol";
import {MockFeed} from "../mocks/MockFeed.sol";
import {CoverManagerBase} from "./CoverManagerBase.t.sol";
import {AccountStub} from "./stubs/AccountStub.sol";

/// @notice CoverManager unit tests: every state transition and revert, against the S2 stubs.
/// Base scenario: 50-lot long at 835,000, stop 830,825 (50 bps), quote escrow 20,779, rent 20,000, Cap 830,825.
/// Crash: references at 830,000, best bid 829,600 (inside the first-close floor R x (1 - A) = 829,585).
contract CoverManagerTest is CoverManagerBase {
    uint256 internal constant ESCROW = 20_779;
    uint256 internal constant RENT = 20_000;
    uint256 internal constant CAP = 830_825;
    uint256 internal constant BID_X = 829_600;
    uint256 internal constant TIGHT_FLOOR = 829_585; // floor(830,000 x 9995 / 1e4)
    uint256 internal constant WIDE_FLOOR = 821_700; // floor(830,000 x 9900 / 1e4)
    uint256 internal constant STEP1_FLOOR = 829_170; // floor(830,000 x 9990 / 1e4): A x 2 after one short attempt
    /// @dev Fill at 829,600: G_real = (41,541,250 - 14,332) - (41,480,000 - 14,311) = 61,229 < G_ref + A x SN 62,020,
    /// so the trader is made whole to the stop.
    uint256 internal constant PAID_FULL = 61_229;
    int256 internal constant REALIZED_FULL = 3_890_689; // 4,175,000 released - 270,000 PnL - 14,311 fee
    /// @dev Widened fill at 829,000 (book hole under R): min(G_real 91,219, G_ref 41,250 + A x SN 20,770) = 62,020.
    uint256 internal constant PAID_WIDE = 62_020;

    // Admin and roles

    function test_setFactory_onceOnlyAndRole() public {
        CoverManager m = new CoverManager(address(ex), address(ausd), address(vault), admin);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, address(this), bytes32(0)
            )
        );
        m.setFactory(address(fac));
        vm.startPrank(admin);
        vm.expectRevert(ICoverManager.ZeroAddress.selector);
        m.setFactory(address(0));
        vm.expectEmit(address(m));
        emit ICoverManager.FactorySet(address(fac));
        m.setFactory(address(fac));
        vm.expectRevert(ICoverManager.FactoryAlreadySet.selector);
        m.setFactory(address(fac));
        vm.stopPrank();
    }

    function test_constructor_zeroAddress() public {
        vm.expectRevert(ICoverManager.ZeroAddress.selector);
        new CoverManager(address(0), address(ausd), address(vault), admin);
    }

    function test_listMarket_roleAndDuplicate() public {
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, address(this), Constants.RISK_ADMIN_ROLE
            )
        );
        cm.listMarket(2, _cfg(), Constants.defaultMarketParams());
        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(ICoverManager.MarketAlreadyListed.selector, PERP));
        cm.listMarket(PERP, _cfg(), Constants.defaultMarketParams());
    }

    function _ethCfg() internal view returns (MarketConfig memory c) {
        c = _cfg();
        c.priceDecimals = 2;
        c.lotDecimals = 3;
        c.scale = 10;
    }

    function test_listMarket_configBounds() public {
        ex.listPerp(2, "ETH", 2, 3, 2000, 250_000); // scale 10
        MarketParams memory p = Constants.defaultMarketParams();
        vm.startPrank(admin);

        MarketConfig memory bad = _ethCfg();
        bad.lotDecimals = 5; // pd + ld = 7
        _expectCfg();
        cm.listMarket(2, bad, p);
        bad = _ethCfg();
        bad.scale = 1; // wrong scale
        _expectCfg();
        cm.listMarket(2, bad, p);
        bad = _ethCfg();
        bad.creRefStore = address(1); // unsupported until the stretch store exists
        _expectCfg();
        cm.listMarket(2, bad, p);
        bad = _ethCfg();
        bad.feedDecimals = 1; // below pd
        _expectCfg();
        cm.listMarket(2, bad, p);
        bad = _ethCfg();
        bad.feed = address(0x1234); // no code
        _expectCfg();
        cm.listMarket(2, bad, p);
        bad = _ethCfg();
        bad.feed = address(new MockFeed(18, "X", 1)); // decimals mismatch
        _expectCfg();
        cm.listMarket(2, bad, p);
        _expectCfg();
        cm.listMarket(uint256(type(uint16).max) + 1, _ethCfg(), p);
        bad = _ethCfg();
        bad.priceDecimals = 3; // disagrees with Perpl (pd 2), scale 1 consistent
        bad.scale = 1;
        _expectCfg();
        cm.listMarket(2, bad, p);

        MarketConfig memory c = _ethCfg();
        MarketConfig memory listed = _ethCfg();
        listed.listed = true;
        vm.expectEmit(address(cm));
        emit ICoverManager.MarketListed(2, listed);
        cm.listMarket(2, c, p);
        vm.stopPrank();
        assertEq(cm.listedPerps().length, 2);
        assertEq(cm.scaleOf(2), 10);
        assertTrue(cm.marketConfig(2).listed);
    }

    function test_listMarket_feedOptional() public {
        ex.listPerp(3, "MON", 6, 0, 1000, 30_000);
        MarketConfig memory c = MarketConfig(false, 6, 0, 1, address(0), 0, address(0));
        vm.prank(admin);
        cm.listMarket(3, c, Constants.defaultMarketParams());
        (uint256 ref, uint8 n) = cm.referencePrice(3, true, 0);
        assertEq(n, 2);
        assertEq(ref, 30_000);
    }

    function _expectCfg() internal {
        vm.expectRevert(abi.encodeWithSelector(ICoverManager.ParamOutOfBounds.selector, Constants.F_MARKET_CONFIG));
    }

    function test_setMarketParams_crossFieldAndEvent() public {
        vm.startPrank(admin);
        MarketParams memory p = Constants.defaultMarketParams();
        p.minDurationBlocks = 2000;
        p.maxDurationBlocks = 1500;
        _expectParam(Constants.F_DURATION_ORDER);
        cm.setMarketParams(PERP, p);

        p = Constants.defaultMarketParams();
        p.windowBlocks = 200;
        p.armTtlBlocks = 400; // 48,000 + 200 + 400 > 48,300
        _expectParam(Constants.F_COOLDOWN_COVERAGE);
        cm.setMarketParams(PERP, p);

        p = Constants.defaultMarketParams();
        p.warmupBlocks = 1000; // == minDuration
        _expectParam(Constants.F_WARMUP_VS_DURATION);
        cm.setMarketParams(PERP, p);

        // SA3-I6: floorSlack >= 2A, so every widened step is wider than step 0.
        p = Constants.defaultMarketParams();
        p.slipAllowanceBps = 50;
        p.floorSlackBps = 99;
        _expectParam(Constants.F_FLOOR_SLACK_VS_SLIP);
        cm.setMarketParams(PERP, p);
        p.floorSlackBps = 100;
        cm.setMarketParams(PERP, p);
        p = Constants.defaultMarketParams();
        cm.setMarketParams(PERP, p);

        p = Constants.defaultMarketParams();
        p.zEdgesE2[0] = 0;
        _expectParam(Constants.F_Z_EDGES);
        cm.setMarketParams(PERP, p);
        p = Constants.defaultMarketParams();
        p.zEdgesE2[5] = p.zEdgesE2[4];
        _expectParam(Constants.F_Z_EDGES);
        cm.setMarketParams(PERP, p);

        p = Constants.defaultMarketParams();
        p.gapBpsE2[8] = 20_001;
        _expectParam(Constants.F_GAP_TABLE);
        cm.setMarketParams(PERP, p);

        vm.expectRevert(abi.encodeWithSelector(ICoverManager.MarketNotListed.selector, 9));
        cm.setMarketParams(9, Constants.defaultMarketParams());

        p = Constants.defaultMarketParams();
        p.slipAllowanceBps = 10;
        vm.expectEmit(address(cm));
        emit ICoverManager.MarketParamsSet(PERP, Constants.defaultMarketParams(), p);
        cm.setMarketParams(PERP, p);
        vm.stopPrank();
        assertEq(cm.marketParams(PERP).slipAllowanceBps, 10);
    }

    function _expectParam(uint8 f) internal {
        vm.expectRevert(abi.encodeWithSelector(ICoverManager.ParamOutOfBounds.selector, f));
    }

    function test_postSigma_boundsRoleAndListing() public {
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, address(this), Constants.SIGMA_ROLE
            )
        );
        cm.postSigma(PERP, 27);
        vm.startPrank(keeper);
        _expectParam(cm.F_SIGMA_POST());
        cm.postSigma(PERP, 4);
        _expectParam(cm.F_SIGMA_POST());
        cm.postSigma(PERP, 2001);
        vm.expectRevert(abi.encodeWithSelector(ICoverManager.MarketNotListed.selector, 2));
        cm.postSigma(2, 27);
        cm.postSigma(PERP, 5);
        vm.expectEmit(address(cm));
        emit ICoverManager.SigmaPosted(PERP, 2000, block.number);
        cm.postSigma(PERP, 2000);
        vm.stopPrank();
        (uint32 s, uint48 b) = cm.sigmaOf(PERP);
        assertEq(s, 2000);
        assertEq(b, block.number);
    }

    function test_pause_blocksBuysOnly() public {
        bytes32 id = _buy();
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, address(this), Constants.PAUSER_ROLE
            )
        );
        cm.pauseBuys();
        vm.prank(admin);
        cm.pauseBuys();
        assertTrue(cm.paused());
        AccountStub b = _newAccount(100e6);
        _openLong(b, LOTS);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        cm.quote(address(b), _params());
        vm.expectRevert(Pausable.EnforcedPause.selector);
        _buy(b, _params());
        // Lifecycle never pauses
        _pastWarmup();
        _crash(830_000, BID_X, LOTS);
        assertEq(_armAndTrigger(id), PAID_FULL);
        vm.prank(admin);
        cm.unpauseBuys();
        _setRefs(MARK);
        _buy(b, _params());
    }

    // Quote and openCover

    function test_quote_handComputed() public view {
        Quote memory q = cm.quote(address(acct), _params());
        assertEq(q.notionalCNS, 41_541_250);
        assertEq(q.capCNS, CAP);
        assertEq(q.escrowCNS, ESCROW);
        assertEq(q.rentCNS, RENT);
        assertEq(q.feeBpsE2, 500);
        assertEq(q.utilAfterBps, 9);
        assertEq(q.distanceBps, 50);
        assertEq(q.minDistanceBps, 11);
        assertEq(q.expiryBlock, block.number + 12_000);
    }

    function test_openCover_effects() public {
        uint256 bal0 = ausd.balanceOf(address(acct));
        bytes32 expectId = keccak256(abi.encode(address(acct), PERP, uint256(0)));
        vm.expectEmit(address(cm));
        emit ICoverManager.CoverBought(
            expectId, address(acct), PERP, true, LOTS, STOP, 200, ESCROW, RENT, CAP, block.number + 12_000
        );
        bytes32 id = _buy();
        assertEq(id, expectId);
        assertEq(bal0 - ausd.balanceOf(address(acct)), ESCROW + RENT);
        assertEq(ausd.balanceOf(address(cm)), ESCROW + RENT);
        assertEq(vault.reserved(PERP), CAP);
        assertEq(vault.reservedTotal(), CAP);
        assertEq(cm.liveCount(PERP), 1);
        assertEq(cm.activeCoverOf(address(acct), PERP), id);
        assertEq(cm.coverNonce(address(acct)), 1);
        Cover memory c = _cover(id);
        assertEq(c.account, address(acct));
        assertEq(c.perpId, PERP);
        assertEq(uint8(c.status), uint8(CoverStatus.Live));
        assertTrue(c.isLong);
        assertEq(c.lots, LOTS);
        assertEq(c.stopPNS, STOP);
        assertEq(c.startBlock, block.number);
        assertEq(c.expiryBlock, block.number + 12_000);
        assertEq(c.capCNS, CAP);
        assertEq(c.escrowCNS, ESCROW);
        assertEq(c.rentCNS, RENT);
        assertGe(uint256(c.escrowCNS) * 1e4, 41_541_250 * 5); // I13
        assertFalse(cm.isLocked(address(acct), PERP));
    }

    function test_openCover_notAccount() public {
        vm.expectRevert(ICoverManager.NotAccount.selector);
        cm.openCover(address(acct), _params(), 1e6); // caller is not the account
        AccountStub rogue = new AccountStub(IPerplMin(address(ex)), IERC20(address(ausd)), ICoverManager(address(cm)));
        vm.expectRevert(ICoverManager.NotAccount.selector);
        rogue.buyCover(_params(), 1e6); // not registered
        CoverManager m = new CoverManager(address(ex), address(ausd), address(vault), admin);
        AccountStub early = new AccountStub(IPerplMin(address(ex)), IERC20(address(ausd)), ICoverManager(address(m)));
        vm.expectRevert(ICoverManager.NotAccount.selector);
        early.buyCover(_params(), 1e6); // factory unset
    }

    function test_openCover_marketAndVenueGuards() public {
        CoverParams memory p = _params();
        p.perpId = 2;
        vm.expectRevert(abi.encodeWithSelector(ICoverManager.MarketNotListed.selector, 2));
        _buy(acct, p);

        ex.setWhitelistingEnabled(true);
        vm.expectRevert(ICoverManager.WhitelistingOn.selector);
        _buy(acct, _params());
        ex.setWhitelisted(address(acct), true);
        cm.quote(address(acct), _params());
        ex.setWhitelistingEnabled(false);

        ex.setHalted(true);
        vm.expectRevert(ICoverManager.VenueUnavailable.selector);
        _buy(acct, _params());
        ex.setHalted(false);
        ex.setPerpStatus(PERP, 0);
        vm.expectRevert(ICoverManager.VenueUnavailable.selector);
        _buy(acct, _params());
        ex.setPerpStatus(PERP, 4);

        ausd.freeze(address(vault));
        vm.expectRevert(abi.encodeWithSelector(ICoverManager.AusdFrozen.selector, address(vault)));
        cm.quote(address(acct), _params());
        ausd.unfreeze(address(vault));
        ausd.freeze(address(acct));
        vm.expectRevert(abi.encodeWithSelector(ICoverManager.AusdFrozen.selector, address(acct)));
        cm.quote(address(acct), _params());
    }

    function test_openCover_positionGuards() public {
        bytes32 id = _buy();
        vm.expectRevert(abi.encodeWithSelector(ICoverManager.CoverExists.selector, id));
        _buy(acct, _params());

        AccountStub b = _newAccount(100e6);
        vm.expectRevert(abi.encodeWithSelector(ICoverManager.LotsExceedPosition.selector, LOTS, 0));
        _buy(b, _params()); // no position
        _openLong(b, LOTS);
        CoverParams memory p = _params();
        p.lots = 0;
        vm.expectRevert(ICoverManager.ZeroLots.selector);
        _buy(b, p);
        p.lots = LOTS + 1;
        vm.expectRevert(abi.encodeWithSelector(ICoverManager.LotsExceedPosition.selector, LOTS + 1, LOTS));
        _buy(b, p);
        p = _params();
        p.isLong = false;
        p.stopPNS = 839_175;
        vm.expectRevert(ICoverManager.WrongSide.selector);
        _buy(b, p);
    }

    function test_openCover_staleMarkAndSigma() public {
        vm.warp(block.timestamp + 63);
        vm.expectRevert(abi.encodeWithSelector(ICoverManager.MarkStale.selector, T0));
        cm.quote(address(acct), _params());
        ex.setMark(PERP, MARK); // a stale oracle alone does not block buys
        cm.quote(address(acct), _params());

        vm.roll(block.number + 6001);
        _setRefs(MARK);
        vm.expectRevert(abi.encodeWithSelector(ICoverManager.SigmaStale.selector, B0));
        cm.quote(address(acct), _params());
        vm.prank(keeper);
        cm.postSigma(PERP, 27);
        cm.quote(address(acct), _params());
    }

    function test_openCover_quoteBounds() public {
        CoverParams memory p = _params();
        p.stopPNS = 836_000;
        vm.expectRevert(ICoverManager.StopWrongSide.selector);
        _buy(acct, p);
        p.stopPNS = 834_200; // 9 bps < minDist 11
        vm.expectRevert(abi.encodeWithSelector(ICoverManager.StopTooClose.selector, 9, 11));
        _buy(acct, p);
        p = _params();
        p.durationBlocks = 48_001;
        vm.expectRevert(abi.encodeWithSelector(ICoverManager.DurationOutOfRange.selector, uint32(48_001)));
        _buy(acct, p);
        p = _params();
        p.maxGapBps = 201;
        vm.expectRevert(abi.encodeWithSelector(ICoverManager.MaxGapOutOfRange.selector, uint16(201)));
        _buy(acct, p);
        vm.prank(keeper);
        cm.postSigma(PERP, 163); // stressed: minDist 68
        vm.expectRevert(abi.encodeWithSelector(ICoverManager.StopTooClose.selector, 50, 68));
        _buy(acct, _params());
    }

    function test_openCover_notionalTooLarge() public {
        AccountStub b = _newAccount(100e6);
        _openLong(b, 61);
        CoverParams memory p = _params();
        p.lots = 61;
        vm.expectRevert(abi.encodeWithSelector(ICoverManager.NotionalTooLarge.selector, 61 * STOP));
        _buy(b, p);
    }

    function test_openCover_liquidationBuffer() public {
        AccountStub b = _newAccount(100e6);
        maker.rest(1, PERP, MARK, LOTS);
        b.trade(0, PERP, MARK, LOTS, 2000); // 20x: deposit 2,087,500, limit 835,000
        vm.expectRevert(abi.encodeWithSelector(ICoverManager.LiquidationBufferTooThin.selector, 1_039_575, 835_000));
        _buy(b, _params());
        CoverParams memory p = _params();
        p.stopPNS = 834_000; // 11.97 bps: loss 50,000 + Cap 834,000 = 884,000 > 835,000
        vm.expectRevert(abi.encodeWithSelector(ICoverManager.LiquidationBufferTooThin.selector, 884_000, 835_000));
        _buy(b, p);
        p.maxGapBps = 50; // Cap 208,500: 258,500 fits
        _buy(b, p);
    }

    function test_openCover_vaultCapacityAndPremium() public {
        vault.setMaxUtil(8);
        vm.expectRevert(abi.encodeWithSelector(ICoverVault.UtilizationExceeded.selector, 9, 8));
        cm.quote(address(acct), _params());
        vault.setMaxUtil(8000);
        vault.setTotalAssets(10e6); // util 8.3% < 80%
        MarketParams memory p = Constants.defaultMarketParams();
        p.marketCapBps = 500; // 0.5 AUSD < Cap 0.83
        vm.prank(admin);
        cm.setMarketParams(PERP, p);
        vm.expectRevert(abi.encodeWithSelector(ICoverVault.MarketCapExceeded.selector, PERP, CAP, 500_000));
        cm.quote(address(acct), _params());
        vault.setTotalAssets(VAULT_ASSETS);
        Quote memory q = cm.quote(address(acct), _params());
        uint256 premium = q.escrowCNS + q.rentCNS;
        vm.expectRevert(abi.encodeWithSelector(ICoverManager.PremiumTooHigh.selector, premium, premium - 1));
        acct.buyCover(_params(), premium - 1);
        acct.buyCover(_params(), premium);
    }

    // Arm

    function test_arm_guards() public {
        bytes32 none = keccak256("none");
        vm.expectRevert(abi.encodeWithSelector(ICoverManager.BadStatus.selector, none, CoverStatus.None));
        cm.arm(none);
        bytes32 id = _buy();
        _setRefs(830_000);
        vm.expectRevert(abi.encodeWithSelector(ICoverManager.TooEarly.selector, B0 + 200));
        cm.arm(id);
        _roll(200);
        ex.setHalted(true);
        assertFalse(cm.arm(id)); // venue down: false, no revert
        ex.setHalted(false);
        _roll(12_000);
        _setRefs(830_000);
        vm.expectRevert(abi.encodeWithSelector(ICoverManager.CoverExpired.selector, B0 + 12_000));
        cm.arm(id);
    }

    function test_arm_noReference() public {
        bytes32 id = _buy();
        _roll(200);
        vm.warp(block.timestamp + 200); // mark, oracle and feed all stale; empty bids read as crossed
        vm.expectRevert(ICoverManager.NoReference.selector);
        cm.arm(id);
    }

    function test_arm_conditionNotMet_bookAndRef() public {
        bytes32 id = _buy();
        _pastWarmup();
        // Ref at the mark (50 bps above the stop), empty book: A3 book-only push refused
        vm.expectRevert(ICoverManager.ConditionNotMet.selector);
        cm.arm(id);
        // H-01: ref within refTol above the stop is not enough, even with the book through the stop
        _setRefs(831_000);
        vm.expectRevert(ICoverManager.ConditionNotMet.selector);
        cm.arm(id);
        // Ref through the stop but the best bid is still above it
        _setRefs(830_500);
        _restBid(831_500, 10);
        vm.expectRevert(ICoverManager.ConditionNotMet.selector);
        cm.arm(id);
    }

    function test_arm_emptyBidsCrossed_long() public {
        bytes32 id = _buy();
        _roll(200);
        _setRefs(830_500); // through the stop, no bids at all
        vm.expectEmit(address(cm));
        emit ICoverManager.Armed(id, PERP, keeper, block.number, 0, 830_500);
        vm.prank(keeper);
        assertTrue(cm.arm(id));
        assertEq(uint8(_status(id)), uint8(CoverStatus.Armed));
        assertTrue(cm.isLocked(address(acct), PERP));
        assertEq(_cover(id).armer, keeper);
    }

    function test_arm_short_emptyAsksCrossed_C1() public {
        AccountStub s = _newAccount(100e6);
        _openShort(s, LOTS);
        CoverParams memory p = _params();
        p.isLong = false;
        p.stopPNS = 839_175; // 50 bps above
        bytes32 id = _buy(s, p);
        _roll(200);
        _setRefs(838_500); // within tol below the stop but not through it (H-01)
        vm.expectRevert(ICoverManager.ConditionNotMet.selector);
        cm.arm(id);
        _setRefs(839_500); // through the stop; no asks rest
        vm.expectEmit(address(cm));
        emit ICoverManager.Armed(id, PERP, address(this), block.number, 0, 839_500);
        assertTrue(cm.arm(id));
        // Ask resting below the stop un-crosses the book
        _roll(201);
        _setRefs(839_500);
        _restAsk(838_000, 5);
        vm.expectRevert(ICoverManager.ConditionNotMet.selector);
        cm.arm(id);
    }

    function test_arm_bookCrossedAtStop() public {
        bytes32 id = _buy();
        _roll(200);
        _setRefs(830_826); // one tick above the stop: not through
        _restBid(830_825, 10); // best bid exactly at the stop counts as crossed
        vm.expectRevert(ICoverManager.ConditionNotMet.selector);
        cm.arm(id);
        _setRefs(830_825); // reference exactly at the stop counts as through
        vm.expectEmit(address(cm));
        emit ICoverManager.Armed(id, PERP, address(this), block.number, 830_825, 830_825);
        cm.arm(id);
    }

    function test_arm_voidsLiquidatedPosition() public {
        bytes32 id = _buy();
        _roll(200);
        _setRefs(830_000);
        ex.liquidate(PERP, acct.perplAccountId());
        uint256 bal0 = ausd.balanceOf(address(acct));
        // M-03: references through the stop, so the escrow is kept by the vault
        vm.expectEmit(address(cm));
        emit ICoverManager.CoverEnded(id, CoverStatus.Voided, EndReason.LiquidatedOrAdl, 0);
        vm.expectEmit(address(cm));
        emit ICoverManager.EscrowForfeited(id, ESCROW);
        assertFalse(cm.arm(id));
        assertEq(ausd.balanceOf(address(acct)), bal0);
        assertEq(vault.premiumIn(), RENT + ESCROW);
        assertEq(vault.reservedTotal(), 0);
        assertEq(cm.liveCount(PERP), 0);
        assertEq(cm.activeCoverOf(address(acct), PERP), bytes32(0));
        assertEq(ausd.balanceOf(address(cm)), 0);
    }

    function test_arm_ttlLapse_lazyLiveAndRearm() public {
        bytes32 id = _buy();
        _roll(200);
        _setRefs(830_500);
        cm.arm(id);
        _roll(201);
        assertFalse(cm.isLocked(address(acct), PERP)); // lazily Live
        _setRefs(830_500);
        vm.expectEmit(address(cm));
        emit ICoverManager.Disarmed(id, DisarmReason.ArmTtlElapsed);
        vm.prank(keeper);
        cm.arm(id);
        assertEq(_cover(id).armer, keeper);
        assertEq(_cover(id).armedBlock, block.number);
    }

    // Trigger

    /// @dev Mark above the stop (no fast path) while the oracle and feed are through it (median through).
    function _setSplitRefs(uint256 markPx, uint256 otherPx) internal {
        ex.setMark(PERP, markPx);
        ex.setOracle(PERP, otherPx);
        feed.setAnswer(int256(otherPx) * 1e7);
    }

    /// @dev Book hole 12 bps under R: steps 0 (5 bps) and 1 (10 bps) find no bid, step 2 (20 bps) fills at 829,000.
    function _triggeredWide() internal returns (bytes32 id) {
        id = _buy();
        _pastWarmup();
        _crash(830_000, 829_000, LOTS);
        vm.prank(keeper);
        cm.arm(id);
        _roll(1);
        _setRefs(830_000);
        vm.prank(keeper);
        assertEq(cm.trigger(id), 0, "tight floor: no fill");
        _roll(1);
        _setRefs(830_000);
        vm.prank(keeper);
        assertEq(cm.trigger(id), 0, "step 1: no fill");
        _roll(1);
        _setRefs(830_000);
        vm.prank(keeper);
        assertEq(cm.trigger(id), PAID_WIDE, "widened floor fills");
    }

    function _armed() internal returns (bytes32 id) {
        id = _buy();
        _pastWarmup();
        _crash(830_000, BID_X, LOTS);
        vm.prank(keeper);
        cm.arm(id);
    }

    function test_trigger_sameBlockAndExclusiveWindow() public {
        bytes32 id = _buy();
        _pastWarmup();
        _setSplitRefs(831_000, 830_000); // median 830,000 through, mark above: no fast path
        _restBid(BID_X, LOTS);
        vm.prank(keeper);
        cm.arm(id);
        uint256 armedAt = block.number;
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(ICoverManager.TooEarly.selector, armedAt + 1));
        cm.trigger(id);
        _roll(3);
        _setSplitRefs(831_000, 830_000);
        vm.prank(keeper2);
        vm.expectRevert(abi.encodeWithSelector(ICoverManager.NotArmer.selector, keeper2, keeper));
        cm.trigger(id);
        _roll(1);
        _setSplitRefs(831_000, 830_000);
        vm.prank(keeper2); // past the exclusive window: permissionless
        assertEq(cm.trigger(id), PAID_FULL);
    }

    /// @dev L-02: when the fast-path condition holds, anyone may trigger inside the armer's window.
    function test_trigger_fastPathIgnoresExclusiveWindow() public {
        bytes32 id = _armed(); // references (mark included) at 830,000: fast path holds
        _roll(1);
        _setRefs(830_000);
        vm.prank(keeper2);
        assertEq(cm.trigger(id), PAID_FULL);
    }

    /// @dev L-02: an arm whose exclusive window would reach the expiry block grants no exclusivity.
    function test_trigger_noExclusiveWindowNearExpiry() public {
        bytes32 id = _buy();
        vm.roll(B0 + 12_000 - 3); // armed + exclusiveBlocks (3) == expiryBlock
        _setSplitRefs(831_000, 830_000);
        _restBid(BID_X, LOTS);
        vm.prank(keeper);
        cm.arm(id);
        _roll(1);
        _setSplitRefs(831_000, 830_000);
        vm.prank(keeper2);
        assertEq(cm.trigger(id), PAID_FULL);
    }

    function test_trigger_fullFill_handComputed() public {
        bytes32 id = _armed();
        _roll(1);
        uint256 perpl0 = ex.getAccountById(acct.perplAccountId()).balanceCNS;
        vm.expectEmit(address(cm));
        emit ICoverManager.Triggered(id, PERP, block.number, LOTS, REALIZED_FULL, PAID_FULL, 830_000, PAID_FULL, 0);
        vm.prank(keeper);
        uint256 paid = cm.trigger(id);
        assertEq(paid, PAID_FULL);
        Cover memory c = _cover(id);
        assertEq(uint8(c.status), uint8(CoverStatus.Triggered));
        assertEq(c.filledLots, LOTS);
        assertEq(c.gRealCumCNS, PAID_FULL);
        assertEq(c.refTrigPNS, 830_000);
        assertEq(c.paidCNS, PAID_FULL);
        assertEq(c.owedCNS, 0);
        assertEq(c.triggerBlock, block.number);
        assertEq(c.triggerTs, block.timestamp);
        assertEq(vault.paidOut(), PAID_FULL);
        assertEq(vault.reservedTotal(), CAP - PAID_FULL); // payCapped consumed the reservation
        // Perpl balance grew by the close proceeds and the payout (creditToPerpl)
        assertEq(ex.getAccountById(acct.perplAccountId()).balanceCNS - perpl0, uint256(REALIZED_FULL) + PAID_FULL);
        assertTrue(vault.sawSettling());
        assertFalse(cm.isSettling());
        assertTrue(cm.isLocked(address(acct), PERP));
    }

    function test_trigger_disarm_conditionGone() public {
        bytes32 id = _armed();
        _roll(1);
        _setRefs(MARK); // reference recovered outside refTol
        vm.expectEmit(address(cm));
        emit ICoverManager.Disarmed(id, DisarmReason.ConditionGone);
        vm.prank(keeper);
        assertEq(cm.trigger(id), 0);
        assertEq(uint8(_status(id)), uint8(CoverStatus.Live));
        assertEq(acct.closeCalls(), 0);
    }

    function test_trigger_disarm_bookUncrossed() public {
        bytes32 id = _armed();
        _roll(1);
        _setSplitRefs(831_000, 830_000); // no fast path
        _restBid(831_000, 5);
        vm.prank(keeper);
        assertEq(cm.trigger(id), 0);
        assertEq(uint8(_status(id)), uint8(CoverStatus.Live));
    }

    function test_trigger_disarm_venueUnavailable() public {
        bytes32 id = _armed();
        _roll(1);
        ex.setPerpStatus(PERP, 0);
        vm.expectEmit(address(cm));
        emit ICoverManager.Disarmed(id, DisarmReason.VenueUnavailable);
        vm.prank(keeper);
        assertEq(cm.trigger(id), 0);
    }

    function test_trigger_ttlLapse_disarms() public {
        bytes32 id = _buy();
        _roll(200);
        _setSplitRefs(831_000, 830_500); // armable but the mark is above the stop (no fast path)
        cm.arm(id);
        _roll(201);
        _setSplitRefs(831_000, 830_500);
        vm.expectEmit(address(cm));
        emit ICoverManager.Disarmed(id, DisarmReason.ArmTtlElapsed);
        assertEq(cm.trigger(id), 0);
        assertEq(uint8(_status(id)), uint8(CoverStatus.Live));
    }

    function test_trigger_live_requiresFastPath() public {
        bytes32 id = _buy();
        _pastWarmup();
        vm.expectRevert(ICoverManager.ConditionNotMet.selector);
        cm.trigger(id);
    }

    /// @dev U1 (I9 gate): a Live cover never fires in one block on a stale or zero mark, even through the stop.
    function test_trigger_live_staleOrZeroMark_reverts() public {
        bytes32 id = _buy();
        _pastWarmup();
        _crash(830_000, BID_X, LOTS);
        ex.setMarkAt(PERP, 830_000, block.timestamp - 63); // 63 s old > refFreshSec 60 + 2 s tolerance
        vm.expectRevert(ICoverManager.ConditionNotMet.selector);
        cm.trigger(id);
        (, bytes32[] memory toTrig) = cm.watchList(PERP, 16);
        assertEq(toTrig.length, 0, "stale mark is not a fast-path candidate");
        ex.setMarkAt(PERP, 830_000, block.timestamp - 62); // at the tolerance edge: fresh
        (, toTrig) = cm.watchList(PERP, 16);
        assertEq(toTrig.length, 1);
        ex.setMark(PERP, 0);
        vm.expectRevert(ICoverManager.ConditionNotMet.selector);
        cm.trigger(id);
        (, toTrig) = cm.watchList(PERP, 16);
        assertEq(toTrig.length, 0, "zero mark is not a fast-path candidate");
    }

    function test_trigger_fastPath_singleBlock() public {
        bytes32 id = _buy();
        _roll(199);
        _crash(830_000, BID_X, LOTS);
        vm.expectRevert(ICoverManager.ConditionNotMet.selector); // A13: no fast path inside warm-up
        cm.trigger(id);
        _roll(1);
        _setRefs(830_000);
        vm.prank(keeper2);
        assertEq(cm.trigger(id), PAID_FULL);
        assertEq(uint8(_status(id)), uint8(CoverStatus.Triggered));
    }

    /// @dev H-01 floor policy: the first attempt is floored at R x (1 - A); only after a short close in an earlier
    /// block, with R still through the stop, does the floor widen to min(stop, R) x (1 - slack).
    function test_trigger_noFill_staysArmed_thenFills() public {
        bytes32 id = _buy();
        _pastWarmup();
        _setRefs(830_000);
        _restBid(800_000, LOTS); // below both floors
        vm.prank(keeper);
        cm.arm(id);
        _roll(1);
        _setRefs(830_000);
        vm.expectEmit(address(cm));
        emit ICoverManager.TriggerNoFill(id, block.number, TIGHT_FLOOR);
        vm.prank(keeper);
        assertEq(cm.trigger(id), 0);
        assertEq(uint8(_status(id)), uint8(CoverStatus.Armed));
        assertEq(_cover(id).shortBlock, block.number);
        vm.expectEmit(address(cm)); // same block: still the tight floor
        emit ICoverManager.TriggerNoFill(id, block.number, TIGHT_FLOOR);
        vm.prank(keeper);
        cm.trigger(id);
        _roll(1);
        _setRefs(830_000);
        vm.expectEmit(address(cm));
        emit ICoverManager.TriggerNoFill(id, block.number, STEP1_FLOOR); // N-01: one step per block, not the slack
        vm.prank(keeper);
        cm.trigger(id);
        assertEq(_cover(id).shortSteps, 2);
        _roll(1);
        _setRefs(830_000);
        _restBid(829_000, LOTS);
        vm.prank(keeper);
        assertEq(cm.trigger(id), PAID_WIDE); // step 2: 20 bps under R reaches 829,000
    }

    /// @dev H-01: the widened floor needs the reference itself through the stop; with R back above it the floor
    /// stays at R x (1 - A) even after a no-fill.
    function test_trigger_noWidenWhenRefAboveStop() public {
        bytes32 id = _buy();
        _pastWarmup();
        _setRefs(830_000);
        _restBid(800_000, LOTS);
        vm.prank(keeper);
        cm.arm(id);
        _roll(1);
        _setRefs(830_000);
        vm.prank(keeper);
        cm.trigger(id); // no fill, short block recorded
        _roll(1);
        _setRefs(831_000); // ref within refTol above the stop: still armed, not through
        _restBid(800_000, 1);
        _setSplitRefs(831_000, 831_000);
        vm.expectEmit(address(cm));
        emit ICoverManager.TriggerNoFill(id, block.number, 830_584); // floor(831,000 x 9995 / 1e4)
        vm.prank(keeper);
        cm.trigger(id);
    }

    function test_disarm_resetsShortBlock() public {
        bytes32 id = _buy();
        _pastWarmup();
        _setRefs(830_000);
        _restBid(800_000, LOTS);
        cm.arm(id);
        _roll(1);
        _setRefs(830_000);
        cm.trigger(id);
        assertGt(_cover(id).shortBlock, 0);
        _roll(1);
        _setRefs(MARK); // recovered: disarm
        cm.trigger(id);
        assertEq(_cover(id).shortBlock, 0);
        assertEq(uint8(_status(id)), uint8(CoverStatus.Live));
    }

    function test_trigger_partialThenRemainder() public {
        bytes32 id = _buy();
        _pastWarmup();
        _crash(830_000, BID_X, 20);
        vm.prank(keeper);
        cm.arm(id);
        _roll(1);
        vm.prank(keeper);
        uint256 p1 = cm.trigger(id);
        // F = 20 at 829,600: min(G_real 24,492, G_ref 16,500 + A x SN 8,308, Cap) = 24,492
        assertEq(p1, 24_492);
        Cover memory c = _cover(id);
        assertEq(c.filledLots, 20);
        assertEq(c.gRealCumCNS, 24_492);
        (, bytes32[] memory toTrig) = cm.watchList(PERP, 16);
        assertEq(toTrig.length, 1);
        assertEq(toTrig[0], id);
        _roll(1);
        _restBid(BID_X, 30);
        vm.prank(keeper2); // remainder is permissionless
        uint256 p2 = cm.trigger(id);
        assertEq(p1 + p2, PAID_FULL);
        assertEq(_cover(id).gRealCumCNS, PAID_FULL);
        _roll(1);
        vm.expectRevert(ICoverManager.ConditionNotMet.selector); // nothing left to close
        cm.trigger(id);
    }

    function test_trigger_remainderWindowCloses() public {
        bytes32 id = _buy();
        _pastWarmup();
        _crash(830_000, BID_X, 20);
        cm.arm(id);
        _roll(1);
        cm.trigger(id);
        _roll(41);
        _restBid(BID_X, 30);
        vm.expectRevert(ICoverManager.ConditionNotMet.selector);
        cm.trigger(id);
    }

    /// @dev U2: a partial fill, then the position is liquidated or flipped inside the window: the remainder reverts.
    function test_trigger_remainderAfterLiquidationOrFlip_reverts() public {
        bytes32 id = _buy();
        _pastWarmup();
        _crash(830_000, BID_X, 20);
        cm.arm(id);
        _roll(1);
        cm.trigger(id);
        uint256 s = vm.snapshotState();
        _roll(1);
        ex.liquidate(PERP, acct.perplAccountId());
        _restBid(BID_X, 30);
        vm.expectRevert(ICoverManager.ConditionNotMet.selector);
        cm.trigger(id);
        vm.revertToState(s);
        _roll(1);
        ex.adl(PERP, acct.perplAccountId(), 30); // gone
        _setRefs(830_000);
        maker.rest(0, PERP, 830_000, 40);
        acct.trade(1, PERP, 830_000, 10, 1000); // reopen as a short (account trade skips sync on Triggered)
        assertEq(acct.position(PERP).positionType, 1);
        vm.expectRevert(ICoverManager.ConditionNotMet.selector);
        cm.trigger(id);
    }

    function test_trigger_positionGone_voids() public {
        bytes32 id = _armed();
        _roll(1);
        _setRefs(830_000);
        ex.liquidate(PERP, acct.perplAccountId());
        vm.prank(keeper);
        assertEq(cm.trigger(id), 0);
        assertEq(uint8(_status(id)), uint8(CoverStatus.Voided));
        assertEq(vault.paidOut(), 0);
    }

    function test_trigger_expired_reverts() public {
        bytes32 id = _buy();
        _roll(12_001);
        _crash(830_000, BID_X, LOTS);
        vm.expectRevert(abi.encodeWithSelector(ICoverManager.CoverExpired.selector, B0 + 12_000));
        cm.trigger(id);
    }

    function test_trigger_badStatus() public {
        bytes32 id = _buy();
        acct.cancelCover(id);
        vm.expectRevert(abi.encodeWithSelector(ICoverManager.BadStatus.selector, id, CoverStatus.Cancelled));
        cm.trigger(id);
    }

    /// @dev D49: stale references block opens but never the close. With n == 0 the payout is A x SN.
    function test_trigger_oracleOutage_armedStillCloses() public {
        bytes32 id = _armed();
        vm.roll(block.number + 1);
        vm.warp(block.timestamp + 200); // mark, oracle (62 s) and feed (120 s) all stale
        (, uint8 n) = cm.referencePrice(PERP, true, 0);
        assertEq(n, 0);
        AccountStub b = _newAccount(100e6);
        vm.expectRevert(); // opens revert on Perpl (MarkPriceAgeExceedsMax)
        b.trade(0, PERP, MARK, 1, 1000);
        vm.prank(keeper);
        uint256 paid = cm.trigger(id);
        assertEq(paid, 20_770); // min(61,229, 0 + 20,770, Cap)
        assertEq(_cover(id).refTrigPNS, 0);
        // A post-trigger publish tops up through observe and finalize
        _roll(1);
        _setRefs(830_000);
        assertTrue(cm.observe(id));
        cm.finalize(id);
        assertEq(_cover(id).paidCNS, PAID_FULL);
    }

    function test_trigger_reentrancyBlocked() public {
        bytes32 id = _armed();
        _roll(1);
        acct.setReenter(id);
        vm.prank(keeper);
        vm.expectRevert(ReentrancyGuardTransient.ReentrancyGuardReentrantCall.selector);
        cm.trigger(id);
    }

    function test_trigger_measureDontTrust() public {
        bytes32 id = _armed();
        _roll(1);
        acct.setLie(-1);
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(ICoverManager.LotsExceedPosition.selector, LOTS - 1, LOTS));
        cm.trigger(id);
    }

    function test_trigger_payFailure_defersThenFinalizePays() public {
        bytes32 id = _armed();
        _roll(1);
        vault.setPayReverts(true);
        vm.expectEmit(address(cm));
        emit ICoverManager.PayoutDeferred(id, PAID_FULL);
        vm.prank(keeper);
        assertEq(cm.trigger(id), 0);
        assertEq(_cover(id).owedCNS, PAID_FULL);
        _roll(41);
        vm.expectEmit(address(cm));
        emit ICoverManager.PayoutDeferred(id, PAID_FULL);
        assertEq(cm.finalize(id), 0); // still failing: stays Triggered
        assertEq(uint8(_status(id)), uint8(CoverStatus.Triggered));
        vault.setPayReverts(false);
        assertEq(cm.finalize(id), PAID_FULL);
        assertEq(uint8(_status(id)), uint8(CoverStatus.Finalized));
        assertEq(_cover(id).paidCNS, PAID_FULL);
    }

    function test_trigger_creditFailure_stillPaidToWallet() public {
        bytes32 id = _armed();
        _roll(1);
        acct.setCreditReverts(true);
        uint256 w0 = ausd.balanceOf(address(acct));
        vm.prank(keeper);
        assertEq(cm.trigger(id), PAID_FULL);
        assertEq(ausd.balanceOf(address(acct)) - w0, PAID_FULL);
        assertEq(_cover(id).owedCNS, 0);
    }

    function test_trigger_perBlockCap_defersToFinalize() public {
        bytes32 id = _armed();
        vault.setTotalAssets(5e6);
        MarketParams memory p = Constants.defaultMarketParams();
        p.perBlockPayoutCapBps = 100; // 1% of 5 AUSD = 50,000 per block
        vm.prank(admin);
        cm.setMarketParams(PERP, p);
        _roll(1);
        vm.prank(keeper);
        assertEq(cm.trigger(id), 50_000);
        assertEq(_cover(id).owedCNS, PAID_FULL - 50_000);
        assertEq(vault.blockPayout(PERP).paidCNS, 50_000);
        assertEq(vault.owedTotal(), PAID_FULL - 50_000, "L-08: the vault nets the deferral");
        _roll(41);
        assertEq(cm.finalize(id), PAID_FULL - 50_000);
        assertEq(uint8(_status(id)), uint8(CoverStatus.Finalized));
        assertEq(vault.owedTotal(), 0);
    }

    /// @dev L-05: past the window, a still-owed cover keeps only paid + owed reserved.
    function test_finalize_owed_releasesExcessReserve() public {
        bytes32 id = _armed();
        vault.setTotalAssets(5e6);
        MarketParams memory p = Constants.defaultMarketParams();
        p.perBlockPayoutCapBps = 100;
        vm.prank(admin);
        cm.setMarketParams(PERP, p);
        _roll(1);
        vm.prank(keeper);
        cm.trigger(id);
        _roll(41);
        vault.setPayReverts(true);
        cm.finalize(id);
        Cover memory c = _cover(id);
        assertEq(uint8(c.status), uint8(CoverStatus.Triggered));
        assertEq(c.capCNS, uint256(c.paidCNS) + c.owedCNS);
        assertEq(vault.reservedTotal(), c.owedCNS);
        vault.setPayReverts(false);
        cm.finalize(id);
        assertEq(uint8(_status(id)), uint8(CoverStatus.Finalized));
        assertEq(vault.reservedTotal(), 0);
    }

    // Observe and finalize

    function _triggered() internal returns (bytes32 id) {
        id = _armed();
        _roll(1);
        vm.prank(keeper);
        cm.trigger(id);
    }

    function test_observe_guards() public {
        AccountStub b = _newAccount(100e6);
        _openLong(b, LOTS);
        bytes32 live = _buy(b, _params());
        vm.expectRevert(abi.encodeWithSelector(ICoverManager.BadStatus.selector, live, CoverStatus.Live));
        cm.observe(live);
        bytes32 id = _triggered();
        vm.expectRevert(abi.encodeWithSelector(ICoverManager.TooEarly.selector, block.number + 1));
        cm.observe(id);
        _roll(1);
        assertFalse(cm.observe(id)); // nothing published after the trigger second
        _roll(40);
        _setRefs(829_500);
        vm.expectRevert(ICoverManager.ConditionNotMet.selector);
        cm.observe(id);
    }

    function test_observe_topUp_and_earlyFinalize() public {
        bytes32 id = _triggeredWide();
        _roll(2);
        _setRefs(829_500);
        vm.expectEmit(address(cm));
        emit ICoverManager.Observed(id, 829_500, block.number);
        assertTrue(cm.observe(id));
        vm.expectRevert(abi.encodeWithSelector(ICoverManager.BadStatus.selector, id, CoverStatus.Triggered));
        cm.observe(id);
        // Pfinal = min(91,219, max(41,250, 66,250) + 20,770, Cap) = 87,020: top-up 25,000
        uint256 v0 = vault.premiumIn();
        uint256 w0 = ausd.balanceOf(address(acct));
        vm.expectEmit(address(cm));
        emit ICoverManager.Finalized(id, 25_000, 87_020, 829_500, ESCROW);
        assertEq(cm.finalize(id), 25_000); // observed and fully filled: no need to wait for the window
        assertEq(vault.premiumIn() - v0, ESCROW + RENT);
        assertEq(ausd.balanceOf(address(acct)), w0); // no refund on a full fill; top-up went to Perpl
        assertEq(vault.reservedTotal(), 0);
        assertEq(ausd.balanceOf(address(cm)), 0);
        assertEq(cm.liveCount(PERP), 0);
        assertEq(cm.activeCoverOf(address(acct), PERP), bytes32(0));
        assertFalse(cm.isLocked(address(acct), PERP));
        vm.expectRevert(abi.encodeWithSelector(ICoverManager.BadStatus.selector, id, CoverStatus.Finalized));
        cm.finalize(id);
    }

    function test_finalize_tooEarly_andPartialWaitsForWindow() public {
        bytes32 id = _buy();
        _pastWarmup();
        _crash(830_000, BID_X, 20);
        cm.arm(id);
        _roll(1);
        cm.trigger(id);
        uint256 tb = block.number;
        vm.expectRevert(abi.encodeWithSelector(ICoverManager.TooEarly.selector, tb + 41));
        cm.finalize(id);
        _roll(1);
        _setRefs(830_000);
        assertTrue(cm.observe(id));
        vm.expectRevert(abi.encodeWithSelector(ICoverManager.TooEarly.selector, tb + 41)); // partial fill
        cm.finalize(id);
        vm.roll(tb + 41);
        uint256 w0 = ausd.balanceOf(address(acct));
        uint256 v0 = vault.premiumIn();
        cm.finalize(id);
        // escrow to vault = ceil(20,779 x 20 / 50) = 8,312; refund 12,467
        assertEq(vault.premiumIn() - v0, 8312 + RENT);
        assertEq(ausd.balanceOf(address(acct)) - w0, 12_467);
        assertEq(vault.reservedTotal(), 0);
        assertEq(ausd.balanceOf(address(cm)), 0);
    }

    function test_finalize_badStatus() public {
        bytes32 id = _buy();
        vm.expectRevert(abi.encodeWithSelector(ICoverManager.BadStatus.selector, id, CoverStatus.Live));
        cm.finalize(id);
    }

    // End paths

    function test_expire() public {
        bytes32 id = _buy();
        vm.expectRevert(abi.encodeWithSelector(ICoverManager.TooEarly.selector, B0 + 12_001));
        cm.expire(id);
        _roll(12_001);
        _setRefs(MARK); // far from the stop: refundable (M-03)
        uint256 w0 = ausd.balanceOf(address(acct));
        vm.expectEmit(address(cm));
        emit ICoverManager.CoverEnded(id, CoverStatus.Expired, EndReason.Expired, ESCROW);
        cm.expire(id);
        assertEq(ausd.balanceOf(address(acct)) - w0, ESCROW);
        assertEq(vault.premiumIn(), RENT);
        assertEq(vault.reservedTotal(), 0);
        assertEq(ausd.balanceOf(address(cm)), 0);
        vm.expectRevert(abi.encodeWithSelector(ICoverManager.BadStatus.selector, id, CoverStatus.Expired));
        cm.expire(id);
    }

    function test_expire_fromArmed() public {
        bytes32 id = _buy();
        vm.roll(B0 + 11_999); // SA3-01: the last block that accepts an arm
        _setSplitRefs(831_000, 830_500);
        cm.arm(id);
        _roll(2);
        _setRefs(MARK);
        vm.expectEmit(address(cm));
        emit ICoverManager.CoverEnded(id, CoverStatus.Expired, EndReason.Expired, 0); // armed once: kept (M-03)
        cm.expire(id);
        assertEq(uint8(_status(id)), uint8(CoverStatus.Expired));
        assertEq(vault.premiumIn(), RENT + ESCROW);
    }

    // M-03 escrow retention

    /// @dev N-02: expiry refunds a never-armed cover even with every reference stale (outcome independent of timing).
    function test_N02_expire_staleRefs_refunds() public {
        bytes32 id = _buy();
        _roll(12_001); // nothing republished
        uint256 w0 = ausd.balanceOf(address(acct));
        vm.expectEmit(address(cm));
        emit ICoverManager.CoverEnded(id, CoverStatus.Expired, EndReason.Expired, ESCROW);
        cm.expire(id);
        assertEq(ausd.balanceOf(address(acct)) - w0, ESCROW);
        assertEq(vault.premiumIn(), RENT);
    }

    /// @dev Before expiry, stale references still read as not provably far (M-03 zone rule).
    function test_M03_cancel_staleRefs_forfeits() public {
        bytes32 id = _buy();
        _roll(1000); // nothing republished, still live
        vm.expectEmit(address(cm));
        emit ICoverManager.EscrowForfeited(id, ESCROW);
        acct.cancelCover(id);
        assertEq(vault.premiumIn(), RENT + ESCROW);
    }

    function test_M03_cancelNearStop_forfeits_farRefunds() public {
        bytes32 id = _buy();
        _setRefs(831_600); // 9 bps above the stop < minDistance 11
        uint256 w0 = ausd.balanceOf(address(acct));
        acct.cancelCover(id);
        assertEq(ausd.balanceOf(address(acct)), w0, "near the stop: kept");
        assertEq(vault.premiumIn(), RENT + ESCROW);

        _setRefs(MARK);
        bytes32 id2 = _buy(acct, _params());
        w0 = ausd.balanceOf(address(acct));
        _setRefs(831_800); // 11 bps: exactly minDistance
        acct.cancelCover(id2);
        assertEq(ausd.balanceOf(address(acct)) - w0, ESCROW, "at minDistance: refunded");
    }

    /// @dev One stale-but-low source cannot be dodged: the least favorable fresh source decides.
    function test_M03_leastFavorableSourceDecides() public {
        bytes32 id = _buy();
        _setRefs(MARK);
        feed.setAnswer(831_000e7); // feed 2 bps above the stop, mark and oracle far
        acct.cancelCover(id);
        assertEq(vault.premiumIn(), RENT + ESCROW);
    }

    function test_M03_ownTradeExitNearStop_keepsEscrow() public {
        bytes32 id = _buy();
        _roll(200);
        _setRefs(831_000); // 2 bps above the stop: an owner exit here is the adverse selection M-03 closes
        _restBid(831_000, LOTS);
        uint256 w0 = ausd.balanceOf(address(acct));
        acct.trade(2, PERP, 831_000, LOTS, 0);
        assertEq(uint8(_status(id)), uint8(CoverStatus.Voided));
        assertEq(ausd.balanceOf(address(acct)), w0);
        assertEq(vault.premiumIn(), RENT + ESCROW);
    }

    function test_M03_resizeNearStop_keepsFreedEscrow() public {
        bytes32 id = _buy();
        _setRefs(831_000);
        _restBid(831_000, 20);
        uint256 w0 = ausd.balanceOf(address(acct));
        vm.expectEmit(address(cm));
        emit ICoverManager.CoverResized(id, 30, CAP - 498_495, 0);
        vm.expectEmit(address(cm));
        emit ICoverManager.EscrowForfeited(id, ESCROW - 12_468);
        acct.trade(2, PERP, 831_000, 20, 0);
        assertEq(ausd.balanceOf(address(acct)), w0);
        assertEq(vault.premiumIn(), ESCROW - 12_468);
    }

    // L-05 frozen account

    function test_L05_frozenAccount_refundBecomesClaim() public {
        bytes32 id = _buy();
        _roll(12_001);
        _setRefs(MARK);
        ausd.freeze(address(acct));
        vm.expectEmit(address(cm));
        emit ICoverManager.RefundOwed(address(acct), ESCROW);
        cm.expire(id); // does not brick
        assertEq(uint8(_status(id)), uint8(CoverStatus.Expired));
        assertEq(vault.reservedTotal(), 0, "reserve released");
        assertEq(cm.refundOwed(address(acct)), ESCROW);
        assertEq(cm.refundOwedTotal(), ESCROW);
        assertEq(ausd.balanceOf(address(cm)), ESCROW);
        vm.expectRevert();
        cm.claimRefund(address(acct)); // still frozen
        ausd.unfreeze(address(acct));
        uint256 w0 = ausd.balanceOf(address(acct));
        vm.expectEmit(address(cm));
        emit ICoverManager.RefundClaimed(address(acct), ESCROW);
        assertEq(cm.claimRefund(address(acct)), ESCROW);
        assertEq(ausd.balanceOf(address(acct)) - w0, ESCROW);
        assertEq(cm.refundOwedTotal(), 0);
        vm.expectRevert(abi.encodeWithSelector(ICoverManager.NoRefundOwed.selector, address(acct)));
        cm.claimRefund(address(acct));
    }

    function test_L05_frozenAccount_syncAndFinalizeDoNotBrick() public {
        bytes32 id = _buy();
        _restBid(MARK, 20);
        ausd.freeze(address(acct));
        acct.trade(2, PERP, MARK, 20, 0); // resize refund cannot land: recorded, trade goes through
        assertEq(cm.refundOwed(address(acct)), ESCROW - 12_468);
        ausd.unfreeze(address(acct));
        cm.claimRefund(address(acct));

        _setRefs(MARK);
        _pastWarmup();
        _crash(830_000, BID_X, 12); // partial fill: a refund is due at finalize
        cm.arm(id);
        _roll(1);
        cm.trigger(id);
        ausd.freeze(address(acct));
        _roll(41);
        cm.finalize(id);
        assertEq(uint8(_status(id)), uint8(CoverStatus.Finalized));
        assertGt(cm.refundOwed(address(acct)), 0);
        assertEq(vault.reservedTotal(), 0);
    }

    function test_expire_triggered_badStatus() public {
        bytes32 id = _triggered();
        _roll(12_001);
        vm.expectRevert(abi.encodeWithSelector(ICoverManager.BadStatus.selector, id, CoverStatus.Triggered));
        cm.expire(id);
    }

    function test_voidCover_intactLiquidatedAdl() public {
        bytes32 id = _buy();
        vm.expectRevert(abi.encodeWithSelector(ICoverManager.PositionIntact.selector, id));
        cm.voidCover(id);
        ex.adl(PERP, acct.perplAccountId(), 10); // 40 < 50 lots covered
        vm.expectEmit(address(cm));
        emit ICoverManager.CoverEnded(id, CoverStatus.Voided, EndReason.LiquidatedOrAdl, ESCROW);
        cm.voidCover(id);
        assertEq(vault.reservedTotal(), 0);
        vm.expectRevert(abi.encodeWithSelector(ICoverManager.BadStatus.selector, id, CoverStatus.Voided));
        cm.voidCover(id);
    }

    function test_voidCover_triggered_badStatus() public {
        bytes32 id = _triggered();
        vm.expectRevert(abi.encodeWithSelector(ICoverManager.BadStatus.selector, id, CoverStatus.Triggered));
        cm.voidCover(id);
    }

    function test_syncCover_resizeOnReduce() public {
        bytes32 id = _buy();
        _restBid(MARK, 20); // far from the stop: the freed escrow is refunded
        uint256 w0 = ausd.balanceOf(address(acct));
        // newCap = ceil(830,825 x 30 / 50) = 498,495; newEscrow = ceil(20,779 x 30 / 50) = 12,468 (12,467.4)
        vm.expectEmit(address(cm));
        emit ICoverManager.CoverResized(id, 30, CAP - 498_495, ESCROW - 12_468);
        acct.trade(2, PERP, MARK, 20, 0);
        Cover memory c = _cover(id);
        assertEq(c.lots, 30);
        assertEq(c.capCNS, 498_495);
        assertEq(c.escrowCNS, 12_468);
        assertEq(c.rentCNS, RENT);
        assertEq(ausd.balanceOf(address(acct)) - w0, ESCROW - 12_468);
        assertEq(vault.reservedTotal(), 498_495);
        assertEq(ausd.balanceOf(address(cm)), 12_468 + RENT);
    }

    function test_syncCover_closeVoids_flipVoids_increaseNoop() public {
        bytes32 id = _buy();
        maker.rest(1, PERP, MARK, 10);
        acct.trade(0, PERP, MARK, 10, 1000); // increase: cover unchanged
        assertEq(_cover(id).lots, LOTS);
        _restBid(MARK, 60);
        vm.expectEmit(address(cm));
        emit ICoverManager.CoverEnded(id, CoverStatus.Voided, EndReason.PositionClosedOrFlipped, ESCROW);
        acct.trade(2, PERP, MARK, 60, 0);

        AccountStub b = _newAccount(100e6);
        _openLong(b, LOTS);
        bytes32 id2 = _buy(b, _params());
        _restBid(MARK, 70);
        b.trade(1, PERP, MARK, 70, 1000); // flips to a 20-lot short
        assertEq(uint8(_status(id2)), uint8(CoverStatus.Voided));
        b.sync(PERP); // no active cover: no-op
    }

    function test_syncCover_notAccount() public {
        vm.expectRevert(ICoverManager.NotAccount.selector);
        cm.syncCover(address(acct), PERP);
    }

    /// @dev U3: a direct syncCover on a Triggered cover is a no-op, even after the position shrank.
    function test_syncCover_onTriggered_noop() public {
        bytes32 id = _buy();
        _pastWarmup();
        _crash(830_000, BID_X, 20);
        cm.arm(id);
        _roll(1);
        cm.trigger(id);
        Cover memory c0 = _cover(id);
        _restBid(MARK, 10);
        acct.trade(2, PERP, BID_X, 10, 0); // stub trade: Triggered cover is not resized
        acct.sync(PERP);
        Cover memory c1 = _cover(id);
        assertEq(uint8(c1.status), uint8(CoverStatus.Triggered));
        assertEq(c1.lots, c0.lots);
        assertEq(c1.escrowCNS, c0.escrowCNS);
        assertEq(c1.capCNS, c0.capCNS);
    }

    function test_cancelCover() public {
        bytes32 id = _buy();
        AccountStub b = _newAccount(100e6);
        vm.prank(address(b));
        vm.expectRevert(abi.encodeWithSelector(ICoverManager.NotCoverAccount.selector, id));
        cm.cancelCover(address(b), id);
        // Far from the stop and never armed: full escrow refund
        uint256 w0 = ausd.balanceOf(address(acct));
        vm.expectEmit(address(cm));
        emit ICoverManager.CoverEnded(id, CoverStatus.Cancelled, EndReason.OwnerCancel, ESCROW);
        acct.cancelCover(id);
        assertEq(ausd.balanceOf(address(acct)) - w0, ESCROW);
        assertEq(vault.premiumIn(), RENT);
        // A fresh cover can be bought after the end
        _setRefs(MARK);
        bytes32 id2 = _buy(acct, _params());
        assertTrue(id2 != id);
        _roll(200);
        _setSplitRefs(831_000, 830_500);
        cm.arm(id2);
        vm.expectRevert(abi.encodeWithSelector(ICoverManager.BadStatus.selector, id2, CoverStatus.Armed));
        acct.cancelCover(id2); // A5: arming locks cancels
        _roll(201); // TTL lapsed: Live again
        _setRefs(MARK);
        w0 = ausd.balanceOf(address(acct));
        vm.expectEmit(address(cm));
        emit ICoverManager.CoverEnded(id2, CoverStatus.Cancelled, EndReason.OwnerCancel, 0); // M-03: armed once
        acct.cancelCover(id2);
        assertEq(ausd.balanceOf(address(acct)), w0);
        assertEq(vault.premiumIn(), 2 * RENT + ESCROW);
    }

    // Views

    function test_watchList_and_housekeeping() public {
        bytes32 a = _buy(); // will be armable
        AccountStub b2 = _newAccount(100e6);
        _openLong(b2, LOTS);
        CoverParams memory far = _params();
        far.stopPNS = 825_000; // 119 bps: never within refTol of 831,000
        bytes32 b = _buy(b2, far);
        AccountStub c3 = _newAccount(100e6);
        _openLong(c3, LOTS);
        CoverParams memory short_ = _params();
        short_.durationBlocks = 1000;
        bytes32 c = _buy(c3, short_); // will expire
        _roll(1001);
        _setSplitRefs(831_000, 830_500); // median through a's stop, mark above it: arm candidate, no fast path
        (bytes32[] memory toArm, bytes32[] memory toTrig) = cm.watchList(PERP, 16);
        assertEq(toArm.length, 1);
        assertEq(toArm[0], a);
        assertEq(toTrig.length, 0);
        (bytes32[] memory obs, bytes32[] memory fin, bytes32[] memory exp, bytes32[] memory vd) =
            cm.housekeeping(PERP, 16);
        assertEq(obs.length + fin.length + vd.length, 0);
        assertEq(exp.length, 1);
        assertEq(exp[0], c);
        ex.liquidate(PERP, b2.perplAccountId());
        (,,, vd) = cm.housekeeping(PERP, 16);
        assertEq(vd.length, 1);
        assertEq(vd[0], b);
        cm.arm(a);
        _roll(1);
        _setSplitRefs(831_000, 830_500);
        (toArm, toTrig) = cm.watchList(PERP, 16);
        assertEq(toTrig.length, 1);
        assertEq(toTrig[0], a);
        (toArm, toTrig) = cm.watchList(PERP, 0);
        assertEq(toTrig.length, 0);
        (toArm, toTrig) = cm.watchList(77, 16); // unlisted: empty, no revert
        assertEq(toArm.length, 0);
    }

    function test_housekeeping_observeAndFinalize() public {
        bytes32 id = _triggered();
        _roll(1);
        (bytes32[] memory obs, bytes32[] memory fin,,) = cm.housekeeping(PERP, 16);
        assertEq(obs.length + fin.length, 0);
        _setRefs(829_900);
        (obs, fin,,) = cm.housekeeping(PERP, 16);
        assertEq(obs.length, 1);
        assertEq(obs[0], id);
        cm.observe(id);
        (obs, fin,,) = cm.housekeeping(PERP, 16);
        assertEq(fin.length, 1);
    }

    function test_referencePrice_medianAndLeastFavorable() public {
        _setRefs(835_000);
        ex.setOracle(PERP, 834_000);
        feed.setAnswer(833_000e7);
        (uint256 r, uint8 n) = cm.referencePrice(PERP, true, 0);
        assertEq(n, 3);
        assertEq(r, 834_000);
        vm.warp(block.timestamp + 100); // mark and oracle stale, feed fresh
        (r, n) = cm.referencePrice(PERP, false, 0);
        assertEq(n, 1);
        assertEq(r, 833_000);
        feed.setReverts(true); // feed outage tolerated
        (r, n) = cm.referencePrice(PERP, true, 0);
        assertEq(n, 0);
        assertEq(r, 0);
        vm.expectRevert(abi.encodeWithSelector(ICoverManager.MarketNotListed.selector, 5));
        cm.referencePrice(5, true, 0);
    }

    function test_ignOracle_dropsTheOracleSource() public {
        (, uint8 n) = cm.referencePrice(PERP, true, 0);
        assertEq(n, 3);
        ex.setIgnOracle(PERP, true);
        (, n) = cm.referencePrice(PERP, true, 0);
        assertEq(n, 2);
    }

    // M-02 quote sources

    function test_M02_quote_leastFavorableFreshSource() public {
        feed.setAnswer(833_000e7); // fresh feed 24 bps closer to the stop than the mark
        Quote memory q = cm.quote(address(acct), _params());
        assertEq(q.distanceBps, (833_000 - STOP) * 1e4 / 833_000);
        vm.warp(block.timestamp + 121); // feed stale, mark and oracle republished: the stale low feed is ignored
        ex.setMark(PERP, MARK);
        ex.setOracle(PERP, MARK);
        assertEq(cm.quote(address(acct), _params()).distanceBps, 50);
        ex.setOracle(PERP, 830_000); // fresh oracle already through the stop
        vm.expectRevert(ICoverManager.StopWrongSide.selector);
        cm.quote(address(acct), _params());
    }

    function test_M02_quote_bookTopCounts() public {
        _restBid(831_500, 1); // best bid 8 bps above the stop, references far
        vm.expectRevert(abi.encodeWithSelector(ICoverManager.StopTooClose.selector, 8, 11));
        cm.quote(address(acct), _params());
        AccountStub s_ = _newAccount(100e6);
        _openShort(s_, LOTS);
        CoverParams memory p = _params();
        p.isLong = false;
        p.stopPNS = 839_175;
        _restAsk(839_000, 1); // best ask 2 bps under a short stop
        vm.expectRevert(abi.encodeWithSelector(ICoverManager.StopTooClose.selector, 2, 11));
        cm.quote(address(s_), p);
        _restAsk(839_175, 1);
    }

    // L-01 observe fallback

    function test_L01_markOnlyAccepted_whenNoOtherSourceExists() public {
        bytes32 id = _triggered();
        _roll(2);
        ex.setMark(PERP, 829_900);
        assertFalse(cm.observe(id), "feed configured: mark alone is not enough");
        ex.setOracle(PERP, 829_900); // oracle alone (non-mark) is enough
        assertTrue(cm.observe(id));
    }

    function test_L01_markOnly_fallbackOnMarketWithoutFeed() public {
        ex.listPerp(3, "MON", 6, 0, 1000, 30_000);
        MarketConfig memory c = MarketConfig(false, 6, 0, 1, address(0), 0, address(0));
        vm.prank(admin);
        cm.listMarket(3, c, Constants.defaultMarketParams());
        vm.prank(keeper);
        cm.postSigma(3, 27);
        ex.setIgnOracle(3, true);
        AccountStub m_ = _newAccount(100e6);
        maker.rest(1, 3, 30_000, 1000);
        m_.trade(0, 3, 30_000, 1000, 1000);
        CoverParams memory p = CoverParams(3, true, 1000, 29_850, 200, 12_000);
        bytes32 id = _buy(m_, p);
        _roll(200);
        ex.setMark(3, 29_800);
        ex.setOracle(3, 29_800); // mock opens need a fresh oracle; the manager ignores it (ignOracle)
        maker.rest(0, 3, 29_790, 1000);
        cm.trigger(id); // fast path on the mark
        _roll(2);
        ex.setMark(3, 29_700);
        (bytes32[] memory obs,,,) = cm.housekeeping(3, 16);
        assertEq(obs.length, 1);
        assertTrue(cm.observe(id), "mark is the only source this market has");
    }

    // L-06 Perpl price range

    function test_L06_closeLimitClampedToPerplMax() public {
        ex.listPerp(2, "HI", 1, 5, 2000, 16_700_000);
        vm.prank(admin);
        cm.listMarket(2, _cfgNoFeed(), Constants.defaultMarketParams());
        vm.prank(keeper);
        cm.postSigma(2, 27);
        AccountStub s_ = _newAccount(100e6);
        maker.rest(0, 2, 16_700_000, 2);
        s_.trade(1, 2, 16_700_000, 2, 1000);
        bytes32 id = _buy(s_, CoverParams(2, false, 2, 16_768_000, 200, 12_000));
        _roll(200);
        ex.setMark(2, 16_770_000);
        ex.setOracle(2, 16_770_000);
        // ceil(16,770,000 x 1.0005) = 16,778,385 is above Perpl's range: clamped, so the venue accepts the IOC
        vm.expectEmit(address(cm));
        emit ICoverManager.TriggerNoFill(id, block.number, Constants.PERPL_MAX_PRICE_PNS);
        cm.trigger(id);
        maker.rest(1, 2, 16_775_000, 2);
        _roll(1);
        ex.setMark(2, 16_770_000);
        ex.setOracle(2, 16_770_000);
        cm.trigger(id);
        assertEq(_cover(id).filledLots, 2);
    }

    function _cfgNoFeed() internal pure returns (MarketConfig memory c) {
        c = MarketConfig(false, 1, 5, 1, address(0), 0, address(0));
    }

    function test_L06_listMarket_rejectsNonzeroBase() public {
        ex.listPerp(2, "B", 1, 5, 2000, 835_000);
        ex.setBasePricePNS(2, 100_000);
        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(ICoverManager.ParamOutOfBounds.selector, Constants.F_MARKET_CONFIG));
        cm.listMarket(2, _cfgNoFeed(), Constants.defaultMarketParams());
    }

    // Per-market pause (I-02)

    function test_pauseMarket_blocksBuysOnThatMarketOnly() public {
        bytes32 id = _buy();
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, address(this), Constants.PAUSER_ROLE
            )
        );
        cm.pauseMarket(PERP);
        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(ICoverManager.MarketNotListed.selector, 9));
        cm.pauseMarket(9);
        vm.expectEmit(address(cm));
        emit ICoverManager.MarketPauseSet(PERP, true);
        vm.prank(admin);
        cm.pauseMarket(PERP);
        assertTrue(cm.marketPaused(PERP));
        AccountStub b = _newAccount(100e6);
        _openLong(b, LOTS);
        vm.expectRevert(abi.encodeWithSelector(ICoverManager.MarketPaused.selector, PERP));
        cm.quote(address(b), _params());
        _pastWarmup();
        _crash(830_000, BID_X, LOTS);
        assertEq(_armAndTrigger(id), PAID_FULL, "lifecycle never pauses");
        vm.prank(admin);
        cm.unpauseMarket(PERP);
        assertFalse(cm.marketPaused(PERP));
        _setRefs(MARK);
        _restBid(MARK, 1);
        cm.quote(address(b), _params());
    }

    // L-09 capacity share

    function test_L09_coverShareCapped() public {
        vault.setTotalAssets(10e6); // market limit 5 AUSD, one cover may use 0.5 AUSD of Cap
        vm.expectRevert(abi.encodeWithSelector(ICoverManager.CoverShareExceeded.selector, CAP, 500_000));
        cm.quote(address(acct), _params());
        CoverParams memory p = _params();
        p.lots = 30; // Cap 498,495
        cm.quote(address(acct), p);
    }

    // C5: N-01 chain steps, N-02 post-expiry semantics, L-03 snapshots, L-09 rent floor

    function test_N01_stepsCapAtFloorSlack() public {
        bytes32 id = _buy();
        _pastWarmup();
        _setRefs(830_000); // no bids at all: every attempt is short
        uint256[7] memory lim = [uint256(TIGHT_FLOOR), STEP1_FLOOR, 828_340, 826_680, 823_360, WIDE_FLOOR, WIDE_FLOOR];
        for (uint256 k; k < 8; ++k) {
            vm.expectEmit(address(cm));
            emit ICoverManager.TriggerNoFill(id, block.number, lim[k < 7 ? k : 6]);
            cm.trigger(id);
            _roll(1);
            _setRefs(830_000);
        }
        assertEq(_cover(id).shortSteps, Constants.CLOSE_FLOOR_MAX_STEPS);
    }

    /// @dev Short side: ceil(max(stop, R) x (1 + A x 2^k)).
    function test_N01_steps_shortSide() public {
        AccountStub b = _newAccount(100e6);
        _openShort(b, LOTS);
        CoverParams memory p = _params();
        p.isLong = false;
        p.stopPNS = 839_175; // 50 bps above MARK
        bytes32 id = _buy(b, p);
        _pastWarmup();
        _setRefs(840_000);
        vm.expectEmit(address(cm));
        emit ICoverManager.TriggerNoFill(id, block.number, 840_420); // ceil(840,000 x 1.0005)
        cm.trigger(id);
        _roll(1);
        _setRefs(840_000);
        vm.expectEmit(address(cm));
        emit ICoverManager.TriggerNoFill(id, block.number, 840_840); // step 1: 10 bps
        cm.trigger(id);
        _roll(1);
        _setRefs(840_000);
        _restAsk(841_600, LOTS);
        cm.trigger(id); // step 2: 841,680 reaches the ask
        assertEq(_cover(id).filledLots, LOTS);
        assertEq(_cover(id).shortBlock, 0, "full fill ends the chain");
    }

    /// @dev SA3-02 short side: 16 one-lot asks use up maxMatches while honest asks sit inside the step-0 limit, so
    /// the attempt does not step and a same-block retry fills at step 0.
    function test_SA3_02_shortSide_matchLimitedDoesNotStep() public {
        AccountStub b = _newAccount(100e6);
        _openShort(b, LOTS);
        CoverParams memory p = _params();
        p.isLong = false;
        p.stopPNS = 839_175;
        bytes32 id = _buy(b, p);
        _pastWarmup();
        _setRefs(840_000);
        for (uint256 i; i < 16; ++i) {
            _restAsk(840_000, 1);
        }
        _restAsk(840_300, LOTS); // <= ceil(840,000 x 1.0005) = 840,420
        cm.trigger(id);
        assertEq(_cover(id).filledLots, 16);
        assertEq(_cover(id).shortBlock, 0, "match-limited: no step");
        cm.trigger(id);
        assertEq(_cover(id).filledLots, LOTS);
    }

    /// @dev The chain carries into remainder retries while R and R_trig stay through; R back above ends it.
    function test_N01_remainderChain() public {
        bytes32 id = _buy();
        _pastWarmup();
        _crash(830_000, BID_X, 20);
        cm.arm(id);
        _roll(1);
        _setRefs(830_000);
        cm.trigger(id); // fills 20 at 829,600, short with R through: chain step 1
        assertEq(_cover(id).shortSteps, 1);
        uint256 snap = vm.snapshotState();
        _roll(1);
        _setRefs(830_000);
        vm.expectEmit(address(cm));
        emit ICoverManager.TriggerNoFill(id, block.number, STEP1_FLOOR);
        cm.trigger(id);
        _roll(1);
        _setRefs(830_000);
        _restBid(829_000, 30);
        cm.trigger(id); // step 2 fills the rest
        assertEq(_cover(id).filledLots, LOTS);

        vm.revertToState(snap);
        _roll(1);
        _setRefs(MARK); // R back above the stop: tight at R_trig, chain ends
        vm.expectEmit(address(cm));
        emit ICoverManager.TriggerNoFill(id, block.number, TIGHT_FLOOR);
        cm.trigger(id);
        assertEq(_cover(id).shortBlock, 0);
    }

    /// @dev L-03: warmup and window are the purchase-time values for a live cover.
    function test_L03_warmupAndWindowSnapshotted() public {
        bytes32 id = _buy();
        assertEq(_cover(id).warmupBlocks, Constants.WARMUP_BLOCKS);
        assertEq(_cover(id).windowBlocks, Constants.WINDOW_BLOCKS);
        MarketParams memory p = cm.marketParams(PERP);
        p.warmupBlocks = 900;
        p.windowBlocks = 10;
        vm.prank(admin);
        cm.setMarketParams(PERP, p);
        _pastWarmup(); // 200 blocks: ready under the snapshot, not under the live 900
        _crash(830_000, BID_X, LOTS);
        assertTrue(cm.arm(id));
        _roll(1);
        _setRefs(830_000);
        cm.trigger(id);
        _roll(30); // beyond the live window 10, inside the snapshot 40
        _setRefs(829_500);
        assertTrue(cm.observe(id));
        (, bytes32[] memory toTrig) = cm.watchList(PERP, 4);
        assertEq(toTrig.length, 0);
    }

    function test_N02_syncAfterExpiry_isExpiry() public {
        bytes32 id = _buy();
        _roll(12_001);
        _setRefs(830_900); // inside the zone: before expiry this would forfeit
        _restBid(830_900, 20);
        uint256 w0 = ausd.balanceOf(address(acct));
        vm.expectEmit(address(cm));
        emit ICoverManager.CoverEnded(id, CoverStatus.Expired, EndReason.Expired, ESCROW);
        acct.trade(2, PERP, 830_900, 20, 0);
        assertEq(ausd.balanceOf(address(acct)) - w0, ESCROW);
    }

    function test_N02_voidAfterExpiry_isExpiry() public {
        bytes32 id = _buy();
        ex.adl(PERP, acct.perplAccountId(), 10);
        _roll(12_001);
        vm.expectEmit(address(cm));
        emit ICoverManager.CoverEnded(id, CoverStatus.Expired, EndReason.Expired, ESCROW);
        cm.voidCover(id);
    }

    /// @dev L-09: a 4 h cover pays the floor four times; the default 1 h cover is unchanged.
    function test_L09_rentFloorScalesWithDuration() public view {
        CoverParams memory p = _params();
        assertEq(cm.quote(address(acct), p).rentCNS, RENT);
        p.durationBlocks = 12_001;
        assertEq(cm.quote(address(acct), p).rentCNS, 2 * RENT);
        p.durationBlocks = 48_000;
        assertEq(cm.quote(address(acct), p).rentCNS, 4 * RENT);
    }
}
