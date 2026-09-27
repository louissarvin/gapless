// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {GaplessAccount} from "../../../src/GaplessAccount.sol";
import {IPerplMin} from "../../../src/interfaces/perpl/IPerplMin.sol";
import {PremiumMath} from "../../../src/libraries/PremiumMath.sol";
import {PayoutMath} from "../../../src/libraries/PayoutMath.sol";
import {CoverParams, Cover, CoverStatus, MarketParams} from "../../../src/types/GaplessTypes.sol";
import {PerplTrader} from "../../mocks/PerplTrader.sol";
import {HandlerBase} from "./HandlerBase.sol";

/// @notice A1 self-dealer: a covered long on a real GaplessAccount plus a colluding Perpl account. Each episode
/// runs atomically with the reference held at the current mark (no real move) or, with `touch`, exactly at the
/// stop (a genuine touch): open, buy a cover near the minimum distance, optionally clear the bids above the stop and
/// rest an own bid (CR1), arm, rest the colluder's bid anywhere in [floor, stop], trigger, finalize, unwind at the
/// reference. H-01 stop hunter: a third party wicks a thin, mainnet-like bid book through an honest trader's stop
/// while references stay at fair value. Also donates to vault and manager.
contract AttackerHandler is HandlerBase {
    GaplessAccount public immutable atk;
    address public immutable owner;
    PerplTrader public immutable col;
    GaplessAccount public immutable victim;
    PerplTrader public immutable hunter;
    address internal constant HUNTER_KEY = address(0xBAD);

    struct Ep {
        uint256 p;
        uint256 lots;
        uint256 stop;
        uint16 gap;
        bytes32 id;
        int256 v0;
    }

    constructor(Env memory e, GaplessAccount atk_, PerplTrader col_, GaplessAccount victim_, PerplTrader hunter_)
        HandlerBase(e)
    {
        atk = atk_;
        owner = atk_.owner();
        col = col_;
        victim = victim_;
        hunter = hunter_;
    }

    function _equity(uint256 accountId) internal view returns (int256) {
        IPerplMin.AccountInfo memory a = ex.getAccountById(accountId);
        (IPerplMin.PositionInfo memory p,,) = ex.getPosition(perp, accountId);
        return int256(a.balanceCNS + a.lockedBalanceCNS + p.depositCNS) + p.pnlCNS + p.premiumPnlCNS;
    }

    function _value() internal view returns (int256) {
        return int256(ausd.balanceOf(address(atk)) + ausd.balanceOf(owner) + ausd.balanceOf(address(col)))
            + _equity(atk.perplAccountId()) + _equity(col.accountId());
    }

    function _order(uint8 t, uint256 px, uint256 lots, bool ioc) internal view returns (IPerplMin.OrderDesc memory d) {
        d.perpId = perp;
        d.orderType = t;
        d.pricePNS = px;
        d.lotLNS = lots;
        d.immediateOrCancel = ioc;
        d.leverageHdths = 1000;
        d.maxNegPnlCollatBPS = 300;
    }

    function selfDeal(uint256 lots, uint256 extraBps, uint256 gap, uint256 bidOff, bool sweepAbove, bool ownBid)
        external
    {
        _selfDeal(lots, extraBps, gap, bidOff, sweepAbove, ownBid, false);
    }

    /// @dev Same episode while the market genuinely touches the stop (references at the stop).
    function selfDealOnTouch(uint256 lots, uint256 extraBps, uint256 gap, uint256 bidOff, bool ownBid) external {
        _selfDeal(lots, extraBps, gap, bidOff, true, ownBid, true);
    }

    function _selfDeal(
        uint256 lots,
        uint256 extraBps,
        uint256 gap,
        uint256 bidOff,
        bool sweepAbove,
        bool ownBid,
        bool touch
    ) internal {
        if (cm.activeCoverOf(address(atk), perp) != 0 || cm.paused()) return;
        if (ex.isHalted() || ex.getPerpetualInfo(perp).status != 4) return;
        Ep memory e;
        e.p = _mark();
        _refs(e.p);
        _requoteNow();
        e.v0 = _value();
        e.lots = bound(lots, 1, 55);
        e.gap = uint16(bound(gap, 50, cm.marketParams(perp).maxGapBpsCap));
        if (!_open(e)) return _close(e, false);
        if (!_buy(e, extraBps)) return _close(e, false);

        MarketParams memory mp = cm.marketParams(perp);
        _roll(mp.warmupBlocks);
        _refs(e.p);
        if (touch) ghost.touched();
        if (sweepAbove) {
            ex.setMark(perp, e.p);
            try col.ioc(1, perp, e.stop, 400_000) {} catch {} // sells into every bid at or above the stop
        }
        if (ownBid) {
            vm.prank(owner);
            try atk.trade(_order(0, e.stop - 1, 5, false)) {} catch {}
        }
        uint256 refPx = touch ? e.stop : e.p;
        _refs(refPx);
        _armTracked(e.id, address(this));
        _roll(1);
        _refs(refPx);
        (uint256 ref,) = cm.referencePrice(perp, true, 0);
        uint256 floor = PayoutMath.tightLimitPNS(ref, cm.getCover(e.id).slipAllowanceBps, true);
        uint256 bid = floor + bound(bidOff, 0, e.stop > floor ? e.stop - floor : 0);
        try col.rest(0, perp, Math.max(bid, 1), e.lots) {} catch {}
        bool fired = _triggerTracked(e.id, address(this)) && cm.getCover(e.id).status == CoverStatus.Triggered;
        _recordBlockPaid();
        _settle(e, mp);
        _close(e, fired);
    }

    function _open(Ep memory e) internal returns (bool) {
        try mm.rest(1, perp, e.p, e.lots) {} catch {}
        vm.prank(owner);
        try atk.trade(_order(0, e.p * 101 / 100, e.lots, true)) {} catch {
            return false;
        }
        (IPerplMin.PositionInfo memory pos,,) = ex.getPosition(perp, atk.perplAccountId());
        if (pos.lotLNS == 0 || pos.positionType != 0) return false;
        e.lots = pos.lotLNS;
        return true;
    }

    function _buy(Ep memory e, uint256 extraBps) internal returns (bool) {
        _freshSigma();
        (uint32 sigma,) = cm.sigmaOf(perp);
        uint256 d = PremiumMath.minDistanceBps(cm.marketParams(perp), sigma) + bound(extraBps, 0, 20);
        e.stop = e.p * (1e4 - d) / 1e4;
        uint256 lots = Math.min(e.lots, cm.marketParams(perp).maxCoverNotionalCNS / e.stop);
        if (lots == 0) return false;
        CoverParams memory cp = CoverParams(perp, true, lots, e.stop, e.gap, 12_000);
        uint16 aNow = cm.marketParams(perp).slipAllowanceBps;
        vm.prank(owner);
        try atk.buyCover(cp, 10e6) returns (bytes32 id) {
            e.id = id;
            ghost.addCover(id, aNow, lots * e.stop * cm.scaleOf(perp));
            return true;
        } catch {
            return false;
        }
    }

    /// @dev Window, observe, finalize (deferral retried), or wait out an unfired arm and cancel.
    function _settle(Ep memory e, MarketParams memory mp) internal {
        Cover memory c = cm.getCover(e.id);
        if (c.status == CoverStatus.Triggered) {
            _roll(mp.windowBlocks + 1);
            _refs(e.p);
            for (uint256 k; k < 4 && cm.getCover(e.id).status == CoverStatus.Triggered; ++k) {
                try cm.finalize(e.id) {} catch {}
                _roll(1);
            }
        } else if (c.status == CoverStatus.Armed || c.status == CoverStatus.Live) {
            _roll(mp.armTtlBlocks + 1);
            vm.prank(owner);
            try atk.cancelCover(e.id) {} catch {}
        }
    }

    /// @dev Unwinds both accounts at the reference against the deep market maker, then books the episode.
    function _close(Ep memory e, bool fired) internal {
        _refs(e.p);
        (IPerplMin.PositionInfo memory pa,,) = ex.getPosition(perp, atk.perplAccountId());
        if (pa.lotLNS > 0 && cm.activeCoverOf(address(atk), perp) == 0) {
            bool isLong = pa.positionType == 0;
            try mm.rest(isLong ? 0 : 1, perp, e.p, pa.lotLNS) {} catch {}
            vm.prank(owner);
            try atk.trade(_order(isLong ? 2 : 3, isLong ? e.p * 97 / 100 : e.p * 103 / 100, pa.lotLNS, true)) {} catch {}
        }
        (IPerplMin.PositionInfo memory pc,,) = ex.getPosition(perp, col.accountId());
        if (pc.lotLNS > 0) {
            bool isLong = pc.positionType == 0;
            try mm.rest(isLong ? 0 : 1, perp, e.p, pc.lotLNS) {} catch {}
            try col.ioc(isLong ? 2 : 3, perp, isLong ? e.p * 97 / 100 : e.p * 103 / 100, pc.lotLNS) {} catch {}
        }
        int256 protocol;
        if (e.id != 0) {
            Cover memory c = cm.getCover(e.id);
            (uint256 kept,) = PayoutMath.escrowSplit(c.escrowCNS, c.filledLots, c.lots);
            bool ended = uint8(c.status) >= uint8(CoverStatus.Finalized);
            // Rent and escrow kept only count once the cover has ended (still held by the manager otherwise).
            protocol = int256(uint256(c.paidCNS)) - (ended ? int256(kept + c.rentCNS) : int256(0));
            if (!ended) protocol -= int256(uint256(c.escrowCNS) + c.rentCNS); // still paid in, not yet refunded
        }
        ghost.episode(protocol, _value() - e.v0, fired);
    }

    struct Hunt {
        uint256 fair;
        uint256 stop;
        uint256 lots;
        bytes32 id;
        int256 h0;
        uint256 bidOid;
    }

    /// @notice H-01: a covered long on a thin, mainnet-like bid book (BTC-PERP depth profile scaled to the cover);
    /// the hunter sells through the stop, rests a bid under it, arms and triggers. References stay at fair value.
    function stopHunt(uint256 distBps, uint256 depthSeed, uint256 sweepOff, uint256 bidOff, bool tryTrigger) external {
        if (cm.activeCoverOf(address(victim), perp) != 0 || cm.paused() || cm.marketPaused(perp)) return;
        if (ex.isHalted() || ex.getPerpetualInfo(perp).status != 4) return;
        Hunt memory h;
        ghost.setOutage(false); // honest references at fair value for the whole hunt
        h.fair = _mark();
        _refs(h.fair);
        _requoteNow(); // no stale quotes crossed against fair: the hunter's PnL must come from the cover only
        if (!_victimCover(h, distBps)) return _endHunt(h, false);
        _roll(cm.marketParams(perp).warmupBlocks);
        _refs(h.fair);
        _thinBook(h, depthSeed);
        h.h0 = _hunterEquity(h.fair);
        // Sell through the stop into the thin bids, then rest a bid under the stop for the cover's close.
        try hunter.ioc(1, perp, h.stop * (1e4 - bound(sweepOff, 1, 150)) / 1e4, 1_000_000) {} catch {}
        try hunter.rest(0, perp, h.stop * (1e4 - bound(bidOff, 0, 150)) / 1e4, h.lots) returns (uint256 oid) {
            h.bidOid = oid;
        } catch {}
        _armTracked(h.id, HUNTER_KEY);
        _roll(1);
        _refs(h.fair);
        if (tryTrigger) _triggerTracked(h.id, HUNTER_KEY);
        _endHunt(h, cm.getCover(h.id).filledLots > 0);
    }

    function _victimCover(Hunt memory h, uint256 distBps) internal returns (bool) {
        _freshSigma();
        (uint32 sigma,) = cm.sigmaOf(perp);
        uint256 d = PremiumMath.minDistanceBps(cm.marketParams(perp), sigma) + bound(distBps, 0, 40);
        h.stop = h.fair * (1e4 - d) / 1e4;
        h.lots = cm.marketParams(perp).maxCoverNotionalCNS / h.stop;
        if (h.lots == 0) return false;
        try mm.rest(1, perp, h.fair, h.lots) {} catch {}
        vm.prank(victim.owner());
        try victim.trade(_order(0, h.fair * 101 / 100, h.lots, true)) {} catch {
            return false;
        }
        (IPerplMin.PositionInfo memory pos,,) = ex.getPosition(perp, victim.perplAccountId());
        if (pos.lotLNS < h.lots || pos.positionType != 0) return false;
        uint16 aNow = cm.marketParams(perp).slipAllowanceBps;
        vm.prank(victim.owner());
        try victim.buyCover(CoverParams(perp, true, h.lots, h.stop, 200, 12_000), 10e6) returns (bytes32 id) {
            h.id = id;
            ghost.addCover(id, aNow, h.lots * h.stop * cm.scaleOf(perp));
            return true;
        } catch {
            return false;
        }
    }

    /// @dev Clears every bid down to 3% under fair, then rests the measured BTC-PERP profile (3 to 71 bps) at
    /// 0.5x to 4x of the cover size; the mainnet ratio is about 3.6x a spec-size cover.
    function _thinBook(Hunt memory h, uint256 depthSeed) internal {
        try mm.ioc(1, perp, h.fair * 97 / 100, 1_000_000) {} catch {}
        _refs(h.fair);
        uint16[6] memory bps = [uint16(3), 6, 23, 43, 64, 71];
        uint16[6] memory w = [uint16(6022), 1780, 163, 163, 164, 29];
        uint256 k = bound(depthSeed, 50, 400); // percent of the mainnet-to-cover ratio
        for (uint256 i; i < 6; ++i) {
            uint256 lots = uint256(w[i]) * h.lots * k / (2331 * 100);
            if (lots > 0) try mm.rest(0, perp, h.fair * (1e4 - bps[i]) / 1e4, lots) {} catch {}
        }
    }

    function _hunterEquity(uint256 px) internal view returns (int256 e) {
        PerplTrader.Snap memory sn = hunter.snap(perp);
        e = int256(sn.balance + sn.locked + sn.deposit) + sn.premium;
        if (sn.lots > 0) {
            int256 diff = (int256(px) - int256(sn.entryPNS)) * int256(sn.lots);
            e += sn.positionType == 0 ? diff : -diff;
        }
    }

    /// @dev Cancels the hunter's bid, books the hunt marked at fair (before the flattening fee, so the measure only
    /// flatters the hunter), flattens against the deep maker, then unwinds the victim so the next hunt starts clean.
    function _endHunt(Hunt memory h, bool closed) internal {
        _refs(h.fair);
        if (h.bidOid != 0) {
            IPerplMin.OrderDesc memory d = hunter.desc(4, perp, 0, 0, false);
            d.orderId = h.bidOid;
            try hunter.exec(d) {} catch {}
        }
        if (h.id != 0) ghost.hunt(_hunterEquity(h.fair) - h.h0, closed);
        PerplTrader.Snap memory sn = hunter.snap(perp);
        if (sn.lots > 0) {
            bool isLong = sn.positionType == 0;
            try mm.rest(isLong ? 0 : 1, perp, h.fair, sn.lots) {} catch {}
            try hunter.ioc(isLong ? 2 : 3, perp, isLong ? h.fair * 97 / 100 : h.fair * 103 / 100, sn.lots) {} catch {}
        }
        bytes32 id = cm.activeCoverOf(address(victim), perp);
        if (id != 0 && cm.getCover(id).status != CoverStatus.Triggered) {
            vm.prank(victim.owner());
            try victim.cancelCover(id) {} catch {}
        }
        (IPerplMin.PositionInfo memory pv,,) = ex.getPosition(perp, victim.perplAccountId());
        if (pv.lotLNS > 0 && cm.activeCoverOf(address(victim), perp) == 0) {
            try mm.rest(0, perp, h.fair, pv.lotLNS) {} catch {}
            vm.prank(victim.owner());
            try victim.trade(_order(2, h.fair * 97 / 100, pv.lotLNS, true)) {} catch {}
        }
    }

    function donate(uint256 amt, bool toManager) external {
        amt = bound(amt, 1, 10e6);
        ausd.mint(address(this), amt);
        if (toManager) {
            require(ausd.transfer(address(cm), amt));
            ghost.donate(amt);
        } else {
            require(ausd.transfer(address(vault), amt));
        }
    }
}
