// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {IAccessControlDefaultAdminRules} from
    "@openzeppelin/contracts/access/extensions/IAccessControlDefaultAdminRules.sol";
import {CoverVault} from "../src/CoverVault.sol";
import {GaplessFactory} from "../src/GaplessFactory.sol";
import {GaplessAccount} from "../src/GaplessAccount.sol";
import {GaplessCreSink} from "../src/cre/GaplessCreSink.sol";
import {ICoverManager} from "../src/interfaces/ICoverManager.sol";
import {Constants} from "../src/Constants.sol";

/// @title Deploy
/// @notice Gapless deploy in the frozen order of INTERFACES.md section 3 (steps 1 to 7), then the CRE sink.
/// ListMarket (step 8) is S2.
/// @dev Simulate: forge script script/Deploy.s.sol with flag:rpc-url monad and flag:account $DEPLOYER_ACCOUNT.
/// Broadcast only from the runbook (spec 7 checklist). Env: TREASURY, KEEPER, and optionally ADMIN, RISK_ADMIN,
/// PAUSER (each defaults to the deployer with a warning). Never resume across Foundry versions.
/// A separate ADMIN gets a scheduled DEFAULT_ADMIN transfer on both contracts; it must call
/// acceptDefaultAdminTransfer after Constants.ADMIN_DELAY on both contracts. ListMarket then runs in three sessions
/// (RISK_ADMIN lists, keeper posts sigma, a separate LP key seeds the vault).
contract Deploy is Script {
    struct Config {
        address ex;
        address ausd;
        address deployer; // sends every deploy tx; DEFAULT_ADMIN until `admin` accepts
        address treasury;
        address keeper; // SIGMA_ROLE
        uint8 builderId;
        address creForwarder; // 0 skips the CRE simulation sink
        address admin; // DEFAULT_ADMIN target (multisig)
        address riskAdmin; // RISK_ADMIN_ROLE (manager)
        address pauser; // PAUSER_ROLE (manager and vault)
    }

    struct Deployment {
        CoverVault vault;
        address manager;
        GaplessFactory factory;
        address impl;
        GaplessCreSink sink;
    }

    function run() external returns (Deployment memory d) {
        require(block.chainid == Constants.CHAIN_ID, "Deploy: chain 143 only");
        Config memory c = Config({
            ex: Constants.PERPL_EXCHANGE,
            ausd: Constants.AUSD,
            deployer: msg.sender,
            treasury: vm.envAddress("TREASURY"),
            keeper: vm.envAddress("KEEPER"),
            builderId: Constants.BUILDER_ID,
            creForwarder: Constants.CRE_FORWARDER_SIM,
            admin: vm.envOr("ADMIN", msg.sender),
            riskAdmin: vm.envOr("RISK_ADMIN", msg.sender),
            pauser: vm.envOr("PAUSER", msg.sender)
        });
        _warnRoles(c);
        d = deploy(c);
        _log(d);
    }

    /// @notice Steps 1 to 7. Every call is sent by `c.deployer`.
    function deploy(Config memory c) public returns (Deployment memory d) {
        require(
            c.ex.code.length != 0 && c.ausd.code.length != 0 && c.deployer != address(0) && c.treasury != address(0)
                && c.keeper != address(0) && c.admin != address(0) && c.riskAdmin != address(0)
                && c.pauser != address(0),
            "Deploy: bad config"
        );
        require(IERC20(c.ausd).balanceOf(c.deployer) >= Constants.VAULT_SEED_CNS, "Deploy: seed AUSD");

        vm.startBroadcast(c.deployer);
        // 1. Pre-approve the vault's predicted address (approve uses nonce n, the vault n + 1).
        address predicted = vm.computeCreateAddress(c.deployer, vm.getNonce(c.deployer) + 1);
        require(IERC20(c.ausd).approve(predicted, Constants.VAULT_SEED_CNS), "Deploy: approve");
        // 2. Vault pulls the seed and mints its shares to 0xdEaD.
        d.vault = new CoverVault(IERC20(c.ausd), c.deployer, Constants.defaultVaultConfig(c.treasury));
        require(address(d.vault) == predicted, "Deploy: vault address");
        // 3. Manager.
        d.manager = _deployManager(c, address(d.vault));
        // 4. Factory deploys the account implementation.
        d.factory = new GaplessFactory(c.ex, c.ausd, d.manager, address(d.vault), c.builderId);
        d.impl = d.factory.IMPL();
        // 5, 6. One-time wiring; setManager reads manager.factory().
        ICoverManager(d.manager).setFactory(address(d.factory));
        d.vault.setManager(d.manager);
        // 7. Roles, each to its own key (I-01).
        IAccessControl(d.manager).grantRole(Constants.RISK_ADMIN_ROLE, c.riskAdmin);
        IAccessControl(d.manager).grantRole(Constants.PAUSER_ROLE, c.pauser);
        IAccessControl(d.manager).grantRole(Constants.SIGMA_ROLE, c.keeper);
        d.vault.grantRole(Constants.PAUSER_ROLE, c.pauser);
        if (c.admin != c.deployer) {
            IAccessControlDefaultAdminRules(d.manager).beginDefaultAdminTransfer(c.admin);
            d.vault.beginDefaultAdminTransfer(c.admin);
        }
        // Spec 7 checklist: simulation CRE sink (no roles, no funds).
        if (c.creForwarder != address(0)) {
            d.sink = new GaplessCreSink(c.creForwarder, Constants.CHAIN_SELECTOR, d.manager);
        }
        vm.stopBroadcast();

        _check(c, d);
    }

    /// @dev Step 3. CoverManager(EX, AUSD, vault, admin) from the S2 artifact; tests override with a stub.
    function _deployManager(Config memory c, address vault) internal virtual returns (address) {
        return deployCode("CoverManager.sol:CoverManager", abi.encode(c.ex, c.ausd, vault, c.deployer));
    }

    function _check(Config memory c, Deployment memory d) internal view {
        GaplessAccount impl = GaplessAccount(d.impl);
        require(impl.FACTORY() == address(d.factory), "Deploy: impl factory");
        require(impl.MANAGER() == d.manager && impl.VAULT() == address(d.vault), "Deploy: impl wiring");
        require(impl.owner() == Constants.DEAD, "Deploy: impl not locked");
        require(ICoverManager(d.manager).factory() == address(d.factory), "Deploy: manager factory");
        require(d.vault.manager() == d.manager && d.vault.factory() == address(d.factory), "Deploy: vault wiring");
        require(d.vault.totalAssets() == Constants.VAULT_SEED_CNS, "Deploy: seed assets");
        require(d.vault.balanceOf(Constants.DEAD) == d.vault.totalSupply(), "Deploy: seed shares");
        require(d.vault.hasRole(d.vault.DEFAULT_ADMIN_ROLE(), c.deployer), "Deploy: vault admin");
        require(IERC20(c.ausd).allowance(c.deployer, address(d.vault)) == 0, "Deploy: seed allowance");
        IAccessControl m = IAccessControl(d.manager);
        require(m.hasRole(Constants.RISK_ADMIN_ROLE, c.riskAdmin), "Deploy: risk admin");
        require(m.hasRole(Constants.SIGMA_ROLE, c.keeper), "Deploy: keeper sigma");
        require(d.vault.config().treasury == c.treasury, "Deploy: treasury");
        require(
            m.hasRole(Constants.PAUSER_ROLE, c.pauser) && d.vault.hasRole(Constants.PAUSER_ROLE, c.pauser),
            "Deploy: pauser"
        );
        if (c.admin != c.deployer) {
            (address pendingVault,) = d.vault.pendingDefaultAdmin();
            (address pendingManager,) = IAccessControlDefaultAdminRules(d.manager).pendingDefaultAdmin();
            require(pendingVault == c.admin && pendingManager == c.admin, "Deploy: admin transfer");
        }
    }

    /// @dev Loud when a role silently falls back to the deployer (canary only; split before raising caps).
    function _warnRoles(Config memory c) internal pure {
        if (c.admin == c.deployer) console2.log("WARNING: ADMIN unset, DEFAULT_ADMIN stays with the deployer");
        if (c.riskAdmin == c.deployer) console2.log("WARNING: RISK_ADMIN unset, granted to the deployer");
        if (c.pauser == c.deployer) console2.log("WARNING: PAUSER unset, granted to the deployer");
    }

    function _log(Deployment memory d) internal pure {
        console2.log("CoverVault     ", address(d.vault));
        console2.log("CoverManager   ", d.manager);
        console2.log("GaplessFactory ", address(d.factory));
        console2.log("GaplessAccount ", d.impl);
        console2.log("GaplessCreSink ", address(d.sink));
    }
}
