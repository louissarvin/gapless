// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Test} from "forge-std/Test.sol";
import {PremiumMath} from "../../src/libraries/PremiumMath.sol";
import {Constants} from "../../src/Constants.sol";
import {MarketParams, Quote} from "../../src/types/GaplessTypes.sol";

/// @notice Quote properties: monotone in lots and utilization (escrow, rent, Cap), rent monotone in duration,
/// minDistance monotone in sigma, I13 (escrow >= A x N), ceilings on user-paid amounts, floor on Cap.
/// @dev Escrow is not monotone in sigma or duration: both move z across buckets of a fitted, non-monotone
/// gap table (default 194, 91, 101, ...), so only rent is checked against duration.
contract QuoteFuzzTest is Test {
    function _params(uint256 seed) internal pure returns (MarketParams memory p) {
        p = Constants.defaultMarketParams();
        p.maxCoverNotionalCNS = 100_000e6;
        if (seed % 3 == 0) return p;
        p.slipAllowanceBps = uint16(5 + seed % 46);
        p.loadBps = uint16(seed % 20_001);
        p.rentAprBps = uint16((seed >> 16) % 10_001);
        p.uKinkBps = uint16(1000 + (seed >> 32) % 8001);
        p.slope1Bps = uint16((seed >> 48) % 20_001);
        p.slope2Bps = uint16((seed >> 64) % 60_001);
        p.impactBpsPerKE2 = uint16((seed >> 80) % 1001);
        p.minFeeCNS = uint80((seed >> 96) % 1_000_001);
    }

    function _input(uint256 lots, uint256 reserved, uint256 sigma, uint32 duration)
        internal
        pure
        returns (PremiumMath.QuoteInput memory)
    {
        return PremiumMath.QuoteInput(lots, 830_825, true, 200, duration, 835_000, 1, sigma, reserved, 10_000_000e6, 1);
    }

    function testFuzz_monotoneInLots(uint256 seed, uint256 a, uint256 b, uint256 sigma) public pure {
        MarketParams memory p = _params(seed);
        sigma = bound(sigma, 5, 27); // keeps the 50 bps stop above minDist
        a = bound(a, 1, 120_000);
        b = bound(b, a, 120_000); // N <= 100,000 AUSD
        Quote memory qa = PremiumMath.quote(p, _input(a, 0, sigma, 12_000));
        Quote memory qb = PremiumMath.quote(p, _input(b, 0, sigma, 12_000));
        assertLe(qa.escrowCNS, qb.escrowCNS);
        assertLe(qa.rentCNS, qb.rentCNS);
        assertLe(qa.capCNS, qb.capCNS);
    }

    function testFuzz_monotoneInUtilization(uint256 seed, uint256 r1, uint256 r2, uint256 lots) public pure {
        MarketParams memory p = _params(seed);
        lots = bound(lots, 1, 60);
        r1 = bound(r1, 0, 8_000_000e6);
        r2 = bound(r2, r1, 8_000_000e6);
        Quote memory q1 = PremiumMath.quote(p, _input(lots, r1, 27, 12_000));
        Quote memory q2 = PremiumMath.quote(p, _input(lots, r2, 27, 12_000));
        assertLe(q1.utilAfterBps, q2.utilAfterBps);
        assertLe(q1.escrowCNS, q2.escrowCNS);
        assertLe(q1.rentCNS, q2.rentCNS);
    }

    function testFuzz_rentMonotoneInDuration(uint256 seed, uint32 t1, uint32 t2, uint256 lots) public pure {
        MarketParams memory p = _params(seed);
        lots = bound(lots, 1, 60);
        t1 = uint32(bound(t1, 1000, 48_000));
        t2 = uint32(bound(t2, t1, 48_000));
        Quote memory q1 = PremiumMath.quote(p, _input(lots, 0, 27, t1));
        Quote memory q2 = PremiumMath.quote(p, _input(lots, 0, 27, t2));
        assertLe(q1.rentCNS, q2.rentCNS);
    }

    function testFuzz_minDistanceMonotoneInSigma(uint256 s1, uint256 s2, uint32 warmup) public pure {
        MarketParams memory p = Constants.defaultMarketParams();
        p.warmupBlocks = uint32(bound(warmup, 100, 2000));
        s1 = bound(s1, 5, 2000);
        s2 = bound(s2, s1, 2000);
        assertLe(PremiumMath.minDistanceBps(p, s1), PremiumMath.minDistanceBps(p, s2));
    }

    /// @dev I13 and rounding direction for any in-bounds params and inputs.
    function testFuzz_roundingFavorsVault(uint256 seed, uint256 lots, uint256 reserved, uint16 maxGap, uint32 t)
        public
        pure
    {
        MarketParams memory p = _params(seed);
        lots = bound(lots, 1, 120_000);
        reserved = bound(reserved, 0, 8_000_000e6);
        maxGap = uint16(bound(maxGap, 50, 200));
        t = uint32(bound(t, 1000, 48_000));
        PremiumMath.QuoteInput memory qi = _input(lots, reserved, 20, t);
        qi.maxGapBps = maxGap;
        Quote memory q = PremiumMath.quote(p, qi);
        uint256 n = q.notionalCNS;
        assertGe(q.feeBpsE2, uint256(p.slipAllowanceBps) * 100, "fee >= A");
        assertGe(q.escrowCNS * 1e4, n * p.slipAllowanceBps, "I13 escrow >= A x N");
        assertLe(q.capCNS * 1e4, n * maxGap, "Cap floors");
        assertGt((q.capCNS + 1) * 1e4, n * maxGap, "Cap is the floor");
        uint256 m = PremiumMath.multiplierBps(p, q.utilAfterBps);
        assertGe(q.escrowCNS * 1e10, n * q.feeBpsE2 * m, "escrow ceils");
        if (q.escrowCNS > 0) assertLt((q.escrowCNS - 1) * 1e10, n * q.feeBpsE2 * m, "escrow is the ceiling");
        assertGe(q.rentCNS, p.minFeeCNS, "rent floor");
        assertGe(q.utilAfterBps * 10_000_000e6, (reserved + q.capCNS) * 1e4, "util ceils");
    }
}
