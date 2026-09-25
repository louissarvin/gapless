// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {CloseResult} from "../types/GaplessTypes.sol";
import {Constants} from "../Constants.sol";

/// @title PayoutMath
/// @notice Spec 3.7 close floors (tight, widened), realized gap from storage deltas, reference gap and the payout
/// bound min(G_real, G_ref + A, Cap). Every payout term rounds down; every amount kept by the vault rounds up.
library PayoutMath {
    /// @notice First-attempt IOC limit (H-01): R x (1 - A) for a long, ceil(R x (1 + A)) for a short.
    /// @dev Any fill at or better than this leaves the trader at least min(stop, R) x (1 - A) before the payout.
    function tightLimitPNS(uint256 refPNS, uint16 slipAllowanceBps, bool isLong) internal pure returns (uint256) {
        uint256 bps = Constants.BPS;
        if (isLong) return refPNS * (bps - slipAllowanceBps) / bps;
        return Math.mulDiv(refPNS, bps + slipAllowanceBps, bps, Math.Rounding.Ceil);
    }

    /// @notice Widened IOC limit: min(stop, R) x (1 - slackBps) at step k >= 1 (slackBps = min(floorSlack, A x 2^k)),
    /// or the D49 floor when no reference is fresh (R = 0, slackBps = floorSlack).
    /// @dev Long: floor(floor(R > 0 ? min(stop, R) : stop * (1e4 - maxGap) / 1e4) * (1e4 - slack) / 1e4).
    /// Short mirrors with max and ceil.
    function closeLimitPNS(uint256 stopPNS, uint256 refPNS, uint16 maxGapBps, uint16 slackBps, bool isLong)
        internal
        pure
        returns (uint256)
    {
        uint256 bps = Constants.BPS;
        if (isLong) {
            uint256 base = refPNS > 0 ? Math.min(stopPNS, refPNS) : stopPNS * (bps - maxGapBps) / bps;
            return base * (bps - slackBps) / bps;
        }
        uint256 baseS =
            refPNS > 0 ? Math.max(stopPNS, refPNS) : Math.mulDiv(stopPNS, bps + maxGapBps, bps, Math.Rounding.Ceil);
        return Math.mulDiv(baseS, bps + slackBps, bps, Math.Rounding.Ceil);
    }

    /// @notice G_real for one close: the gap at the stop net of the taker fee at the stop, funding excluded.
    /// @dev X = realized - releasedDeposit - funding = (exit - entry) * f * s - feeAtExit for a long, so
    /// G = stop*f*s*(1 - fee) - entry*f*s - X = (stop - exit)*f*s*(1 - fee). Clamped at 0, rounds down.
    function gRealCNS(CloseResult memory r, uint256 stopPNS, uint256 scale, bool isLong)
        internal
        pure
        returns (uint256)
    {
        if (r.filledLots == 0) return 0;
        uint256 fee = Math.min(r.takerFeePpm, Constants.PPM);
        uint256 stopN = stopPNS * r.filledLots * scale;
        int256 entryN = SafeCast.toInt256(r.entryPNS * r.filledLots * scale);
        int256 x = r.realizedCNS - SafeCast.toInt256(r.releasedDepositCNS) - r.fundingCNS;
        int256 g;
        if (isLong) {
            g = SafeCast.toInt256(Math.mulDiv(stopN, Constants.PPM - fee, Constants.PPM)) - entryN - x;
        } else {
            g = entryN - SafeCast.toInt256(Math.mulDiv(stopN, Constants.PPM + fee, Constants.PPM, Math.Rounding.Ceil))
                - x;
        }
        return g > 0 ? uint256(g) : 0;
    }

    /// @return Reference gap: max(0, stop - ref) * lots * scale for long (mirror for short); 0 when ref == 0.
    function gRefCNS(uint256 stopPNS, uint256 refPNS, uint256 lots, uint256 scale, bool isLong)
        internal
        pure
        returns (uint256)
    {
        if (refPNS == 0) return 0;
        if (isLong) return stopPNS > refPNS ? (stopPNS - refPNS) * lots * scale : 0;
        return refPNS > stopPNS ? (refPNS - stopPNS) * lots * scale : 0;
    }

    /// @return min(gRealCum, gRef + floor(SN * A / 1e4), floor(SN * maxGap / 1e4)).
    function boundCNS(uint256 gRealCum, uint256 gRef, uint256 stopNotional, uint16 slipAllowanceBps, uint16 maxGapBps)
        internal
        pure
        returns (uint256)
    {
        uint256 refBound = gRef + stopNotional * slipAllowanceBps / Constants.BPS;
        uint256 capBound = stopNotional * maxGapBps / Constants.BPS;
        return Math.min(gRealCum, Math.min(refBound, capBound));
    }

    /// @return toVault ceil(escrow * filled / lots). @return refund escrow - toVault.
    function escrowSplit(uint256 escrowCNS, uint256 filledLots, uint256 lots)
        internal
        pure
        returns (uint256 toVault, uint256 refund)
    {
        toVault = Math.mulDiv(escrowCNS, filledLots, lots, Math.Rounding.Ceil);
        refund = escrowCNS - toVault;
    }

    /// @return newCap ceil(cap * newLots / oldLots). @return newEscrow ceil(escrow * newLots / oldLots).
    function resize(uint256 capCNS, uint256 escrowCNS, uint256 oldLots, uint256 newLots)
        internal
        pure
        returns (uint256 newCap, uint256 newEscrow)
    {
        newCap = Math.mulDiv(capCNS, newLots, oldLots, Math.Rounding.Ceil);
        newEscrow = Math.mulDiv(escrowCNS, newLots, oldLots, Math.Rounding.Ceil);
    }
}
