// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {CoverManagerBase} from "./CoverManagerBase.t.sol";
import {Constants} from "../../src/Constants.sol";

/// @notice Keeper gas budgets (spec 4.1): arm 300K, trigger 1.5M, observe 250K, finalize 600K, expire and void
/// 400K, postSigma 80K. Measured under `network = "monad"` gas pricing against the mocks and S2 stubs.
contract CoverManagerGasTest is CoverManagerBase {
    function _measureTrigger(uint256 levels) internal returns (uint256 armGas, uint256 trigGas, bytes32 id) {
        id = _buy();
        _pastWarmup();
        _setRefs(830_000);
        uint256 per = LOTS / levels;
        for (uint256 i; i < levels; ++i) {
            _restBid(829_900 - i * 10, i + 1 == levels ? LOTS - per * (levels - 1) : per);
        }
        uint256 g = gasleft();
        vm.prank(keeper);
        cm.arm(id);
        armGas = g - gasleft();
        _roll(1);
        _setRefs(830_000);
        g = gasleft();
        vm.prank(keeper);
        cm.trigger(id);
        trigGas = g - gasleft();
    }

    function test_gas_lifecycleBudgets() public {
        (uint256 armGas, uint256 trigGas, bytes32 id) = _measureTrigger(1);
        emit log_named_uint("arm", armGas);
        emit log_named_uint("trigger (1 level)", trigGas);
        emit log_named_uint("  of which closeForCover", acct.lastCloseGas());
        assertLt(armGas, 300_000);
        assertLt(trigGas, 1_500_000);

        _roll(1);
        _setRefs(829_500);
        uint256 g = gasleft();
        cm.observe(id);
        uint256 obsGas = g - gasleft();
        emit log_named_uint("observe", obsGas);
        assertLt(obsGas, 250_000);

        g = gasleft();
        cm.finalize(id);
        uint256 finGas = g - gasleft();
        emit log_named_uint("finalize", finGas);
        assertLt(finGas, 600_000);

        g = gasleft();
        vm.prank(keeper);
        cm.postSigma(PERP, 30);
        uint256 sigGas = g - gasleft();
        emit log_named_uint("postSigma", sigGas);
        assertLt(sigGas, 80_000);
    }

    function test_gas_trigger8Levels() public {
        (, uint256 trigGas,) = _measureTrigger(8);
        emit log_named_uint("trigger (8 levels)", trigGas);
        emit log_named_uint("  of which closeForCover", acct.lastCloseGas());
        assertLt(trigGas, 1_500_000);
    }

    /// @dev A full 16-match walk at the default maxMatchesClose: under the 1.5M trigger budget.
    function test_gas_triggerAtMaxMatches() public {
        assertEq(cm.marketParams(PERP).maxMatchesClose, 16);
        (, uint256 trigGas, bytes32 id) = _measureTrigger(16);
        emit log_named_uint("trigger (16 matches)", trigGas);
        emit log_named_uint("  of which closeForCover", acct.lastCloseGas());
        assertEq(cm.getCover(id).filledLots, LOTS);
        assertLt(trigGas, 1_500_000);
    }

    /// @dev SA3-02 worst case: a short attempt at 16 matches pays the extra book read. 16 one-lot bids, then an honest
    /// bid inside the limit, so the read finds the book not thin and the chain stays (the dust case).
    function test_gas_triggerShortAtMaxMatches() public {
        bytes32 id = _buy();
        _pastWarmup();
        _setRefs(830_000);
        for (uint256 i; i < 16; ++i) {
            _restBid(829_900 - i * 10, 1);
        }
        _restBid(829_700, LOTS); // >= 829,585 = R x (1 - A)
        vm.prank(keeper);
        cm.arm(id);
        _roll(1);
        _setRefs(830_000);
        uint256 g = gasleft();
        vm.prank(keeper);
        cm.trigger(id);
        uint256 trigGas = g - gasleft();
        emit log_named_uint("trigger (16 matches, short, book read)", trigGas);
        emit log_named_uint("  of which closeForCover", acct.lastCloseGas());
        assertEq(cm.getCover(id).filledLots, 16);
        assertEq(cm.getCover(id).shortBlock, 0, "match-limited: chain unchanged");
        assertLt(trigGas, 1_500_000);
    }

    /// @dev C7 worst case: a match-limited attempt on a running chain (k >= 1) also writes the hold block (a cold
    /// slot). Step 0 finds nothing, then 16 one-lot bids and an honest bid inside the step-1 limit.
    function test_gas_triggerHoldAtMaxMatches() public {
        bytes32 id = _buy();
        _pastWarmup();
        _setRefs(830_000);
        _restBid(829_200, LOTS); // under R x (1 - A) = 829,585, over the step-1 limit 829,170
        vm.prank(keeper);
        cm.arm(id);
        _roll(1);
        _setRefs(830_000);
        vm.prank(keeper);
        cm.trigger(id); // step 0: no fill, thin, chain at 1
        assertEq(cm.getCover(id).shortSteps, 1);
        _roll(1);
        _setRefs(830_000);
        for (uint256 i; i < 16; ++i) {
            _restBid(829_900 - i * 10, 1);
        }
        uint256 g = gasleft();
        vm.prank(keeper);
        cm.trigger(id);
        uint256 trigGas = g - gasleft();
        emit log_named_uint("trigger (16 matches, hold on a running chain)", trigGas);
        assertEq(cm.getCover(id).filledLots, 16);
        assertEq(cm.getCover(id).shortBlock, block.number, "held: gap restarts here");
        assertEq(cm.getCover(id).shortSteps, 1, "held: step kept");
        assertLt(trigGas, 1_500_000);

        g = gasleft();
        vm.prank(keeper);
        cm.trigger(id); // same-block retry reads the hold and keeps step 1
        uint256 retryGas = g - gasleft();
        emit log_named_uint("same-block retry after the hold (remainder)", retryGas);
        assertEq(cm.getCover(id).filledLots, LOTS);
        assertLt(retryGas, 1_500_000);
    }

    /// @dev 25 resting levels: the walk stops at 16 matches and the remainder fills on a second call. The mock's
    /// getPerpetualInfo scans every resting order (Perpl's is O(1)), so this bound is looser than the budget.
    function test_gas_trigger25Levels_walkBounded() public {
        (, uint256 trigGas, bytes32 id) = _measureTrigger(25);
        emit log_named_uint("trigger (16 of 25 levels, mock O(n) book)", trigGas);
        emit log_named_uint("  of which closeForCover", acct.lastCloseGas());
        assertEq(cm.getCover(id).filledLots, 32, "walk stopped at 16 matches");
        assertLt(trigGas, 1_800_000);
        uint256 g = gasleft();
        cm.trigger(id);
        uint256 remGas = g - gasleft();
        emit log_named_uint("remainder trigger (9 levels)", remGas);
        assertEq(cm.getCover(id).filledLots, LOTS);
        assertLt(remGas, 1_500_000);
    }

    function test_gas_expireAndVoid() public {
        bytes32 id = _buy();
        _roll(12_001);
        uint256 g = gasleft();
        cm.expire(id);
        uint256 expGas = g - gasleft();
        emit log_named_uint("expire", expGas);
        assertLt(expGas, 400_000);

        _setRefs(MARK);
        vm.prank(keeper);
        cm.postSigma(PERP, 27);
        bytes32 id2 = _buy(acct, _params());
        ex.liquidate(PERP, acct.perplAccountId());
        g = gasleft();
        cm.voidCover(id2);
        uint256 voidGas = g - gasleft();
        emit log_named_uint("voidCover", voidGas);
        assertLt(voidGas, 400_000);
    }

    /// @dev No spec budget for buys; 700K keeps the plugin's gas estimate honest (quote reads plus two transfers).
    function test_gas_openCover() public {
        uint256 g = gasleft();
        bytes32 id = _buy();
        uint256 used = g - gasleft();
        emit log_named_uint("buyCover via account (openCover inside)", used);
        assertTrue(id != bytes32(0));
        assertLt(used, 700_000);
    }
}
