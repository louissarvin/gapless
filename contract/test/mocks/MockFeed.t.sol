// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Test} from "forge-std/Test.sol";
import {MockFeed} from "./MockFeed.sol";

contract MockFeedTest is Test {
    MockFeed internal feed;

    function setUp() public {
        vm.warp(1_791_190_979);
        feed = new MockFeed(8, "BTC / USD", 86_174e8);
    }

    function test_latestRound() public view {
        (uint80 id, int256 answer,, uint256 updatedAt, uint80 answeredIn) = feed.latestRoundData();
        assertEq(feed.decimals(), 8);
        assertEq(feed.description(), "BTC / USD");
        assertEq(id, 1);
        assertEq(answer, 86_174e8);
        assertEq(updatedAt, block.timestamp);
        assertEq(answeredIn, id);
    }

    function test_setAnswerAt_staleAndHistory() public {
        feed.setAnswerAt(85_000e8, block.timestamp - 3600);
        (uint80 id, int256 answer,, uint256 updatedAt,) = feed.latestRoundData();
        assertEq(id, 2);
        assertEq(answer, 85_000e8);
        assertEq(updatedAt, block.timestamp - 3600);
        (, int256 first,,,) = feed.getRoundData(1);
        assertEq(first, 86_174e8);
        vm.expectRevert(abi.encodeWithSelector(MockFeed.NoRound.selector, 9));
        feed.getRoundData(9);
    }

    function test_nonPositiveAnswerIsReturnedAsIs() public {
        feed.setAnswer(0);
        (, int256 answer,,,) = feed.latestRoundData();
        assertEq(answer, 0);
        feed.setAnswer(-1);
        (, answer,,,) = feed.latestRoundData();
        assertEq(answer, -1);
    }

    function test_outageReverts() public {
        feed.setReverts(true);
        vm.expectRevert(MockFeed.FeedDown.selector);
        feed.latestRoundData();
    }
}
