// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Cover, CoverStatus, MarketParams, CoverParams} from "../../../src/types/GaplessTypes.sol";
import {GaplessAccount} from "../../../src/GaplessAccount.sol";
import {IPerplMin} from "../../../src/interfaces/perpl/IPerplMin.sol";
import {ReferenceLib} from "../../../src/libraries/ReferenceLib.sol";
import {Constants} from "../../../src/Constants.sol";
import {HandlerBase} from "./HandlerBase.sol";

/// @notice Untrusted keepers: every lifecycle call from several senders, plus block advance. Records I9 and I12
/// (trigger preconditions and the armer's exclusive window) by comparing state before and after each trigger.
contract KeeperHandler is HandlerBase {
    address[3] internal keepers;
    GaplessAccount[] internal traders;

    constructor(Env memory e, GaplessAccount[] memory t) HandlerBase(e) {
        keepers = [address(0xA1), address(0xA2), address(0xA3)];
        for (uint256 i; i < t.length; ++i) {
            traders.push(t[i]);
        }
    }

    function arm(uint256 k, uint256 who) external {
        _publish();
        (bytes32 id, bool ok) = _pick(k);
        if (!ok) return;
        CoverStatus before = cm.getCover(id).status;
        _armTracked(id, keepers[who % 3]);
        _checkForward(id, before);
    }

    function trigger(uint256 k, uint256 who) public {
        _publish();
        (bytes32 id, bool ok) = _pick(k);
        if (!ok) return;
        _trigger(id, keepers[who % 3]);
    }

    /// @dev Arm and fire within the arm TTL in one call (random block delays would otherwise lapse most arms).
    function armAndTrigger(uint256 k, uint256 who, uint256 wait, uint256 who2) external {
        _publish();
        (bytes32 id, bool ok) = _pick(k);
        if (!ok) return;
        CoverStatus before = cm.getCover(id).status;
        _armTracked(id, keepers[who % 3]);
        _checkForward(id, before);
        _roll(bound(wait, 1, 6));
        _publish();
        _trigger(id, keepers[who2 % 3]);
    }

    function _trigger(bytes32 id, address caller) internal {
        Cover memory c0 = cm.getCover(id);
        MarketParams memory p = cm.marketParams(perp);
        bool fast = _fastPath(c0, p);
        if (_triggerTracked(id, caller)) {
            Cover memory c1 = cm.getCover(id);
            if (c0.status != CoverStatus.Triggered && c1.status == CoverStatus.Triggered) {
                ghost.triggered();
                bool armedLive = c0.status == CoverStatus.Armed && block.number > c0.armedBlock
                    && block.number <= uint256(c0.armedBlock) + p.armTtlBlocks;
                if (!armedLive && !fast) ghost.violate("I9 trigger without arm or fast path");
                if (block.number > c0.expiryBlock) ghost.violate("I9 trigger after expiry");
                if (block.number < uint256(c0.startBlock) + c0.warmupBlocks && !armedLive) {
                    ghost.violate("I9 trigger inside warm-up");
                }
                // I12 (L-02): the armer's window binds only off the fast path and only if it ends before expiry.
                uint256 exclEnd = uint256(c0.armedBlock) + p.exclusiveBlocks;
                if (armedLive && !fast && block.number <= exclEnd && exclEnd < c0.expiryBlock && caller != c0.armer) {
                    ghost.violate("I12 exclusive window");
                }
            }
        }
        _checkForward(id, c0.status);
        _recordBlockPaid();
    }

    function _fastPath(Cover memory c, MarketParams memory p) internal view returns (bool) {
        if (block.number < uint256(c.startBlock) + c.warmupBlocks) return false;
        uint256 mark = ex.getPerpetualInfo(perp).markPNS;
        uint256 ts = ex.getPerpetualInfo(perp).markTimestamp;
        if (!ReferenceLib.isFresh(ts, p.refFreshSec, Constants.REF_TS_TOLERANCE_SEC, block.timestamp, 0)) return false;
        return c.isLong ? mark <= c.stopPNS : mark >= c.stopPNS;
    }

    function observe(uint256 k) external {
        _publish();
        (bytes32 id, bool ok) = _pick(k);
        if (!ok) return;
        CoverStatus before = cm.getCover(id).status;
        try cm.observe(id) {} catch {}
        _checkForward(id, before);
    }

    function finalize(uint256 k) external {
        _publish();
        (bytes32 id, bool ok) = _pick(k);
        if (!ok) return;
        CoverStatus before = cm.getCover(id).status;
        try cm.finalize(id) {
            Cover memory c = cm.getCover(id);
            if (c.status == CoverStatus.Finalized) {
                ghost.finalized();
                if (c.owedCNS != 0) ghost.violate("I4 finalized with owed");
            }
        } catch {}
        _checkForward(id, before);
        _recordBlockPaid();
    }

    function expire(uint256 k) external {
        _publish();
        (bytes32 id, bool ok) = _pick(k);
        if (!ok) return;
        CoverStatus before = cm.getCover(id).status;
        try cm.expire(id) {} catch {}
        _checkForward(id, before);
    }

    function voidCover(uint256 k) external {
        _publish();
        (bytes32 id, bool ok) = _pick(k);
        if (!ok) return;
        CoverStatus before = cm.getCover(id).status;
        try cm.voidCover(id) {} catch {}
        _checkForward(id, before);
    }

    struct Gap {
        bytes32 id;
        uint256 ref;
        uint256 post;
        bool fast;
    }

    /// @dev Atomic gap scenario (random block delays between calls would expire most lifecycles): the market gaps
    /// through a live cover's stop, the closing side is swept and refilled below the reference, then the keeper
    /// arms (or uses the fast path), triggers, observes a post-trigger publish and finalizes.
    function gapAndSettle(uint256 k, uint256 throughBps, uint256 offBps, uint256 depth, int256 postBps, uint256 who)
        external
    {
        (bytes32 id, bool ok) = _pick(k);
        if (!ok) return;
        _gap(id, throughBps, offBps, depth, postBps, who);
    }

    /// @dev Same scenario on a cover bought in this call by trader `i` (keeps the live population non-empty).
    function freshCoverGap(uint256 i, uint256 distBps, uint256 throughBps, uint256 offBps, uint256 depth, int256 postBps)
        external
    {
        GaplessAccount a = traders[i % traders.length];
        ghost.setOutage(false);
        _refs(_mark());
        _requoteNow();
        bytes32 id = cm.activeCoverOf(address(a), perp);
        if (id == 0) id = _buyFor(a, distBps);
        if (id == 0) return;
        _gap(id, throughBps, offBps, depth, postBps, i);
    }

    function _buyFor(GaplessAccount a, uint256 distBps) internal returns (bytes32 id) {
        (IPerplMin.PositionInfo memory p,,) = ex.getPosition(perp, a.perplAccountId());
        if (p.lotLNS == 0) {
            uint256 m = _mark();
            try mm.rest(1, perp, m, 50) {} catch {}
            IPerplMin.OrderDesc memory d;
            d.perpId = perp;
            d.pricePNS = m * 101 / 100;
            d.lotLNS = 50;
            d.immediateOrCancel = true;
            d.leverageHdths = 1000;
            d.maxNegPnlCollatBPS = 300;
            vm.prank(a.owner());
            try a.trade(d) {} catch {}
            (p,,) = ex.getPosition(perp, a.perplAccountId());
            if (p.lotLNS == 0) return 0;
        }
        _freshSigma();
        bool isLong = p.positionType == 0;
        uint256 mk = _mark();
        distBps = bound(distBps, 15, 120);
        uint256 stop = isLong ? mk * (1e4 - distBps) / 1e4 : mk * (1e4 + distBps) / 1e4;
        uint256 lots = p.lotLNS;
        uint256 maxLots = cm.marketParams(perp).maxCoverNotionalCNS / stop;
        if (lots > maxLots) lots = maxLots;
        if (lots == 0) return 0;
        CoverParams memory cp = CoverParams(perp, isLong, lots, stop, 200, 48_000);
        uint16 aNow = cm.marketParams(perp).slipAllowanceBps;
        vm.prank(a.owner());
        try a.buyCover(cp, 10e6) returns (bytes32 nid) {
            id = nid;
            ghost.addCover(id, aNow, lots * stop * cm.scaleOf(perp));
        } catch (bytes memory err) {
            ghost.note(err);
        }
    }

    function _gap(bytes32 id, uint256 throughBps, uint256 offBps, uint256 depth, int256 postBps, uint256 who) internal {
        Cover memory c = cm.getCover(id);
        if (c.status != CoverStatus.Live && c.status != CoverStatus.Armed) return;
        uint256 ready = uint256(c.startBlock) + c.warmupBlocks;
        if (block.number < ready) _roll(ready - block.number);
        if (block.number > c.expiryBlock) {
            try cm.expire(id) {} catch {}
            return;
        }
        Gap memory g;
        g.id = id;
        g.fast = throughBps % 4 == 0;
        throughBps = bound(throughBps, 0, 300);
        g.ref = c.isLong ? uint256(c.stopPNS) * (1e4 - throughBps) / 1e4 : uint256(c.stopPNS) * (1e4 + throughBps) / 1e4;
        ghost.setOutage(false);
        _refs(_mark());
        try mm.ioc(c.isLong ? 1 : 0, perp, c.stopPNS, 400_000) {} catch {}
        _refs(g.ref);
        offBps = bound(offBps, 0, 150);
        uint256 lvl = c.isLong ? g.ref * (1e4 - offBps) / 1e4 : g.ref * (1e4 + offBps) / 1e4;
        try mm.rest(c.isLong ? 0 : 1, perp, lvl, bound(depth, 1, 200)) {} catch {}
        if (!g.fast) {
            _armTracked(id, keepers[who % 3]);
            _checkForward(id, c.status);
            _roll(1);
            _refs(g.ref);
        }
        _trigger(id, keepers[who % 3]);
        postBps = bound(postBps, -100, 100);
        g.post = uint256(int256(g.ref) + int256(g.ref) * postBps / 1e4);
        _roll(2);
        _refs(g.post);
        try mm.rest(c.isLong ? 0 : 1, perp, lvl, bound(depth, 1, 200)) {} catch {}
        _triggerTracked(id, keepers[who % 3]); // remainder, if any
        try cm.observe(id) {} catch {}
        _roll(uint256(c.windowBlocks) + 1);
        _refs(g.post);
        for (uint256 i; i < 3 && cm.getCover(id).status == CoverStatus.Triggered; ++i) {
            CoverStatus b = cm.getCover(id).status;
            try cm.finalize(id) {
                if (cm.getCover(id).status == CoverStatus.Finalized) {
                    ghost.finalized();
                    if (cm.getCover(id).owedCNS != 0) ghost.violate("I4 finalized with owed");
                }
            } catch {}
            _checkForward(id, b);
            _recordBlockPaid();
            _roll(1);
        }
    }

    function roll(uint256 n) external {
        _roll(bound(n, 1, 400));
    }

    struct Relapse {
        bytes32 id;
        uint256 fair;
        uint256 hunt;
        bool isLong;
        address who;
        uint256 mix;
    }

    /// @notice N-05: a touch whose fast-path close finds no bid, a recovery, then a later touch where a third party
    /// empties the book and rests one order a tick inside the widened floor, followed by a few keeper retries.
    /// `gap` picks the distance between the touches (1 to 10 blocks: same touch; up to 1,500: a new touch). C7: retries
    /// land 1 to 12 blocks apart (11 and 12 end the chain) and some are preceded by maxMatchesClose + 1 one-lot
    /// orders at the touch price, so the attempt is match-limited and holds its step (SE2-H1 remainder case).
    /// I14 then checks every fill against the independent chain model in HandlerBase.
    function touchRecoverTouch(uint256 i, uint256 distBps, uint256 gap, uint256 retries, bool recover, uint256 who)
        external
    {
        Relapse memory r;
        ghost.setOutage(false);
        r.fair = _mark();
        _refs(r.fair);
        _requoteNow();
        r.id = _relapseCover(i, distBps);
        if (r.id == 0) return;
        Cover memory c = cm.getCover(r.id);
        uint256 ready = uint256(c.startBlock) + c.warmupBlocks;
        if (block.number < ready) _roll(ready - block.number);
        r.isLong = c.isLong;
        r.who = keepers[who % 3];
        r.mix = uint256(keccak256(abi.encode(i, gap, who)));
        ghost.relapsed();

        _touch(c, c.stopPNS);
        _triggerTracked(r.id, r.who); // first touch: no bid within reach, nothing fills

        gap = bound(gap, 1, 1500);
        if (recover) {
            _refs(r.fair);
            _requoteNow();
        }
        _roll(gap);
        _touch(c, c.stopPNS);
        // Third party: one order a tick inside the widest floor, everything better swept away.
        uint256 slack = c.floorSlackBps;
        r.hunt = r.isLong ? uint256(c.stopPNS) * (1e4 - slack) / 1e4 + 1 : uint256(c.stopPNS) * (1e4 + slack) / 1e4;
        try mm.rest(r.isLong ? 0 : 1, perp, r.hunt, c.lots) {} catch {}
        _triggerTracked(r.id, r.who);
        retries = bound(retries, 0, 7);
        for (uint256 k; k < retries && cm.getCover(r.id).filledLots < c.lots; ++k) {
            uint256 m = uint256(keccak256(abi.encode(r.mix, k)));
            _roll(1 + m % 12);
            _refs(c.stopPNS);
            if ((m >> 8) % 3 == 0) _dust(c);
            _triggerTracked(r.id, r.who);
        }
        _settleTouched(r.id);
    }

    /// @dev maxMatchesClose + 1 one-lot orders at the stop: an attempt fills the first maxMatchesClose and leaves one.
    function _dust(Cover memory c) internal {
        uint256 n = uint256(cm.marketParams(perp).maxMatchesClose) + 1;
        for (uint256 j; j < n; ++j) {
            try mm.rest(c.isLong ? 0 : 1, perp, c.stopPNS, 1) {} catch {}
        }
    }

    /// @dev First trader (from i) with a Live cover that outlives the scenario, buying one if it has none.
    function _relapseCover(uint256 i, uint256 distBps) internal returns (bytes32) {
        for (uint256 j; j < traders.length; ++j) {
            GaplessAccount a = traders[(i + j) % traders.length];
            bytes32 id = cm.activeCoverOf(address(a), perp);
            if (id == 0) id = _buyFor(a, distBps);
            if (id == 0) continue;
            Cover memory c = cm.getCover(id);
            if (c.status == CoverStatus.Live && uint256(c.startBlock) + c.warmupBlocks + 1600 < c.expiryBlock) {
                return id;
            }
        }
        return 0;
    }

    /// @dev References at `px` (through the stop) and the closing side of the book emptied well past the floors.
    function _touch(Cover memory c, uint256 px) internal {
        _refs(px);
        uint256 far = c.isLong ? px * 96 / 100 : px * 104 / 100;
        try mm.ioc(c.isLong ? 1 : 0, perp, far, 1_000_000) {} catch {}
        _refs(px);
    }

    function _settleTouched(bytes32 id) internal {
        Cover memory c = cm.getCover(id);
        if (c.status != CoverStatus.Triggered) return;
        _roll(uint256(c.windowBlocks) + 1);
        _refs(_mark());
        for (uint256 k; k < 3 && cm.getCover(id).status == CoverStatus.Triggered; ++k) {
            try cm.finalize(id) {
                if (cm.getCover(id).status == CoverStatus.Finalized) ghost.finalized();
            } catch {}
            _recordBlockPaid();
            _roll(1);
        }
    }
}
