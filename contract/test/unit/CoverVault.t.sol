// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC4626} from "@openzeppelin/contracts/interfaces/IERC4626.sol";
import {ERC4626} from "@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol";
import {IERC20Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {
    IAccessControlDefaultAdminRules
} from "@openzeppelin/contracts/access/extensions/IAccessControlDefaultAdminRules.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {GaplessFixture} from "../utils/GaplessFixture.sol";
import {CoverVault} from "../../src/CoverVault.sol";
import {GaplessAccount} from "../../src/GaplessAccount.sol";
import {ICoverVault} from "../../src/interfaces/ICoverVault.sol";
import {VaultConfig, RedeemRequest, PayoutBlockCap} from "../../src/types/GaplessTypes.sol";
import {Constants} from "../../src/Constants.sol";
import {ManagerStub} from "./stubs/ManagerStub.sol";

contract CoverVaultTest is GaplessFixture {
    address internal lp = makeAddr("lp");
    address internal lp2 = makeAddr("lp2");
    GaplessAccount internal acct;

    function setUp() public {
        _setUpGapless();
        _lp(lp, 1000e6);
        acct = _account(makeAddr("trader"), 0, _noGrant());
    }

    function _newVault(VaultConfig memory cfg) internal returns (CoverVault v) {
        ausd.mint(deployer, 1e6);
        vm.startBroadcast(deployer);
        ausd.approve(vm.computeCreateAddress(deployer, vm.getNonce(deployer) + 1), 1e6);
        v = new CoverVault(IERC20(address(ausd)), deployer, cfg);
        vm.stopBroadcast();
    }

    function _req(address who, uint256 shares) internal returns (uint256 id) {
        vm.prank(who);
        id = vault.requestRedeem(shares);
    }

    // Constructor and seed

    function test_seedAndMetadata() public view {
        assertEq(vault.decimals(), 12);
        assertEq(vault.asset(), address(ausd));
        assertEq(vault.name(), "Gapless Cover Vault");
        assertEq(vault.symbol(), "gcvAUSD");
        assertEq(vault.balanceOf(Constants.DEAD), 1e12);
        assertEq(vault.COOLDOWN_BLOCKS(), 48_300);
        assertEq(vault.DEPOSIT_LOCK_BLOCKS(), 48_300);
        assertEq(vault.PAUSER_ROLE(), Constants.PAUSER_ROLE);
        VaultConfig memory c = vault.config();
        assertEq(c.treasury, treasury);
        assertEq(c.maxUtilizationBps, 8000);
        assertEq(c.protocolFeeBps, 1000);
        assertEq(c.minDepositCNS, 1e6);
        assertEq(vault.defaultAdmin(), deployer);
        assertEq(vault.defaultAdminDelay(), 1 hours);
        assertTrue(vault.hasRole(Constants.PAUSER_ROLE, deployer));
    }

    function test_constructor_seedNotApproved() public {
        ausd.mint(deployer, 1e6);
        vm.prank(deployer);
        vm.expectRevert();
        new CoverVault(IERC20(address(ausd)), deployer, Constants.defaultVaultConfig(treasury));
    }

    function test_constructor_badConfigIndices() public {
        VaultConfig memory c = Constants.defaultVaultConfig(address(0));
        vm.expectRevert(abi.encodeWithSelector(ICoverVault.ConfigOutOfBounds.selector, 0));
        new CoverVault(IERC20(address(ausd)), deployer, c);
        c = Constants.defaultVaultConfig(treasury);
        c.maxUtilizationBps = 9001;
        vm.expectRevert(abi.encodeWithSelector(ICoverVault.ConfigOutOfBounds.selector, 1));
        new CoverVault(IERC20(address(ausd)), deployer, c);
    }

    function test_constructor_zeroAdmin() public {
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControlDefaultAdminRules.AccessControlInvalidDefaultAdmin.selector, address(0)
            )
        );
        new CoverVault(IERC20(address(ausd)), address(0), Constants.defaultVaultConfig(treasury));
    }

    // deposit and mint

    function test_deposit_mintsAndLocks() public {
        ausd.mint(lp2, 10e6);
        vm.startPrank(lp2);
        ausd.approve(address(vault), 10e6);
        uint256 expected = vault.previewDeposit(10e6);
        uint256 ta0 = vault.totalAssets();
        vm.expectEmit(address(vault));
        emit IERC4626.Deposit(lp2, lp2, 10e6, expected);
        uint256 shares = vault.deposit(10e6, lp2);
        vm.stopPrank();
        assertEq(shares, expected);
        assertEq(shares, 10e12, "1 share unit per 1e-12 at par");
        assertEq(vault.totalAssets(), ta0 + 10e6);
        assertEq(vault.lockUntil(lp2), block.number + 48_300);
    }

    function test_deposit_thirdPartyReverts() public {
        ausd.mint(lp2, 10e6);
        vm.startPrank(lp2);
        ausd.approve(address(vault), 10e6);
        vm.expectRevert(ICoverVault.ThirdPartyDeposit.selector);
        vault.deposit(10e6, lp);
        vm.stopPrank();
    }

    function test_deposit_belowMin() public {
        vm.prank(lp2);
        vm.expectRevert(ICoverVault.BelowMinDeposit.selector);
        vault.deposit(1e6 - 1, lp2);
    }

    function test_deposit_paused() public {
        vm.prank(deployer);
        vault.pause();
        assertEq(vault.maxDeposit(lp2), 0);
        assertEq(vault.maxMint(lp2), 0);
        vm.prank(lp2);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        vault.deposit(10e6, lp2);
        vm.prank(lp2);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        vault.mint(10e12, lp2);
    }

    function test_deposit_settling() public {
        stub.setSettling(true);
        vm.prank(lp2);
        vm.expectRevert(ICoverVault.Settling.selector);
        vault.deposit(10e6, lp2);
        vm.prank(lp2);
        vm.expectRevert(ICoverVault.Settling.selector);
        vault.mint(10e12, lp2);
    }

    function test_mint_roundsAssetsUp() public {
        _payout(100e6); // share price below par so mint math rounds
        uint256 shares = 7e12 + 3;
        uint256 assets = vault.previewMint(shares);
        ausd.mint(lp2, assets);
        vm.startPrank(lp2);
        ausd.approve(address(vault), assets);
        assertEq(vault.mint(shares, lp2), assets);
        vm.stopPrank();
        assertEq(vault.balanceOf(lp2), shares);
        assertGe(assets * (vault.totalSupply() + 1e6), shares * (vault.totalAssets() - assets + 1), "ceil");
    }

    function test_mint_guards() public {
        vm.prank(lp2);
        vm.expectRevert(ICoverVault.ThirdPartyDeposit.selector);
        vault.mint(10e12, lp);
        vm.prank(lp2);
        vm.expectRevert(ICoverVault.BelowMinDeposit.selector);
        vault.mint(1e12 - 1e6, lp2);
    }

    // Sync exits disabled, non-transferable

    function test_syncExitsDisabled() public {
        assertEq(vault.maxWithdraw(lp), 0);
        assertEq(vault.maxRedeem(lp), 0);
        vm.expectRevert(ICoverVault.AsyncOnly.selector);
        vault.previewWithdraw(1);
        vm.expectRevert(ICoverVault.AsyncOnly.selector);
        vault.previewRedeem(1);
        vm.prank(lp);
        vm.expectRevert(ICoverVault.AsyncOnly.selector);
        vault.withdraw(1, lp, lp);
        vm.prank(lp);
        vm.expectRevert(ICoverVault.AsyncOnly.selector);
        vault.redeem(1, lp, lp);
    }

    function test_nonTransferable() public {
        vm.prank(lp);
        vm.expectRevert(ICoverVault.NonTransferable.selector);
        vault.transfer(lp2, 1);
        vm.prank(lp);
        vault.approve(lp2, 1);
        vm.prank(lp2);
        vm.expectRevert(ICoverVault.NonTransferable.selector);
        vault.transferFrom(lp, lp2, 1);
        vm.prank(lp);
        vm.expectRevert(ICoverVault.NonTransferable.selector);
        vault.transfer(address(vault), 1);
    }

    // requestRedeem

    function test_requestRedeem_lockedThenEscrows() public {
        uint256 shares = vault.balanceOf(lp);
        uint256 until = vault.lockUntil(lp);
        vm.prank(lp);
        vm.expectRevert(abi.encodeWithSelector(ICoverVault.DepositLocked.selector, until));
        vault.requestRedeem(shares);

        vm.roll(until);
        uint256 assets = vault.convertToAssets(shares);
        vm.expectEmit(address(vault));
        emit ICoverVault.RedeemRequested(lp, 1, shares, assets, block.number + 48_300);
        uint256 id = _req(lp, shares);
        assertEq(id, 1);
        assertEq(vault.nextRequestId(), 2);
        assertEq(vault.balanceOf(lp), 0);
        assertEq(vault.balanceOf(address(vault)), shares);
        RedeemRequest memory r = vault.getRequest(id);
        assertEq(r.owner, lp);
        assertEq(r.shares, shares);
        assertEq(r.assetsAtRequest, assets);
        assertEq(r.claimableBlock, block.number + 48_300);
        assertEq(vault.requestIdsOf(lp).length, 1);
    }

    function test_requestRedeem_badAmounts() public {
        vm.roll(vault.lockUntil(lp));
        uint256 bal = vault.balanceOf(lp);
        vm.prank(lp);
        vm.expectRevert(abi.encodeWithSelector(ERC4626.ERC4626ExceededMaxRedeem.selector, lp, 0, bal));
        vault.requestRedeem(0);
        vm.prank(lp);
        vm.expectRevert(abi.encodeWithSelector(ERC4626.ERC4626ExceededMaxRedeem.selector, lp, bal + 1, bal));
        vault.requestRedeem(bal + 1);
    }

    function test_requestRedeem_settling() public {
        vm.roll(vault.lockUntil(lp));
        stub.setSettling(true);
        vm.prank(lp);
        vm.expectRevert(ICoverVault.Settling.selector);
        vault.requestRedeem(1);
    }

    // claimRedeem

    function test_claimRedeem_happy() public {
        vm.roll(vault.lockUntil(lp));
        uint256 shares = vault.balanceOf(lp);
        uint256 id = _req(lp, shares);
        vm.prank(lp);
        vm.expectRevert(abi.encodeWithSelector(ICoverVault.CooldownActive.selector, block.number + 48_300));
        vault.claimRedeem(id, lp);

        vm.roll(block.number + 48_300);
        uint256 supply0 = vault.totalSupply();
        vm.expectEmit(address(vault));
        emit ICoverVault.RedeemClaimed(lp, id, lp2, 1000e6, shares);
        vm.prank(lp);
        uint256 assets = vault.claimRedeem(id, lp2);
        assertEq(assets, 1000e6);
        assertEq(ausd.balanceOf(lp2), 1000e6);
        assertEq(vault.totalSupply(), supply0 - shares);
        assertEq(vault.totalAssets(), 1e6);
        assertEq(vault.requestIdsOf(lp).length, 0);
        assertEq(vault.getRequest(id).owner, address(0));

        vm.prank(lp);
        vm.expectRevert(abi.encodeWithSelector(ICoverVault.NotRequestOwner.selector, id));
        vault.claimRedeem(id, lp);
    }

    function test_claimRedeem_guards() public {
        vm.roll(vault.lockUntil(lp));
        uint256 id = _req(lp, 1e12);
        vm.roll(block.number + 48_300);
        vm.prank(lp);
        vm.expectRevert(ICoverVault.ZeroAddress.selector);
        vault.claimRedeem(id, address(0));
        vm.prank(lp2);
        vm.expectRevert(abi.encodeWithSelector(ICoverVault.NotRequestOwner.selector, id));
        vault.claimRedeem(id, lp2);
        vm.prank(lp);
        vm.expectRevert(abi.encodeWithSelector(ICoverVault.NotRequestOwner.selector, 999));
        vault.claimRedeem(999, lp);
        stub.setSettling(true);
        vm.prank(lp);
        vm.expectRevert(ICoverVault.Settling.selector);
        vault.claimRedeem(id, lp);
    }

    function test_claimRedeem_paysValueAtClaimAfterLoss() public {
        vm.roll(vault.lockUntil(lp));
        uint256 id = _req(lp, vault.balanceOf(lp));
        uint256 atRequest = vault.getRequest(id).assetsAtRequest;
        _payout(100e6); // payout during the cooldown is absorbed by escrowed shares
        vm.roll(block.number + 48_300);
        uint256 expected = vault.convertToAssets(vault.getRequest(id).shares);
        assertLt(expected, atRequest);
        vm.prank(lp);
        assertEq(vault.claimRedeem(id, lp), expected);
    }

    function test_claimRedeem_capsAtRequestAfterGain() public {
        vm.roll(vault.lockUntil(lp));
        uint256 id = _req(lp, vault.balanceOf(lp));
        uint256 atRequest = vault.getRequest(id).assetsAtRequest;
        _premium(50e6);
        vm.roll(block.number + 48_300);
        uint256 ta0 = vault.totalAssets();
        vm.prank(lp);
        assertEq(vault.claimRedeem(id, lp), atRequest, "gains during cooldown stay with remaining LPs");
        assertEq(vault.totalAssets(), ta0 - atRequest);
        assertGt(vault.convertToAssets(1e12), 1e6, "dead seed got the excess");
    }

    function test_claimRedeem_insufficientFree() public {
        vm.prank(manager);
        vault.reserve(BTC, 500e6, 10_000);
        vm.roll(vault.lockUntil(lp));
        uint256 id = _req(lp, vault.balanceOf(lp));
        vm.roll(block.number + 48_300);
        uint256 free = vault.freeAssets();
        vm.prank(lp);
        vm.expectRevert(abi.encodeWithSelector(ICoverVault.InsufficientFree.selector, 1000e6, free));
        vault.claimRedeem(id, lp);
        vm.prank(manager);
        vault.release(BTC, 500e6);
        vm.prank(lp);
        vault.claimRedeem(id, lp);
    }

    function test_requestIds_swapPop() public {
        vm.roll(vault.lockUntil(lp));
        uint256 a = _req(lp, 1e12);
        uint256 b = _req(lp, 1e12);
        uint256 c = _req(lp, 1e12);
        vm.roll(block.number + 48_300);
        vm.prank(lp);
        vault.claimRedeem(a, lp);
        uint256[] memory ids = vault.requestIdsOf(lp);
        assertEq(ids.length, 2);
        assertEq(ids[0], c);
        assertEq(ids[1], b);
        vm.prank(lp);
        vault.claimRedeem(b, lp);
        vm.prank(lp);
        vault.claimRedeem(c, lp);
        assertEq(vault.requestIdsOf(lp).length, 0);
    }

    // reserve and release

    function test_reserve_onlyManager() public {
        vm.expectRevert(ICoverVault.OnlyManager.selector);
        vault.reserve(BTC, 1, 5000);
        vm.expectRevert(ICoverVault.OnlyManager.selector);
        vault.release(BTC, 1);
        vm.expectRevert(ICoverVault.OnlyManager.selector);
        vault.payCapped(BTC, address(acct), 1, 2500);
        vm.expectRevert(ICoverVault.OnlyManager.selector);
        vault.notifyPremium(0);
    }

    function test_reserve_limits() public {
        uint256 ta = vault.totalAssets(); // 1001e6
        vm.startPrank(manager);
        vm.expectRevert(abi.encodeWithSelector(ICoverVault.MarketCapExceeded.selector, BTC, ta / 2 + 1, ta / 2));
        vault.reserve(BTC, ta / 2 + 1, 5000);
        vm.expectEmit(address(vault));
        emit ICoverVault.Reserved(BTC, ta / 2, ta / 2);
        vault.reserve(BTC, ta / 2, 5000);
        vault.reserve(10, ta * 3 / 10, 5000);
        uint256 over = ta * 8000 / 1e4 - vault.reservedTotal() + 1;
        uint256 bpsAfter = ((vault.reservedTotal() + over) * 1e4 + ta - 1) / ta;
        vm.expectRevert(abi.encodeWithSelector(ICoverVault.UtilizationExceeded.selector, bpsAfter, 8000));
        vault.reserve(20, over, 10_000);
        vault.reserve(20, over - 1, 10_000);
        vm.stopPrank();
        assertEq(vault.reserved(BTC), ta / 2);
        assertEq(vault.utilizationBps(), 8000);
        assertEq(vault.freeAssets(), ta - vault.reservedTotal());
    }

    function test_reserve_marketCapAbove100PctIsBounded() public {
        uint256 ta = vault.totalAssets();
        vm.prank(manager);
        vm.expectRevert(abi.encodeWithSelector(ICoverVault.UtilizationExceeded.selector, 10_000, 8000));
        vault.reserve(BTC, ta, type(uint16).max);
    }

    function test_release() public {
        vm.startPrank(manager);
        vault.reserve(BTC, 100e6, 5000);
        vm.expectRevert(abi.encodeWithSelector(ICoverVault.ReleaseExceedsReserved.selector, BTC, 100e6 + 1, 100e6));
        vault.release(BTC, 100e6 + 1);
        vm.expectEmit(address(vault));
        emit ICoverVault.Released(BTC, 40e6, 60e6);
        vault.release(BTC, 40e6);
        vm.stopPrank();
        assertEq(vault.reserved(BTC), 60e6);
        assertEq(vault.reservedTotal(), 60e6);
    }

    // payCapped

    function test_payCapped_notAccount() public {
        vm.prank(manager);
        vault.reserve(BTC, 100e6, 5000);
        vm.startPrank(manager);
        vm.expectRevert(abi.encodeWithSelector(ICoverVault.NotAccount.selector, address(0)));
        vault.payCapped(BTC, address(0), 1e6, 2500);
        vm.expectRevert(abi.encodeWithSelector(ICoverVault.NotAccount.selector, lp));
        vault.payCapped(BTC, lp, 1e6, 2500);
        vm.expectRevert(abi.encodeWithSelector(ICoverVault.NotAccount.selector, address(impl)));
        vault.payCapped(BTC, address(impl), 1e6, 2500);
        vm.stopPrank();
    }

    function test_payCapped_blockCapAndReservation() public {
        uint256 ta = vault.totalAssets();
        vm.startPrank(manager);
        vault.reserve(BTC, 400e6, 5000);
        uint256 cap = ta * 2500 / 1e4;
        vm.expectEmit(address(vault));
        emit ICoverVault.Paid(BTC, address(acct), 100e6);
        assertEq(vault.payCapped(BTC, address(acct), 100e6, 2500), 100e6);
        assertEq(vault.payCapped(BTC, address(acct), 300e6, 2500), cap - 100e6, "snapshot cap, not live assets");
        assertEq(vault.payCapped(BTC, address(acct), 1e6, 2500), 0, "cap spent returns 0");
        PayoutBlockCap memory b = vault.blockPayout(BTC);
        assertEq(b.blockNumber, block.number);
        assertEq(b.capCNS, cap);
        assertEq(b.paidCNS, cap);
        vm.roll(block.number + 1);
        uint256 rem = vault.reserved(BTC);
        uint256 paid = vault.payCapped(BTC, address(acct), 1000e6, 10_000);
        vm.stopPrank();
        assertEq(paid, rem, "bounded by the market reservation");
        assertEq(vault.reserved(BTC), 0);
        assertEq(vault.reservedTotal(), 0);
        assertEq(vault.totalAssets(), ta - 400e6);
        assertEq(ausd.balanceOf(address(acct)), 400e6);
    }

    function test_payCapped_zeroAmountAndNoReserve() public {
        vm.startPrank(manager);
        assertEq(vault.payCapped(BTC, address(acct), 0, 2500), 0);
        assertEq(vault.payCapped(BTC, address(acct), 5e6, 2500), 0, "nothing reserved");
        vm.stopPrank();
    }

    function test_payCapped_frozenAccountDefersViaManager() public {
        vm.prank(manager);
        vault.reserve(BTC, 100e6, 5000);
        ausd.freeze(address(acct));
        assertEq(stub.settle(BTC, address(acct), 10e6, 2500), 0, "manager catches, owes later");
        assertEq(vault.reserved(BTC), 100e6, "reservation intact");
        ausd.unfreeze(address(acct));
        assertEq(stub.settle(BTC, address(acct), 10e6, 2500), 10e6);
    }

    // notifyPremium

    function test_notifyPremium_split() public {
        uint256 ta0 = vault.totalAssets();
        ausd.mint(manager, 10e6);
        vm.expectEmit(address(vault));
        emit ICoverVault.PremiumReceived(10e6, 9e6, 1e6);
        stub.notify(10e6);
        assertEq(vault.totalAssets(), ta0 + 9e6);
        assertEq(ausd.balanceOf(treasury), 1e6);
    }

    function test_notifyPremium_frozenTreasuryFallsBackToLps() public {
        uint256 ta0 = vault.totalAssets();
        ausd.freeze(treasury);
        ausd.mint(manager, 10e6);
        vm.expectEmit(address(vault));
        emit ICoverVault.PremiumReceived(10e6, 10e6, 0);
        stub.notify(10e6);
        assertEq(vault.totalAssets(), ta0 + 10e6);
    }

    function test_notifyPremium_requiresFunds() public {
        uint256 ta0 = vault.totalAssets();
        uint256 bal = ausd.balanceOf(address(vault));
        vm.prank(manager);
        vm.expectRevert(abi.encodeWithSelector(ICoverVault.InsufficientFree.selector, ta0 + 1, bal));
        vault.notifyPremium(1);
    }

    function test_notifyPremium_dustRoundsToLps() public {
        ausd.mint(manager, 9);
        stub.notify(9);
        assertEq(ausd.balanceOf(treasury), 0, "floor(9 x 10%) = 0");
    }

    // Admin

    function test_setManager_onceAndChecks() public {
        vm.prank(deployer);
        vm.expectRevert(ICoverVault.ManagerAlreadySet.selector);
        vault.setManager(address(1));

        CoverVault v = _newVault(Constants.defaultVaultConfig(treasury));
        vm.prank(lp);
        vm.expectRevert(
            abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, lp, bytes32(0))
        );
        v.setManager(manager);
        vm.startPrank(deployer);
        vm.expectRevert(ICoverVault.ZeroAddress.selector);
        v.setManager(address(0));
        ManagerStub fresh = new ManagerStub(address(ex), address(ausd), address(v), deployer);
        vm.expectRevert(ICoverVault.ZeroAddress.selector);
        v.setManager(address(fresh)); // factory not set yet (step 5 skipped)
        fresh.setFactory(address(factory));
        vm.expectEmit(address(v));
        emit ICoverVault.ManagerSet(address(fresh), address(factory));
        v.setManager(address(fresh));
        vm.stopPrank();
        assertEq(v.manager(), address(fresh));
        assertEq(v.factory(), address(factory));
    }

    function test_unwiredVault_isInert() public {
        CoverVault v = _newVault(Constants.defaultVaultConfig(treasury));
        vm.expectRevert(ICoverVault.OnlyManager.selector);
        v.reserve(BTC, 0, 0);
        ausd.mint(lp2, 5e6);
        vm.startPrank(lp2);
        ausd.approve(address(v), 5e6);
        v.deposit(5e6, lp2); // no manager, no settling check
        vm.stopPrank();
    }

    function test_setConfig_boundsAndEvent() public {
        VaultConfig memory c = Constants.defaultVaultConfig(lp2);
        vm.prank(lp);
        vm.expectRevert(
            abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, lp, bytes32(0))
        );
        vault.setConfig(c);
        vm.startPrank(deployer);
        c.treasury = address(vault);
        vm.expectRevert(abi.encodeWithSelector(ICoverVault.ConfigOutOfBounds.selector, 0));
        vault.setConfig(c);
        c.treasury = lp2;
        c.maxUtilizationBps = 999;
        vm.expectRevert(abi.encodeWithSelector(ICoverVault.ConfigOutOfBounds.selector, 1));
        vault.setConfig(c);
        c.maxUtilizationBps = 9000;
        c.protocolFeeBps = 3001;
        vm.expectRevert(abi.encodeWithSelector(ICoverVault.ConfigOutOfBounds.selector, 2));
        vault.setConfig(c);
        c.protocolFeeBps = 3000;
        c.minDepositCNS = 1e6 - 1;
        vm.expectRevert(abi.encodeWithSelector(ICoverVault.ConfigOutOfBounds.selector, 3));
        vault.setConfig(c);
        c.minDepositCNS = 100e6 + 1;
        vm.expectRevert(abi.encodeWithSelector(ICoverVault.ConfigOutOfBounds.selector, 3));
        vault.setConfig(c);
        c.minDepositCNS = 100e6;
        vm.expectEmit(address(vault));
        emit ICoverVault.ConfigSet(Constants.defaultVaultConfig(treasury), c);
        vault.setConfig(c);
        vm.stopPrank();
        assertEq(vault.config().treasury, lp2);
    }

    /// @dev I-03: the treasury can never be the manager (premium accounting would double count).
    function test_treasuryCannotBeManager() public {
        VaultConfig memory c = Constants.defaultVaultConfig(manager);
        vm.prank(deployer);
        vm.expectRevert(abi.encodeWithSelector(ICoverVault.ConfigOutOfBounds.selector, 0));
        vault.setConfig(c);
        CoverVault v = _newVault(Constants.defaultVaultConfig(treasury));
        ManagerStub fresh = new ManagerStub(address(ex), address(ausd), address(v), deployer);
        vm.startPrank(deployer);
        fresh.setFactory(address(factory));
        v.setConfig(Constants.defaultVaultConfig(address(fresh)));
        vm.expectRevert(abi.encodeWithSelector(ICoverVault.ConfigOutOfBounds.selector, 0));
        v.setManager(address(fresh));
        vm.stopPrank();
    }

    /// @dev L-08: deferred payouts leave the share price at once, so a redeem request snapshots the net value.
    function test_owedNetsOutOfTotalAssetsAndRedeems() public {
        uint256 ta0 = vault.totalAssets();
        uint256 price0 = vault.convertToAssets(1e12);
        vm.expectRevert(ICoverVault.OnlyManager.selector);
        vault.updateOwed(0, 1);
        vm.expectEmit(address(vault));
        emit ICoverVault.OwedUpdated(100e6);
        stub.owe(0, 100e6);
        assertEq(vault.owedTotal(), 100e6);
        assertEq(vault.totalAssets(), ta0 - 100e6);
        assertLt(vault.convertToAssets(1e12), price0);
        vm.roll(block.number + Constants.DEPOSIT_LOCK_BLOCKS);
        uint256 shares = vault.balanceOf(lp);
        uint256 id = _req(lp, shares);
        assertEq(vault.getRequest(id).assetsAtRequest, vault.convertToAssets(shares));
        assertLt(vault.getRequest(id).assetsAtRequest, 1000e6);
        stub.owe(100e6, 40e6);
        assertEq(vault.totalAssets(), ta0 - 40e6);
        stub.owe(40e6, 0);
        assertEq(vault.totalAssets(), ta0);
    }

    function test_totalAssetsFloorsAtZero() public {
        stub.owe(0, vault.totalAssets() + 1);
        assertEq(vault.totalAssets(), 0);
    }

    function test_pause_roles() public {
        vm.prank(lp);
        vm.expectRevert(
            abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, lp, Constants.PAUSER_ROLE)
        );
        vault.pause();
        vm.prank(deployer);
        vault.pause();
        assertTrue(vault.paused());
        // Pause never blocks exits or settlement.
        vm.roll(vault.lockUntil(lp));
        uint256 id = _req(lp, 1e12);
        vm.prank(manager);
        vault.reserve(BTC, 10e6, 5000);
        vm.prank(manager);
        vault.payCapped(BTC, address(acct), 1e6, 2500);
        vm.roll(block.number + 48_300);
        vm.prank(lp);
        vault.claimRedeem(id, lp);
        vm.prank(deployer);
        vault.unpause();
        assertFalse(vault.paused());
    }

    function test_defaultAdminCannotBeGrantedDirectly() public {
        vm.prank(deployer);
        vm.expectRevert(IAccessControlDefaultAdminRules.AccessControlEnforcedDefaultAdminRules.selector);
        vault.grantRole(bytes32(0), lp);
    }

    function test_donationDoesNotMovePrice() public {
        uint256 p0 = vault.convertToAssets(1e12);
        ausd.mint(address(vault), 500e6);
        assertEq(vault.convertToAssets(1e12), p0);
        assertEq(vault.totalAssets(), 1001e6);
    }

    function test_views() public {
        assertEq(vault.utilizationBps(), 0);
        assertEq(vault.freeAssets(), vault.totalAssets());
        vm.prank(manager);
        vault.reserve(BTC, 100e6, 5000);
        assertEq(vault.utilizationBps(), 100e6 * 1e4 / vault.totalAssets());
    }

    // Helpers

    function _payout(uint256 amount) internal {
        vm.startPrank(manager);
        vault.reserve(BTC, amount, 10_000);
        vault.payCapped(BTC, address(acct), amount, 10_000);
        vm.stopPrank();
    }

    function _premium(uint256 amount) internal {
        ausd.mint(manager, amount);
        stub.notify(amount);
    }
}
