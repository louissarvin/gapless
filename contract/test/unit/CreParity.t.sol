// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Test} from "forge-std/Test.sol";
import {stdJson} from "forge-std/StdJson.sol";
import {GaplessCreSink} from "../../src/cre/GaplessCreSink.sol";
import {IGaplessCreSink} from "../../src/interfaces/IGaplessCreSink.sol";
import {Constants} from "../../src/Constants.sol";

/// Counts calls; every id succeeds so the counts equal what the sink forwarded.
contract CreParityManagerStub {
    uint256 public arms;
    uint256 public triggers;

    function arm(bytes32) external returns (bool) {
        ++arms;
        return true;
    }

    function trigger(bytes32) external returns (uint256) {
        ++triggers;
        return 1;
    }
}

/// @notice CRE workflow report bytes (gen-vectors.ts) vs the deployed GaplessCreSink decoder (INTERFACES 5.6).
/// @dev Fixture copied from cre/gapless-cre/gapless-ref/test/fixtures/cre_report_vectors.json; re-copy on regenerate.
contract CreParityTest is Test {
    using stdJson for string;

    struct Vec {
        string name;
        bytes report;
        bytes32 reportHash;
        uint8 kind;
        uint64 sel;
        uint64 seq;
        uint256 perpId;
        uint256 refPricePNS;
        bytes32[] toArm;
        bytes32[] toTrigger;
        string expect;
    }

    string internal json;
    GaplessCreSink internal sink;
    CreParityManagerStub internal mgr;

    function setUp() public {
        json = vm.readFile(string.concat(vm.projectRoot(), "/test/fixtures/cre_report_vectors.json"));
        mgr = new CreParityManagerStub();
        // Same constructor args as Deploy.s.sol used for the live sink.
        sink = new GaplessCreSink(Constants.CRE_FORWARDER_SIM, Constants.CHAIN_SELECTOR, address(mgr));
    }

    function _count() internal view returns (uint256 n) {
        while (json.keyExists(string.concat(".vectors[", vm.toString(n), "]"))) ++n;
    }

    function _vec(uint256 i) internal view returns (Vec memory v) {
        string memory p = string.concat(".vectors[", vm.toString(i), "]");
        string memory f = string.concat(p, ".fields");
        v.name = json.readString(string.concat(p, ".name"));
        v.report = json.readBytes(string.concat(p, ".report"));
        v.reportHash = json.readBytes32(string.concat(p, ".reportHash"));
        v.expect = json.readString(string.concat(p, ".expect"));
        v.kind = uint8(json.readUint(string.concat(f, ".kind")));
        v.sel = uint64(vm.parseUint(json.readString(string.concat(f, ".chainSelector"))));
        v.seq = uint64(vm.parseUint(json.readString(string.concat(f, ".seq"))));
        v.perpId = vm.parseUint(json.readString(string.concat(f, ".perpId")));
        v.refPricePNS = vm.parseUint(json.readString(string.concat(f, ".refPricePNS")));
        v.toArm = json.readBytes32Array(string.concat(f, ".toArm"));
        v.toTrigger = json.readBytes32Array(string.concat(f, ".toTrigger"));
    }

    function _send(bytes memory report) internal {
        vm.prank(Constants.CRE_FORWARDER_SIM);
        sink.onReport("", report);
    }

    function _min(uint256 a, uint256 b) internal pure returns (uint256) {
        return a < b ? a : b;
    }

    function test_fixtureMatchesDeployedConstants() public view {
        assertEq(vm.parseUint(json.readString(".chainSelector")), Constants.CHAIN_SELECTOR);
        assertEq(json.readUint(".kinds.ref"), Constants.CRE_KIND_REF);
        assertEq(json.readUint(".kinds.watch"), Constants.CRE_KIND_WATCH);
        assertEq(json.readUint(".kinds.armedLog"), Constants.CRE_KIND_ARMED_LOG);
        assertEq(sink.forwarder(), Constants.CRE_FORWARDER_SIM);
        assertEq(sink.chainSelector(), Constants.CHAIN_SELECTOR);
        assertEq(sink.MAX_IDS(), Constants.CRE_MAX_IDS);
        assertEq(_count(), 8);
    }

    /// Solidity abi.encode of the fields must equal the TS bytes, and the seen key must equal keccak(report).
    function test_reportBytesMatchSolidityEncoding() public view {
        uint256 n = _count();
        for (uint256 i; i < n; ++i) {
            Vec memory v = _vec(i);
            bytes memory enc = abi.encode(v.kind, v.sel, v.seq, v.perpId, v.refPricePNS, v.toArm, v.toTrigger);
            assertEq(v.report, enc, v.name);
            assertEq(v.report.length, json.readUint(string.concat(".vectors[", vm.toString(i), "].reportLength")));
            assertEq(keccak256(v.report), v.reportHash, v.name);

            (uint8 k, uint64 sel, uint64 seq, uint256 perpId, uint256 ref, bytes32[] memory a, bytes32[] memory t) =
                abi.decode(v.report, (uint8, uint64, uint64, uint256, uint256, bytes32[], bytes32[]));
            assertEq(k, v.kind);
            assertEq(sel, v.sel);
            assertEq(seq, v.seq);
            assertEq(perpId, v.perpId);
            assertEq(ref, v.refPricePNS);
            assertEq(a, v.toArm);
            assertEq(t, v.toTrigger);
        }
    }

    function test_creReportVectors() public {
        uint256 n = _count();
        for (uint256 i; i < n; ++i) {
            Vec memory v = _vec(i);
            // Move the chain so seq is fresh; the u64-max vector stays outside the window (decode-only).
            if (v.seq != type(uint64).max) {
                if (v.kind == Constants.CRE_KIND_ARMED_LOG) vm.roll(uint256(v.seq) + 10);
                else vm.warp(uint256(v.seq) + 5);
            }

            if (keccak256(bytes(v.expect)) == keccak256("WrongChain")) {
                assertTrue(v.sel != Constants.CHAIN_SELECTOR, v.name);
                vm.expectRevert(abi.encodeWithSelector(IGaplessCreSink.WrongChain.selector, v.sel));
                _send(v.report);
                continue;
            }

            uint256 a0 = mgr.arms();
            uint256 t0 = mgr.triggers();
            if (v.seq == type(uint64).max) {
                _send(v.report);
                assertFalse(sink.seen(v.reportHash), v.name);
                assertEq(mgr.arms(), a0);
                continue;
            }

            uint256 armed = _min(v.toArm.length, Constants.CRE_MAX_IDS);
            uint256 triggered = _min(v.toTrigger.length, Constants.CRE_MAX_IDS);
            if (keccak256(bytes(v.expect)) == keccak256("processesFirst3")) assertGt(v.toArm.length, armed, v.name);
            vm.expectEmit(address(sink));
            emit IGaplessCreSink.CreReport(v.kind, v.perpId, v.refPricePNS, armed, triggered);
            _send(v.report);

            assertTrue(sink.seen(v.reportHash), v.name);
            assertEq(sink.lastSeq(v.kind, v.perpId), v.seq, v.name);
            assertEq(mgr.arms() - a0, armed, v.name);
            assertEq(mgr.triggers() - t0, triggered, v.name);
        }

        // N-06: canonical bytes plus trailing zeros map to the already-seen key, so nothing runs again.
        bytes memory nc = json.readBytes(".nonCanonical[0].report");
        bytes32 key = json.readBytes32(".nonCanonical[0].reportHash");
        assertEq(keccak256(nc), json.readBytes32(".nonCanonical[0].rawKeccak"));
        assertTrue(keccak256(nc) != key);
        assertTrue(sink.seen(key));
        (,, uint64 nseq,,,,) = abi.decode(nc, (uint8, uint64, uint64, uint256, uint256, bytes32[], bytes32[]));
        vm.warp(uint256(nseq) + 5);
        uint256 a1 = mgr.arms();
        _send(nc);
        assertEq(mgr.arms(), a1, "trailing bytes replayed");
    }
}
