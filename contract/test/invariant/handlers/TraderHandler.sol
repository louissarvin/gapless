// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {GaplessAccount} from "../../../src/GaplessAccount.sol";
import {IPerplMin} from "../../../src/interfaces/perpl/IPerplMin.sol";
import {CoverParams, Cover, CoverStatus} from "../../../src/types/GaplessTypes.sol";
import {HandlerBase} from "./HandlerBase.sol";

/// @notice Honest traders on real GaplessAccounts: open, reduce, rest own bids (CR1), buy and cancel covers.
contract TraderHandler is HandlerBase {
    GaplessAccount[] public accounts;

    constructor(Env memory e, GaplessAccount[] memory a) HandlerBase(e) {
        for (uint256 i; i < a.length; ++i) {
            accounts.push(a[i]);
        }
    }

    function _acct(uint256 i) internal view returns (GaplessAccount) {
        return accounts[i % accounts.length];
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

    function _pos(GaplessAccount a) internal view returns (IPerplMin.PositionInfo memory p) {
        (p,,) = ex.getPosition(perp, a.perplAccountId());
    }

    function open(uint256 i, bool isLong, uint256 lots) external {
        _publish();
        GaplessAccount a = _acct(i);
        lots = bound(lots, 1, 60);
        uint256 m = _mark();
        vm.prank(a.owner());
        try a.trade(_order(isLong ? 0 : 1, isLong ? m * 101 / 100 : m * 99 / 100, lots, true)) {
            _checkI10(a);
        } catch {}
    }

    function reduce(uint256 i, uint256 lots) external {
        _publish();
        GaplessAccount a = _acct(i);
        IPerplMin.PositionInfo memory p = _pos(a);
        if (p.lotLNS == 0) return;
        lots = bound(lots, 1, p.lotLNS);
        bool isLong = p.positionType == 0;
        uint256 m = _mark();
        vm.prank(a.owner());
        try a.trade(_order(isLong ? 2 : 3, isLong ? m * 97 / 100 : m * 103 / 100, lots, true)) {
            _checkI10(a);
        } catch {}
    }

    /// @dev CR1: a trader-owned resting bid on the covered perp; Perpl clears it by self-match during a close.
    function restOwnBid(uint256 i, uint256 offBps, uint256 lots) external {
        _publish();
        GaplessAccount a = _acct(i);
        offBps = bound(offBps, 0, 300);
        lots = bound(lots, 1, 30);
        vm.prank(a.owner());
        try a.trade(_order(0, _mark() * (1e4 - offBps) / 1e4, lots, false)) {} catch {}
    }

    function buy(uint256 i, uint256 distBps, uint256 lots, uint256 gap, uint256 dur) external {
        _publish();
        GaplessAccount a = _acct(i);
        IPerplMin.PositionInfo memory p = _pos(a);
        if (p.lotLNS == 0) return;
        bool isLong = p.positionType == 0;
        uint256 m = _mark();
        distBps = bound(distBps, 10, 150);
        _freshSigma();
        uint256 maxLots = cm.marketParams(perp).maxCoverNotionalCNS / (m * (1e4 + distBps) / 1e4);
        if (maxLots == 0) return;
        CoverParams memory cp = CoverParams({
            perpId: perp,
            isLong: isLong,
            lots: bound(lots, 1, p.lotLNS < maxLots ? p.lotLNS : maxLots),
            stopPNS: isLong ? m * (1e4 - distBps) / 1e4 : m * (1e4 + distBps) / 1e4,
            maxGapBps: uint16(bound(gap, 50, 200)),
            durationBlocks: uint32(bound(dur, 1000, 48_000))
        });
        uint16 aNow = cm.marketParams(perp).slipAllowanceBps;
        vm.prank(a.owner());
        try a.buyCover(cp, 10e6) returns (bytes32 id) {
            ghost.addCover(id, aNow, cp.lots * cp.stopPNS * cm.scaleOf(perp));
        } catch (bytes memory err) {
            ghost.note(err);
        }
    }

    function cancel(uint256 i) external {
        _publish();
        GaplessAccount a = _acct(i);
        bytes32 id = cm.activeCoverOf(address(a), perp);
        if (id == 0) return;
        CoverStatus before = cm.getCover(id).status;
        vm.prank(a.owner());
        try a.cancelCover(id) {} catch {}
        _checkForward(id, before);
    }

    /// @dev I10 after a successful account call: the uncovered remainder fits the position, same side.
    function _checkI10(GaplessAccount a) internal {
        bytes32 id = cm.activeCoverOf(address(a), perp);
        if (id == 0) return;
        Cover memory c = cm.getCover(id);
        if (c.status == CoverStatus.Triggered) return;
        IPerplMin.PositionInfo memory p = _pos(a);
        bool sideOk = p.lotLNS > 0 && (p.positionType == 0) == c.isLong;
        if (!sideOk || p.lotLNS < uint256(c.lots) - c.filledLots) ghost.violate("I10 cover exceeds position");
    }
}
