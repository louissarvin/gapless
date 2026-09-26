// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Test} from "forge-std/Test.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {PayoutMath} from "../../src/libraries/PayoutMath.sol";
import {CloseResult} from "../../src/types/GaplessTypes.sol";

/// @notice Payout properties: the bound never exceeds any of its three terms, G_real equals the net-proceeds
/// difference at the stop under Perpl's ceil fee rounding, funding never leaks, splits and resizes round to the vault.
contract PayoutFuzzTest is Test {
    struct In {
        uint256 stop;
        uint256 exit;
        uint256 entry;
        uint256 f;
        uint256 scale;
        uint256 fee;
        uint256 deposit;
        int256 funding;
    }

    function _bound(In memory x) internal pure {
        x.stop = bound(x.stop, 1, type(uint32).max);
        x.exit = bound(x.exit, 1, type(uint32).max);
        x.entry = bound(x.entry, 1, type(uint32).max);
        x.f = bound(x.f, 1, type(uint40).max);
        x.scale = 10 ** bound(x.scale, 0, 6);
        x.fee = bound(x.fee, 0, 2000);
        x.deposit = bound(x.deposit, 0, x.entry * x.f * x.scale);
        x.funding = bound(x.funding, -1e15, 1e15);
    }

    /// @dev Perpl-shaped close: realized = released + PnL - ceil(fee at exit) + funding.
    function _close(In memory x, bool isLong) internal pure returns (CloseResult memory r) {
        int256 pnl = (int256(x.exit) - int256(x.entry)) * int256(x.f * x.scale);
        if (!isLong) pnl = -pnl;
        uint256 feeExit = Math.mulDiv(x.exit * x.f * x.scale, x.fee, 1e6, Math.Rounding.Ceil);
        r = CloseResult(x.f, x.deposit, int256(x.deposit) + pnl - int256(feeExit) + x.funding, x.entry, x.funding, x.fee);
    }

    function testFuzz_gReal_long_netProceedsAtStop(In memory x) public pure {
        _bound(x);
        uint256 s = x.stop * x.f * x.scale;
        uint256 e = x.exit * x.f * x.scale;
        int256 atStop = int256(s - Math.mulDiv(s, x.fee, 1e6, Math.Rounding.Ceil));
        int256 atExit = int256(e - Math.mulDiv(e, x.fee, 1e6, Math.Rounding.Ceil));
        uint256 expect = atStop > atExit ? uint256(atStop - atExit) : 0;
        assertEq(PayoutMath.gRealCNS(_close(x, true), x.stop, x.scale, true), expect);
    }

    function testFuzz_gReal_short_netCostAtStop(In memory x) public pure {
        _bound(x);
        uint256 s = x.stop * x.f * x.scale;
        uint256 e = x.exit * x.f * x.scale;
        uint256 atStop = s + Math.mulDiv(s, x.fee, 1e6, Math.Rounding.Ceil);
        uint256 atExit = e + Math.mulDiv(e, x.fee, 1e6, Math.Rounding.Ceil);
        uint256 expect = atExit > atStop ? atExit - atStop : 0;
        assertEq(PayoutMath.gRealCNS(_close(x, false), x.stop, x.scale, false), expect);
    }

    function testFuzz_gReal_fundingNeutral(In memory x, int256 extra, bool isLong) public pure {
        _bound(x);
        extra = bound(extra, -1e15, 1e15);
        CloseResult memory r = _close(x, isLong);
        uint256 g0 = PayoutMath.gRealCNS(r, x.stop, x.scale, isLong);
        r.realizedCNS += extra;
        r.fundingCNS += extra;
        assertEq(PayoutMath.gRealCNS(r, x.stop, x.scale, isLong), g0);
    }

    function testFuzz_bound_neverAboveAnyTerm(uint128 gReal, uint128 gRef, uint128 sn, uint16 a, uint16 maxGap)
        public
        pure
    {
        a = uint16(bound(a, 5, 50));
        maxGap = uint16(bound(maxGap, 50, 500));
        uint256 b = PayoutMath.boundCNS(gReal, gRef, sn, a, maxGap);
        assertLe(b, gReal);
        assertLe(b, uint256(gRef) + uint256(sn) * a / 1e4);
        assertLe(b, uint256(sn) * maxGap / 1e4);
        // Self-deal with no reference move pays at most A x SN
        assertLe(PayoutMath.boundCNS(gReal, 0, sn, a, maxGap), uint256(sn) * a / 1e4);
    }

    function testFuzz_escrowSplit_ceilToVault(uint80 escrow, uint40 lots, uint40 filled) public pure {
        lots = uint40(bound(lots, 1, type(uint40).max));
        filled = uint40(bound(filled, 0, lots));
        (uint256 v, uint256 r) = PayoutMath.escrowSplit(escrow, filled, lots);
        assertEq(v + r, escrow);
        assertGe(v * lots, uint256(escrow) * filled);
        assertLe(v, escrow);
    }

    function testFuzz_resize_keepsI13AndCeil(uint80 cap, uint80 escrow, uint40 oldLots, uint40 newLots) public pure {
        oldLots = uint40(bound(oldLots, 1, type(uint40).max));
        newLots = uint40(bound(newLots, 0, oldLots));
        (uint256 c, uint256 e) = PayoutMath.resize(cap, escrow, oldLots, newLots);
        assertLe(c, cap);
        assertLe(e, escrow);
        assertGe(c * oldLots, uint256(cap) * newLots);
        assertGe(e * oldLots, uint256(escrow) * newLots); // escrow/lots ratio never drops: I13 survives
    }

    function testFuzz_closeLimit_tiedToReference(uint32 stop, uint32 ref, uint16 maxGap, uint16 slack) public pure {
        stop = uint32(bound(stop, 1, type(uint32).max));
        maxGap = uint16(bound(maxGap, 50, 500));
        slack = uint16(bound(slack, 10, 300));
        uint256 l = PayoutMath.closeLimitPNS(stop, ref, maxGap, slack, true);
        uint256 s = PayoutMath.closeLimitPNS(stop, ref, maxGap, slack, false);
        if (ref > 0) {
            assertLe(l, Math.min(stop, ref));
            assertGe(s, Math.max(stop, ref));
        } else {
            assertLe(l, uint256(stop) * (1e4 - maxGap) / 1e4);
            assertGe(s, uint256(stop) * (1e4 + maxGap) / 1e4);
        }
    }

    /// @dev H-01: a fill at or better than the tight limit leaves the trader within A of the reference.
    function testFuzz_tightLimit_withinAOfReference(uint32 ref, uint16 a) public pure {
        ref = uint32(bound(ref, 1, type(uint32).max));
        a = uint16(bound(a, 5, 50));
        uint256 l = PayoutMath.tightLimitPNS(ref, a, true);
        uint256 s = PayoutMath.tightLimitPNS(ref, a, false);
        assertLe(l, ref);
        assertGe(l * 1e4 + 1e4, uint256(ref) * (1e4 - a)); // floor loses at most one unit
        assertGe(s, ref);
        assertLe(s * 1e4, uint256(ref) * (1e4 + a) + 1e4); // ceil adds at most one unit
    }

    function testFuzz_gRef_zeroWithoutReference(uint32 stop, uint40 lots, uint8 sc, bool isLong) public pure {
        assertEq(PayoutMath.gRefCNS(stop, 0, lots, 10 ** (sc % 7), isLong), 0);
    }
}
