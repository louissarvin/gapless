// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {RedeemRequest} from "../../../src/types/GaplessTypes.sol";
import {HandlerBase} from "./HandlerBase.sol";

/// @notice LPs on the real CoverVault: deposit, async request, claim. Checks I6 and I8 per call.
contract LPHandler is HandlerBase {
    address[3] internal lps;

    constructor(Env memory e) HandlerBase(e) {
        lps = [address(0xB1), address(0xB2), address(0xB3)];
    }

    function _price() internal view returns (uint256) {
        return vault.convertToAssets(1e12);
    }

    function deposit(uint256 i, uint256 amt) external {
        address lp = lps[i % 3];
        amt = bound(amt, 1e6, 500e6);
        ausd.mint(lp, amt);
        uint256 p0 = _price();
        vm.startPrank(lp);
        ausd.approve(address(vault), amt);
        try vault.deposit(amt, lp) {
            uint256 p1 = _price();
            if (p1 + 1 < p0) ghost.violate("I6 deposit lowered share price");
        } catch {}
        vm.stopPrank();
    }

    function requestRedeem(uint256 i, uint256 frac) external {
        address lp = lps[i % 3];
        uint256 shares = vault.balanceOf(lp) * bound(frac, 1, 100) / 100;
        if (shares == 0) return;
        vm.prank(lp);
        try vault.requestRedeem(shares) {} catch {}
    }

    function claim(uint256 i, uint256 k) external {
        address lp = lps[i % 3];
        uint256[] memory ids = vault.requestIdsOf(lp);
        if (ids.length == 0) return;
        uint256 id = ids[k % ids.length];
        RedeemRequest memory r = vault.getRequest(id);
        if (r.shares == 0) return;
        uint256 p0 = _price();
        uint256 free = vault.freeAssets();
        vm.prank(lp);
        try vault.claimRedeem(id, lp) returns (uint256 assets) {
            if (assets > r.assetsAtRequest) ghost.violate("I8 claim above assetsAtRequest");
            if (block.number < r.claimableBlock) ghost.violate("I8 claim before cooldown");
            if (assets > free) ghost.violate("I8 claim above free assets");
            if (_price() + 1 < p0) ghost.violate("I6 claim lowered share price");
        } catch {}
    }
}
