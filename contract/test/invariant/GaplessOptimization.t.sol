// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {GaplessInvariantBase} from "./GaplessInvariantBase.sol";

/// @notice Optimization mode (int256 invariants are maximized, fixed seed): O1 attacker PnL and O2 single-block
/// drawdown. Reports the best values; GaplessInvariantTest asserts the same two targets <= 0 after every call.
contract GaplessOptimizationTest is GaplessInvariantBase {
    function setUp() public override {
        super.setUp();
        excludeContract(address(lpH));
        excludeContract(address(adminH));
    }

    function invariant_opt_O1_attackerEpisodePnL() public view returns (int256) {
        return _optO1();
    }

    function invariant_opt_O2_blockDrawdownOverCap() public view returns (int256) {
        return _optO2();
    }
}
