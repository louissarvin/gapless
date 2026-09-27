// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {MarketParams} from "../../../src/types/GaplessTypes.sol";
import {Constants} from "../../../src/Constants.sol";
import {HandlerBase} from "./HandlerBase.sol";

/// @notice Admin and SIGMA keys fuzzing their powers inside and outside the bounds (A14).
contract AdminHandler is HandlerBase {
    address internal immutable admin;

    constructor(Env memory e, address admin_) HandlerBase(e) {
        admin = admin_;
    }

    function setParams(
        uint256 slip,
        uint256 slack,
        uint256 tol,
        uint256 cap,
        uint256 perBlock,
        uint256 window,
        uint256 warmup
    ) external {
        MarketParams memory p = cm.marketParams(perp);
        p.warmupBlocks = uint32(bound(warmup, 50, 1200)); // L-03: live covers keep their snapshot
        p.slipAllowanceBps = uint16(bound(slip, 0, 60));
        p.floorSlackBps = uint16(bound(slack, 0, 400));
        p.refTolBps = uint16(bound(tol, 0, 250));
        p.marketCapBps = uint16(bound(cap, 0, 11_000));
        p.perBlockPayoutCapBps = uint16(bound(perBlock, 0, 11_000));
        p.windowBlocks = uint32(bound(window, 0, 250));
        vm.prank(admin);
        try cm.setMarketParams(perp, p) {
            ghost.setMaxSlip(p.slipAllowanceBps);
        } catch {}
    }

    function postSigma(uint256 s) external {
        vm.prank(sigmaKey);
        // Mostly realistic values (calm 27 to stressed 163); one call in four probes the bounds.
        bool probe = uint256(keccak256(abi.encode(s, block.number))) % 4 == 0;
        try cm.postSigma(perp, uint32(probe ? bound(s, 0, 2500) : bound(s, 5, 200))) {} catch {}
    }

    /// @dev Pauses about 1 call in 8; unpauses otherwise.
    function pause(uint8 seed) external {
        bool on = uint256(keccak256(abi.encode(seed, block.number))) % 8 == 0; // fuzzers favor 0
        vm.prank(admin);
        if (on) {
            try cm.pauseBuys() {} catch {}
        } else {
            try cm.unpauseBuys() {} catch {}
        }
    }
}
