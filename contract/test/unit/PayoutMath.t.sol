// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Test} from "forge-std/Test.sol";
import {PayoutMath} from "../../src/libraries/PayoutMath.sol";
import {CloseResult} from "../../src/types/GaplessTypes.sol";

contract PayoutMathTest is Test {
    // Hand-computed vectors

    function test_closeLimit_long() public pure {
        // R below stop: floor at R x 0.99
        assertEq(PayoutMath.closeLimitPNS(830_825, 830_000, 200, 100, true), 821_700);
        // R above stop: anchored at the stop
        assertEq(PayoutMath.closeLimitPNS(830_825, 840_000, 200, 100, true), 822_516); // 830825 x 0.99 = 822516.75
        // No reference: floor(floor(830825 x 0.98) x 0.99) = floor(814208 x 0.99) = 806065
        assertEq(PayoutMath.closeLimitPNS(830_825, 0, 200, 100, true), 806_065);
    }

    function test_closeLimit_short() public pure {
        // R above stop: ceil(R x 1.01)
        assertEq(PayoutMath.closeLimitPNS(839_175, 840_000, 200, 100, false), 848_400);
        // R below stop: anchored at the stop, ceil(839175 x 1.01) = 847566.75 -> 847567
        assertEq(PayoutMath.closeLimitPNS(839_175, 830_000, 200, 100, false), 847_567);
        // No reference: ceil(ceil(839175 x 1.02) x 1.01) = ceil(855959 x 1.01) = ceil(864518.59) = 864519
        assertEq(PayoutMath.closeLimitPNS(839_175, 0, 200, 100, false), 864_519);
    }

    /// @dev H-01 first-attempt floor: R x (1 - A) for a long, ceil(R x (1 + A)) for a short.
    function test_tightLimit_bothSides() public pure {
        assertEq(PayoutMath.tightLimitPNS(830_000, 5, true), 829_585);
        assertEq(PayoutMath.tightLimitPNS(840_000, 5, true), 839_580); // R above the stop: still R-tied
        assertEq(PayoutMath.tightLimitPNS(840_000, 5, false), 840_420);
        assertEq(PayoutMath.tightLimitPNS(830_001, 5, false), 830_417); // ceil(830,416.0005)
        assertEq(PayoutMath.tightLimitPNS(830_001, 50, true), 825_850); // floor(825,850.995)
    }

    function test_gReal_long_matchesClosedForm() public pure {
        // Long 50 lots, entry 835,000, exit 829,000, fee 345 ppm, deposit 4,175,000, no funding.
        // realized = 4,175,000 - 300,000 - ceil(829,000 x 50 x 345 / 1e6 = 14,300.25) = 3,860,699
        CloseResult memory r = CloseResult(50, 4_175_000, 3_860_699, 835_000, 0, 345);
        // floor(41,541,250 x 999,655 / 1e6) - 41,750,000 + 314,301 = 41,526,918 - 41,435,699 = 91,219
        assertEq(PayoutMath.gRealCNS(r, 830_825, 1, true), 91_219);
    }

    function test_gReal_fundingExcluded() public pure {
        // Same close with +10,000 funding realized: G_real unchanged (funding never leaks)
        CloseResult memory r = CloseResult(50, 4_175_000, 3_870_699, 835_000, 10_000, 345);
        assertEq(PayoutMath.gRealCNS(r, 830_825, 1, true), 91_219);
        r = CloseResult(50, 4_175_000, 3_850_699, 835_000, -10_000, 345);
        assertEq(PayoutMath.gRealCNS(r, 830_825, 1, true), 91_219);
    }

    function test_gReal_short_andClamp() public pure {
        // Short 50 lots, entry 835,000, exit 840,000 (stop 839,175), fee 345 ppm, deposit 4,175,000.
        // pnl = -250,000; fee = ceil(840,000 x 50 x 345 / 1e6) = 14,490; realized = 3,910,510; X = -264,490
        CloseResult memory r = CloseResult(50, 4_175_000, 3_910_510, 835_000, 0, 345);
        // 41,750,000 - ceil(41,958,750 x 1,000,345 / 1e6 = 41,973,225.77) + 264,490 = 41,264 (gap 825 x 50 x (1 + fee))
        assertEq(PayoutMath.gRealCNS(r, 839_175, 1, false), 41_264);
        // Fill better than the stop: clamped at 0
        r = CloseResult(50, 4_175_000, 4_175_000 - 100_000 - 14_400, 835_000, 0, 345); // exit 837,000
        assertEq(PayoutMath.gRealCNS(r, 839_175, 1, false), 0);
        assertEq(PayoutMath.gRealCNS(CloseResult(0, 0, 0, 0, 0, 0), 839_175, 1, false), 0);
    }

    function test_gRef() public pure {
        assertEq(PayoutMath.gRefCNS(830_825, 830_000, 50, 1, true), 41_250);
        assertEq(PayoutMath.gRefCNS(830_825, 831_000, 50, 1, true), 0);
        assertEq(PayoutMath.gRefCNS(830_825, 0, 50, 1, true), 0);
        assertEq(PayoutMath.gRefCNS(839_175, 840_000, 50, 10, false), 412_500);
        assertEq(PayoutMath.gRefCNS(839_175, 839_000, 50, 1, false), 0);
    }

    function test_bound() public pure {
        // SN 41,541,250: A x SN = 20,770 (floor of 20,770.6), cap = 830,825
        assertEq(PayoutMath.boundCNS(91_219, 41_250, 41_541_250, 5, 200), 62_020);
        assertEq(PayoutMath.boundCNS(50_000, 41_250, 41_541_250, 5, 200), 50_000);
        assertEq(PayoutMath.boundCNS(10_000_000, 9_000_000, 41_541_250, 5, 200), 830_825);
        assertEq(PayoutMath.boundCNS(10_000_000, 0, 41_541_250, 5, 200), 20_770); // self-deal: A x SN
    }

    function test_escrowSplit_ceilToVault() public pure {
        (uint256 v, uint256 r) = PayoutMath.escrowSplit(20_779, 17, 50); // 7064.86 -> 7065
        assertEq(v, 7065);
        assertEq(r, 13_714);
        (v, r) = PayoutMath.escrowSplit(20_779, 50, 50);
        assertEq(v, 20_779);
        assertEq(r, 0);
        (v, r) = PayoutMath.escrowSplit(20_779, 0, 50);
        assertEq(v, 0);
        assertEq(r, 20_779);
    }

    function test_resize_ceil() public pure {
        (uint256 c, uint256 e) = PayoutMath.resize(830_825, 20_779, 50, 33);
        assertEq(c, 548_345); // 548344.5 -> ceil
        assertEq(e, 13_715); // 13714.14 -> ceil
    }

    // Parity with the Python reference (test/fixtures/payout_vectors.json, 2,000 vectors)

    struct V {
        uint256[] isLong;
        uint256[] scale;
        uint256[] stop;
        uint256[] lots;
        uint256[] filled;
        uint256[] entry;
        uint256[] fee;
        uint256[] released;
        int256[] realized;
        int256[] funding;
        uint256[] ref;
        uint256[] maxGap;
        uint256[] slack;
        uint256[] a;
    }

    function test_parity_pythonReference() public view {
        string memory j = vm.readFile("test/fixtures/payout_vectors.json");
        uint256 n = vm.parseJsonUint(j, ".n");
        V memory v;
        v.isLong = vm.parseJsonUintArray(j, ".isLong");
        v.scale = vm.parseJsonUintArray(j, ".scale");
        v.stop = vm.parseJsonUintArray(j, ".stop");
        v.lots = vm.parseJsonUintArray(j, ".lots");
        v.filled = vm.parseJsonUintArray(j, ".filled");
        v.entry = vm.parseJsonUintArray(j, ".entry");
        v.fee = vm.parseJsonUintArray(j, ".fee");
        v.released = vm.parseJsonUintArray(j, ".released");
        v.realized = vm.parseJsonIntArray(j, ".realized");
        v.funding = vm.parseJsonIntArray(j, ".funding");
        v.ref = vm.parseJsonUintArray(j, ".ref");
        v.maxGap = vm.parseJsonUintArray(j, ".maxGap");
        v.slack = vm.parseJsonUintArray(j, ".slack");
        v.a = vm.parseJsonUintArray(j, ".a");
        O memory o;
        o.limit = vm.parseJsonUintArray(j, ".outLimit");
        o.gReal = vm.parseJsonUintArray(j, ".outGReal");
        o.gRef = vm.parseJsonUintArray(j, ".outGRef");
        o.bound = vm.parseJsonUintArray(j, ".outBound");
        for (uint256 i; i < n; ++i) {
            _check(v, o, i);
        }
        _paritySplit(j, n, v.lots, v.filled);
    }

    struct O {
        uint256[] limit;
        uint256[] gReal;
        uint256[] gRef;
        uint256[] bound;
    }

    function _check(V memory v, O memory o, uint256 i) internal pure {
        bool isLong = v.isLong[i] == 1;
        uint256 lim = PayoutMath.closeLimitPNS(v.stop[i], v.ref[i], uint16(v.maxGap[i]), uint16(v.slack[i]), isLong);
        assertEq(lim, o.limit[i], "limit");
        CloseResult memory r =
            CloseResult(v.filled[i], v.released[i], v.realized[i], v.entry[i], v.funding[i], v.fee[i]);
        uint256 gr = PayoutMath.gRealCNS(r, v.stop[i], v.scale[i], isLong);
        assertEq(gr, o.gReal[i], "gReal");
        uint256 gf = PayoutMath.gRefCNS(v.stop[i], v.ref[i], v.filled[i], v.scale[i], isLong);
        assertEq(gf, o.gRef[i], "gRef");
        uint256 sn = v.stop[i] * v.filled[i] * v.scale[i];
        assertEq(PayoutMath.boundCNS(gr, gf, sn, uint16(v.a[i]), uint16(v.maxGap[i])), o.bound[i], "bound");
    }

    struct S {
        uint256[] escrow;
        uint256[] cap;
        uint256[] newLots;
        uint256[] toVault;
        uint256[] refund;
        uint256[] newCap;
        uint256[] newEscrow;
    }

    function _paritySplit(string memory j, uint256 n, uint256[] memory lots, uint256[] memory filled) internal pure {
        S memory x;
        x.escrow = vm.parseJsonUintArray(j, ".escrow");
        x.cap = vm.parseJsonUintArray(j, ".cap");
        x.newLots = vm.parseJsonUintArray(j, ".newLots");
        x.toVault = vm.parseJsonUintArray(j, ".outToVault");
        x.refund = vm.parseJsonUintArray(j, ".outRefund");
        x.newCap = vm.parseJsonUintArray(j, ".outNewCap");
        x.newEscrow = vm.parseJsonUintArray(j, ".outNewEscrow");
        for (uint256 i; i < n; ++i) {
            _checkSplit(x, lots[i], filled[i], i);
        }
    }

    function _checkSplit(S memory x, uint256 lots, uint256 filled, uint256 i) internal pure {
        (uint256 tv, uint256 rf) = PayoutMath.escrowSplit(x.escrow[i], filled, lots);
        assertEq(tv, x.toVault[i], "toVault");
        assertEq(rf, x.refund[i], "refund");
        (uint256 nc, uint256 ne) = PayoutMath.resize(x.cap[i], x.escrow[i], lots, x.newLots[i]);
        assertEq(nc, x.newCap[i], "newCap");
        assertEq(ne, x.newEscrow[i], "newEscrow");
    }
}
