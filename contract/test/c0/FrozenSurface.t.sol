// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Test} from "forge-std/Test.sol";
import {Constants} from "../../src/Constants.sol";
import {MarketParams, MarketConfig, VaultConfig} from "../../src/types/GaplessTypes.sol";
import {ICoverManager} from "../../src/interfaces/ICoverManager.sol";
import {IReceiver} from "../../src/interfaces/IGaplessCreSink.sol";

/// Pins the frozen ABI facts offchain consumers hardcode, and checks the listing defaults against every bound.
contract FrozenSurfaceTest is Test {
    function test_creArmedTopic() public pure {
        assertEq(ICoverManager.Armed.selector, keccak256("Armed(bytes32,uint256,address,uint256,uint256,uint256)"));
    }

    function test_creReportSelectorAndKinds() public pure {
        assertEq(IReceiver.onReport.selector, bytes4(keccak256("onReport(bytes,bytes)")));
        assertEq(Constants.CRE_KIND_REF, 1);
        assertEq(Constants.CRE_KIND_WATCH, 2);
        assertEq(Constants.CRE_KIND_ARMED_LOG, 3);
        assertEq(Constants.CRE_MAX_IDS, 3);
        assertEq(Constants.CHAIN_SELECTOR, 8_481_857_512_324_358_265);
    }

    function test_roles() public pure {
        assertEq(Constants.RISK_ADMIN_ROLE, keccak256("RISK_ADMIN_ROLE"));
        assertEq(Constants.SIGMA_ROLE, keccak256("SIGMA_ROLE"));
        assertEq(Constants.PAUSER_ROLE, keccak256("PAUSER_ROLE"));
    }

    function test_buildPlanOverrides() public pure {
        MarketParams memory p = Constants.defaultMarketParams();
        assertEq(p.maxCoverNotionalCNS, 50e6);
        assertEq(p.sigmaMaxAgeBlocks, Constants.SIGMA_MAX_AGE_BLOCKS_MAX);
        assertEq(Constants.BUILDER_ID, 0);
        assertEq(Constants.VAULT_SEED_CNS, 1e6);
        assertEq(Constants.DEAD, 0x000000000000000000000000000000000000dEaD);
    }

    function test_defaultMarketParamsWithinBounds() public pure {
        MarketParams memory p = Constants.defaultMarketParams();
        _in(p.slipAllowanceBps, Constants.SLIP_ALLOWANCE_BPS_MIN, Constants.SLIP_ALLOWANCE_BPS_MAX);
        _in(p.maxGapBpsCap, Constants.MAX_GAP_BPS_CAP_MIN, Constants.MAX_GAP_BPS_CAP_MAX);
        _in(p.floorSlackBps, Constants.FLOOR_SLACK_BPS_MIN, Constants.FLOOR_SLACK_BPS_MAX);
        _in(p.refTolBps, Constants.REF_TOL_BPS_MIN, Constants.REF_TOL_BPS_MAX);
        _in(p.minStopDistanceBps, Constants.MIN_STOP_DISTANCE_BPS_MIN, Constants.MIN_STOP_DISTANCE_BPS_MAX);
        _in(p.kDistE2, Constants.K_DIST_E2_MIN, Constants.K_DIST_E2_MAX);
        _in(p.loadBps, Constants.LOAD_BPS_MIN, Constants.LOAD_BPS_MAX);
        _in(p.rentAprBps, Constants.RENT_APR_BPS_MIN, Constants.RENT_APR_BPS_MAX);
        _in(p.uKinkBps, Constants.U_KINK_BPS_MIN, Constants.U_KINK_BPS_MAX);
        _in(p.slope1Bps, Constants.SLOPE1_BPS_MIN, Constants.SLOPE1_BPS_MAX);
        _in(p.slope2Bps, Constants.SLOPE2_BPS_MIN, Constants.SLOPE2_BPS_MAX);
        _in(p.marketCapBps, Constants.MARKET_CAP_BPS_MIN, Constants.MARKET_CAP_BPS_MAX);
        _in(p.perBlockPayoutCapBps, Constants.PER_BLOCK_PAYOUT_CAP_BPS_MIN, Constants.PER_BLOCK_PAYOUT_CAP_BPS_MAX);
        _in(p.maxLossToDepositBps, Constants.MAX_LOSS_TO_DEPOSIT_BPS_MIN, Constants.MAX_LOSS_TO_DEPOSIT_BPS_MAX);
        _in(p.impactBpsPerKE2, Constants.IMPACT_BPS_PER_K_E2_MIN, Constants.IMPACT_BPS_PER_K_E2_MAX);
        _in(p.maxMatchesClose, Constants.MAX_MATCHES_CLOSE_MIN, Constants.MAX_MATCHES_CLOSE_MAX);
        _in(p.warmupBlocks, Constants.WARMUP_BLOCKS_MIN, Constants.WARMUP_BLOCKS_MAX);
        _in(p.armTtlBlocks, Constants.ARM_TTL_BLOCKS_MIN, Constants.ARM_TTL_BLOCKS_MAX);
        _in(p.exclusiveBlocks, Constants.EXCLUSIVE_BLOCKS_MIN, Constants.EXCLUSIVE_BLOCKS_MAX);
        _in(p.windowBlocks, Constants.WINDOW_BLOCKS_MIN, Constants.WINDOW_BLOCKS_MAX);
        _in(p.minDurationBlocks, Constants.DURATION_BLOCKS_MIN, Constants.DURATION_BLOCKS_MAX);
        _in(p.maxDurationBlocks, Constants.DURATION_BLOCKS_MIN, Constants.DURATION_BLOCKS_MAX);
        _in(p.sigmaMaxAgeBlocks, Constants.SIGMA_MAX_AGE_BLOCKS_MIN, Constants.SIGMA_MAX_AGE_BLOCKS_MAX);
        _in(p.refFreshSec, Constants.REF_FRESH_SEC_MIN, Constants.REF_FRESH_SEC_MAX);
        _in(p.feedMaxAgeSec, Constants.FEED_MAX_AGE_SEC_MIN, Constants.FEED_MAX_AGE_SEC_MAX);
        _in(p.minFeeCNS, Constants.MIN_FEE_CNS_MIN, Constants.MIN_FEE_CNS_MAX);
        _in(p.maxCoverNotionalCNS, Constants.MAX_COVER_NOTIONAL_CNS_MIN, Constants.MAX_COVER_NOTIONAL_CNS_MAX);
        assertGt(p.zEdgesE2[0], 0);
        for (uint256 i = 1; i < 8; ++i) {
            assertGt(p.zEdgesE2[i], p.zEdgesE2[i - 1], "zEdges strictly increasing");
        }
        for (uint256 i; i < 9; ++i) {
            assertLe(p.gapBpsE2[i], uint256(p.maxGapBpsCap) * 100, "gap table <= cap");
        }
        assertLe(p.minDurationBlocks, p.maxDurationBlocks, "F_DURATION_ORDER");
        assertLe(
            uint256(p.maxDurationBlocks) + p.windowBlocks + p.armTtlBlocks,
            Constants.COOLDOWN_BLOCKS,
            "F_COOLDOWN_COVERAGE"
        );
        assertLt(p.warmupBlocks, p.minDurationBlocks, "F_WARMUP_VS_DURATION");
        assertLe(Constants.COVER_MAX_GAP_BPS_DEFAULT, p.maxGapBpsCap);
        assertGe(Constants.COVER_MAX_GAP_BPS_MIN, Constants.MAX_GAP_BPS_CAP_MIN);
    }

    function test_btcConfigAndVaultConfig() public pure {
        MarketConfig memory c = Constants.btcMarketConfig();
        assertEq(c.scale, 10 ** (6 - c.priceDecimals - c.lotDecimals));
        assertLe(uint256(c.priceDecimals) + c.lotDecimals, Constants.PERPL_MAX_PD_PLUS_LD);
        assertGe(c.feedDecimals, c.priceDecimals);
        VaultConfig memory v = Constants.defaultVaultConfig(address(1));
        _in(v.maxUtilizationBps, Constants.MAX_UTILIZATION_BPS_MIN, Constants.MAX_UTILIZATION_BPS_MAX);
        _in(v.protocolFeeBps, Constants.PROTOCOL_FEE_BPS_MIN, Constants.PROTOCOL_FEE_BPS_MAX);
        _in(v.minDepositCNS, Constants.MIN_DEPOSIT_CNS_MIN, Constants.MIN_DEPOSIT_CNS_MAX);
        assertEq(Constants.DEPOSIT_LOCK_BLOCKS, Constants.COOLDOWN_BLOCKS);
    }

    function _in(uint256 v, uint256 lo, uint256 hi) internal pure {
        assertGe(v, lo);
        assertLe(v, hi);
    }
}
