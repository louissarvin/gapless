// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";

/// @notice Chainlink CRE consumer entry point; the forwarder checks supportsInterface for it.
interface IReceiver is IERC165 {
    function onReport(bytes calldata metadata, bytes calldata report) external;
}

/// @title IGaplessCreSink (stretch)
/// @notice Simulation CRE receiver behind MockKeystoneForwarder 0x9eF6...784d, which anyone can call (D15).
/// It may only call permissionless, state-checked manager functions; refPricePNS is display-only.
/// @dev report = abi.encode(uint8 kind, uint64 chainSelector, uint64 seq, uint256 perpId, uint256 refPricePNS,
/// bytes32[] toArm, bytes32[] toTrigger) (D16). Kinds: 1 ref price, 2 watchtower, 3 Armed log.
/// A report's content is processed once (keyed by keccak256 of the canonical abi.encode of the decoded fields, L-04,
/// N-06); a seq above now or older than the max age returns silently.
/// lastSeq is tracked per (kind, perpId) for monitoring only. Wrong chain selector reverts; business failures never
/// revert (try arm / try trigger on at most MAX_IDS ids each). Never require metadata.length == 62 (prod sends 64).
interface IGaplessCreSink is IReceiver {
    /// @notice `triggered` counts trigger calls that did not revert (disarms and TriggerNoFill included), not fills.
    event CreReport(uint8 kind, uint256 perpId, uint256 refPricePNS, uint256 armed, uint256 triggered);

    error NotForwarder();
    error WrongChain(uint64 chainSelector);

    function forwarder() external view returns (address);
    function chainSelector() external view returns (uint64);
    function manager() external view returns (address);
    function lastSeq(uint8 kind, uint256 perpId) external view returns (uint64);
    /// @param reportHash keccak256(abi.encode(kind, chainSelector, seq, perpId, refPricePNS, toArm, toTrigger)).
    function seen(bytes32 reportHash) external view returns (bool);
    function MAX_IDS() external view returns (uint256);
}
