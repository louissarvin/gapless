// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Test} from "forge-std/Test.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {GaplessFixture, DeployHarness} from "../utils/GaplessFixture.sol";
import {Deploy} from "../../script/Deploy.s.sol";
import {GaplessAccount} from "../../src/GaplessAccount.sol";
import {ICoverManager} from "../../src/interfaces/ICoverManager.sol";
import {Constants} from "../../src/Constants.sol";
import {MockAUSD} from "../mocks/MockAUSD.sol";
import {MockPerplExchange} from "../mocks/MockPerplExchange.sol";
import {ManagerStub} from "./stubs/ManagerStub.sol";

/// Deploy.s.sol against the mocks: INTERFACES section 3 order, wiring, roles and post-deploy checks.
contract DeployTest is GaplessFixture {
    function setUp() public {
        _setUpGapless();
    }

    function test_wiringAndSeed() public view {
        assertEq(vault.totalAssets(), Constants.VAULT_SEED_CNS);
        assertEq(vault.balanceOf(Constants.DEAD), 1e12);
        assertEq(vault.totalSupply(), 1e12);
        assertEq(ausd.allowance(deployer, address(vault)), 0, "seed allowance fully used");
        assertEq(vault.manager(), manager);
        assertEq(vault.factory(), address(factory));
        assertEq(ICoverManager(manager).factory(), address(factory));
        assertEq(impl.FACTORY(), address(factory));
        assertEq(impl.MANAGER(), manager);
        assertEq(impl.VAULT(), address(vault));
        assertEq(impl.EX(), address(ex));
        assertEq(impl.owner(), Constants.DEAD);
        assertEq(factory.MANAGER(), manager);
        assertEq(sink.manager(), manager);
        assertEq(sink.forwarder(), Constants.CRE_FORWARDER_SIM);
        assertEq(sink.chainSelector(), Constants.CHAIN_SELECTOR);
    }

    function test_roles() public view {
        assertEq(vault.defaultAdmin(), deployer);
        assertTrue(vault.hasRole(Constants.PAUSER_ROLE, deployer));
        assertTrue(stub.hasRole(Constants.RISK_ADMIN_ROLE, deployer));
        assertTrue(stub.hasRole(Constants.PAUSER_ROLE, deployer));
        assertTrue(stub.hasRole(Constants.SIGMA_ROLE, keeper));
        assertFalse(stub.hasRole(Constants.SIGMA_ROLE, deployer), "sigma key is the keeper only");
    }

    function test_deployerNonceOrder() public view {
        // approve (n), vault (n + 1), manager (n + 2), factory (n + 3); impl is the factory's first CREATE.
        assertEq(vm.computeCreateAddress(address(factory), 1), address(impl));
    }

    function test_badConfigReverts() public {
        DeployHarness h = new DeployHarness(false);
        Deploy.Config memory c = Deploy.Config(
            address(ex), address(ausd), deployer, treasury, address(0), 0, address(0), deployer, deployer, deployer
        );
        vm.expectRevert(bytes("Deploy: bad config"));
        h.deploy(c);
        c.keeper = keeper;
        c.deployer = makeAddr("poor");
        vm.expectRevert(bytes("Deploy: seed AUSD"));
        h.deploy(c);
    }

    function test_runUsesMainnetConstants() public {
        // Etch the doubles at the mainnet addresses so run() exercises its real config path.
        deployCodeTo("MockAUSD.sol:MockAUSD", Constants.AUSD);
        deployCodeTo("MockPerplExchange.sol:MockPerplExchange", abi.encode(Constants.AUSD), Constants.PERPL_EXCHANGE);
        address eoa = address(this); // run() takes the deployer from msg.sender (the flag:account EOA)
        MockAUSD(Constants.AUSD).mint(eoa, 1e6);
        vm.setEnv("TREASURY", vm.toString(treasury));
        vm.setEnv("KEEPER", vm.toString(keeper));
        DeployHarness h = new DeployHarness(false);
        Deploy.Deployment memory d = h.run();
        assertEq(GaplessAccount(d.impl).EX(), Constants.PERPL_EXCHANGE);
        assertEq(d.vault.asset(), Constants.AUSD);
        assertEq(d.vault.config().treasury, treasury);
        assertTrue(ManagerStub(d.manager).hasRole(Constants.SIGMA_ROLE, keeper));
        assertEq(d.vault.defaultAdmin(), eoa);
    }

    /// @dev I-01: separate admin, risk admin and pauser keys; the admin takes over after the 1 h delay.
    function test_splitRoles() public {
        address admin = makeAddr("multisig");
        address risk = makeAddr("riskAdmin");
        address pauser = makeAddr("pauser");
        ausd.mint(deployer, 1e6);
        DeployHarness h = new DeployHarness(true);
        Deploy.Deployment memory d = h.deploy(
            Deploy.Config(address(ex), address(ausd), deployer, treasury, keeper, 0, address(0), admin, risk, pauser)
        );
        ICoverManager m = ICoverManager(d.manager);
        assertTrue(m.hasRole(Constants.RISK_ADMIN_ROLE, risk));
        assertFalse(m.hasRole(Constants.RISK_ADMIN_ROLE, deployer));
        assertTrue(m.hasRole(Constants.PAUSER_ROLE, pauser));
        assertFalse(m.hasRole(Constants.PAUSER_ROLE, deployer));
        assertTrue(d.vault.hasRole(Constants.PAUSER_ROLE, pauser));
        assertFalse(d.vault.hasRole(Constants.PAUSER_ROLE, deployer));
        (address pending,) = m.pendingDefaultAdmin();
        assertEq(pending, admin);
        vm.warp(block.timestamp + Constants.ADMIN_DELAY + 1);
        vm.prank(admin);
        m.acceptDefaultAdminTransfer();
        vm.prank(admin);
        d.vault.acceptDefaultAdminTransfer();
        assertEq(m.defaultAdmin(), admin);
        assertEq(d.vault.defaultAdmin(), admin);
        assertEq(address(d.sink), address(0));
    }

    /// @notice CR1 MF-2: the one-shot broadcast is checked for the keeper's SIGMA_ROLE and the vault treasury.
    function test_checkCatchesKeeperSigmaAndTreasury() public {
        ausd.mint(deployer, 1e6);
        DeployHarness h = new DeployHarness(true);
        Deploy.Config memory c = Deploy.Config(
            address(ex), address(ausd), deployer, treasury, keeper, 0, address(0), deployer, deployer, deployer
        );
        Deploy.Deployment memory d = h.deploy(c);
        h.check(c, d);
        uint256 snap = vm.snapshotState();

        vm.prank(deployer);
        IAccessControl(d.manager).revokeRole(Constants.SIGMA_ROLE, keeper);
        vm.expectRevert(bytes("Deploy: keeper sigma"));
        h.check(c, d);

        vm.revertToState(snap);
        vm.prank(deployer);
        d.vault.setConfig(Constants.defaultVaultConfig(makeAddr("typo")));
        vm.expectRevert(bytes("Deploy: treasury"));
        h.check(c, d);
    }

    /// @dev ADMIN, RISK_ADMIN and PAUSER unset: every role falls back to the deployer (with a logged warning).
    function test_runDefaultsRolesToDeployer() public {
        deployCodeTo("MockAUSD.sol:MockAUSD", Constants.AUSD);
        deployCodeTo("MockPerplExchange.sol:MockPerplExchange", abi.encode(Constants.AUSD), Constants.PERPL_EXCHANGE);
        MockAUSD(Constants.AUSD).mint(address(this), 1e6);
        vm.setEnv("TREASURY", vm.toString(treasury));
        vm.setEnv("KEEPER", vm.toString(keeper));
        DeployHarness h = new DeployHarness(false);
        Deploy.Deployment memory d = h.run();
        assertTrue(d.vault.hasRole(Constants.PAUSER_ROLE, address(this)));
        assertTrue(ManagerStub(d.manager).hasRole(Constants.RISK_ADMIN_ROLE, address(this)));
        assertTrue(ManagerStub(d.manager).hasRole(Constants.PAUSER_ROLE, address(this)));
        assertEq(d.vault.defaultAdmin(), address(this));
    }

    function test_runRejectsOtherChains() public {
        vm.chainId(1);
        DeployHarness h = new DeployHarness(false);
        vm.expectRevert(bytes("Deploy: chain 143 only"));
        h.run();
    }
}

/// The stub must speak the frozen ICoverManager ABI for every call S1 code makes.
contract ManagerStubSelectorsTest is Test {
    function test_selectorsMatchFrozenInterface() public {
        ManagerStub stub = new ManagerStub(address(1), address(2), address(3), address(4));
        assertEq(ManagerStub.quote.selector, ICoverManager.quote.selector);
        assertEq(ManagerStub.openCover.selector, ICoverManager.openCover.selector);
        assertEq(ManagerStub.syncCover.selector, ICoverManager.syncCover.selector);
        assertEq(ManagerStub.cancelCover.selector, ICoverManager.cancelCover.selector);
        assertEq(stub.activeCoverOf.selector, ICoverManager.activeCoverOf.selector);
        assertEq(ManagerStub.isLocked.selector, ICoverManager.isLocked.selector);
        assertEq(stub.isSettling.selector, ICoverManager.isSettling.selector);
        assertEq(stub.factory.selector, ICoverManager.factory.selector);
        assertEq(ManagerStub.setFactory.selector, ICoverManager.setFactory.selector);
        assertEq(stub.coverNonce.selector, ICoverManager.coverNonce.selector);
        assertEq(stub.EXCHANGE.selector, ICoverManager.EXCHANGE.selector);
        assertEq(stub.AUSD.selector, ICoverManager.AUSD.selector);
        assertEq(stub.VAULT.selector, ICoverManager.VAULT.selector);
        assertEq(ManagerStub.grantRole.selector, IAccessControl.grantRole.selector);
    }
}
