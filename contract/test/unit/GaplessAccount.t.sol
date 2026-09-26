// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {IERC20Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";
import {GaplessFixture} from "../utils/GaplessFixture.sol";
import {GaplessAccount} from "../../src/GaplessAccount.sol";
import {IGaplessAccount} from "../../src/interfaces/IGaplessAccount.sol";
import {ICoverManager} from "../../src/interfaces/ICoverManager.sol";
import {IPerplMin} from "../../src/interfaces/perpl/IPerplMin.sol";
import {IPerplErrors} from "../../src/interfaces/perpl/IPerplErrors.sol";
import {OperatorGrant, CoverParams, CloseResult} from "../../src/types/GaplessTypes.sol";
import {Constants} from "../../src/Constants.sol";
import {ERC1271Wallet} from "./stubs/ERC1271Wallet.sol";

contract GaplessAccountTest is GaplessFixture {
    address internal owner;
    uint256 internal ownerPk;
    address internal op;
    uint256 internal opPk;
    address internal stranger = makeAddr("stranger");
    GaplessAccount internal acct;
    uint64 internal expiry;

    function setUp() public {
        _setUpGapless();
        (owner, ownerPk) = makeAddrAndKey("owner");
        (op, opPk) = makeAddrAndKey("operator");
        expiry = uint64(block.timestamp + 1 days);
        _lp(makeAddr("lp"), 100e6);
        acct = _account(owner, 100e6, _grant(op, expiry, 500e6));
    }

    // Initialize and wiring

    function test_initialState() public view {
        assertEq(acct.owner(), owner);
        assertEq(acct.EX(), address(ex));
        assertEq(acct.AUSD(), address(ausd));
        assertEq(acct.FACTORY(), address(factory));
        assertEq(acct.MANAGER(), manager);
        assertEq(acct.VAULT(), address(vault));
        assertEq(acct.BUILDER_ID(), 0);
        assertEq(acct.WITHDRAW_TYPEHASH(), Constants.WITHDRAW_TYPEHASH);
        assertEq(acct.SET_OPERATOR_TYPEHASH(), Constants.SET_OPERATOR_TYPEHASH);
        OperatorGrant memory g = acct.operator();
        assertEq(g.key, op);
        assertEq(g.expiry, expiry);
        assertEq(g.maxNotionalPerTradeCNS, 500e6);
        assertGt(acct.perplAccountId(), 0);
        assertEq(acct.opNonce(), 0);
    }

    function test_domainSeparatorIsPerClone() public view {
        assertEq(acct.DOMAIN_SEPARATOR(), _domain("GaplessAccount", address(acct)));
        (, string memory name, string memory version, uint256 chainId, address verifying,,) = acct.eip712Domain();
        assertEq(name, "GaplessAccount");
        assertEq(version, "1");
        assertEq(chainId, 143);
        assertEq(verifying, address(acct));
        assertTrue(acct.DOMAIN_SEPARATOR() != impl.DOMAIN_SEPARATOR());
    }

    function test_initialize_revertsNotFactory() public {
        vm.expectRevert(IGaplessAccount.NotFactory.selector);
        acct.initialize(stranger, _noGrant());
    }

    function test_initialize_revertsTwice() public {
        vm.prank(address(factory));
        vm.expectRevert(IGaplessAccount.AlreadyInitialized.selector);
        acct.initialize(stranger, _noGrant());
    }

    function test_implementationIsLocked() public {
        assertEq(impl.owner(), Constants.DEAD);
        vm.prank(address(factory));
        vm.expectRevert(IGaplessAccount.AlreadyInitialized.selector);
        impl.initialize(stranger, _noGrant());
        vm.prank(stranger);
        vm.expectRevert(IGaplessAccount.NotOwner.selector);
        impl.withdraw(1);
    }

    function test_constructor_revertsZeroAddress() public {
        vm.expectRevert(IGaplessAccount.ZeroAddress.selector);
        new GaplessAccount(address(0), address(ausd), manager, address(vault), 0);
        vm.expectRevert(IGaplessAccount.ZeroAddress.selector);
        new GaplessAccount(address(ex), address(ausd), manager, address(0), 0);
    }

    // sweep

    function test_sweep_depositsWalletToPerpl() public {
        uint256 bal0 = _perplBalance(acct);
        ausd.mint(address(acct), 7e6);
        vm.expectEmit(address(acct));
        emit IGaplessAccount.Swept(7e6);
        vm.prank(stranger);
        acct.sweep();
        assertEq(_perplBalance(acct), bal0 + 7e6);
        assertEq(ausd.balanceOf(address(acct)), 0);
        assertEq(ausd.allowance(address(acct), address(ex)), 0);
    }

    function test_sweep_noopWhenEmpty() public {
        uint256 bal0 = _perplBalance(acct);
        acct.sweep();
        assertEq(_perplBalance(acct), bal0);
    }

    function test_sweep_activationThreshold() public {
        GaplessAccount a = _account(makeAddr("small"), 9_999_999, _noGrant());
        assertEq(a.perplAccountId(), 0, "below 10 AUSD stays inactive");
        assertEq(ausd.balanceOf(address(a)), 9_999_999);
        ausd.mint(address(a), 1);
        vm.recordLogs();
        a.sweep();
        assertGt(a.perplAccountId(), 0);
        assertEq(ex.getAccountById(a.perplAccountId()).balanceCNS, 10e6);
        assertEq(ausd.allowance(address(a), address(ex)), 0);
    }

    function test_sweep_bubblesPerplErrors() public {
        GaplessAccount a = _account(makeAddr("w"), 0, _noGrant());
        ausd.mint(address(a), 20e6);
        ex.setWhitelistingEnabled(true);
        vm.expectRevert(abi.encodeWithSelector(IPerplErrors.NotWhitelisted.selector, address(a)));
        a.sweep();
    }

    // depositWithPermit

    function _permitSig(uint256 pk, address spender, uint256 value, uint256 deadline, string memory name)
        internal
        view
        returns (uint8 v, bytes32 r, bytes32 s)
    {
        address o = vm.addr(pk);
        bytes32 sh = keccak256(abi.encode(ausd.PERMIT_TYPEHASH(), o, spender, value, ausd.nonces(o), deadline));
        (v, r, s) = vm.sign(pk, keccak256(abi.encodePacked("\x19\x01", _domain(name, address(ausd)), sh)));
    }

    function test_depositWithPermit_relayed() public {
        ausd.mint(owner, 30e6);
        uint256 bal0 = _perplBalance(acct);
        (uint8 v, bytes32 r, bytes32 s) =
            _permitSig(ownerPk, address(acct), 30e6, block.timestamp + 1 hours, "Agora Dollar");
        vm.prank(stranger);
        acct.depositWithPermit(30e6, block.timestamp + 1 hours, v, r, s);
        assertEq(_perplBalance(acct), bal0 + 30e6);
        assertEq(ausd.balanceOf(owner), 0);
    }

    function test_depositWithPermit_frontRunPermitStillDeposits() public {
        ausd.mint(owner, 30e6);
        uint256 dl = block.timestamp + 1 hours;
        (uint8 v, bytes32 r, bytes32 s) = _permitSig(ownerPk, address(acct), 30e6, dl, "Agora Dollar");
        ausd.permit(owner, address(acct), 30e6, dl, v, r, s); // griefer front-runs the permit
        acct.depositWithPermit(30e6, dl, v, r, s);
        assertEq(ausd.balanceOf(owner), 0);
    }

    function test_depositWithPermit_ausdNameFails() public {
        ausd.mint(owner, 30e6);
        uint256 dl = block.timestamp + 1 hours;
        (uint8 v, bytes32 r, bytes32 s) = _permitSig(ownerPk, address(acct), 30e6, dl, "AUSD");
        vm.expectRevert(IGaplessAccount.BadSig.selector);
        acct.depositWithPermit(30e6, dl, v, r, s);
    }

    function test_depositWithPermit_revertsZero() public {
        vm.expectRevert(IGaplessAccount.ZeroAmount.selector);
        acct.depositWithPermit(0, 0, 0, 0, 0);
    }

    function test_depositWithPermit_onlyPullsFromOwner() public {
        // A stranger's signature can never redirect: the account always pulls from owner().
        ausd.mint(stranger, 30e6);
        (address s2, uint256 s2Pk) = makeAddrAndKey("s2");
        ausd.mint(s2, 30e6);
        uint256 dl = block.timestamp + 1 hours;
        (uint8 v, bytes32 r, bytes32 s) = _permitSig(s2Pk, address(acct), 30e6, dl, "Agora Dollar");
        vm.expectRevert(IGaplessAccount.BadSig.selector);
        acct.depositWithPermit(30e6, dl, v, r, s);
        assertEq(ausd.balanceOf(s2), 30e6);
    }

    // trade: auth and operator scope

    function test_trade_ownerOpensLong() public {
        vm.expectEmit(address(acct));
        emit IGaplessAccount.Traded(BTC, 0, 100, ASK * 101 / 100, owner);
        _openLong(acct, 100);
        assertEq(_position(acct).lotLNS, 100);
        assertEq(_position(acct).positionType, 0);
    }

    function test_trade_operatorWithinCap() public {
        IPerplMin.OrderDesc memory d = _order(0, ASK * 101 / 100, 100); // ~87 AUSD notional
        vm.prank(op);
        acct.trade(d);
        assertEq(_position(acct).lotLNS, 100);
    }

    function test_trade_operatorNotionalCap() public {
        IPerplMin.OrderDesc memory d = _order(0, ASK, 581); // 500.67 AUSD > 500 cap
        vm.prank(op);
        vm.expectRevert(abi.encodeWithSelector(IGaplessAccount.NotionalCapExceeded.selector, ASK * 581, 500e6));
        acct.trade(d);
        d.lotLNS = 580; // 499.8 AUSD
        vm.prank(op);
        acct.trade(d);
    }

    function test_trade_operatorChangeIsCapped() public {
        IPerplMin.OrderDesc memory d = _order(Constants.ORDER_CHANGE, ASK, 10_000);
        vm.prank(op);
        vm.expectRevert(abi.encodeWithSelector(IGaplessAccount.NotionalCapExceeded.selector, ASK * 10_000, 500e6));
        acct.trade(d);
    }

    function test_trade_operatorCloseNotCapped() public {
        _openLong(acct, 1000);
        // Raise the cap check irrelevance: a close of 1000 lots (~860 AUSD) passes for the operator.
        vm.prank(op);
        acct.trade(_order(Constants.ORDER_CLOSE_LONG, BID * 99 / 100, 1000));
        assertEq(_position(acct).lotLNS, 0);
    }

    /// @dev M-01: a sell limit is only a floor, so a far-off limit is rejected before it can understate notional.
    function test_trade_operatorOffMarketLimitRejected() public {
        IPerplMin.OrderDesc memory d = _order(Constants.ORDER_OPEN_SHORT, 1, 10_000);
        vm.prank(op);
        vm.expectRevert(abi.encodeWithSelector(IGaplessAccount.LimitOffMarket.selector, 1, BID));
        acct.trade(d);
        d = _order(Constants.ORDER_OPEN_LONG, BID * 106 / 100, 1); // 6% above mark
        vm.prank(op);
        vm.expectRevert(abi.encodeWithSelector(IGaplessAccount.LimitOffMarket.selector, BID * 106 / 100, BID));
        acct.trade(d);
        d = _order(Constants.ORDER_CHANGE, BID / 2, 1);
        vm.prank(op);
        vm.expectRevert(abi.encodeWithSelector(IGaplessAccount.LimitOffMarket.selector, BID / 2, BID));
        acct.trade(d);
        // Exactly at the 5% band edge passes the band check
        d = _order(Constants.ORDER_OPEN_SHORT, BID * 95 / 100 + 1, 100);
        vm.prank(op);
        acct.trade(d);
    }

    /// @dev M-01: an in-band sell limit below the mark is priced at the mark for the cap.
    function test_trade_operatorShortCappedAtMark() public {
        IPerplMin.OrderDesc memory d = _order(Constants.ORDER_OPEN_SHORT, BID * 96 / 100, 581); // > 500 AUSD at mark
        vm.prank(op);
        vm.expectRevert(abi.encodeWithSelector(IGaplessAccount.NotionalCapExceeded.selector, BID * 581, 500e6));
        acct.trade(d);
        d.lotLNS = 580;
        vm.prank(op);
        acct.trade(d);
    }

    /// @dev M-01: operator closes are band-checked and bounded by the position; the owner is never restricted.
    function test_trade_operatorCloseBoundedByPosition_ownerUnaffected() public {
        _openLong(acct, 100);
        vm.prank(op);
        vm.expectRevert(abi.encodeWithSelector(IGaplessAccount.CloseExceedsPosition.selector, 101, 100));
        acct.trade(_order(Constants.ORDER_CLOSE_LONG, BID * 99 / 100, 101));
        vm.prank(op);
        vm.expectRevert(abi.encodeWithSelector(IGaplessAccount.LimitOffMarket.selector, 1, BID));
        acct.trade(_order(Constants.ORDER_CLOSE_LONG, 1, 100));
        // Owner: off-market limits and any size, as before
        vm.prank(owner);
        acct.trade(_order(Constants.ORDER_CLOSE_LONG, 1, 100));
        assertEq(_position(acct).lotLNS, 0);
        vm.prank(owner);
        acct.trade(_order(Constants.ORDER_OPEN_SHORT, 1, 1000));
        assertEq(_position(acct).lotLNS, 1000);
    }

    function test_trade_operatorZeroMarkRejected() public {
        ex.setMark(BTC, 0);
        vm.prank(op);
        vm.expectRevert(abi.encodeWithSelector(IGaplessAccount.LimitOffMarket.selector, ASK, 0));
        acct.trade(_order(Constants.ORDER_OPEN_LONG, ASK, 1));
        vm.prank(op);
        // Cancel carries no price: never band-checked, so the call reaches Perpl
        vm.expectRevert(abi.encodeWithSelector(IPerplErrors.OrderDoesNotExist.selector, 1, 0));
        acct.trade(_order(Constants.ORDER_CANCEL, 0, 0));
    }

    function test_trade_operatorExpired() public {
        vm.warp(expiry);
        _refreshRefs();
        vm.prank(op);
        vm.expectRevert(abi.encodeWithSelector(IGaplessAccount.OperatorExpired.selector, expiry));
        acct.trade(_order(0, ASK * 101 / 100, 1));
        vm.warp(expiry - 1);
        _refreshRefs();
        vm.prank(op);
        acct.trade(_order(0, ASK * 101 / 100, 1));
    }

    function test_trade_strangerReverts() public {
        vm.prank(stranger);
        vm.expectRevert(IGaplessAccount.NotOwnerOrOperator.selector);
        acct.trade(_order(0, ASK * 101 / 100, 1));
    }

    function test_trade_badOrderType() public {
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(IGaplessAccount.BadOrderType.selector, 7));
        acct.trade(_order(7, ASK, 1));
    }

    function test_trade_perplNotActive() public {
        GaplessAccount a = _account(makeAddr("inactive"), 0, _noGrant());
        vm.prank(a.owner());
        vm.expectRevert(IGaplessAccount.PerplNotActive.selector);
        a.trade(_order(0, ASK, 1));
    }

    function test_trade_perpLockedWhileArmed() public {
        _openLong(acct, 100);
        stub.setLocked(address(acct), BTC, true);
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(IGaplessAccount.PerpLocked.selector, BTC));
        acct.trade(_order(Constants.ORDER_CLOSE_LONG, BID * 99 / 100, 100));
        vm.prank(op);
        vm.expectRevert(abi.encodeWithSelector(IGaplessAccount.PerpLocked.selector, BTC));
        acct.trade(_order(Constants.ORDER_CANCEL, 0, 0));
        // D44 and C17: withdrawing free balance stays open while armed.
        vm.prank(owner);
        acct.withdraw(1e6);
    }

    function test_trade_syncsActiveCover() public {
        _openLong(acct, 100);
        vm.prank(owner);
        acct.buyCover(_coverParams(100, true), 10e6);
        uint256 calls = stub.syncCalls();
        vm.prank(owner);
        acct.trade(_order(Constants.ORDER_CLOSE_LONG, BID * 99 / 100, 50));
        assertEq(stub.syncCalls(), calls + 1);
    }

    function test_trade_noSyncWithoutCover() public {
        _openLong(acct, 100);
        assertEq(stub.syncCalls(), 0);
    }

    function test_trade_perplErrorBubbles() public {
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(IPerplErrors.CloseOrderExceedsPosition.selector, 0, 5));
        acct.trade(_order(Constants.ORDER_CLOSE_LONG, BID, 5));
    }

    // Covers: premium funding

    function test_buyCover_paysFromPerplShortfall() public {
        _openLong(acct, 100);
        uint256 bal0 = _perplBalance(acct);
        uint256 need = stub.escrowCNS() + stub.rentCNS();
        vm.prank(op);
        bytes32 id = acct.buyCover(_coverParams(100, true), need);
        assertTrue(id != bytes32(0));
        assertEq(_perplBalance(acct), bal0 - need, "shortfall from Perpl");
        assertEq(ausd.balanceOf(manager), need);
        assertEq(ausd.allowance(address(acct), manager), 0, "allowance reset");
        assertEq(stub.activeCoverOf(address(acct), BTC), id);
    }

    function test_buyCover_walletFirst() public {
        ausd.mint(address(acct), 5e6);
        uint256 bal0 = _perplBalance(acct);
        uint256 need = stub.escrowCNS() + stub.rentCNS();
        vm.prank(owner);
        acct.buyCover(_coverParams(100, true), need);
        assertEq(_perplBalance(acct), bal0, "Perpl untouched");
        assertEq(ausd.balanceOf(address(acct)), 5e6 - need);
    }

    function test_buyCover_partialWalletThenPerpl() public {
        ausd.mint(address(acct), 1e6);
        uint256 bal0 = _perplBalance(acct);
        uint256 need = stub.escrowCNS() + stub.rentCNS();
        vm.prank(owner);
        acct.buyCover(_coverParams(100, true), need);
        assertEq(_perplBalance(acct), bal0 - (need - 1e6));
        assertEq(ausd.balanceOf(address(acct)), 0);
    }

    function test_buyCover_premiumUnfunded() public {
        stub.setQuote(200e6, 20_000, 1e6);
        uint256 free = _perplBalance(acct);
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(IGaplessAccount.PremiumUnfunded.selector, 200e6 + 20_000, free));
        acct.buyCover(_coverParams(100, true), 300e6);
    }

    function test_buyCover_premiumUnfundedWhenInactive() public {
        GaplessAccount a = _account(makeAddr("inactive"), 1e6, _noGrant());
        uint256 need = stub.escrowCNS() + stub.rentCNS();
        vm.prank(a.owner());
        vm.expectRevert(abi.encodeWithSelector(IGaplessAccount.PremiumUnfunded.selector, need, 1e6));
        a.buyCover(_coverParams(100, true), need);
    }

    function test_buyCover_premiumTooHigh() public {
        uint256 need = stub.escrowCNS() + stub.rentCNS();
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(ICoverManager.PremiumTooHigh.selector, need, need - 1));
        acct.buyCover(_coverParams(100, true), need - 1);
    }

    function test_buyCover_withdrawRateLimitBubbles() public {
        ex.setWithdrawAllowanceCNS(1);
        vm.prank(owner);
        vm.expectRevert();
        acct.buyCover(_coverParams(100, true), 10e6);
    }

    function test_buyCover_strangerReverts() public {
        vm.prank(stranger);
        vm.expectRevert(IGaplessAccount.NotOwnerOrOperator.selector);
        acct.buyCover(_coverParams(100, true), 10e6);
    }

    function test_tradeAndCover_operator() public {
        uint256 need = stub.escrowCNS() + stub.rentCNS();
        vm.prank(op);
        bytes32 id = acct.tradeAndCover(_order(0, ASK * 101 / 100, 100), _coverParams(100, true), need);
        assertEq(_position(acct).lotLNS, 100);
        assertEq(stub.activeCoverOf(address(acct), BTC), id);
        assertEq(ausd.allowance(address(acct), manager), 0);
    }

    function test_tradeAndCover_coverExistsAfterSync() public {
        uint256 need = stub.escrowCNS() + stub.rentCNS();
        vm.prank(owner);
        bytes32 id = acct.tradeAndCover(_order(0, ASK * 101 / 100, 100), _coverParams(100, true), need);
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(ICoverManager.CoverExists.selector, id));
        acct.tradeAndCover(_order(0, ASK * 101 / 100, 100), _coverParams(200, true), need);
    }

    function test_cancelCover_refundsToWallet() public {
        vm.prank(owner);
        bytes32 id = acct.buyCover(_coverParams(100, true), 10e6);
        uint256 escrow = stub.escrowCNS();
        vm.prank(op);
        acct.cancelCover(id);
        assertEq(ausd.balanceOf(address(acct)), escrow, "plain transfer refund (C6)");
        assertEq(stub.activeCoverOf(address(acct), BTC), bytes32(0));
    }

    function test_cancelCover_strangerReverts() public {
        vm.prank(stranger);
        vm.expectRevert(IGaplessAccount.NotOwnerOrOperator.selector);
        acct.cancelCover(bytes32(uint256(1)));
    }

    // withdraw

    function test_withdraw_walletThenPerpl() public {
        ausd.mint(address(acct), 3e6);
        uint256 bal0 = _perplBalance(acct);
        vm.expectEmit(address(acct));
        emit IGaplessAccount.Withdrawn(owner, 10e6);
        vm.prank(owner);
        acct.withdraw(10e6);
        assertEq(ausd.balanceOf(owner), 10e6);
        assertEq(_perplBalance(acct), bal0 - 7e6);
        assertEq(ausd.balanceOf(address(acct)), 0);
    }

    function test_withdraw_walletOnly() public {
        ausd.mint(address(acct), 3e6);
        uint256 bal0 = _perplBalance(acct);
        vm.prank(owner);
        acct.withdraw(3e6);
        assertEq(_perplBalance(acct), bal0);
    }

    function test_withdraw_onlyOwner() public {
        vm.prank(op);
        vm.expectRevert(IGaplessAccount.NotOwner.selector);
        acct.withdraw(1e6);
    }

    function test_withdraw_zero() public {
        vm.prank(owner);
        vm.expectRevert(IGaplessAccount.ZeroAmount.selector);
        acct.withdraw(0);
    }

    function test_withdraw_inactiveShort() public {
        GaplessAccount a = _account(makeAddr("inactive"), 1e6, _noGrant());
        vm.prank(a.owner());
        vm.expectRevert(IGaplessAccount.PerplNotActive.selector);
        a.withdraw(2e6);
    }

    function test_withdraw_tooMuchBubbles() public {
        uint256 bal = _perplBalance(acct);
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(IPerplErrors.InsufficientFunds.selector, bal, bal + 1));
        acct.withdraw(bal + 1);
    }

    // withdrawWithSig

    function _withdrawSig(uint256 pk, GaplessAccount a, uint256 amount, uint256 nonce, uint256 deadline)
        internal
        view
        returns (bytes memory)
    {
        return _sign(
            pk,
            a.DOMAIN_SEPARATOR(),
            keccak256(abi.encode(Constants.WITHDRAW_TYPEHASH, address(a), amount, nonce, deadline))
        );
    }

    function test_withdrawWithSig_relayed() public {
        uint256 dl = block.timestamp + 1 hours;
        bytes memory sig = _withdrawSig(ownerPk, acct, 5e6, 0, dl);
        vm.prank(stranger);
        acct.withdrawWithSig(5e6, dl, sig);
        assertEq(ausd.balanceOf(owner), 5e6, "always pays the owner");
        assertEq(ausd.balanceOf(stranger), 0);
        assertEq(acct.opNonce(), 1);
    }

    function test_withdrawWithSig_replayReverts() public {
        uint256 dl = block.timestamp + 1 hours;
        bytes memory sig = _withdrawSig(ownerPk, acct, 5e6, 0, dl);
        acct.withdrawWithSig(5e6, dl, sig);
        vm.expectRevert(IGaplessAccount.BadSig.selector);
        acct.withdrawWithSig(5e6, dl, sig);
    }

    function test_withdrawWithSig_expired() public {
        uint256 dl = block.timestamp - 1;
        bytes memory sig = _withdrawSig(ownerPk, acct, 5e6, 0, dl);
        vm.expectRevert(IGaplessAccount.SigExpired.selector);
        acct.withdrawWithSig(5e6, dl, sig);
    }

    function test_withdrawWithSig_operatorCannotSign() public {
        uint256 dl = block.timestamp + 1 hours;
        bytes memory sig = _withdrawSig(opPk, acct, 5e6, 0, dl);
        vm.expectRevert(IGaplessAccount.BadSig.selector);
        acct.withdrawWithSig(5e6, dl, sig);
    }

    function test_withdrawWithSig_tamperedAmount() public {
        uint256 dl = block.timestamp + 1 hours;
        bytes memory sig = _withdrawSig(ownerPk, acct, 5e6, 0, dl);
        vm.expectRevert(IGaplessAccount.BadSig.selector);
        acct.withdrawWithSig(6e6, dl, sig);
    }

    function test_withdrawWithSig_crossAccountReplay() public {
        GaplessAccount other = _account(makeAddr("other"), 50e6, _noGrant());
        // Same owner key on a second factory is impossible, so replay across clones of different owners:
        uint256 dl = block.timestamp + 1 hours;
        bytes memory sig = _withdrawSig(ownerPk, acct, 5e6, 0, dl);
        vm.expectRevert(IGaplessAccount.BadSig.selector);
        other.withdrawWithSig(5e6, dl, sig);
    }

    function test_withdrawWithSig_wrongChain() public {
        uint256 dl = block.timestamp + 1 hours;
        bytes memory sig = _withdrawSig(ownerPk, acct, 5e6, 0, dl);
        vm.chainId(1);
        vm.expectRevert(IGaplessAccount.BadSig.selector);
        acct.withdrawWithSig(5e6, dl, sig);
    }

    function test_withdrawWithSig_highSRejected() public {
        uint256 dl = block.timestamp + 1 hours;
        bytes32 sh = keccak256(abi.encode(Constants.WITHDRAW_TYPEHASH, address(acct), 5e6, 0, dl));
        (uint8 v, bytes32 r, bytes32 s) =
            vm.sign(ownerPk, keccak256(abi.encodePacked("\x19\x01", acct.DOMAIN_SEPARATOR(), sh)));
        uint256 n = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141;
        bytes memory malleated = abi.encodePacked(r, bytes32(n - uint256(s)), v == 27 ? uint8(28) : uint8(27));
        vm.expectRevert(IGaplessAccount.BadSig.selector);
        acct.withdrawWithSig(5e6, dl, malleated);
        acct.withdrawWithSig(5e6, dl, abi.encodePacked(r, s, v));
        assertEq(ausd.balanceOf(owner), 5e6);
    }

    function test_withdrawWithSig_erc1271Owner() public {
        (address signer, uint256 signerPk) = makeAddrAndKey("walletSigner");
        ERC1271Wallet w = new ERC1271Wallet(signer);
        GaplessAccount a = _account(address(w), 0, _noGrant());
        ausd.mint(address(a), 4e6);
        uint256 dl = block.timestamp + 1 hours;
        a.withdrawWithSig(4e6, dl, _withdrawSig(signerPk, a, 4e6, 0, dl));
        assertEq(ausd.balanceOf(address(w)), 4e6);
        bytes memory wrong = _withdrawSig(ownerPk, a, 1, 1, dl);
        vm.expectRevert(IGaplessAccount.BadSig.selector);
        a.withdrawWithSig(1, dl, wrong);
    }

    // Operator management

    function _opSig(uint256 pk, GaplessAccount a, OperatorGrant memory g, uint256 nonce, uint256 dl)
        internal
        view
        returns (bytes memory)
    {
        return _sign(
            pk,
            a.DOMAIN_SEPARATOR(),
            keccak256(
                abi.encode(
                    Constants.SET_OPERATOR_TYPEHASH,
                    address(a),
                    g.key,
                    g.expiry,
                    g.maxNotionalPerTradeCNS,
                    g.maxNotionalPerDayCNS,
                    nonce,
                    dl
                )
            )
        );
    }

    function test_setOperator_owner() public {
        OperatorGrant memory g = _grant(stranger, uint64(block.timestamp + 10), 1e6);
        vm.expectEmit(address(acct));
        emit IGaplessAccount.OperatorSet(stranger, g.expiry, 1e6, type(uint128).max);
        vm.prank(owner);
        acct.setOperator(g);
        assertEq(acct.operator().key, stranger);
        assertEq(acct.opNonce(), 1, "direct set bumps the nonce");
        vm.prank(op);
        vm.expectRevert(IGaplessAccount.NotOwnerOrOperator.selector);
        acct.trade(_order(0, ASK, 1));
    }

    function test_setOperator_onlyOwner() public {
        vm.prank(op);
        vm.expectRevert(IGaplessAccount.NotOwner.selector);
        acct.setOperator(_grant(op, type(uint64).max, type(uint128).max));
    }

    function test_revokeOperator() public {
        vm.expectEmit(address(acct));
        emit IGaplessAccount.OperatorSet(address(0), 0, 0, 0);
        vm.prank(owner);
        acct.revokeOperator();
        vm.prank(op);
        vm.expectRevert(IGaplessAccount.NotOwnerOrOperator.selector);
        acct.trade(_order(0, ASK, 1));
        vm.prank(op);
        vm.expectRevert(IGaplessAccount.NotOwner.selector);
        acct.revokeOperator();
    }

    function test_setOperatorWithSig() public {
        OperatorGrant memory g = _grant(stranger, uint64(block.timestamp + 10), 1e6);
        uint256 dl = block.timestamp + 1 hours;
        bytes memory sig = _opSig(ownerPk, acct, g, 0, dl);
        vm.prank(op);
        acct.setOperatorWithSig(g, dl, sig);
        assertEq(acct.operator().key, stranger);
        vm.expectRevert(IGaplessAccount.BadSig.selector);
        acct.setOperatorWithSig(g, dl, sig);
    }

    function test_setOperatorWithSig_expiredAndBadSigner() public {
        OperatorGrant memory g = _grant(stranger, uint64(block.timestamp + 10), 1e6);
        uint256 past = block.timestamp - 1;
        bytes memory sig = _opSig(ownerPk, acct, g, 0, past);
        vm.expectRevert(IGaplessAccount.SigExpired.selector);
        acct.setOperatorWithSig(g, past, sig);
        uint256 dl = block.timestamp + 1 hours;
        sig = _opSig(opPk, acct, g, 0, dl);
        vm.expectRevert(IGaplessAccount.BadSig.selector);
        acct.setOperatorWithSig(g, dl, sig);
    }

    function test_revokeInvalidatesPendingOperatorSig() public {
        OperatorGrant memory g = _grant(stranger, uint64(block.timestamp + 1 days), 1e6);
        uint256 dl = block.timestamp + 1 hours;
        bytes memory pending = _opSig(ownerPk, acct, g, 0, dl);
        vm.prank(owner);
        acct.revokeOperator();
        vm.expectRevert(IGaplessAccount.BadSig.selector);
        acct.setOperatorWithSig(g, dl, pending);
        assertEq(acct.operator().key, address(0));
    }

    // closeForCover

    function _close(uint256 lots, uint256 limit) internal returns (CloseResult memory) {
        return stub.close(address(acct), BTC, true, lots, limit, 32);
    }

    function test_closeForCover_onlyManager() public {
        vm.prank(owner);
        vm.expectRevert(IGaplessAccount.NotManager.selector);
        acct.closeForCover(BTC, true, 1, BID, 32);
    }

    function test_closeForCover_fullFillMatchesStorageDeltas() public {
        _openLong(acct, 100);
        IPerplMin.PositionInfo memory p0 = _position(acct);
        uint256 bal0 = _perplBalance(acct);
        vm.roll(block.number + 1);
        CloseResult memory r = _close(100, BID * 99 / 100);
        assertEq(r.filledLots, 100);
        assertEq(r.releasedDepositCNS, p0.depositCNS);
        assertEq(r.realizedCNS, int256(_perplBalance(acct)) - int256(bal0));
        assertEq(r.entryPNS, p0.pricePNS);
        assertEq(r.fundingCNS, 0);
        assertEq(r.takerFeePpm, 345);
        assertEq(_position(acct).lotLNS, 0);
        // released + pnl - fee == realized: BID - ASK = -10 PNS x 100 lots, fee ceil(BID x 100 x 345 / 1e6)
        uint256 fee = (BID * 100 * 345 + 1e6 - 1) / 1e6;
        assertEq(r.realizedCNS, int256(p0.depositCNS) - 1000 - int256(fee));
    }

    function test_closeForCover_zeroFillIoc() public {
        _openLong(acct, 100);
        uint256 bal0 = _perplBalance(acct);
        CloseResult memory r = _close(100, BID + 1);
        assertEq(r.filledLots, 0);
        assertEq(r.realizedCNS, 0);
        assertEq(r.releasedDepositCNS, 0);
        assertEq(r.takerFeePpm, 0, "zero result on no fill");
        assertEq(_position(acct).lotLNS, 100);
        assertEq(_perplBalance(acct), bal0);
    }

    function test_closeForCover_clampsToPosition() public {
        _openLong(acct, 100);
        CloseResult memory r = _close(1000, BID * 99 / 100);
        assertEq(r.filledLots, 100, "no CloseOrderExceedsPosition");
    }

    function test_closeForCover_wrongSideOrNoPosition() public {
        CloseResult memory r = _close(100, BID);
        assertEq(r.filledLots, 0, "no position");
        _openShort(acct, 100);
        r = _close(100, BID);
        assertEq(r.filledLots, 0, "short position, long cover");
        assertEq(_position(acct).lotLNS, 100);
        r = stub.close(address(acct), BTC, false, 100, ASK * 101 / 100, 32);
        assertEq(r.filledLots, 100);
    }

    function test_closeForCover_zeroLotsOrInactive() public {
        _openLong(acct, 100);
        assertEq(_close(0, BID).filledLots, 0);
        GaplessAccount a = _account(makeAddr("inactive"), 0, _noGrant());
        assertEq(stub.close(address(a), BTC, true, 1, BID, 32).filledLots, 0);
    }

    function test_closeForCover_partialFill() public {
        ex.listPerp(2, "THIN", 1, 5, 1500, BID);
        maker.rest(Constants.ORDER_OPEN_SHORT, 2, ASK, 1000);
        maker.rest(Constants.ORDER_OPEN_LONG, 2, BID, 30);
        IPerplMin.OrderDesc memory d = _order(0, ASK * 101 / 100, 100);
        d.perpId = 2;
        vm.prank(owner);
        acct.trade(d);
        CloseResult memory r = stub.close(address(acct), 2, true, 100, BID, 32);
        assertEq(r.filledLots, 30);
        (IPerplMin.PositionInfo memory p,,) = ex.getPosition(2, acct.perplAccountId());
        assertEq(p.lotLNS, 70);
    }

    function test_closeForCover_maxMatchesBound() public {
        ex.listPerp(3, "DUST", 1, 5, 1500, BID);
        maker.rest(Constants.ORDER_OPEN_SHORT, 3, ASK, 1000);
        for (uint256 i; i < 5; ++i) {
            maker.rest(Constants.ORDER_OPEN_LONG, 3, BID - i, 1);
        }
        maker.rest(Constants.ORDER_OPEN_LONG, 3, BID - 10, 1000);
        IPerplMin.OrderDesc memory d = _order(0, ASK * 101 / 100, 100);
        d.perpId = 3;
        vm.prank(owner);
        acct.trade(d);
        CloseResult memory r = stub.close(address(acct), 3, true, 100, BID - 20, 3);
        assertEq(r.filledLots, 3, "dust spam bounded by maxMatches");
    }

    function test_closeForCover_staleReferenceStillCloses() public {
        _openLong(acct, 100);
        vm.roll(block.number + 400);
        vm.warp(block.timestamp + 120);
        assertEq(_close(100, BID * 99 / 100).filledLots, 100);
    }

    function test_closeForCover_fundingProRataFloor() public {
        _openLong(acct, 100);
        ex.accrueFunding(BTC, acct.perplAccountId(), -12_345);
        CloseResult memory r = _close(50, BID * 99 / 100);
        assertEq(r.filledLots, 50);
        assertEq(r.fundingCNS, -6173, "floor(-6172.5)");
        ex.accrueFunding(BTC, acct.perplAccountId(), 12_345 + 101);
        r = _close(25, BID * 99 / 100);
        // remaining premium = -12345 - (-6172) + 12446 = 6273; 6273 * 25 / 50 = 3136.5 -> 3136
        assertEq(r.fundingCNS, 3136);
    }

    function test_closeForCover_ownRestingBidClearedNotCountedAsRealized() public {
        _openLong(acct, 100);
        // The trader's own resting bid sits at the top of the book; Perpl clears it during the close
        // (self-match, G0 #8) and unlocks its collateral. That unlock is not close proceeds.
        IPerplMin.OrderDesc memory rest = _order(Constants.ORDER_OPEN_LONG, BID + 5, 50);
        rest.immediateOrCancel = false;
        vm.prank(owner);
        acct.trade(rest);
        IPerplMin.AccountInfo memory a0 = ex.getAccountById(acct.perplAccountId());
        assertGt(a0.lockedBalanceCNS, 0);
        IPerplMin.PositionInfo memory p0 = _position(acct);
        CloseResult memory r = _close(100, BID * 99 / 100);
        assertEq(r.filledLots, 100);
        IPerplMin.AccountInfo memory a1 = ex.getAccountById(acct.perplAccountId());
        assertEq(a1.lockedBalanceCNS, 0, "own order cleared");
        uint256 fee = (BID * 100 * 345 + 1e6 - 1) / 1e6;
        assertEq(r.realizedCNS, int256(p0.depositCNS) + (int256(BID) - int256(p0.pricePNS)) * 100 - int256(fee));
    }

    function test_closeForCover_feeTier() public {
        _openLong(acct, 100);
        ex.setFeeTier(acct.perplAccountId(), 3);
        assertEq(_close(100, BID * 99 / 100).takerFeePpm, 210);
    }

    function test_closeForCover_venueErrorBubbles() public {
        _openLong(acct, 100);
        ex.setHalted(true);
        vm.expectRevert(IPerplErrors.ExchangeHalted.selector);
        _close(100, BID);
    }

    function test_closeForCover_shortSide() public {
        _openShort(acct, 100);
        IPerplMin.PositionInfo memory p0 = _position(acct);
        uint256 bal0 = _perplBalance(acct);
        CloseResult memory r = stub.close(address(acct), BTC, false, 100, ASK * 101 / 100, 32);
        assertEq(r.filledLots, 100);
        assertEq(r.entryPNS, p0.pricePNS);
        assertEq(r.realizedCNS, int256(_perplBalance(acct)) - int256(bal0));
    }

    function _refreshRefs() internal {
        ex.setMark(BTC, BID);
        ex.setOracle(BTC, BID);
    }

    // creditToPerpl

    function test_creditToPerpl_deposits() public {
        uint256 bal0 = _perplBalance(acct);
        ausd.mint(address(acct), 3e6);
        vm.expectEmit(address(acct));
        emit IGaplessAccount.Credited(3e6, true);
        stub.credit(address(acct), 3e6);
        assertEq(_perplBalance(acct), bal0 + 3e6);
        assertEq(ausd.allowance(address(acct), address(ex)), 0);
    }

    function test_creditToPerpl_onlyManager() public {
        vm.prank(owner);
        vm.expectRevert(IGaplessAccount.NotManager.selector);
        acct.creditToPerpl(1);
    }

    function test_creditToPerpl_inactiveKeepsWallet() public {
        GaplessAccount a = _account(makeAddr("inactive"), 0, _noGrant());
        ausd.mint(address(a), 3e6);
        vm.expectEmit(address(a));
        emit IGaplessAccount.Credited(3e6, false);
        stub.credit(address(a), 3e6);
        assertEq(ausd.balanceOf(address(a)), 3e6);
    }

    function test_creditToPerpl_perplFailureKeepsWallet() public {
        ausd.mint(address(acct), 3e6);
        ex.setHalted(true);
        stub.credit(address(acct), 3e6);
        assertEq(ausd.balanceOf(address(acct)), 3e6);
        ex.setHalted(false);
        ausd.freeze(address(acct));
        stub.credit(address(acct), 3e6);
        assertEq(ausd.balanceOf(address(acct)), 3e6, "frozen AUSD stays put, no revert");
        assertEq(ausd.allowance(address(acct), address(ex)), 0);
    }

    function test_creditToPerpl_clampsToWallet() public {
        ausd.mint(address(acct), 1e6);
        vm.expectEmit(address(acct));
        emit IGaplessAccount.Credited(1e6, true);
        stub.credit(address(acct), 5e6);
    }

    // Fuzz: operator scope

    function testFuzz_operatorNotionalBoundary(uint128 cap, uint40 lots, uint32 px, bool isBid) public {
        lots = uint40(bound(lots, 1, 1e9));
        uint256 mark = ex.getPerpetualInfo(BTC).markPNS;
        px = uint32(bound(px, mark * 95 / 100 + 1, mark * 105 / 100));
        vm.prank(owner);
        acct.setOperator(_grant(op, uint64(block.timestamp + 1), cap));
        uint256 notional = uint256(lots) * (px > mark ? px : mark);
        IPerplMin.OrderDesc memory d =
            _order(isBid ? Constants.ORDER_OPEN_LONG : Constants.ORDER_OPEN_SHORT, px, lots);
        d.postOnly = true; // rests or reverts without a fill so the check is isolated
        vm.prank(op);
        if (notional > cap) {
            vm.expectRevert(abi.encodeWithSelector(IGaplessAccount.NotionalCapExceeded.selector, notional, cap));
            acct.trade(d);
        } else {
            try acct.trade(d) {}
            catch (bytes memory err) {
                assertTrue(bytes4(err) != IGaplessAccount.NotionalCapExceeded.selector, "cap must pass");
                assertTrue(bytes4(err) != IGaplessAccount.LimitOffMarket.selector, "band must pass");
            }
        }
    }

    function testFuzz_operatorExpiry(uint64 exp, uint64 nowTs) public {
        exp = uint64(bound(exp, block.timestamp, type(uint40).max));
        nowTs = uint64(bound(nowTs, block.timestamp, type(uint40).max));
        vm.prank(owner);
        acct.setOperator(_grant(op, exp, type(uint128).max));
        vm.warp(nowTs);
        vm.prank(op);
        if (nowTs >= exp) {
            vm.expectRevert(abi.encodeWithSelector(IGaplessAccount.OperatorExpired.selector, exp));
            acct.cancelCover(bytes32(0));
        } else {
            vm.expectRevert(abi.encodeWithSelector(ICoverManager.NotCoverAccount.selector, bytes32(0)));
            acct.cancelCover(bytes32(0));
        }
    }

    // N-03: rolling operator budget

    function _budgeted(uint128 perTrade, uint128 perDay) internal {
        vm.prank(owner);
        acct.setOperator(OperatorGrant(op, uint64(block.timestamp + 3 days), perTrade, perDay));
    }

    function test_N03_budget_chargesOpensClosesAndChange() public {
        _budgeted(500e6, 100e6);
        _openLong(acct, 50); // owner: free
        (uint256 used,) = acct.operatorUsage();
        assertEq(used, 0);
        vm.prank(op);
        acct.trade(_order(Constants.ORDER_OPEN_LONG, ASK, 20)); // 20 x ASK
        vm.prank(op);
        acct.trade(_order(Constants.ORDER_CLOSE_LONG, BID * 99 / 100, 20)); // closes at max(limit, mark) = mark
        (used,) = acct.operatorUsage();
        assertEq(used, 20 * ASK + 20 * BID);
        IPerplMin.OrderDesc memory d = _order(Constants.ORDER_CHANGE, ASK, 80);
        uint256 left = 100e6 - used;
        vm.prank(op);
        vm.expectRevert(abi.encodeWithSelector(IGaplessAccount.OperatorBudgetExceeded.selector, ASK * 80, left));
        acct.trade(d);
    }

    function test_N03_budget_cancelAndCollateralFree_zeroBudgetBlocks() public {
        _budgeted(500e6, 0);
        IPerplMin.OrderDesc memory d = _order(Constants.ORDER_OPEN_LONG, ASK, 1);
        vm.prank(op);
        vm.expectRevert(abi.encodeWithSelector(IGaplessAccount.OperatorBudgetExceeded.selector, ASK, 0));
        acct.trade(d);
        d = _order(Constants.ORDER_INCREASE_COLLATERAL, 0, 0);
        d.amountCNS = 1;
        vm.prank(op);
        try acct.trade(d) {}
        catch (bytes memory err) {
            assertTrue(bytes4(err) != IGaplessAccount.OperatorBudgetExceeded.selector, "type 5 is not charged");
        }
        (, uint256 avail) = acct.operatorUsage();
        assertEq(avail, 0);
    }

    function test_N03_budget_decaysLinearly_andSurvivesGrantChange() public {
        _budgeted(500e6, 100e6);
        vm.prank(op);
        acct.trade(_order(Constants.ORDER_OPEN_LONG, ASK, 100)); // 86.175 AUSD
        uint256 charged = 100 * ASK;
        vm.warp(block.timestamp + 6 hours); // a quarter of the window: 25 AUSD decayed
        (uint256 used, uint256 avail) = acct.operatorUsage();
        assertEq(used, charged - 25e6);
        assertEq(avail, 100e6 - used);
        _budgeted(500e6, 100e6); // re-issuing the grant does not refill the bucket
        (uint256 used2,) = acct.operatorUsage();
        assertEq(used2, used);
        vm.prank(owner);
        acct.revokeOperator();
        uint256 avail2;
        (used2, avail2) = acct.operatorUsage(); // SA3-I4: decay so far is kept; no grant, so none available
        assertEq(used2, used);
        assertEq(avail2, 0);
        vm.warp(block.timestamp + 1 days);
        (used2,) = acct.operatorUsage();
        assertEq(used2, used, "nothing decays while revoked");
        _budgeted(500e6, 100e6);
        vm.warp(block.timestamp + 6 hours);
        (used2,) = acct.operatorUsage();
        assertEq(used2, used - 25e6, "decay resumes at the new grant's rate from the grant");
    }

    function test_N03_budget_operatorBuyCharged() public {
        _budgeted(500e6, 40e6);
        _openLong(acct, 50);
        CoverParams memory p = _coverParams(50, true); // 50 x 98% of BID ~ 42.2 AUSD notional
        vm.prank(op);
        vm.expectRevert(
            abi.encodeWithSelector(IGaplessAccount.OperatorBudgetExceeded.selector, 50 * p.stopPNS, 40e6)
        );
        acct.buyCover(p, 10e6);
        vm.prank(owner);
        acct.buyCover(p, 10e6); // owner is never charged
        (uint256 used,) = acct.operatorUsage();
        assertEq(used, 0);
    }
}
