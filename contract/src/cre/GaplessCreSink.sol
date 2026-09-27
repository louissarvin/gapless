// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {ICoverManager} from "../interfaces/ICoverManager.sol";
import {GaplessCreReceiver} from "./GaplessCreReceiver.sol";

/// @title GaplessCreSink
/// @notice Simulation CRE receiver behind the permissionless MockKeystoneForwarder (D15). It only calls the
/// manager's permissionless, state-checked arm and trigger; refPricePNS is display-only.
/// @dev Holds no funds and no roles. As armer it may use the exclusive trigger window (C15, accepted).
contract GaplessCreSink is GaplessCreReceiver {
    address public immutable manager;

    error ZeroAddress();

    /// @param forwarder_ MockKeystoneForwarder (Constants.CRE_FORWARDER_SIM).
    /// @param chainSelector_ Monad mainnet selector (Constants.CHAIN_SELECTOR).
    /// @param manager_ CoverManager.
    constructor(address forwarder_, uint64 chainSelector_, address manager_)
        GaplessCreReceiver(forwarder_, chainSelector_)
    {
        if (forwarder_ == address(0) || manager_ == address(0)) revert ZeroAddress();
        manager = manager_;
    }

    /// @dev At most MAX_IDS of each; a stale or failing id is skipped, never reverting the report.
    function _onCreReport(
        uint8 kind,
        uint256 perpId,
        uint256 refPricePNS,
        bytes32[] memory toArm,
        bytes32[] memory toTrigger
    ) internal override {
        ICoverManager m = ICoverManager(manager);
        uint256 armed;
        uint256 triggered;
        for (uint256 i; i < toArm.length && i < MAX_IDS; ++i) {
            try m.arm(toArm[i]) returns (bool ok) {
                if (ok) ++armed;
            } catch {}
        }
        for (uint256 i; i < toTrigger.length && i < MAX_IDS; ++i) {
            try m.trigger(toTrigger[i]) returns (uint256) {
                ++triggered;
            } catch {}
        }
        emit CreReport(kind, perpId, refPricePNS, armed, triggered);
    }
}
