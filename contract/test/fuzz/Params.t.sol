// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {ICoverManager} from "../../src/interfaces/ICoverManager.sol";
import {Constants} from "../../src/Constants.sol";
import {MarketParams} from "../../src/types/GaplessTypes.sol";
import {CoverManagerBase} from "../unit/CoverManagerBase.t.sol";

/// @notice Every MarketParams field reverts ParamOutOfBounds(index) outside its bounds and is accepted at both
/// edges (A14). Cross-field rules are covered in CoverManager.t.sol.
contract ParamsFuzzTest is CoverManagerBase {
    function _bounds(uint8 f) internal pure returns (uint256 lo, uint256 hi, uint256 typeMax) {
        if (f == 0) return (Constants.SLIP_ALLOWANCE_BPS_MIN, Constants.SLIP_ALLOWANCE_BPS_MAX, type(uint16).max);
        if (f == 1) return (Constants.MAX_GAP_BPS_CAP_MIN, Constants.MAX_GAP_BPS_CAP_MAX, type(uint16).max);
        if (f == 2) return (Constants.FLOOR_SLACK_BPS_MIN, Constants.FLOOR_SLACK_BPS_MAX, type(uint16).max);
        if (f == 3) return (Constants.REF_TOL_BPS_MIN, Constants.REF_TOL_BPS_MAX, type(uint16).max);
        if (f == 4) return (Constants.MIN_STOP_DISTANCE_BPS_MIN, Constants.MIN_STOP_DISTANCE_BPS_MAX, type(uint16).max);
        if (f == 5) return (Constants.K_DIST_E2_MIN, Constants.K_DIST_E2_MAX, type(uint16).max);
        if (f == 6) return (Constants.LOAD_BPS_MIN, Constants.LOAD_BPS_MAX, type(uint16).max);
        if (f == 7) return (Constants.RENT_APR_BPS_MIN, Constants.RENT_APR_BPS_MAX, type(uint16).max);
        if (f == 8) return (Constants.U_KINK_BPS_MIN, Constants.U_KINK_BPS_MAX, type(uint16).max);
        if (f == 9) return (Constants.SLOPE1_BPS_MIN, Constants.SLOPE1_BPS_MAX, type(uint16).max);
        if (f == 10) return (Constants.SLOPE2_BPS_MIN, Constants.SLOPE2_BPS_MAX, type(uint16).max);
        if (f == 11) return (Constants.MARKET_CAP_BPS_MIN, Constants.MARKET_CAP_BPS_MAX, type(uint16).max);
        if (f == 12) {
            return (Constants.PER_BLOCK_PAYOUT_CAP_BPS_MIN, Constants.PER_BLOCK_PAYOUT_CAP_BPS_MAX, type(uint16).max);
        }
        if (f == 13) {
            return (Constants.MAX_LOSS_TO_DEPOSIT_BPS_MIN, Constants.MAX_LOSS_TO_DEPOSIT_BPS_MAX, type(uint16).max);
        }
        if (f == 14) return (Constants.IMPACT_BPS_PER_K_E2_MIN, Constants.IMPACT_BPS_PER_K_E2_MAX, type(uint16).max);
        if (f == 15) return (Constants.MAX_MATCHES_CLOSE_MIN, Constants.MAX_MATCHES_CLOSE_MAX, type(uint16).max);
        if (f == 16) return (Constants.WARMUP_BLOCKS_MIN, Constants.WARMUP_BLOCKS_MAX, type(uint32).max);
        if (f == 17) return (Constants.ARM_TTL_BLOCKS_MIN, Constants.ARM_TTL_BLOCKS_MAX, type(uint32).max);
        if (f == 18) return (Constants.EXCLUSIVE_BLOCKS_MIN, Constants.EXCLUSIVE_BLOCKS_MAX, type(uint32).max);
        if (f == 19) return (Constants.WINDOW_BLOCKS_MIN, Constants.WINDOW_BLOCKS_MAX, type(uint32).max);
        if (f == 20 || f == 21) return (Constants.DURATION_BLOCKS_MIN, Constants.DURATION_BLOCKS_MAX, type(uint32).max);
        if (f == 22) return (Constants.SIGMA_MAX_AGE_BLOCKS_MIN, Constants.SIGMA_MAX_AGE_BLOCKS_MAX, type(uint32).max);
        if (f == 23) return (Constants.REF_FRESH_SEC_MIN, Constants.REF_FRESH_SEC_MAX, type(uint32).max);
        if (f == 24) return (Constants.FEED_MAX_AGE_SEC_MIN, Constants.FEED_MAX_AGE_SEC_MAX, type(uint32).max);
        if (f == 25) return (Constants.MIN_FEE_CNS_MIN, Constants.MIN_FEE_CNS_MAX, type(uint80).max);
        return (Constants.MAX_COVER_NOTIONAL_CNS_MIN, Constants.MAX_COVER_NOTIONAL_CNS_MAX, type(uint80).max);
    }

    function _set(MarketParams memory p, uint8 f, uint256 v) internal pure {
        if (f == 0) p.slipAllowanceBps = uint16(v);
        else if (f == 1) p.maxGapBpsCap = uint16(v);
        else if (f == 2) p.floorSlackBps = uint16(v);
        else if (f == 3) p.refTolBps = uint16(v);
        else if (f == 4) p.minStopDistanceBps = uint16(v);
        else if (f == 5) p.kDistE2 = uint16(v);
        else if (f == 6) p.loadBps = uint16(v);
        else if (f == 7) p.rentAprBps = uint16(v);
        else if (f == 8) p.uKinkBps = uint16(v);
        else if (f == 9) p.slope1Bps = uint16(v);
        else if (f == 10) p.slope2Bps = uint16(v);
        else if (f == 11) p.marketCapBps = uint16(v);
        else if (f == 12) p.perBlockPayoutCapBps = uint16(v);
        else if (f == 13) p.maxLossToDepositBps = uint16(v);
        else if (f == 14) p.impactBpsPerKE2 = uint16(v);
        else if (f == 15) p.maxMatchesClose = uint16(v);
        else if (f == 16) p.warmupBlocks = uint32(v);
        else if (f == 17) p.armTtlBlocks = uint32(v);
        else if (f == 18) p.exclusiveBlocks = uint32(v);
        else if (f == 19) p.windowBlocks = uint32(v);
        else if (f == 20) p.minDurationBlocks = uint32(v);
        else if (f == 21) p.maxDurationBlocks = uint32(v);
        else if (f == 22) p.sigmaMaxAgeBlocks = uint32(v);
        else if (f == 23) p.refFreshSec = uint32(v);
        else if (f == 24) p.feedMaxAgeSec = uint32(v);
        else if (f == 25) p.minFeeCNS = uint80(v);
        else p.maxCoverNotionalCNS = uint80(v);
    }

    /// @dev Cross-field rules are kept satisfied so only the field's own bound can fire.
    function _base(uint8 f) internal pure returns (MarketParams memory p) {
        p = Constants.defaultMarketParams();
        if (f == 1) {
            for (uint256 i; i < 9; ++i) {
                p.gapBpsE2[i] = 0; // gap table must stay <= cap x 100 at the low edge
            }
        }
        if (f == 16 || f == 20) {
            p.minDurationBlocks = 2001; // warmup < minDuration at every in-bounds warmup
            p.maxDurationBlocks = 48_000;
        }
        if (f == 20) p.warmupBlocks = 100;
        if (f == 21) p.minDurationBlocks = 500;
        if (f == 21) p.warmupBlocks = 100;
        if (f == 17 || f == 19 || f == 21) {
            p.armTtlBlocks = f == 17 ? p.armTtlBlocks : 10;
            p.windowBlocks = f == 19 ? p.windowBlocks : 10;
            p.maxDurationBlocks = 47_000; // keeps maxDuration + window + armTtl <= 48,300
        }
    }

    function testFuzz_eachFieldBounded(uint8 f, uint256 below, uint256 above) public {
        f = uint8(bound(f, 0, 26));
        (uint256 lo, uint256 hi, uint256 tmax) = _bounds(f);
        vm.startPrank(admin);
        if (f == 20) {
            // minDuration above its bound would first violate the order rule; test the low edge only
            hi = 47_000;
        }
        if (lo > 0) {
            MarketParams memory p = _base(f);
            _set(p, f, bound(below, 0, lo - 1));
            vm.expectRevert(abi.encodeWithSelector(ICoverManager.ParamOutOfBounds.selector, f));
            cm.setMarketParams(PERP, p);
        }
        if (hi < tmax && f != 20) {
            MarketParams memory p = _base(f);
            _set(p, f, bound(above, hi + 1, tmax));
            vm.expectRevert(abi.encodeWithSelector(ICoverManager.ParamOutOfBounds.selector, f));
            cm.setMarketParams(PERP, p);
        }
        MarketParams memory ok = _base(f);
        _set(ok, f, lo);
        cm.setMarketParams(PERP, ok);
        _set(ok, f, hi);
        cm.setMarketParams(PERP, ok);
        vm.stopPrank();
    }

    function test_allFieldsCovered() public {
        for (uint8 f; f <= 26; ++f) {
            testFuzz_eachFieldBounded(f, 0, type(uint256).max);
        }
    }
}
