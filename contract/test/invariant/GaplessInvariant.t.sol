// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {PayoutMath} from "../../src/libraries/PayoutMath.sol";
import {Cover, CoverStatus, PayoutBlockCap} from "../../src/types/GaplessTypes.sol";
import {GaplessInvariantBase} from "./GaplessInvariantBase.sol";

/// @notice Spec 3.9 invariants I1 to I13 and O1/O2 as assertions. Handler-local checks (I3 transitions, I6, I8,
/// I9, I10, I12, I4 at finalize) report through Ghost.violations.
abstract contract GaplessInvariantChecks is GaplessInvariantBase {
    function _ended(CoverStatus s) internal pure returns (bool) {
        return uint8(s) >= uint8(CoverStatus.Finalized);
    }

    /// I1 solvency: the vault holds every reservation in AUSD, and reservations never exceed gross assets
    /// (totalAssets is net of deferred payouts, which stay reserved, L-08).
    function check_I1_solvency() public view {
        assertGe(ausd.balanceOf(address(vault)), vault.reservedTotal(), "I1 balance < reserved");
        assertLe(vault.reservedTotal(), vault.totalAssets() + vault.owedTotal(), "I1 reserved > assets");
        assertLe(vault.owedTotal(), vault.reservedTotal(), "I1 owed outside the reserve");
    }

    /// I2 payout bound: paid + owed <= min(G_real, max(G_ref trig, post) + A x SN, maxGap x SN) <= Cap, with A the
    /// cover's purchase-time snapshot (L-03), which must equal A at buy.
    function check_I2_payoutBound() public view {
        uint256 n = ghost.count();
        for (uint256 i; i < n; ++i) {
            Cover memory c = cm.getCover(ghost.ids(i));
            uint256 a = c.slipAllowanceBps;
            assertEq(a, ghost.aAtBuy(ghost.ids(i)), "L-03 A snapshot");
            uint256 owed = uint256(c.paidCNS) + c.owedCNS;
            if (c.filledLots == 0) {
                assertEq(owed, 0, "I2 paid without a fill");
                continue;
            }
            uint256 sn = uint256(c.stopPNS) * c.filledLots;
            uint256 gT = PayoutMath.gRefCNS(c.stopPNS, c.refTrigPNS, c.filledLots, 1, c.isLong);
            uint256 gP = c.observed ? PayoutMath.gRefCNS(c.stopPNS, c.refPostPNS, c.filledLots, 1, c.isLong) : 0;
            uint256 b = PayoutMath.boundCNS(c.gRealCumCNS, Math.max(gT, gP), sn, uint16(a), c.maxGapBps);
            assertLe(owed, b, "I2 above min(G_real, G_ref + A, Cap)");
            assertLe(owed, c.capCNS, "I2 above Cap");
        }
    }

    /// I3 one non-terminal cover per (account, perp), and activeCoverOf always points at it.
    function check_I3_singleActive() public view {
        uint256 n = ghost.count();
        for (uint256 i; i < n; ++i) {
            bytes32 id = ghost.ids(i);
            Cover memory c = cm.getCover(id);
            bytes32 act = cm.activeCoverOf(c.account, BTC);
            if (_ended(c.status)) assertTrue(act != id, "I3 terminal still active");
            else assertEq(act, id, "I3 non-terminal not active");
        }
    }

    /// I4 per-block payout cap (O2 as an assertion): the block's payouts never exceed its snapshot.
    function check_I4_O2_blockCap() public view {
        PayoutBlockCap memory b = vault.blockPayout(BTC);
        assertLe(b.paidCNS, b.capCNS, "I4 block payout above cap");
    }

    /// I5 manager custody: AUSD held == escrow + rent of non-terminal covers (+ donations, which stay inert).
    function check_I5_managerCustody() public view {
        uint256 n = ghost.count();
        uint256 sum;
        for (uint256 i; i < n; ++i) {
            Cover memory c = cm.getCover(ghost.ids(i));
            if (!_ended(c.status)) sum += uint256(c.escrowCNS) + c.rentCNS;
        }
        assertEq(
            ausd.balanceOf(address(cm)), sum + cm.refundOwedTotal() + ghost.donatedToManager(), "I5 custody mismatch"
        );
    }

    /// I7 reserve consistency: sum of (Cap - paid) over non-terminal covers == reservedTotal == reserved[BTC].
    function check_I7_reserves() public view {
        uint256 n = ghost.count();
        uint256 sum;
        uint256 live;
        for (uint256 i; i < n; ++i) {
            Cover memory c = cm.getCover(ghost.ids(i));
            if (_ended(c.status)) continue;
            sum += uint256(c.capCNS) - c.paidCNS;
            ++live;
        }
        assertEq(sum, vault.reservedTotal(), "I7 sum != reservedTotal");
        assertEq(vault.reservedTotal(), vault.reserved(BTC), "I7 total != market");
        assertEq(cm.liveCount(BTC), live, "live set size");
    }

    /// I11 escrow isolation and recipients: no AUSD at address(0), every cover account is a factory clone,
    /// escrow and rent sit on the manager (I5), never in totalAssets.
    function check_I11_isolation() public view {
        assertEq(ausd.balanceOf(address(0)), 0, "I11 AUSD burned to zero");
        assertLe(vault.totalAssets(), ausd.balanceOf(address(vault)), "I11 assets above balance");
        uint256 n = ghost.count();
        for (uint256 i; i < n; ++i) {
            assertTrue(factory.isAccount(cm.getCover(ghost.ids(i)).account), "I11 non-account cover");
        }
    }

    /// I13 escrow floor: escrow >= notional x A(at buy) / 1e4, preserved by resizes.
    function check_I13_escrowFloor() public view {
        uint256 n = ghost.count();
        for (uint256 i; i < n; ++i) {
            bytes32 id = ghost.ids(i);
            Cover memory c = cm.getCover(id);
            uint256 notional = uint256(c.stopPNS) * c.lots;
            assertGe(uint256(c.escrowCNS) * 1e4, notional * ghost.aAtBuy(id), "I13 escrow below A x N");
        }
    }

    /// I14 trader side (H-01, N-01, N-05): with a fresh reference R at trigger, the trader's exit net of the payout
    /// is never below min(stop, R) x (1 - allowance) per fill, where the allowance of each fill comes from the
    /// handlers' independent chain model (HandlerBase._model): A on the first attempt of a touch, and
    /// min(floorSlack, A x 2^k) only after k thin-book short attempts, each with R through the stop and at most
    /// STEP_MAX_GAP_BLOCKS after the touch's previous attempt (C7). A stale or foreign shortBlock earns nothing. In CNS:
    /// G_realCum <= paid + owed + G_ref + sum(allowance_i x min(stop, R) x F_i).
    function check_I14_traderExit() public view {
        uint256 n = ghost.count();
        for (uint256 i; i < n; ++i) {
            bytes32 id = ghost.ids(i);
            Cover memory c = cm.getCover(id);
            if (c.filledLots == 0 || c.refTrigPNS == 0) continue; // D49 outage close is bounded by maxGap instead
            // Plus rounding: floor of the limit (1 unit per lot) and per-level fee ceil.
            uint256 allowance = ghost.allowCNS(id) + 2 * uint256(c.filledLots) + 64;
            uint256 gRef = PayoutMath.gRefCNS(c.stopPNS, c.refTrigPNS, c.filledLots, 1, c.isLong);
            assertLe(c.gRealCumCNS, uint256(c.paidCNS) + c.owedCNS + gRef + allowance, "I14 trader exit below floor");
        }
    }

    /// O3 stop hunting (H-01): with honest references, a hunter never closes a covered lot and never profits.
    function check_O3_stopHunt() public view {
        assertEq(ghost.huntCloses(), 0, "O3 hunt closed a covered position");
        assertLe(ghost.hunterPnL(), 0, "O3 hunter profits");
        assertLe(ghost.bestHunt(), 0, "O3 single hunt profitable");
    }

    /// I3 transitions, I4 at finalize, I6, I8, I9, I10, I12 (checked inside the handlers).
    function check_handlerChecks() public view {
        assertEq(ghost.violations(), 0, ghost.lastViolation());
    }

    /// O1: a self-dealer's PnL against the protocol (payouts - escrow kept - rent) never exceeds zero.
    function check_O1_attackerPnL() public view {
        assertLe(ghost.attackerPnL(), 0, "O1 attacker profits from the vault");
        assertLe(ghost.worstEpisode(), 0, "O1 single episode profitable");
    }

    function _checkAll() internal view {
        check_I1_solvency();
        check_I2_payoutBound();
        check_I3_singleActive();
        check_I4_O2_blockCap();
        check_I5_managerCustody();
        check_I7_reserves();
        check_I11_isolation();
        check_I13_escrowFloor();
        check_handlerChecks();
        check_O1_attackerPnL();
        check_I14_traderExit();
        check_O3_stopHunt();
    }

    function _logStats() internal {
        emit log_named_uint("covers", ghost.count());
        emit log_named_uint("triggers", ghost.triggers());
        emit log_named_uint("finalizes", ghost.finalizes());
        emit log_named_uint("attack episodes", ghost.episodes());
        emit log_named_uint("attacker triggers", ghost.attackerTriggers());
        emit log_named_int("attacker protocol PnL", ghost.attackerPnL());
        emit log_named_int("attacker best MTM episode", ghost.bestMtm());
        emit log_named_uint("max single-block payout", ghost.maxBlockPaid());
        emit log_named_uint("resting orders at end", ex.getPerpetualInfo(BTC).numOrders);
        emit log_named_uint("stop hunts", ghost.hunts());
        emit log_named_int("hunter PnL (sum)", ghost.hunterPnL());
        emit log_named_uint("self-deals on a genuine touch", ghost.touchEpisodes());
        emit log_named_uint("touch, recover, touch (N-05)", ghost.relapses());
        emit log_named_uint("fills at a widened step", ghost.chainWidened());
        emit log_named_uint("match-limited holds (C7)", ghost.chainHolds());
        for (uint256 i; i < ghost.reasonsLength(); ++i) {
            bytes4 r = ghost.reasons(i);
            emit log_named_bytes32("buy revert", bytes32(r));
            emit log_named_uint("  count", ghost.reasonCount(r));
        }
    }
}

/// @notice Campaign over the six handlers; every check runs after every call. Runs x depth come from the profile
/// in foundry.toml (default and ci 64 x 200, deep 256 x 500, long 2048 x 500).
contract GaplessInvariantTest is GaplessInvariantChecks {
    function invariant_I1_solvency() public view {
        check_I1_solvency();
    }

    function invariant_I2_payoutBound() public view {
        check_I2_payoutBound();
    }

    function invariant_I3_singleActive() public view {
        check_I3_singleActive();
    }

    function invariant_I4_O2_blockCap() public view {
        check_I4_O2_blockCap();
    }

    function invariant_I5_managerCustody() public view {
        check_I5_managerCustody();
    }

    function invariant_I7_reserves() public view {
        check_I7_reserves();
    }

    function invariant_I11_isolation() public view {
        check_I11_isolation();
    }

    function invariant_I13_escrowFloor() public view {
        check_I13_escrowFloor();
    }

    function invariant_handlerChecks() public view {
        check_handlerChecks();
    }

    function invariant_O1_attackerPnL() public view {
        check_O1_attackerPnL();
    }

    function invariant_I14_traderExit() public view {
        check_I14_traderExit();
    }

    function invariant_O3_stopHunt() public view {
        check_O3_stopHunt();
    }

    /// @notice The GaplessOptimizationTest targets as assertions (CR1 SF-13): both stay <= 0.
    function invariant_O1_O2_optimizationTargets() public view {
        assertLe(_optO1(), 0, "O1 target: an episode profited");
        assertLe(_optO2(), 0, "O2 target: block payouts above cap");
    }

    function afterInvariant() external {
        _logStats();
    }
}
