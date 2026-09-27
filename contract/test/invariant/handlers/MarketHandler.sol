// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {GaplessAccount} from "../../../src/GaplessAccount.sol";
import {IPerplMin} from "../../../src/interfaces/perpl/IPerplMin.sol";
import {HandlerBase} from "./HandlerBase.sol";

/// @notice Exogenous market: references move together or diverge, go stale, the book is rebuilt or swept, the
/// venue halts, and Perpl liquidates or ADLs trader positions.
contract MarketHandler is HandlerBase {
    uint256 public immutable P0;
    GaplessAccount[] internal traders;

    constructor(Env memory e, GaplessAccount[] memory t) HandlerBase(e) {
        P0 = ex.getPerpetualInfo(perp).markPNS;
        for (uint256 i; i < t.length; ++i) {
            traders.push(t[i]);
        }
    }

    function _clamp(uint256 px) internal view returns (uint256) {
        return bound(px, P0 * 80 / 100, P0 * 120 / 100);
    }

    /// @param staleMask bit 0 skips the mark, bit 1 the oracle, bit 2 the feed (they keep their old timestamps).
    function move(uint256 bps, bool down, uint8 staleMask) external {
        uint256 m = _mark();
        bps = bound(bps, 0, 400);
        uint256 px = _clamp(down ? m * (1e4 - bps) / 1e4 : m * (1e4 + bps) / 1e4);
        ghost.setOutage(false);
        if (staleMask & 1 == 0) ex.setMark(perp, px);
        if (staleMask & 2 == 0) ex.setOracle(perp, px);
        if (staleMask & 4 == 0) feed.setAnswer(int256(px) * 1e7);
    }

    /// @dev One source diverges (A4); the median of three should ignore it.
    function skewOne(uint8 which, uint256 bps, bool down) external {
        uint256 m = _mark();
        bps = bound(bps, 0, 1000);
        uint256 px = _clamp(down ? m * (1e4 - bps) / 1e4 : m * (1e4 + bps) / 1e4);
        which %= 3;
        if (which == 0) ex.setMark(perp, px);
        else if (which == 1) ex.setOracle(perp, px);
        else feed.setAnswer(int256(px) * 1e7);
    }

    /// @dev Publisher outage: time passes with no publishes until the next move (D49, trigger must still work).
    function stale(uint256 secs) external {
        ghost.setOutage(true);
        vm.warp(block.timestamp + bound(secs, 1, 300));
    }

    function restBid(uint256 offBps, uint256 lots) external {
        uint256 px = _mark() * (1e4 - bound(offBps, 0, 500)) / 1e4;
        try mm.rest(0, perp, px, bound(lots, 1, 200)) {} catch {}
    }

    function restAsk(uint256 offBps, uint256 lots) external {
        uint256 px = _mark() * (1e4 + bound(offBps, 0, 500)) / 1e4;
        try mm.rest(1, perp, px, bound(lots, 1, 200)) {} catch {}
    }

    /// @dev A large taker sweeps resting bids (or asks) down to 3% through the mark, emptying the side.
    function sweep(bool bids, uint256 lots) external {
        uint256 m = _mark();
        ex.setMark(perp, m); // opens need a fresh mark
        lots = bound(lots, 1, 400_000);
        try mm.ioc(bids ? 1 : 0, perp, bids ? m * 97 / 100 : m * 103 / 100, lots) {} catch {}
    }

    /// @dev Rare venue outage (about 1 call in 8 takes the venue down).
    function venue(uint8 seed) external {
        uint256 h = uint256(keccak256(abi.encode(seed, block.number))); // fuzzers favor 0
        if (h % 8 != 0) return;
        ex.setHalted(h % 16 == 0);
        ex.setPerpStatus(perp, h % 16 == 0 ? 4 : 0);
    }

    function venueUp() external {
        ex.setHalted(false);
        ex.setPerpStatus(perp, 4);
    }

    /// @dev Gap event: references drop (or jump) by `bps`, the bids (asks) above are swept, a new level rests.
    function crash(uint256 bps, bool down, uint256 restOffBps, uint256 depth) external {
        uint256 m = _mark();
        bps = bound(bps, 10, 400);
        uint256 px = _clamp(down ? m * (1e4 - bps) / 1e4 : m * (1e4 + bps) / 1e4);
        ghost.setOutage(false);
        _refs(m);
        try mm.ioc(down ? 1 : 0, perp, down ? px : px, 400_000) {} catch {}
        _refs(px);
        restOffBps = bound(restOffBps, 0, 150);
        uint256 lvl = down ? px * (1e4 - restOffBps) / 1e4 : px * (1e4 + restOffBps) / 1e4;
        try mm.rest(down ? 0 : 1, perp, lvl, bound(depth, 1, 300)) {} catch {}
    }

    function liquidate(uint256 i) external {
        GaplessAccount a = traders[i % traders.length];
        try ex.liquidate(perp, a.perplAccountId()) {} catch {}
    }

    function adl(uint256 i, uint256 lots) external {
        GaplessAccount a = traders[i % traders.length];
        (IPerplMin.PositionInfo memory p,,) = ex.getPosition(perp, a.perplAccountId());
        if (p.lotLNS == 0) return;
        try ex.adl(perp, a.perplAccountId(), bound(lots, 1, p.lotLNS)) {} catch {}
    }

    function funding(uint256 i, int256 delta) external {
        GaplessAccount a = traders[i % traders.length];
        try ex.accrueFunding(perp, a.perplAccountId(), bound(delta, -1e6, 1e6)) {} catch {}
    }
}
