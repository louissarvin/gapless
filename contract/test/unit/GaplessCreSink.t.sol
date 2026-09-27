// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Test} from "forge-std/Test.sol";
import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import {GaplessCreSink} from "../../src/cre/GaplessCreSink.sol";
import {IGaplessCreSink, IReceiver} from "../../src/interfaces/IGaplessCreSink.sol";
import {Constants} from "../../src/Constants.sol";

/// arm/trigger double: ids with a set bit fail; arm returns false for "venue unavailable" ids.
contract CreManagerStub {
    uint256 public arms;
    uint256 public triggers;
    mapping(bytes32 => bool) public fails;
    mapping(bytes32 => bool) public unarmable;
    address public reenterTarget;
    bytes public reenterData;

    function setFails(bytes32 id) external {
        fails[id] = true;
    }

    function setUnarmable(bytes32 id) external {
        unarmable[id] = true;
    }

    function setReenter(address t, bytes calldata d) external {
        reenterTarget = t;
        reenterData = d;
    }

    function arm(bytes32 id) external returns (bool) {
        if (fails[id]) revert("arm failed");
        ++arms;
        return !unarmable[id];
    }

    function trigger(bytes32 id) external returns (uint256) {
        if (reenterTarget != address(0)) {
            (bool ok, bytes memory ret) = reenterTarget.call(reenterData);
            if (!ok) {
                assembly ("memory-safe") {
                    revert(add(ret, 32), mload(ret))
                }
            }
        }
        if (fails[id]) revert("trigger failed");
        ++triggers;
        return 0;
    }
}

contract GaplessCreSinkTest is Test {
    address internal fwd = Constants.CRE_FORWARDER_SIM;
    uint64 internal sel = Constants.CHAIN_SELECTOR;
    CreManagerStub internal mgr;
    GaplessCreSink internal sink;

    function setUp() public {
        vm.warp(1_791_190_979);
        vm.roll(110_711_378);
        mgr = new CreManagerStub();
        sink = new GaplessCreSink(fwd, sel, address(mgr));
    }

    function _report(uint8 kind, uint64 seq, bytes32[] memory a, bytes32[] memory t)
        internal
        view
        returns (bytes memory)
    {
        return abi.encode(kind, sel, seq, uint256(1), uint256(861_740), a, t);
    }

    function _ids(uint256 n, uint256 offset) internal pure returns (bytes32[] memory ids) {
        ids = new bytes32[](n);
        for (uint256 i; i < n; ++i) {
            ids[i] = bytes32(i + 1 + offset);
        }
    }

    function _send(bytes memory report) internal {
        vm.prank(fwd);
        sink.onReport(hex"", report);
    }

    function test_views() public view {
        assertEq(sink.forwarder(), fwd);
        assertEq(sink.chainSelector(), sel);
        assertEq(sink.manager(), address(mgr));
        assertEq(sink.MAX_IDS(), 3);
        assertTrue(sink.supportsInterface(type(IReceiver).interfaceId));
        assertTrue(sink.supportsInterface(type(IERC165).interfaceId));
        assertFalse(sink.supportsInterface(0xffffffff));
    }

    function test_constructor_zero() public {
        vm.expectRevert(GaplessCreSink.ZeroAddress.selector);
        new GaplessCreSink(address(0), sel, address(mgr));
        vm.expectRevert(GaplessCreSink.ZeroAddress.selector);
        new GaplessCreSink(fwd, sel, address(0));
    }

    function test_onlyForwarder() public {
        bytes memory r = _report(2, uint64(block.timestamp), _ids(1, 0), _ids(0, 0));
        vm.expectRevert(IGaplessCreSink.NotForwarder.selector);
        sink.onReport(hex"", r);
    }

    function test_wrongChainReverts() public {
        bytes memory r =
            abi.encode(uint8(2), uint64(1), uint64(block.timestamp), uint256(1), uint256(0), _ids(0, 0), _ids(0, 0));
        vm.prank(fwd);
        vm.expectRevert(abi.encodeWithSelector(IGaplessCreSink.WrongChain.selector, uint64(1)));
        sink.onReport(hex"", r);
    }

    function test_armsAndTriggersWithEvent() public {
        vm.expectEmit(address(sink));
        emit IGaplessCreSink.CreReport(2, 1, 861_740, 2, 2);
        _send(_report(2, uint64(block.timestamp), _ids(2, 0), _ids(2, 10)));
        assertEq(mgr.arms(), 2);
        assertEq(mgr.triggers(), 2);
        assertEq(sink.lastSeq(2, 1), block.timestamp);
    }

    function test_maxIdsBound() public {
        _send(_report(2, uint64(block.timestamp), _ids(5, 0), _ids(7, 10)));
        assertEq(mgr.arms(), 3);
        assertEq(mgr.triggers(), 3);
    }

    function test_failuresSkippedNeverRevert() public {
        mgr.setFails(bytes32(uint256(1)));
        mgr.setFails(bytes32(uint256(12)));
        mgr.setUnarmable(bytes32(uint256(2)));
        vm.expectEmit(address(sink));
        emit IGaplessCreSink.CreReport(2, 1, 861_740, 1, 2);
        _send(_report(2, uint64(block.timestamp), _ids(3, 0), _ids(3, 10)));
    }

    /// @dev L-04: replay protection is per report, so an older (still fresh) report is processed; only an exact
    /// replay or a report past the max age is ignored.
    function test_replayedAndTooOldReturnSilently() public {
        uint64 t = uint64(block.timestamp);
        _send(_report(1, t, _ids(1, 0), _ids(0, 0)));
        vm.recordLogs();
        _send(_report(1, t, _ids(1, 0), _ids(0, 0))); // replay
        _send(_report(1, uint64(t - Constants.CRE_REPORT_MAX_AGE_SEC - 1), _ids(1, 0), _ids(0, 0))); // too old
        assertEq(vm.getRecordedLogs().length, 0);
        assertEq(mgr.arms(), 1);
        _send(_report(1, t - 1, _ids(1, 0), _ids(0, 0))); // older but fresh: a different genuine report
        assertEq(mgr.arms(), 2);
        assertEq(sink.lastSeq(1, 1), t, "lastSeq keeps the max");
        _send(_report(2, t - 5, _ids(1, 0), _ids(0, 0))); // kinds are independent
        assertEq(mgr.arms(), 3);
    }

    function test_futureSeqIgnored_cannotBrickAKind() public {
        _send(_report(2, type(uint64).max, _ids(1, 0), _ids(0, 0)));
        assertEq(sink.lastSeq(2, 1), 0, "forged max seq ignored");
        _send(_report(2, uint64(block.timestamp + 3), _ids(1, 0), _ids(0, 0)));
        assertEq(sink.lastSeq(2, 1), 0, "beyond the 2 s tolerance");
        _send(_report(2, uint64(block.timestamp + 2), _ids(1, 0), _ids(0, 0)));
        assertEq(sink.lastSeq(2, 1), block.timestamp + 2);
        assertEq(mgr.arms(), 1);
        _send(_report(2, uint64(block.timestamp), _ids(2, 0), _ids(0, 0))); // a later forged seq drops nothing
        assertEq(mgr.arms(), 3);
    }

    function test_armedLogKindUsesBlockNumber() public {
        _send(_report(3, uint64(block.number + 1), _ids(0, 0), _ids(1, 0)));
        assertEq(sink.lastSeq(3, 1), 0);
        _send(_report(3, uint64(block.number), _ids(0, 0), _ids(1, 0)));
        assertEq(sink.lastSeq(3, 1), block.number);
        assertEq(mgr.triggers(), 1);
        _send(_report(3, uint64(block.number - Constants.CRE_REPORT_MAX_AGE_BLOCKS - 1), _ids(0, 0), _ids(2, 0)));
        assertEq(mgr.triggers(), 1, "Armed log older than the max age ignored");
        _send(_report(3, uint64(block.number - 5), _ids(0, 0), _ids(2, 0)));
        assertEq(mgr.triggers(), 3, "older genuine Armed log still processed");
    }

    function test_metadataLengthNeverChecked() public {
        bytes memory r = _report(2, uint64(block.timestamp), _ids(1, 0), _ids(0, 0));
        vm.prank(fwd);
        sink.onReport(new bytes(64), r);
        assertEq(mgr.arms(), 1);
    }

    function test_reentryFromManagerIsCaught() public {
        bytes memory inner = _report(2, uint64(block.timestamp), _ids(1, 50), _ids(0, 0));
        mgr.setReenter(address(sink), abi.encodeCall(IReceiver.onReport, (hex"", inner)));
        vm.expectEmit(address(sink));
        emit IGaplessCreSink.CreReport(1, 1, 861_740, 0, 0);
        _send(_report(1, uint64(block.timestamp), _ids(0, 0), _ids(1, 0)));
        assertEq(mgr.triggers(), 0, "re-entrant trigger reverted inside try");
    }

    function testFuzz_neverRevertsOnBusinessFailures(uint8 kind, uint8 nArm, uint8 nTrig, uint256 failMask) public {
        vm.assume(kind != Constants.CRE_KIND_ARMED_LOG);
        nArm = uint8(bound(nArm, 0, 10));
        nTrig = uint8(bound(nTrig, 0, 10));
        for (uint256 i; i < 20; ++i) {
            if (failMask >> i & 1 == 1) mgr.setFails(bytes32(i + 1));
        }
        _send(_report(kind, uint64(block.timestamp), _ids(nArm, 0), _ids(nTrig, 0)));
        assertLe(mgr.arms(), 3);
        assertLe(mgr.triggers(), 3);
    }
}
