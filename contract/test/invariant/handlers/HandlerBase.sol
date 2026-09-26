// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {CommonBase} from "forge-std/Base.sol";
import {Vm} from "forge-std/Vm.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {ICoverManager} from "../../../src/interfaces/ICoverManager.sol";
import {IGaplessAccount} from "../../../src/interfaces/IGaplessAccount.sol";
import {Constants} from "../../../src/Constants.sol";
import {PayoutMath} from "../../../src/libraries/PayoutMath.sol";
import {ReferenceLib} from "../../../src/libraries/ReferenceLib.sol";
import {StdCheats} from "forge-std/StdCheats.sol";
import {StdUtils} from "forge-std/StdUtils.sol";
import {CoverManager} from "../../../src/CoverManager.sol";
import {CoverVault} from "../../../src/CoverVault.sol";
import {IPerplMin} from "../../../src/interfaces/perpl/IPerplMin.sol";
import {Cover, CoverStatus, MarketParams} from "../../../src/types/GaplessTypes.sol";
import {MockAUSD} from "../../mocks/MockAUSD.sol";
import {MockPerplExchange} from "../../mocks/MockPerplExchange.sol";
import {MockFeed} from "../../mocks/MockFeed.sol";
import {PerplTrader} from "../../mocks/PerplTrader.sol";
import {Ghost} from "./Ghost.sol";

/// @notice Shared wiring for the S2 invariant handlers (real S1 stack, mocks for Perpl, AUSD and Chainlink).
abstract contract HandlerBase is CommonBase, StdCheats, StdUtils {
    struct Env {
        MockAUSD ausd;
        MockPerplExchange ex;
        MockFeed feed;
        CoverManager cm;
        CoverVault vault;
        PerplTrader mm; // deep third-party market maker
        Ghost ghost;
        uint256 perp;
        address sigmaKey;
    }

    MockAUSD internal ausd;
    MockPerplExchange internal ex;
    MockFeed internal feed;
    CoverManager internal cm;
    CoverVault internal vault;
    PerplTrader internal mm;
    Ghost internal ghost;
    uint256 internal perp;
    address internal sigmaKey;

    constructor(Env memory e) {
        ausd = e.ausd;
        ex = e.ex;
        feed = e.feed;
        cm = e.cm;
        vault = e.vault;
        mm = e.mm;
        ghost = e.ghost;
        perp = e.perp;
        sigmaKey = e.sigmaKey;
    }

    function _mark() internal view returns (uint256) {
        return ex.getPerpetualInfo(perp).markPNS;
    }

    function _refs(uint256 px) internal {
        ex.setMark(perp, px);
        ex.setOracle(perp, px);
        feed.setAnswer(int256(px) * 1e7);
    }

    function _roll(uint256 n) internal {
        vm.roll(block.number + n);
        vm.warp(block.timestamp + (n * 3 + 9) / 10);
    }

    /// @dev Prefers a non-terminal cover among up to 8 candidates from a random start.
    function _pick(uint256 seed) internal view returns (bytes32 id, bool ok) {
        uint256 n = ghost.count();
        if (n == 0) return (bytes32(0), false);
        for (uint256 k; k < 8 && k < n; ++k) {
            id = ghost.ids((seed + k) % n);
            if (uint8(cm.getCover(id).status) < uint8(CoverStatus.Finalized)) return (id, true);
        }
        return (ghost.ids(seed % n), true);
    }

    /// @dev Heartbeat publisher: unless an outage is on, sources older than half their max age are republished at
    /// their current values (no price change).
    function _publish() internal {
        if (ghost.outage()) return;
        IPerplMin.PerpetualInfo memory info = ex.getPerpetualInfo(perp);
        if (info.markTimestamp + 30 < block.timestamp) ex.setMark(perp, info.markPNS);
        if (info.oracleTimestampSec + 30 < block.timestamp) ex.setOracle(perp, info.oraclePNS);
        (, int256 a,, uint256 updatedAt,) = feed.latestRoundData();
        if (updatedAt + 60 < block.timestamp) feed.setAnswer(a);
        _requote(info);
    }

    function _requoteNow() internal {
        _requote(ex.getPerpetualInfo(perp));
    }

    /// @dev Market maker and arbitrageur that follow the reference: levels crossed against the mark are taken out,
    /// and when the touch drifts more than 10 bps from the mark (or a side is empty) it quotes 100 lots 2 bps away.
    /// Atomic scenarios call this only at their start, so the holes they build persist inside them.
    function _requote(IPerplMin.PerpetualInfo memory info) internal {
        uint256 m = info.markPNS;
        if (m == 0 || ghost.outage()) return;
        uint256 bid = info.maxBidPriceONS == 0 ? 0 : info.basePricePNS + info.maxBidPriceONS;
        uint256 ask = info.minAskPriceONS == 0 ? 0 : info.basePricePNS + info.minAskPriceONS;
        if (ask != 0 && ask < m) try mm.ioc(0, perp, m, 1_000_000) {} catch {}
        if (bid > m) try mm.ioc(1, perp, m, 1_000_000) {} catch {}
        if (bid > m || bid * 1e4 < m * 9990) try mm.rest(0, perp, m * 9998 / 1e4, 100) {} catch {}
        if (ask == 0 || ask < m || ask * 1e4 > m * 10_010) try mm.rest(1, perp, m * 10_002 / 1e4, 100) {} catch {}
    }

    /// @dev Forward-only status check across one call (I3): Armed may fall back to Live; terminal never moves.
    function _checkForward(bytes32 id, CoverStatus before) internal {
        CoverStatus a = cm.getCover(id).status;
        if (a == before) return;
        bool beforeTerminal = uint8(before) >= uint8(CoverStatus.Finalized);
        if (beforeTerminal) return ghost.violate("I3 terminal moved");
        if (before == CoverStatus.Triggered && uint8(a) < uint8(CoverStatus.Finalized)) {
            return ghost.violate("I3 triggered moved back");
        }
        if (before == CoverStatus.Triggered && a != CoverStatus.Finalized) return ghost.violate("I3 triggered end");
    }

    /// @dev The keeper posts sigma on demand when it ages out (spec 4.1); posts keep the current value.
    function _freshSigma() internal {
        (uint32 s, uint48 b) = cm.sigmaOf(perp);
        if (b != 0 && block.number - b <= cm.marketParams(perp).sigmaMaxAgeBlocks) return;
        vm.prank(sigmaKey);
        try cm.postSigma(perp, s == 0 ? 27 : s) {} catch {}
    }

    function _recordBlockPaid() internal {
        ghost.blockPaid(vault.blockPayout(perp).paidCNS);
    }

    // I14 model (N-01, N-05): every arm and trigger in the handlers goes through these wrappers, which rebuild the
    // short-close chain from observed outcomes only and book the allowance each fill is entitled to by the spec:
    // A at step 0, min(floorSlack, A x 2^k) after k thin-book short attempts with R through, each attempt of the touch
    // at most STEP_MAX_GAP_BLOCKS (10) after the previous one (C7).

    function _armTracked(bytes32 id, address caller) internal returns (bool armed) {
        vm.prank(caller);
        try cm.arm(id) returns (bool a) {
            armed = a;
        } catch {}
        Cover memory c = cm.getCover(id);
        if (c.status == CoverStatus.Armed && c.armedBlock == block.number) {
            ghost.resetChain(id);
            if (block.number >= c.expiryBlock) ghost.violate("I9 arm in the expiry block"); // SA3-01
        }
    }

    struct Attempt {
        Cover c0;
        uint256 ref;
        uint256 posLots;
        uint256 ttl;
        bool ok;
    }

    function _triggerTracked(bytes32 id, address caller) internal returns (bool ok) {
        Attempt memory a;
        a.c0 = cm.getCover(id);
        a.ttl = cm.marketParams(perp).armTtlBlocks;
        (a.ref,) = cm.referencePrice(perp, a.c0.isLong, 0);
        uint256 acctId = IGaplessAccount(a.c0.account).perplAccountId();
        if (acctId != 0) {
            (IPerplMin.PositionInfo memory p,,) = ex.getPosition(perp, acctId);
            a.posLots = p.lotLNS;
        }
        vm.recordLogs();
        vm.prank(caller);
        try cm.trigger(id) {
            ok = true;
        } catch {}
        Vm.Log[] memory logs = vm.getRecordedLogs();
        if (ok) _model(id, a, logs);
    }

    function _model(bytes32 id, Attempt memory a, Vm.Log[] memory logs) internal {
        (bool attempted, bool disarmed) = _scan(logs, id);
        Cover memory c0 = a.c0;
        bool lapsed = c0.status == CoverStatus.Armed && block.number > uint256(c0.armedBlock) + a.ttl;
        if (disarmed || lapsed) ghost.resetChain(id);
        if (!attempted) return;
        Cover memory c1 = cm.getCover(id);
        bool through = _thr(c0, a.ref) && (c0.status != CoverStatus.Triggered || _thr(c0, c0.refTrigPNS));
        uint256 sb = ghost.chainBlock(id);
        uint256 k;
        if (through && sb != 0 && block.number - sb <= Constants.STEP_MAX_GAP_BLOCKS) {
            uint256 steps = ghost.chainSteps(id);
            k = block.number != sb || ghost.chainHeld(id) ? steps : steps - 1;
        }
        uint256 allow = k == 0 ? c0.slipAllowanceBps : Math.min(c0.floorSlackBps, uint256(c0.slipAllowanceBps) << k);
        uint256 filled = uint256(c1.filledLots) - c0.filledLots;
        if (filled > 0 && c1.refTrigPNS != 0) {
            uint256 base = Math.min(c1.stopPNS, c1.refTrigPNS);
            ghost.addAllow(id, base * filled * allow / 1e4, k > 0);
        }
        uint256 req = Math.min(uint256(c0.lots) - c0.filledLots, a.posLots);
        _chainAfter(id, a, through && filled < req, k, sb);
    }

    /// @dev SA3-02: a short attempt advances only if no level at or better than its limit is left on the book (one
    /// step per block). C7: otherwise a running chain keeps step k and its gap restarts from this attempt.
    function _chainAfter(bytes32 id, Attempt memory a, bool shortThrough, uint256 k, uint256 sb) internal {
        if (!shortThrough) return ghost.resetChain(id);
        uint256 ref = a.c0.status == CoverStatus.Triggered ? a.c0.refTrigPNS : a.ref;
        bool sameBlock = sb == block.number;
        if (_thinAt(a.c0, _limitAt(a.c0, ref, k))) {
            if (sameBlock && !ghost.chainHeld(id)) return;
            ghost.setChain(id, block.number, Math.min(k + 1, Constants.CLOSE_FLOOR_MAX_STEPS), false);
        } else if (k > 0 && !sameBlock) {
            ghost.setChain(id, block.number, k, true);
        }
    }

    /// @dev Spec close limit at step k for R through the stop (R != 0), clamped to Perpl's price range.
    function _limitAt(Cover memory c, uint256 ref, uint256 k) internal pure returns (uint256 l) {
        if (k == 0) {
            l = PayoutMath.tightLimitPNS(ref, c.slipAllowanceBps, c.isLong);
        } else {
            uint256 allow = Math.min(c.floorSlackBps, uint256(c.slipAllowanceBps) << k);
            l = PayoutMath.closeLimitPNS(c.stopPNS, ref, c.maxGapBps, uint16(allow), c.isLong);
        }
        l = Math.min(Math.max(l, Constants.PERPL_MIN_PRICE_PNS), Constants.PERPL_MAX_PRICE_PNS);
    }

    function _thinAt(Cover memory c, uint256 limit) internal view returns (bool) {
        (uint256 book, bool empty) = ReferenceLib.bookPNS(ex.getPerpetualInfo(perp), c.isLong);
        return empty || (c.isLong ? book < limit : book > limit);
    }

    function _scan(Vm.Log[] memory logs, bytes32 id) internal view returns (bool attempted, bool disarmed) {
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter != address(cm) || logs[i].topics.length < 2 || logs[i].topics[1] != id) continue;
            bytes32 t = logs[i].topics[0];
            if (t == ICoverManager.TriggerNoFill.selector || t == ICoverManager.Triggered.selector) attempted = true;
            if (t == ICoverManager.Disarmed.selector) disarmed = true;
        }
    }

    /// @dev Reference at or through the stop; 0 never is.
    function _thr(Cover memory c, uint256 ref) internal pure returns (bool) {
        return ref != 0 && (c.isLong ? ref <= c.stopPNS : ref >= c.stopPNS);
    }
}
