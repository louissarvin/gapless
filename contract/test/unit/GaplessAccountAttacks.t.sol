// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {GaplessFixture} from "../utils/GaplessFixture.sol";
import {GaplessFactory} from "../../src/GaplessFactory.sol";
import {GaplessAccount} from "../../src/GaplessAccount.sol";
import {ICoverVault} from "../../src/interfaces/ICoverVault.sol";
import {IGaplessAccount} from "../../src/interfaces/IGaplessAccount.sol";
import {CoverParams, Quote, OperatorGrant} from "../../src/types/GaplessTypes.sol";
import {Constants} from "../../src/Constants.sol";

/// Hostile manager: every hook it receives from an account-originated call tries to re-enter the account.
contract ReentrantManager {
    enum Mode {
        None,
        CloseForCover,
        CreditToPerpl,
        Trade,
        Withdraw
    }

    Mode public mode;
    bytes public lastRevert;
    bytes32 public active;

    function setMode(Mode m) external {
        mode = m;
    }

    function setActive(bytes32 id) external {
        active = id;
    }

    function factory() external view returns (address) {
        return address(this);
    }

    function isLocked(address, uint256) external pure returns (bool) {
        return false;
    }

    function activeCoverOf(address, uint256) external view returns (bytes32) {
        return active;
    }

    function quote(address, CoverParams calldata) external pure returns (Quote memory q) {
        q.escrowCNS = 1;
    }

    function openCover(address account, CoverParams calldata, uint256) external returns (bytes32) {
        _reenter(account);
        return bytes32(uint256(1));
    }

    function syncCover(address account, uint256) external {
        _reenter(account);
    }

    function cancelCover(address account, bytes32) external {
        _reenter(account);
    }

    function _reenter(address account) internal {
        Mode m = mode;
        bytes memory data;
        if (m == Mode.CloseForCover) data = abi.encodeCall(IGaplessAccount.closeForCover, (1, true, 1, 1, 1));
        else if (m == Mode.CreditToPerpl) data = abi.encodeCall(IGaplessAccount.creditToPerpl, (1));
        else if (m == Mode.Trade) data = abi.encodeWithSignature("sweep()");
        else if (m == Mode.Withdraw) data = abi.encodeCall(IGaplessAccount.withdraw, (1));
        else return;
        (bool ok, bytes memory ret) = account.call(data);
        if (!ok) {
            // Bubble so the test sees exactly why re-entry failed.
            assembly ("memory-safe") {
                revert(add(ret, 32), mload(ret))
            }
        }
    }
}

contract GaplessAccountAttacksTest is GaplessFixture {
    address internal owner = makeAddr("owner");
    GaplessAccount internal acct;

    function setUp() public {
        _setUpGapless();
        _lp(makeAddr("lp"), 100e6);
        acct = _account(owner, 50e6, _noGrant());
    }

    // A9: hostile manager re-entry is stopped by the account's transient guard.

    function _hostile() internal returns (ReentrantManager m, GaplessAccount a) {
        m = new ReentrantManager();
        GaplessFactory f = new GaplessFactory(address(ex), address(ausd), address(m), address(vault), 0);
        ausd.mint(owner, 50e6);
        vm.startPrank(owner);
        ausd.approve(address(f), 50e6);
        a = GaplessAccount(f.createAccount(50e6, _noGrant()));
        vm.stopPrank();
    }

    function test_A9_managerHookCannotReenterDuringBuy() public {
        (ReentrantManager m, GaplessAccount a) = _hostile();
        ReentrantManager.Mode[3] memory modes =
            [ReentrantManager.Mode.CloseForCover, ReentrantManager.Mode.CreditToPerpl, ReentrantManager.Mode.Trade];
        for (uint256 i; i < modes.length; ++i) {
            m.setMode(modes[i]);
            vm.prank(owner);
            vm.expectRevert(ReentrancyGuardTransient.ReentrancyGuardReentrantCall.selector);
            a.buyCover(_coverParams(1, true), 1);
        }
    }

    function test_A9_syncCoverCannotReenter() public {
        (ReentrantManager m, GaplessAccount a) = _hostile();
        m.setActive(bytes32(uint256(7)));
        m.setMode(ReentrantManager.Mode.Withdraw);
        vm.prank(owner);
        vm.expectRevert(ReentrancyGuardTransient.ReentrancyGuardReentrantCall.selector);
        a.trade(_order(Constants.ORDER_OPEN_LONG, ASK * 101 / 100, 10));
    }

    function test_A9_cancelCannotReenter() public {
        (ReentrantManager m, GaplessAccount a) = _hostile();
        m.setMode(ReentrantManager.Mode.CloseForCover);
        vm.prank(owner);
        vm.expectRevert(ReentrancyGuardTransient.ReentrancyGuardReentrantCall.selector);
        a.cancelCover(bytes32(uint256(1)));
    }

    // A9: read-only reentrancy on totalAssets while settling.

    function test_A9_lpFlowsBlockedWhileSettling() public {
        address lp2 = makeAddr("lp2");
        ausd.mint(lp2, 10e6);
        vm.prank(lp2);
        ausd.approve(address(vault), 10e6);
        stub.setSettling(true);
        vm.prank(lp2);
        vm.expectRevert(ICoverVault.Settling.selector);
        vault.deposit(10e6, lp2);
        stub.setSettling(false);
        vm.prank(lp2);
        vault.deposit(10e6, lp2);
    }

    // A5 and C5 griefing

    function test_C5_thirdPartyCannotExtendLock() public {
        address lp = makeAddr("lp");
        uint256 until = vault.lockUntil(lp);
        address griefer = makeAddr("griefer");
        ausd.mint(griefer, 1e6);
        vm.roll(until - 1);
        vm.startPrank(griefer);
        ausd.approve(address(vault), 1e6);
        vm.expectRevert(ICoverVault.ThirdPartyDeposit.selector);
        vault.deposit(1e6, lp);
        vm.stopPrank();
        vm.roll(until);
        vm.prank(lp);
        vault.requestRedeem(1e12);
    }

    function test_strangerSweepOnlyMovesFundsIntoOwnersPerpl() public {
        ausd.mint(address(acct), 5e6);
        uint256 bal0 = _perplBalance(acct);
        vm.prank(makeAddr("griefer"));
        acct.sweep();
        assertEq(_perplBalance(acct), bal0 + 5e6);
        vm.prank(owner);
        acct.withdraw(bal0 + 5e6);
        assertEq(ausd.balanceOf(owner), bal0 + 5e6);
    }

    function test_operatorCannotExfiltrate() public {
        address op = makeAddr("op");
        vm.prank(owner);
        acct.setOperator(OperatorGrant(op, type(uint64).max, type(uint128).max, type(uint128).max));
        vm.startPrank(op);
        vm.expectRevert(IGaplessAccount.NotOwner.selector);
        acct.withdraw(1);
        vm.expectRevert(IGaplessAccount.NotOwner.selector);
        acct.setOperator(OperatorGrant(op, type(uint64).max, type(uint128).max, type(uint128).max));
        vm.expectRevert(IGaplessAccount.NotOwner.selector);
        acct.revokeOperator();
        vm.expectRevert(IGaplessAccount.NotManager.selector);
        acct.creditToPerpl(1);
        vm.expectRevert(IGaplessAccount.NotManager.selector);
        acct.closeForCover(BTC, true, 1, 1, 1);
        vm.stopPrank();
    }

    function test_A5_ownerCannotFrontRunTriggerWithTrade() public {
        _openLong(acct, 100);
        stub.setLocked(address(acct), BTC, true);
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(IGaplessAccount.PerpLocked.selector, BTC));
        acct.trade(_order(Constants.ORDER_CLOSE_LONG, BID * 99 / 100, 100));
        // The manager still closes through the hook while locked.
        assertEq(stub.close(address(acct), BTC, true, 100, BID * 99 / 100, 32).filledLots, 100);
    }

    // D13 and C10: payouts only to registered clones

    function test_D13_zeroAndUnregisteredRecipients() public {
        vm.startPrank(manager);
        vault.reserve(BTC, 10e6, 5000);
        vm.expectRevert(abi.encodeWithSelector(ICoverVault.NotAccount.selector, address(0)));
        vault.payCapped(BTC, address(0), 1e6, 2500);
        vm.expectRevert(abi.encodeWithSelector(ICoverVault.NotAccount.selector, owner));
        vault.payCapped(BTC, owner, 1e6, 2500);
        vm.stopPrank();
        assertEq(ausd.balanceOf(address(0)), 0);
    }

    function test_D13_withdrawAlwaysPaysOwner() public {
        bytes memory noSig;
        vm.expectRevert(IGaplessAccount.BadSig.selector);
        acct.withdrawWithSig(1, block.timestamp, noSig);
        vm.prank(owner);
        acct.withdraw(1e6);
        assertEq(ausd.balanceOf(owner), 1e6);
    }

    // Self-payout: a covered account's payout goes back into its own Perpl account.

    function test_payoutFlowsIntoPerpl() public {
        vm.prank(manager);
        vault.reserve(BTC, 10e6, 5000);
        uint256 bal0 = _perplBalance(acct);
        assertEq(stub.settle(BTC, address(acct), 4e6, 2500), 4e6);
        assertEq(_perplBalance(acct), bal0 + 4e6, "trigger shape: payCapped then creditToPerpl");
        assertEq(ausd.balanceOf(address(acct)), 0);
    }

    function test_payoutToInactiveAccountStaysInWallet() public {
        GaplessAccount a = _account(makeAddr("inactive"), 0, _noGrant());
        vm.prank(manager);
        vault.reserve(BTC, 10e6, 5000);
        assertEq(stub.settle(BTC, address(a), 4e6, 2500), 4e6);
        assertEq(ausd.balanceOf(address(a)), 4e6);
    }
}
