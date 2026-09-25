// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {ICoverManager} from "../interfaces/ICoverManager.sol";
import {MarketParams, Quote} from "../types/GaplessTypes.sol";
import {Constants} from "../Constants.sol";

/// @title PremiumMath
/// @notice Spec 3.5 quote: refundable trigger escrow plus capital rent, in CNS.
/// @dev Bit-exact with backend/src/jobs/premium.ts except the C5 duration floor in quote (rentFloorCNS, L-09).
/// User-paid amounts (fee, escrow, rent) and utilization round up;
/// Cap, distance, z, impact, minDistance and M round down (spec 3.5 literal, premium.ts parity).
library PremiumMath {
    struct QuoteInput {
        uint256 lots;
        uint256 stopPNS;
        bool isLong;
        uint16 maxGapBps;
        uint32 durationBlocks;
        uint256 markPNS;
        uint256 scale;
        uint256 sigmaBlkBpsE2;
        uint256 reservedTotalCNS;
        uint256 totalAssetsCNS;
        uint256 blockNumber;
    }

    /// @return Notional at the stop: lots * stop * scale.
    function notionalCNS(uint256 lots, uint256 stopPNS, uint256 scale) internal pure returns (uint256) {
        return lots * stopPNS * scale;
    }

    /// @notice Stop distance from mark in bps, floor. Reverts StopWrongSide unless the stop is on the loss side.
    function distanceBps(uint256 markPNS, uint256 stopPNS, bool isLong) internal pure returns (uint256) {
        if (isLong) {
            if (stopPNS >= markPNS) revert ICoverManager.StopWrongSide();
            return (markPNS - stopPNS) * Constants.BPS / markPNS;
        }
        if (stopPNS <= markPNS) revert ICoverManager.StopWrongSide();
        return (stopPNS - markPNS) * Constants.BPS / markPNS;
    }

    /// @return max(minStopDistanceBps, floor(kDistE2 * sigma * sqrt(warmupBlocks) / 1e4)).
    function minDistanceBps(MarketParams memory p, uint256 sigmaBlkBpsE2) internal pure returns (uint256) {
        uint256 v = uint256(p.kDistE2) * sigmaBlkBpsE2 * Math.sqrt(p.warmupBlocks) / Constants.BPS;
        return Math.max(p.minStopDistanceBps, v);
    }

    /// @return z x 100 = floor(d * 1e4 / (sigma * sqrt(T))).
    function zE2(uint256 dBps, uint256 sigmaBlkBpsE2, uint256 durationBlocks) internal pure returns (uint256) {
        return dBps * Constants.BPS / (sigmaBlkBpsE2 * Math.sqrt(durationBlocks));
    }

    /// @return First i with z < zEdgesE2[i], else 8.
    function bucket(uint16[8] memory zEdgesE2, uint256 z) internal pure returns (uint256) {
        for (uint256 i; i < 8; ++i) {
            if (z < zEdgesE2[i]) return i;
        }
        return 8;
    }

    /// @return max(A * 100, ceil(min(cap * 100, gap[i] + floor(impact * N / 1e9)) * (1e4 + load) / 1e4)).
    function feeBpsE2(MarketParams memory p, uint256 i, uint256 notional) internal pure returns (uint256) {
        uint256 impact = uint256(p.impactBpsPerKE2) * notional / Constants.NOTIONAL_PER_IMPACT_UNIT_CNS;
        uint256 gTrig = Math.min(uint256(p.maxGapBpsCap) * 100, uint256(p.gapBpsE2[i]) + impact);
        uint256 loaded = Math.mulDiv(gTrig, Constants.BPS + p.loadBps, Constants.BPS, Math.Rounding.Ceil);
        return Math.max(uint256(p.slipAllowanceBps) * 100, loaded);
    }

    /// @return Cap = floor(notional * maxGapBps / 1e4), the vault reservation.
    function capCNS(uint256 notional, uint16 maxGapBps) internal pure returns (uint256) {
        return notional * maxGapBps / Constants.BPS;
    }

    /// @return ceil((reservedTotal + cap) * 1e4 / totalAssets); max uint when the vault is empty.
    function utilAfterBps(uint256 reservedTotal, uint256 cap, uint256 totalAssets) internal pure returns (uint256) {
        if (totalAssets == 0) return type(uint256).max;
        return Math.mulDiv(reservedTotal + cap, Constants.BPS, totalAssets, Math.Rounding.Ceil);
    }

    /// @return M in bps: 1e4 + floor(slope1 * min(u, kink) / 1e4) + floor(slope2 * max(0, u - kink) / 1e4).
    function multiplierBps(MarketParams memory p, uint256 uAfterBps) internal pure returns (uint256) {
        uint256 below = Math.min(uAfterBps, p.uKinkBps);
        uint256 above = uAfterBps > p.uKinkBps ? uAfterBps - p.uKinkBps : 0;
        return Constants.BPS + uint256(p.slope1Bps) * below / Constants.BPS + uint256(p.slope2Bps) * above / Constants.BPS;
    }

    /// @return ceil(notional * feeBpsE2 * M / 1e10).
    function escrowCNS(uint256 notional, uint256 fee, uint256 mBps) internal pure returns (uint256) {
        return Math.mulDiv(notional, fee * mBps, Constants.BPS_E2 * Constants.BPS, Math.Rounding.Ceil);
    }

    /// @return max(minFeeCNS, ceil(cap * rentApr * T * M / (1e8 * BLOCKS_PER_YEAR))).
    function rentCNS(MarketParams memory p, uint256 cap, uint256 durationBlocks, uint256 mBps)
        internal
        pure
        returns (uint256)
    {
        uint256 raw = Math.mulDiv(
            cap,
            uint256(p.rentAprBps) * durationBlocks * mBps,
            Constants.BPS * Constants.BPS * Constants.BLOCKS_PER_YEAR,
            Math.Rounding.Ceil
        );
        return Math.max(p.minFeeCNS, raw);
    }

    /// @notice L-09: minFeeCNS per started RENT_FLOOR_PERIOD_BLOCKS, so holding capacity costs the floor per hour,
    /// not per cover (pinning with max-duration covers no longer amortizes the floor).
    function rentFloorCNS(uint256 minFeeCNS, uint256 durationBlocks) internal pure returns (uint256) {
        return minFeeCNS * Math.ceilDiv(durationBlocks, Constants.RENT_FLOOR_PERIOD_BLOCKS);
    }

    /// @notice Spec 3.5 end to end (utilization ceiling is enforced by the caller and the vault).
    function quote(MarketParams memory p, QuoteInput memory q) internal pure returns (Quote memory r) {
        if (q.durationBlocks < p.minDurationBlocks || q.durationBlocks > p.maxDurationBlocks) {
            revert ICoverManager.DurationOutOfRange(q.durationBlocks);
        }
        if (q.maxGapBps < Constants.COVER_MAX_GAP_BPS_MIN || q.maxGapBps > p.maxGapBpsCap) {
            revert ICoverManager.MaxGapOutOfRange(q.maxGapBps);
        }
        r.notionalCNS = notionalCNS(q.lots, q.stopPNS, q.scale);
        if (r.notionalCNS > p.maxCoverNotionalCNS) revert ICoverManager.NotionalTooLarge(r.notionalCNS);
        r.distanceBps = distanceBps(q.markPNS, q.stopPNS, q.isLong);
        r.minDistanceBps = minDistanceBps(p, q.sigmaBlkBpsE2);
        if (r.distanceBps < r.minDistanceBps) revert ICoverManager.StopTooClose(r.distanceBps, r.minDistanceBps);
        uint256 i = bucket(p.zEdgesE2, zE2(r.distanceBps, q.sigmaBlkBpsE2, q.durationBlocks));
        r.feeBpsE2 = feeBpsE2(p, i, r.notionalCNS);
        r.capCNS = capCNS(r.notionalCNS, q.maxGapBps);
        r.utilAfterBps = utilAfterBps(q.reservedTotalCNS, r.capCNS, q.totalAssetsCNS);
        // u above 100% is always rejected by the caller; the clamp only keeps M overflow-free.
        uint256 m = multiplierBps(p, Math.min(r.utilAfterBps, Constants.BPS));
        r.escrowCNS = escrowCNS(r.notionalCNS, r.feeBpsE2, m);
        r.rentCNS = Math.max(rentCNS(p, r.capCNS, q.durationBlocks, m), rentFloorCNS(p.minFeeCNS, q.durationBlocks));
        r.expiryBlock = q.blockNumber + q.durationBlocks;
    }
}
