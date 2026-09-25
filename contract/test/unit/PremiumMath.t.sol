// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Test} from "forge-std/Test.sol";
import {PremiumMath} from "../../src/libraries/PremiumMath.sol";
import {ICoverManager} from "../../src/interfaces/ICoverManager.sol";
import {Constants} from "../../src/Constants.sol";
import {MarketParams, Quote} from "../../src/types/GaplessTypes.sol";

/// @dev External wrapper so library reverts are catchable.
contract PremiumMathHarness {
    function quote(MarketParams memory p, PremiumMath.QuoteInput memory q) external pure returns (Quote memory) {
        return PremiumMath.quote(p, q);
    }

    function distanceBps(uint256 mark, uint256 stop, bool isLong) external pure returns (uint256) {
        return PremiumMath.distanceBps(mark, stop, isLong);
    }
}

contract PremiumMathTest is Test {
    PremiumMathHarness internal h = new PremiumMathHarness();

    function _p() internal pure returns (MarketParams memory) {
        return Constants.defaultMarketParams();
    }

    // Hand-computed vectors (spec 3.5, 05 section 2.6; backend math.test.ts)

    function test_notional() public pure {
        assertEq(PremiumMath.notionalCNS(10_000, 830_825, 1), 8_308_250_000); // 0.1 BTC at 83,082.5
        assertEq(PremiumMath.notionalCNS(3, 2_500, 10), 75_000); // ETH-like scale 10
    }

    function test_distance_floorAndSides() public {
        assertEq(PremiumMath.distanceBps(835_000, 830_825, true), 50); // 4175e4 / 835000 = 50 exactly
        assertEq(PremiumMath.distanceBps(835_000, 830_826, true), 49); // 49.99 floors
        assertEq(PremiumMath.distanceBps(835_000, 839_175, false), 50);
        vm.expectRevert(ICoverManager.StopWrongSide.selector);
        h.distanceBps(835_000, 835_000, true);
        vm.expectRevert(ICoverManager.StopWrongSide.selector);
        h.distanceBps(835_000, 840_000, true);
        vm.expectRevert(ICoverManager.StopWrongSide.selector);
        h.distanceBps(835_000, 835_000, false);
        vm.expectRevert(ICoverManager.StopWrongSide.selector);
        h.distanceBps(835_000, 830_000, false);
    }

    function test_minDistance() public pure {
        // sqrt(200) = 14: calm 300 x 27 x 14 / 1e4 = 11.34 -> 11; stressed 300 x 163 x 14 / 1e4 = 68.46 -> 68
        assertEq(PremiumMath.minDistanceBps(_p(), 27), 11);
        assertEq(PremiumMath.minDistanceBps(_p(), 163), 68);
        assertEq(PremiumMath.minDistanceBps(_p(), 5), 10); // floor minStopDistanceBps
    }

    function test_zE2() public pure {
        assertEq(PremiumMath.zE2(50, 27, 12_000), 169); // 500000 / (27 x 109)
        assertEq(PremiumMath.zE2(100, 163, 12_000), 56); // 1e6 / (163 x 109) = 56.28
        assertEq(PremiumMath.zE2(0, 27, 12_000), 0);
    }

    function test_bucket_edges() public pure {
        uint16[8] memory e = _p().zEdgesE2;
        assertEq(PremiumMath.bucket(e, 0), 0);
        assertEq(PremiumMath.bucket(e, 49), 0);
        assertEq(PremiumMath.bucket(e, 50), 1);
        assertEq(PremiumMath.bucket(e, 169), 3);
        assertEq(PremiumMath.bucket(e, 599), 7);
        assertEq(PremiumMath.bucket(e, 600), 8);
        assertEq(PremiumMath.bucket(e, type(uint256).max), 8);
    }

    function test_fee_floorAtA_capAndLoad() public pure {
        MarketParams memory p = _p();
        // bucket 3 gap 143, impact 10 x 8.308e9 / 1e9 = 83: gTrig 226, x1.5 = 339 < A x 100 = 500
        assertEq(PremiumMath.feeBpsE2(p, 3, 8_308_250_000), 500);
        // bucket 7 gap 999 + 0 impact: ceil(999 x 1.5) = 1498.5 -> 1499
        assertEq(PremiumMath.feeBpsE2(p, 7, 1), 1499);
        // gap + impact capped at maxGapBpsCap x 100 = 20000, then loaded: 30000
        assertEq(PremiumMath.feeBpsE2(p, 7, 1e18), 30_000);
    }

    function test_cap_floor() public pure {
        assertEq(PremiumMath.capCNS(8_308_250_000, 200), 166_165_000);
        assertEq(PremiumMath.capCNS(41_541_251, 200), 830_825); // 830825.02 floors
    }

    function test_utilAfter_ceil() public pure {
        assertEq(PremiumMath.utilAfterBps(300e6, 166_165_000, 2000e6), 2331); // 23.308% ceils
        assertEq(PremiumMath.utilAfterBps(0, 830_825, 1000e6), 9); // 8.3 ceils
        assertEq(PremiumMath.utilAfterBps(0, 0, 1000e6), 0);
        assertEq(PremiumMath.utilAfterBps(0, 1, 0), type(uint256).max);
    }

    function test_multiplier_kink() public pure {
        assertEq(PremiumMath.multiplierBps(_p(), 0), 10_000);
        assertEq(PremiumMath.multiplierBps(_p(), 2330), 11_165);
        assertEq(PremiumMath.multiplierBps(_p(), 5000), 12_500);
        assertEq(PremiumMath.multiplierBps(_p(), 7320), 21_780); // 05 section 2.6 "M = 2.179"
        assertEq(PremiumMath.multiplierBps(_p(), 9), 10_004); // 4.5 floors
    }

    function test_escrow_rent_workedExample() public pure {
        // backend math.test.ts: escrow = ceil(8,308,250,000 x 500 x 11,165 / 1e10) = 4,638,081
        assertEq(PremiumMath.escrowCNS(8_308_250_000, 500, 11_165), 4_638_081);
        // raw rent 0.004 AUSD floors to minFeeCNS 20,000
        assertEq(PremiumMath.rentCNS(_p(), 166_165_000, 12_000, 11_165), 20_000);
        MarketParams memory p = _p();
        p.minFeeCNS = 0;
        // ceil(166,165,000 x 2000 x 12,000 x 11,165 / (1e8 x 105,120,000)) = ceil(4235.6) = 4236
        assertEq(PremiumMath.rentCNS(p, 166_165_000, 12_000, 11_165), 4236);
    }

    /// @dev L-09: minFeeCNS per started 12,000 blocks; parity rentCNS is unchanged.
    function test_rentFloor_perStartedPeriod() public pure {
        assertEq(PremiumMath.rentFloorCNS(20_000, 500), 20_000);
        assertEq(PremiumMath.rentFloorCNS(20_000, 12_000), 20_000);
        assertEq(PremiumMath.rentFloorCNS(20_000, 12_001), 40_000);
        assertEq(PremiumMath.rentFloorCNS(20_000, 48_000), 80_000);
        assertEq(PremiumMath.rentFloorCNS(0, 48_000), 0);
    }

    function test_quote_endToEnd_unitHarness() public pure {
        PremiumMath.QuoteInput memory q = PremiumMath.QuoteInput({
            lots: 50,
            stopPNS: 830_825,
            isLong: true,
            maxGapBps: 200,
            durationBlocks: 12_000,
            markPNS: 835_000,
            scale: 1,
            sigmaBlkBpsE2: 27,
            reservedTotalCNS: 0,
            totalAssetsCNS: 1000e6,
            blockNumber: 7
        });
        Quote memory r = PremiumMath.quote(_p(), q);
        assertEq(r.notionalCNS, 41_541_250);
        assertEq(r.capCNS, 830_825);
        assertEq(r.distanceBps, 50);
        assertEq(r.minDistanceBps, 11);
        assertEq(r.feeBpsE2, 500);
        assertEq(r.utilAfterBps, 9);
        assertEq(r.escrowCNS, 20_779); // ceil(41,541,250 x 500 x 10,004 / 1e10) = ceil(20,778.93)
        assertEq(r.rentCNS, 20_000);
        assertEq(r.expiryBlock, 12_007);
        assertGe(r.escrowCNS * 1e4, r.notionalCNS * 5); // I13
    }

    function test_quote_reverts() public {
        MarketParams memory p = _p();
        PremiumMath.QuoteInput memory q = PremiumMath.QuoteInput(50, 830_825, true, 200, 12_000, 835_000, 1, 27, 0, 1e9, 1);
        q.durationBlocks = 999;
        vm.expectRevert(abi.encodeWithSelector(ICoverManager.DurationOutOfRange.selector, uint32(999)));
        h.quote(p, q);
        q.durationBlocks = 48_001;
        vm.expectRevert(abi.encodeWithSelector(ICoverManager.DurationOutOfRange.selector, uint32(48_001)));
        h.quote(p, q);
        q.durationBlocks = 12_000;
        q.maxGapBps = 49;
        vm.expectRevert(abi.encodeWithSelector(ICoverManager.MaxGapOutOfRange.selector, uint16(49)));
        h.quote(p, q);
        q.maxGapBps = 201;
        vm.expectRevert(abi.encodeWithSelector(ICoverManager.MaxGapOutOfRange.selector, uint16(201)));
        h.quote(p, q);
        q.maxGapBps = 200;
        q.lots = 61; // 61 x 830,825 = 50,680,325 > 50e6
        vm.expectRevert(abi.encodeWithSelector(ICoverManager.NotionalTooLarge.selector, 50_680_325));
        h.quote(p, q);
        q.lots = 50;
        q.sigmaBlkBpsE2 = 163; // minDist 68 > 50
        vm.expectRevert(abi.encodeWithSelector(ICoverManager.StopTooClose.selector, 50, 68));
        h.quote(p, q);
        q.sigmaBlkBpsE2 = 27;
        q.stopPNS = 836_000;
        vm.expectRevert(ICoverManager.StopWrongSide.selector);
        h.quote(p, q);
    }

    function test_quote_emptyVault_noOverflow() public pure {
        PremiumMath.QuoteInput memory q = PremiumMath.QuoteInput(50, 830_825, true, 200, 12_000, 835_000, 1, 27, 0, 0, 1);
        Quote memory r = PremiumMath.quote(_p(), q);
        assertEq(r.utilAfterBps, type(uint256).max); // caller rejects
    }

    // Parity with backend/src/jobs/premium.ts (test/fixtures/premium_vectors.json, 400 seeded vectors)

    function test_parity_premiumTs() public view {
        string memory j = vm.readFile("test/fixtures/premium_vectors.json");
        uint256 n = vm.parseJsonUint(j, ".n");
        uint256[][] memory in_ = new uint256[][](12);
        string[12] memory keys = [
            ".slipAllowanceBps",
            ".maxGapBpsCap",
            ".minStopDistanceBps",
            ".kDistE2",
            ".loadBps",
            ".rentAprBps",
            ".uKinkBps",
            ".slope1Bps",
            ".slope2Bps",
            ".impactBpsPerKE2",
            ".warmupBlocks",
            ".minFeeCNS"
        ];
        for (uint256 k; k < 12; ++k) {
            in_[k] = vm.parseJsonUintArray(j, keys[k]);
        }
        uint256[][] memory z = new uint256[][](8);
        for (uint256 k; k < 8; ++k) {
            z[k] = vm.parseJsonUintArray(j, string.concat(".z", vm.toString(k)));
        }
        uint256[][] memory g = new uint256[][](9);
        for (uint256 k; k < 9; ++k) {
            g[k] = vm.parseJsonUintArray(j, string.concat(".g", vm.toString(k)));
        }
        uint256[][] memory x = new uint256[][](14);
        string[14] memory xk = [
            ".notional",
            ".distance",
            ".sigma",
            ".duration",
            ".maxGap",
            ".util",
            ".outMinDist",
            ".outZ",
            ".outBucket",
            ".outFee",
            ".outCap",
            ".outM",
            ".outEscrow",
            ".outRent"
        ];
        for (uint256 k; k < 14; ++k) {
            x[k] = vm.parseJsonUintArray(j, xk[k]);
        }
        for (uint256 i; i < n; ++i) {
            MarketParams memory p = _p();
            p.slipAllowanceBps = uint16(in_[0][i]);
            p.maxGapBpsCap = uint16(in_[1][i]);
            p.minStopDistanceBps = uint16(in_[2][i]);
            p.kDistE2 = uint16(in_[3][i]);
            p.loadBps = uint16(in_[4][i]);
            p.rentAprBps = uint16(in_[5][i]);
            p.uKinkBps = uint16(in_[6][i]);
            p.slope1Bps = uint16(in_[7][i]);
            p.slope2Bps = uint16(in_[8][i]);
            p.impactBpsPerKE2 = uint16(in_[9][i]);
            p.warmupBlocks = uint32(in_[10][i]);
            p.minFeeCNS = uint80(in_[11][i]);
            for (uint256 k; k < 8; ++k) {
                p.zEdgesE2[k] = uint16(z[k][i]);
            }
            for (uint256 k; k < 9; ++k) {
                p.gapBpsE2[k] = uint16(g[k][i]);
            }
            _checkVector(p, x, i);
        }
    }

    function _checkVector(MarketParams memory p, uint256[][] memory x, uint256 i) internal pure {
        uint256 notional = x[0][i];
        uint256 sigma = x[2][i];
        uint256 duration = x[3][i];
        assertEq(PremiumMath.minDistanceBps(p, sigma), x[6][i], "minDist");
        uint256 z = PremiumMath.zE2(x[1][i], sigma, duration);
        assertEq(z, x[7][i], "zE2");
        uint256 b = PremiumMath.bucket(p.zEdgesE2, z);
        assertEq(b, x[8][i], "bucket");
        uint256 fee = PremiumMath.feeBpsE2(p, b, notional);
        assertEq(fee, x[9][i], "fee");
        uint256 cap = PremiumMath.capCNS(notional, uint16(x[4][i]));
        assertEq(cap, x[10][i], "cap");
        uint256 m = PremiumMath.multiplierBps(p, x[5][i]);
        assertEq(m, x[11][i], "M");
        assertEq(PremiumMath.escrowCNS(notional, fee, m), x[12][i], "escrow");
        assertEq(PremiumMath.rentCNS(p, cap, duration, m), x[13][i], "rent");
    }
}
