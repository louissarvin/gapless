// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC4626} from "@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol";
import {AccessControlDefaultAdminRules} from
    "@openzeppelin/contracts/access/extensions/AccessControlDefaultAdminRules.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ICoverVault} from "../../src/interfaces/ICoverVault.sol";
import {ICoverManager} from "../../src/interfaces/ICoverManager.sol";
import {IGaplessAccount} from "../../src/interfaces/IGaplessAccount.sol";
import {IGaplessFactory} from "../../src/interfaces/IGaplessFactory.sol";
import {Constants} from "../../src/Constants.sol";

/// Compile-time proof that each frozen interface composes with its intended OZ 5.6.1 bases.
/// The override lists here are the ones S1 and S2 must repeat in the real contracts.

abstract contract CoverVaultShape is
    ICoverVault,
    ERC4626,
    AccessControlDefaultAdminRules,
    Pausable,
    ReentrancyGuardTransient
{
    constructor(IERC20 ausd, address admin)
        ERC20("Gapless Cover Vault", "gcvAUSD")
        ERC4626(ausd)
        AccessControlDefaultAdminRules(Constants.ADMIN_DELAY, admin)
    {}

    function paused() public view virtual override(ICoverVault, Pausable) returns (bool) {
        return super.paused();
    }
}

abstract contract CoverManagerShape is ICoverManager, AccessControlDefaultAdminRules, Pausable, ReentrancyGuardTransient {
    constructor(address admin) AccessControlDefaultAdminRules(Constants.ADMIN_DELAY, admin) {}

    function paused() public view virtual override(ICoverManager, Pausable) returns (bool) {
        return super.paused();
    }
}

abstract contract GaplessAccountShape is IGaplessAccount, EIP712, ReentrancyGuardTransient {
    constructor() EIP712(Constants.ACCOUNT_EIP712_NAME, Constants.EIP712_VERSION) {}
}

abstract contract GaplessFactoryShape is IGaplessFactory, EIP712 {
    constructor() EIP712(Constants.FACTORY_EIP712_NAME, Constants.EIP712_VERSION) {}
}
