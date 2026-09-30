// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Test} from "forge-std/Test.sol";
import {PremiumMath} from "gapless/libraries/PremiumMath.sol";
import {Constants} from "gapless/Constants.sol";
import {MarketParams, Quote} from "gapless/types/GaplessTypes.sol";

/// Contract-side quote vectors (C5, L-09 rent floor) for backend premium.ts parity: test/fixtures/premium_c5_contract_vectors.json.
contract PremiumParityGen is Test {
    uint256 seed = 0x6335726e74;
    uint256 constant N = 240;
    string constant OBJ = "v";
    mapping(string => uint256[]) cols;
    string[] keys;

    function _rnd(uint256 lo, uint256 hi) internal returns (uint256) {
        unchecked {
            seed = seed * 6364136223846793005 + 1442695040888963407;
        }
        seed &= type(uint64).max;
        return lo + ((seed >> 11) % (hi - lo + 1));
    }

    function _push(string memory k, uint256 v) internal {
        if (cols[k].length == 0) keys.push(k);
        cols[k].push(v);
    }

    function _params(uint256 i) internal returns (MarketParams memory p) {
        p = Constants.defaultMarketParams();
        p.maxCoverNotionalCNS = 100_000e6;
        p.minDurationBlocks = 500;
        if (i % 4 == 0) return p;
        p.slipAllowanceBps = uint16(_rnd(5, 50));
        p.maxGapBpsCap = uint16(_rnd(50, 500));
        p.minStopDistanceBps = uint16(_rnd(5, 500));
        p.kDistE2 = uint16(_rnd(100, 1000));
        p.loadBps = uint16(_rnd(0, 20_000));
        // Low APR half the time so the rent floor binds.
        p.rentAprBps = uint16(i % 2 == 0 ? _rnd(0, 200) : _rnd(0, 10_000));
        p.uKinkBps = uint16(_rnd(1000, 9000));
        p.slope1Bps = uint16(_rnd(0, 20_000));
        p.slope2Bps = uint16(_rnd(0, 60_000));
        p.impactBpsPerKE2 = uint16(_rnd(0, 1000));
        p.warmupBlocks = uint32(_rnd(100, 499));
        p.minFeeCNS = uint80(_rnd(0, 1_000_000));
        uint256 e;
        for (uint256 k; k < 8; ++k) {
            e += _rnd(1, 200);
            p.zEdgesE2[k] = uint16(e);
        }
        for (uint256 k; k < 9; ++k) {
            p.gapBpsE2[k] = uint16(_rnd(0, uint256(p.maxGapBpsCap) * 100));
        }
    }

    function _record(MarketParams memory p, PremiumMath.QuoteInput memory q, Quote memory r) internal {
        _push("slipAllowanceBps", p.slipAllowanceBps);
        _push("maxGapBpsCap", p.maxGapBpsCap);
        _push("minStopDistanceBps", p.minStopDistanceBps);
        _push("kDistE2", p.kDistE2);
        _push("loadBps", p.loadBps);
        _push("rentAprBps", p.rentAprBps);
        _push("uKinkBps", p.uKinkBps);
        _push("slope1Bps", p.slope1Bps);
        _push("slope2Bps", p.slope2Bps);
        _push("impactBpsPerKE2", p.impactBpsPerKE2);
        _push("warmupBlocks", p.warmupBlocks);
        _push("minFeeCNS", p.minFeeCNS);
        for (uint256 k; k < 8; ++k) _push(string.concat("z", vm.toString(k)), p.zEdgesE2[k]);
        for (uint256 k; k < 9; ++k) _push(string.concat("g", vm.toString(k)), p.gapBpsE2[k]);
        _push("notional", r.notionalCNS);
        _push("distance", r.distanceBps);
        _push("sigma", q.sigmaBlkBpsE2);
        _push("duration", q.durationBlocks);
        _push("maxGap", q.maxGapBps);
        _push("util", r.utilAfterBps > 10_000 ? 10_000 : r.utilAfterBps);
        _push("outMinDist", r.minDistanceBps);
        _push("outFee", r.feeBpsE2);
        _push("outCap", r.capCNS);
        _push("outEscrow", r.escrowCNS);
        _push("outRent", r.rentCNS);
    }

    function test_generate() public {
        for (uint256 i; i < N; ++i) {
            MarketParams memory p = _params(i);
            PremiumMath.QuoteInput memory q;
            q.isLong = i % 3 != 0;
            q.scale = _rnd(1, 1000);
            q.markPNS = _rnd(1000, 16_000_000);
            q.sigmaBlkBpsE2 = _rnd(5, 2000);
            // Half the vectors past one rent period, a few on the period edges.
            uint256 dsel = i % 8;
            q.durationBlocks = uint32(
                dsel == 0 ? 12_000 : dsel == 1 ? 12_001 : dsel == 2 ? 48_000 : dsel < 5 ? _rnd(500, 12_000) : _rnd(12_001, 48_000)
            );
            q.maxGapBps = uint16(_rnd(50, p.maxGapBpsCap));
            uint256 minD = PremiumMath.minDistanceBps(p, q.sigmaBlkBpsE2);
            uint256 d = minD + _rnd(0, 1500);
            if (d > 9000) d = 9000;
            q.stopPNS = q.isLong ? q.markPNS * (10_000 - d) / 10_000 : q.markPNS * (10_000 + d) / 10_000;
            while (PremiumMath.distanceBps(q.markPNS, q.stopPNS, q.isLong) < minD) {
                q.stopPNS = q.isLong ? q.stopPNS - 1 : q.stopPNS + 1;
            }
            uint256 maxLots = p.maxCoverNotionalCNS / (q.stopPNS * q.scale);
            if (maxLots == 0) {
                q.scale = 1;
                maxLots = p.maxCoverNotionalCNS / q.stopPNS;
            }
            q.lots = _rnd(1, maxLots > 100_000 ? 100_000 : maxLots);
            q.totalAssetsCNS = _rnd(1e6, 1e12);
            q.reservedTotalCNS = _rnd(0, q.totalAssetsCNS);
            q.blockNumber = 1;
            Quote memory r = PremiumMath.quote(p, q);
            _record(p, q, r);
        }
        string memory json;
        vm.serializeString(OBJ, "source", "contract/src/libraries/PremiumMath.sol quote (C5), forge in /tmp");
        for (uint256 k; k < keys.length; ++k) json = vm.serializeUint(OBJ, keys[k], cols[keys[k]]);
        json = vm.serializeUint(OBJ, "n", N);
        vm.writeJson(json, "/tmp/gapless-contract-parity/premium_c5_vectors.json");
    }
}
