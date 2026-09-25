// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IPerplMin} from "../interfaces/perpl/IPerplMin.sol";
import {MarketConfig, MarketParams} from "../types/GaplessTypes.sol";
import {Constants} from "../Constants.sol";

/// @title ReferenceLib
/// @notice Spec 3.6 reference aggregation: median of fresh sources, least favorable to the claimant when even.
/// @dev The book and lastPNS are never references (01 section 7 #4). Long claimants gain from a low reference, so
/// every tie-break and rounding picks the higher value for longs and the lower for shorts.
library ReferenceLib {
    struct Sources {
        uint256 markPNS;
        uint256 markTs;
        uint256 oraclePNS;
        uint256 oracleTs;
        bool feedOk;
        int256 feedAnswer;
        uint256 feedUpdatedAt;
        bool creOk;
        uint256 crePNS;
        uint256 creTs;
    }

    /// @return ts + maxAge + tol >= nowTs && ts >= minTs.
    function isFresh(uint256 ts, uint256 maxAgeSec, uint256 tolSec, uint256 nowTs, uint256 minTs)
        internal
        pure
        returns (bool)
    {
        return ts + maxAgeSec + tolSec >= nowTs && ts >= minTs;
    }

    /// @notice Chainlink answer to PNS. 0 when answer <= 0. Ceil for long covers, floor for short.
    function feedToPNS(int256 answer, uint8 feedDecimals, uint8 priceDecimals, bool isLong)
        internal
        pure
        returns (uint256)
    {
        if (answer <= 0) return 0;
        // listMarket guarantees feedDecimals >= priceDecimals.
        uint256 div = 10 ** (feedDecimals - priceDecimals);
        return isLong ? Math.ceilDiv(uint256(answer), div) : uint256(answer) / div;
    }

    /// @notice Fresh, positive sources in fixed order (mark, oracle, feed, CRE).
    /// @dev The CRE store also requires |cre - oracle| <= 300 bps against a fresh oracle.
    function collect(
        Sources memory s,
        MarketParams memory p,
        MarketConfig memory c,
        bool isLong,
        uint256 nowTs,
        uint256 minTs
    ) internal pure returns (uint256[4] memory vals, uint8 n) {
        uint256 tol = Constants.REF_TS_TOLERANCE_SEC;
        bool oracleFresh = s.oraclePNS > 0 && isFresh(s.oracleTs, p.refFreshSec, tol, nowTs, minTs);
        if (s.markPNS > 0 && isFresh(s.markTs, p.refFreshSec, tol, nowTs, minTs)) vals[n++] = s.markPNS;
        if (oracleFresh) vals[n++] = s.oraclePNS;
        if (s.feedOk && isFresh(s.feedUpdatedAt, p.feedMaxAgeSec, 0, nowTs, minTs)) {
            uint256 f = feedToPNS(s.feedAnswer, c.feedDecimals, c.priceDecimals, isLong);
            if (f > 0) vals[n++] = f;
        }
        if (s.creOk && s.crePNS > 0 && oracleFresh && isFresh(s.creTs, p.refFreshSec, tol, nowTs, minTs)) {
            uint256 diff = s.crePNS > s.oraclePNS ? s.crePNS - s.oraclePNS : s.oraclePNS - s.crePNS;
            if (diff * Constants.BPS <= s.oraclePNS * Constants.CRE_REF_MAX_DEVIATION_BPS) vals[n++] = s.crePNS;
        }
    }

    /// @notice n >= 3 median (n = 4: max of the middles for long, min for short); n = 2 max long, min short;
    /// n = 1 the value; n = 0 returns 0.
    function aggregate(uint256[4] memory vals, uint8 n, bool isLong) internal pure returns (uint256) {
        if (n == 0) return 0;
        if (n == 1) return vals[0];
        // Insertion sort ascending over at most 4 values.
        for (uint256 i = 1; i < n; ++i) {
            uint256 v = vals[i];
            uint256 j = i;
            while (j > 0 && vals[j - 1] > v) {
                vals[j] = vals[j - 1];
                j -= 1;
            }
            vals[j] = v;
        }
        if (n == 2) return isLong ? vals[1] : vals[0];
        if (n == 3) return vals[1];
        return isLong ? vals[2] : vals[1];
    }

    /// @notice Best opposing book price for the cover's close: long reads the best bid, short the best ask.
    /// @return px base + ONS, 0 when empty. @return empty True when the ONS is 0 or max (no book).
    function bookPNS(IPerplMin.PerpetualInfo memory info, bool isLong) internal pure returns (uint256 px, bool empty) {
        uint256 ons = isLong ? info.maxBidPriceONS : info.minAskPriceONS;
        if (ons == 0 || ons == type(uint256).max) return (0, true);
        return (info.basePricePNS + ons, false);
    }
}
