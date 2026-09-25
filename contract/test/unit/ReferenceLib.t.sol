// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Test} from "forge-std/Test.sol";
import {ReferenceLib} from "../../src/libraries/ReferenceLib.sol";
import {IPerplMin} from "../../src/interfaces/perpl/IPerplMin.sol";
import {Constants} from "../../src/Constants.sol";
import {MarketConfig, MarketParams} from "../../src/types/GaplessTypes.sol";

contract ReferenceLibTest is Test {
    uint256 internal constant NOW = 1_760_000_000;

    function _p() internal pure returns (MarketParams memory) {
        return Constants.defaultMarketParams(); // refFreshSec 60, feedMaxAgeSec 120
    }

    function _c() internal pure returns (MarketConfig memory) {
        return Constants.btcMarketConfig(); // pd 1, feed 8 decimals
    }

    function _all(uint256 mark, uint256 oracle, int256 feed, uint256 ts) internal pure returns (ReferenceLib.Sources memory s) {
        s = ReferenceLib.Sources(mark, ts, oracle, ts, true, feed, ts, false, 0, 0);
    }

    function test_isFresh_boundaries() public pure {
        assertTrue(ReferenceLib.isFresh(NOW - 62, 60, 2, NOW, 0)); // exactly 60 + 2
        assertFalse(ReferenceLib.isFresh(NOW - 63, 60, 2, NOW, 0));
        assertTrue(ReferenceLib.isFresh(NOW + 5, 60, 2, NOW, 0)); // future timestamps are fresh
        assertTrue(ReferenceLib.isFresh(NOW, 60, 2, NOW, NOW));
        assertFalse(ReferenceLib.isFresh(NOW - 1, 60, 2, NOW, NOW)); // published before minTs
    }

    function test_feedToPNS_roundingAgainstClaimant() public pure {
        // 83,082.51234567 USD, 8 decimals -> pd 1: divide by 1e7
        int256 a = 8_308_251_234_567;
        assertEq(ReferenceLib.feedToPNS(a, 8, 1, true), 830_826); // long: ceil
        assertEq(ReferenceLib.feedToPNS(a, 8, 1, false), 830_825); // short: floor
        assertEq(ReferenceLib.feedToPNS(8_308_250_000_000, 8, 1, true), 830_825); // exact
        assertEq(ReferenceLib.feedToPNS(0, 8, 1, true), 0);
        assertEq(ReferenceLib.feedToPNS(-1, 8, 1, false), 0);
        assertEq(ReferenceLib.feedToPNS(123, 6, 6, true), 123); // same decimals
    }

    function test_collect_allFresh_orderAndFeedConversion() public pure {
        ReferenceLib.Sources memory s = _all(835_000, 834_900, 8_351_000_000_000, NOW - 10);
        (uint256[4] memory v, uint8 n) = ReferenceLib.collect(s, _p(), _c(), true, NOW, 0);
        assertEq(n, 3);
        assertEq(v[0], 835_000);
        assertEq(v[1], 834_900);
        assertEq(v[2], 835_100);
    }

    function test_collect_staleAndNonPositive() public pure {
        ReferenceLib.Sources memory s = _all(835_000, 834_900, 8_351_000_000_000, NOW - 10);
        s.markTs = NOW - 63; // stale mark
        s.oraclePNS = 0; // zero oracle
        s.feedUpdatedAt = NOW - 121; // stale feed (no tolerance)
        (, uint8 n) = ReferenceLib.collect(s, _p(), _c(), true, NOW, 0);
        assertEq(n, 0);
        s.feedUpdatedAt = NOW - 120;
        (uint256[4] memory v, uint8 n2) = ReferenceLib.collect(s, _p(), _c(), true, NOW, 0);
        assertEq(n2, 1);
        assertEq(v[0], 835_100);
        s.feedAnswer = -5;
        (, uint8 n3) = ReferenceLib.collect(s, _p(), _c(), true, NOW, 0);
        assertEq(n3, 0);
        s.feedAnswer = 8_351_000_000_000;
        s.feedOk = false; // feed reverted
        (, uint8 n4) = ReferenceLib.collect(s, _p(), _c(), true, NOW, 0);
        assertEq(n4, 0);
    }

    function test_collect_minTs_filtersPreTriggerPublishes() public pure {
        ReferenceLib.Sources memory s = _all(835_000, 834_900, 8_351_000_000_000, NOW - 3);
        s.oracleTs = NOW; // only the oracle published after the trigger second
        (uint256[4] memory v, uint8 n) = ReferenceLib.collect(s, _p(), _c(), true, NOW, NOW - 2);
        assertEq(n, 1);
        assertEq(v[0], 834_900);
    }

    function test_collect_creWithinDeviationOnly() public pure {
        ReferenceLib.Sources memory s = _all(835_000, 834_000, 0, NOW);
        s.feedOk = false;
        s.creOk = true;
        s.creTs = NOW;
        s.crePNS = 834_000 * 10_300 / 10_000; // exactly 300 bps above the oracle
        (, uint8 n) = ReferenceLib.collect(s, _p(), _c(), true, NOW, 0);
        assertEq(n, 3);
        s.crePNS += 1;
        (, uint8 n2) = ReferenceLib.collect(s, _p(), _c(), true, NOW, 0);
        assertEq(n2, 2);
        s.crePNS = 834_000;
        s.oracleTs = NOW - 100; // CRE needs a fresh oracle to compare against
        (, uint8 n3) = ReferenceLib.collect(s, _p(), _c(), true, NOW, 0);
        assertEq(n3, 1);
    }

    function test_aggregate_allCounts() public pure {
        uint256[4] memory v;
        assertEq(ReferenceLib.aggregate(v, 0, true), 0);
        v[0] = 7;
        assertEq(ReferenceLib.aggregate(v, 1, true), 7);
        v = [uint256(10), 5, 0, 0];
        assertEq(ReferenceLib.aggregate(v, 2, true), 10); // long: max
        v = [uint256(10), 5, 0, 0];
        assertEq(ReferenceLib.aggregate(v, 2, false), 5); // short: min
        v = [uint256(30), 10, 20, 0];
        assertEq(ReferenceLib.aggregate(v, 3, true), 20);
        v = [uint256(30), 10, 20, 0];
        assertEq(ReferenceLib.aggregate(v, 3, false), 20);
        v = [uint256(40), 10, 30, 20];
        assertEq(ReferenceLib.aggregate(v, 4, true), 30); // long: higher middle
        v = [uint256(40), 10, 30, 20];
        assertEq(ReferenceLib.aggregate(v, 4, false), 20); // short: lower middle
    }

    function testFuzz_aggregate_isMiddleAndAgainstClaimant(uint256[4] memory v, uint8 n) public pure {
        n = uint8(bound(n, 1, 4));
        uint256[4] memory copy = v;
        uint256 r = ReferenceLib.aggregate(copy, n, true);
        uint256 s = ReferenceLib.aggregate(v, n, false);
        assertGe(r, s); // long reference never below short reference for the same inputs
    }

    function test_bookPNS_sentinelsBothSides() public pure {
        IPerplMin.PerpetualInfo memory info;
        info.basePricePNS = 800_000;
        info.maxBidPriceONS = 30_000;
        info.minAskPriceONS = 35_001;
        (uint256 px, bool empty) = ReferenceLib.bookPNS(info, true);
        assertEq(px, 830_000);
        assertFalse(empty);
        (px, empty) = ReferenceLib.bookPNS(info, false);
        assertEq(px, 835_001);
        assertFalse(empty);
        info.maxBidPriceONS = 0; // measured empty sentinel
        (px, empty) = ReferenceLib.bookPNS(info, true);
        assertTrue(empty);
        assertEq(px, 0);
        info.maxBidPriceONS = type(uint256).max; // defensive sentinel
        (, empty) = ReferenceLib.bookPNS(info, true);
        assertTrue(empty);
        info.minAskPriceONS = 0;
        (, empty) = ReferenceLib.bookPNS(info, false);
        assertTrue(empty);
        info.minAskPriceONS = type(uint256).max;
        (, empty) = ReferenceLib.bookPNS(info, false);
        assertTrue(empty);
    }
}
