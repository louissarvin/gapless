// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {GaplessInvariantChecks} from "./GaplessInvariant.t.sol";

/// @notice Deterministic sweep of the atomic handler scenarios on S1's real stack, with every invariant checked
/// after each step. Complements the random campaign (whose per-run stats reset) with aggregate coverage evidence.
contract ScenarioCoverageTest is GaplessInvariantChecks {
    function _r(uint256 i, uint256 salt) internal pure returns (uint256) {
        return uint256(keccak256(abi.encode(i, salt)));
    }

    function checkAllExt() external view {
        _checkAll();
    }

    function test_scenarioSweep_realStack() public {
        for (uint256 i; i < 72; ++i) {
            uint256 kind = i % 9;
            if (kind == 0) {
                keeperH.freshCoverGap(i, _r(i, 1), _r(i, 2), _r(i, 3), _r(i, 4), int256(_r(i, 5) % 200) - 100);
            } else if (kind == 1) {
                traderH.restOwnBid(i, _r(i, 6), _r(i, 7)); // CR1: own resting bid before the next gap
                keeperH.freshCoverGap(i, _r(i, 8), _r(i, 9), _r(i, 10), _r(i, 11), 0);
            } else if (kind == 2) {
                attackerH.selfDeal(_r(i, 12), _r(i, 13), _r(i, 14), _r(i, 15), i % 4 == 2, i % 3 == 0);
            } else if (kind == 3) {
                marketH.move(_r(i, 16), i % 2 == 0, 0);
                lpH.deposit(i, _r(i, 17));
                traderH.buy(i, _r(i, 18), _r(i, 19), _r(i, 20), _r(i, 21));
                keeperH.expire(i);
                keeperH.voidCover(i);
            } else if (kind == 4) {
                marketH.stale(_r(i, 22)); // publisher outage, then a gap scenario on the armed path
                keeperH.gapAndSettle(i, _r(i, 23) | 1, _r(i, 24), _r(i, 25), 0, i);
                marketH.move(0, true, 0);
            } else if (kind == 5) {
                adminH.setParams(5, 100, 50, 5000, 100 + _r(i, 26) % 2500, 40, 200); // tight per-block cap: deferral
                keeperH.freshCoverGap(i, _r(i, 27), 300, _r(i, 28), 200, -100);
                adminH.setParams(5, 100, 50, 5000, 2500, 40, 200);
            } else if (kind == 6) {
                attackerH.stopHunt(_r(i, 29), _r(i, 30), _r(i, 31), _r(i, 32), i % 3 != 0); // H-01 on a thin book
            } else if (kind == 7) {
                attackerH.selfDealOnTouch(_r(i, 33), _r(i, 34), _r(i, 35), _r(i, 36), i % 2 == 0);
            } else {
                // N-05: same touch (gap 1 to 10, steps widen, C7) or a later touch (gap 1,000, must start tight).
                uint256 gap = (i / 9) % 2 == 0 ? 1 + _r(i, 37) % 10 : 1000;
                keeperH.touchRecoverTouch(i, _r(i, 38), gap, 6, gap > 10, i);
            }
            this.checkAllExt(); // external: fresh memory per round (64 rounds in one frame run out of memory)
        }
        _logStats();
        assertGt(ghost.triggers(), 5, "honest triggers exercised");
        assertGt(ghost.finalizes(), 5, "finalizes exercised");
        assertGt(ghost.episodes(), 5, "attack episodes exercised");
        assertGt(ghost.hunts(), 5, "stop hunts exercised");
        assertGt(ghost.touchEpisodes(), 5, "self-deals on a touch exercised");
        assertGt(ghost.relapses(), 5, "touch, recover, touch exercised");
        assertGt(ghost.chainWidened(), 0, "stepped floors exercised");
        assertGt(ghost.chainHolds(), 0, "match-limited holds exercised (C7)");
    }
}
