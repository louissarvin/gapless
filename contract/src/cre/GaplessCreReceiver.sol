// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {IReceiver, IGaplessCreSink} from "../interfaces/IGaplessCreSink.sol";
import {Constants} from "../Constants.sol";

/// @title GaplessCreReceiver
/// @notice Chainlink CRE consumer base (04 section 1.7): forwarder check, chain selector, once-only reports.
/// @dev Report = abi.encode(uint8 kind, uint64 chainSelector, uint64 seq, uint256 perpId, uint256 refPricePNS,
/// bytes32[] toArm, bytes32[] toTrigger). Metadata length is never checked (prod sends 64 bytes, docs say 62).
/// L-04: replay protection is a seen-set over the hash of the canonical re-encoding of the decoded report (N-06), so a
/// forged report through the permissionless forwarder can never drop a different genuine one, and one report's content
/// is processed once whatever bytes carried it; lastSeq per (kind, perpId) is for monitoring only.
abstract contract GaplessCreReceiver is IGaplessCreSink, ReentrancyGuardTransient {
    uint256 public constant MAX_IDS = Constants.CRE_MAX_IDS;

    address public immutable forwarder;
    uint64 public immutable chainSelector;
    mapping(uint8 kind => mapping(uint256 perpId => uint64)) public lastSeq;
    mapping(bytes32 reportHash => bool) public seen;

    constructor(address forwarder_, uint64 chainSelector_) {
        forwarder = forwarder_;
        chainSelector = chainSelector_;
    }

    /// @notice Forwarder entry point. Replayed, too old or future-dated reports return without reverting.
    function onReport(bytes calldata metadata, bytes calldata report) external nonReentrant {
        if (msg.sender != forwarder) revert NotForwarder();
        _checkMetadata(metadata);
        (
            uint8 kind,
            uint64 sel,
            uint64 seq,
            uint256 perpId,
            uint256 refPricePNS,
            bytes32[] memory toArm,
            bytes32[] memory toTrigger
        ) = abi.decode(report, (uint8, uint64, uint64, uint256, uint256, bytes32[], bytes32[]));
        if (sel != chainSelector) revert WrongChain(sel);
        (uint256 lo, uint256 hi) = _seqWindow(kind);
        // N-06: key on the canonical encoding of the decoded content, so trailing bytes or other offsets cannot replay.
        bytes32 h = keccak256(abi.encode(kind, sel, seq, perpId, refPricePNS, toArm, toTrigger));
        if (seq < lo || seq > hi || seen[h]) return;
        seen[h] = true;
        if (seq > lastSeq[kind][perpId]) lastSeq[kind][perpId] = seq;
        _onCreReport(kind, perpId, refPricePNS, toArm, toTrigger);
    }

    function supportsInterface(bytes4 interfaceId) public pure returns (bool) {
        return interfaceId == type(IReceiver).interfaceId || interfaceId == type(IERC165).interfaceId;
    }

    /// @dev Hook for a trusted (production) receiver to check workflow id and owner. No-op for the simulation sink.
    function _checkMetadata(bytes calldata metadata) internal view virtual {}

    /// @dev seq is the cron second (kinds 1, 2) or the Armed block (kind 3); accepted within [now - max age, now].
    function _seqWindow(uint8 kind) internal view returns (uint256 lo, uint256 hi) {
        if (kind == Constants.CRE_KIND_ARMED_LOG) {
            hi = block.number;
            lo = hi > Constants.CRE_REPORT_MAX_AGE_BLOCKS ? hi - Constants.CRE_REPORT_MAX_AGE_BLOCKS : 0;
        } else {
            uint256 maxAge = Constants.CRE_REPORT_MAX_AGE_SEC;
            hi = block.timestamp + Constants.REF_TS_TOLERANCE_SEC;
            lo = block.timestamp > maxAge ? block.timestamp - maxAge : 0;
        }
    }

    /// @dev Must not revert on business conditions.
    function _onCreReport(
        uint8 kind,
        uint256 perpId,
        uint256 refPricePNS,
        bytes32[] memory toArm,
        bytes32[] memory toTrigger
    ) internal virtual;
}
