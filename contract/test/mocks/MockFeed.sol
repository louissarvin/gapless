// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {IAggregatorV3} from "../../src/interfaces/external/IAggregatorV3.sol";

/// @title MockFeed
/// @notice Chainlink Data Feed test double with settable answer, timestamp and outage.
/// @dev Defaults to 8 decimals like the Monad BTC/USD, ETH/USD and MON/USD feeds.
contract MockFeed is IAggregatorV3 {
    error FeedDown();
    error NoRound(uint80 roundId);

    struct Round {
        int256 answer;
        uint256 startedAt;
        uint256 updatedAt;
    }

    uint8 public immutable override decimals;
    string public override description;
    uint80 public latestRound;
    bool public reverts;
    mapping(uint80 => Round) internal rounds;

    constructor(uint8 decimals_, string memory description_, int256 answer) {
        decimals = decimals_;
        description = description_;
        _push(answer, block.timestamp);
    }

    function version() external pure override returns (uint256) {
        return 4;
    }

    function setAnswer(int256 answer) external {
        _push(answer, block.timestamp);
    }

    /// @notice Push a round with an explicit updatedAt (use to simulate a stale or future feed).
    function setAnswerAt(int256 answer, uint256 updatedAt) external {
        _push(answer, updatedAt);
    }

    /// @notice Make every read revert, as during an aggregator outage or deprecation.
    function setReverts(bool reverts_) external {
        reverts = reverts_;
    }

    function latestRoundData() external view override returns (uint80, int256, uint256, uint256, uint80) {
        if (reverts) revert FeedDown();
        Round memory r = rounds[latestRound];
        return (latestRound, r.answer, r.startedAt, r.updatedAt, latestRound);
    }

    function getRoundData(uint80 roundId) external view override returns (uint80, int256, uint256, uint256, uint80) {
        if (reverts) revert FeedDown();
        Round memory r = rounds[roundId];
        if (r.updatedAt == 0) revert NoRound(roundId);
        return (roundId, r.answer, r.startedAt, r.updatedAt, roundId);
    }

    function _push(int256 answer, uint256 updatedAt) internal {
        ++latestRound;
        rounds[latestRound] = Round(answer, updatedAt, updatedAt);
    }
}
