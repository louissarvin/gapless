// SPDX-License-Identifier: MIT
// Reference for lane S (W5): passed offline against contract/src/cre/GaplessCreSink.sol on 2026-10-06.
// Copy cre_report_vectors.json into contract/test/fixtures/ (fs_permissions) and this file into contract/test/.
pragma solidity 0.8.37;

import {Test} from "forge-std/Test.sol";
import {stdJson} from "forge-std/StdJson.sol";
import {GaplessCreSink} from "../src/cre/GaplessCreSink.sol";
import {IGaplessCreSink} from "../src/interfaces/IGaplessCreSink.sol";

contract ManagerStub {
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

contract CreParityTest is Test {
    using stdJson for string;

    uint64 internal constant SEL = 8_481_857_512_324_358_265;
    uint256 internal constant VECTORS = 8; // keep in sync with the fixture's vectors[] length
    address internal constant FWD = address(0xF0);

    string internal json;
    GaplessCreSink internal sink;
    ManagerStub internal mgr;

    function setUp() public {
        json = vm.readFile(string.concat(vm.projectRoot(), "/test/fixtures/cre_report_vectors.json"));
        mgr = new ManagerStub();
        sink = new GaplessCreSink(FWD, SEL, address(mgr));
    }

    function _vector(uint256 i)
        internal
        view
        returns (bytes memory report, bytes32 h, uint64 seq, uint8 kind, bytes32 expectTag)
    {
        string memory p = string.concat(".vectors[", vm.toString(i), "]");
        report = json.readBytes(string.concat(p, ".report"));
        h = json.readBytes32(string.concat(p, ".reportHash"));
        seq = uint64(vm.parseUint(json.readString(string.concat(p, ".fields.seq"))));
        kind = uint8(json.readUint(string.concat(p, ".fields.kind")));
        expectTag = keccak256(bytes(json.readString(string.concat(p, ".expect"))));
    }

    function _decode(bytes memory r)
        internal
        pure
        returns (uint8 k, uint64 sel, uint64 seq, bytes32[] memory toArm, bytes32[] memory toTrigger)
    {
        (k, sel, seq,,, toArm, toTrigger) =
            abi.decode(r, (uint8, uint64, uint64, uint256, uint256, bytes32[], bytes32[]));
    }

    function test_creReportVectors() public {
        for (uint256 i; i < VECTORS; ++i) {
            (bytes memory report, bytes32 h, uint64 seq, uint8 kind, bytes32 tag) = _vector(i);
            (uint8 k, uint64 sel,, bytes32[] memory toArm, bytes32[] memory toTrigger) = _decode(report);
            assertEq(k, kind);
            // Move the chain so the seq is fresh; the u64-max vector is decode-only.
            if (seq != type(uint64).max) {
                if (kind == 3) vm.roll(seq + 10);
                else vm.warp(seq + 5);
            }
            if (tag == keccak256("WrongChain")) {
                vm.expectRevert(abi.encodeWithSelector(IGaplessCreSink.WrongChain.selector, sel));
                vm.prank(FWD);
                sink.onReport("", report);
                continue;
            }
            uint256 a0 = mgr.arms();
            uint256 t0 = mgr.triggers();
            vm.prank(FWD);
            sink.onReport("", report);
            if (seq == type(uint64).max) {
                assertFalse(sink.seen(h));
                continue;
            }
            assertTrue(sink.seen(h), "seen key mismatch");
            assertEq(mgr.arms() - a0, toArm.length > 3 ? 3 : toArm.length);
            assertEq(mgr.triggers() - t0, toTrigger.length > 3 ? 3 : toTrigger.length);
        }

        // N-06: canonical bytes plus trailing zeros hash to an already-seen key, so nothing runs.
        bytes memory nc = json.readBytes(".nonCanonical[0].report");
        assertTrue(sink.seen(json.readBytes32(".nonCanonical[0].reportHash")));
        (,, uint64 nseq,,) = _decode(nc);
        vm.warp(nseq + 5);
        uint256 a1 = mgr.arms();
        vm.prank(FWD);
        sink.onReport("", nc);
        assertEq(mgr.arms(), a1, "trailing bytes replayed");
    }
}
