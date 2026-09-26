// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {IERC20Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";
import {GaplessFixture} from "../utils/GaplessFixture.sol";
import {GaplessFactory} from "../../src/GaplessFactory.sol";
import {GaplessAccount} from "../../src/GaplessAccount.sol";
import {IGaplessFactory} from "../../src/interfaces/IGaplessFactory.sol";
import {IGaplessAccount} from "../../src/interfaces/IGaplessAccount.sol";
import {IPerplErrors} from "../../src/interfaces/perpl/IPerplErrors.sol";
import {OperatorGrant} from "../../src/types/GaplessTypes.sol";
import {Constants} from "../../src/Constants.sol";
import {ERC1271Wallet} from "./stubs/ERC1271Wallet.sol";

contract GaplessFactoryTest is GaplessFixture {
    address internal alice;
    uint256 internal alicePk;
    address internal relay = makeAddr("relay");
    address internal opKey = makeAddr("opKey");

    function setUp() public {
        _setUpGapless();
        (alice, alicePk) = makeAddrAndKey("alice");
    }

    function _createSig(uint256 pk, address owner_, OperatorGrant memory g, uint256 deadline)
        internal
        view
        returns (bytes memory)
    {
        return _sign(
            pk,
            factory.DOMAIN_SEPARATOR(),
            keccak256(
                abi.encode(
                    Constants.CREATE_ACCOUNT_TYPEHASH,
                    owner_,
                    g.key,
                    g.expiry,
                    g.maxNotionalPerTradeCNS,
                    g.maxNotionalPerDayCNS,
                    deadline
                )
            )
        );
    }

    // Wiring

    function test_wiring() public view {
        assertEq(factory.MANAGER(), manager);
        assertEq(factory.AUSD(), address(ausd));
        assertEq(factory.CREATE_ACCOUNT_TYPEHASH(), Constants.CREATE_ACCOUNT_TYPEHASH);
        assertEq(GaplessAccount(factory.IMPL()).FACTORY(), address(factory));
        assertEq(factory.DOMAIN_SEPARATOR(), _domain("GaplessFactory", address(factory)));
        (, string memory name, string memory version, uint256 chainId, address verifying,,) = factory.eip712Domain();
        assertEq(name, "GaplessFactory");
        assertEq(version, "1");
        assertEq(chainId, 143);
        assertEq(verifying, address(factory));
        assertFalse(factory.isAccount(factory.IMPL()), "implementation is not an account");
    }

    function test_constructor_revertsZero() public {
        vm.expectRevert(IGaplessFactory.ZeroAddress.selector);
        new GaplessFactory(address(0), address(ausd), manager, address(vault), 0);
        vm.expectRevert(IGaplessFactory.ZeroAddress.selector);
        new GaplessFactory(address(ex), address(ausd), address(0), address(vault), 0);
    }

    // createAccount

    function test_createAccount_predictedAndRegistered() public {
        address predicted = factory.accountOf(alice);
        assertEq(
            predicted,
            Clones.predictDeterministicAddress(factory.IMPL(), keccak256(abi.encode(alice)), address(factory))
        );
        assertFalse(factory.isAccount(predicted));
        OperatorGrant memory g = _grant(opKey, uint64(block.timestamp + 1 days), 500e6);
        ausd.mint(alice, 50e6);
        vm.startPrank(alice);
        ausd.approve(address(factory), 50e6);
        vm.expectEmit(address(factory));
        emit IGaplessFactory.AccountCreated(alice, predicted, opKey);
        address a = factory.createAccount(50e6, g);
        vm.stopPrank();
        assertEq(a, predicted);
        assertTrue(factory.isAccount(a));
        assertEq(GaplessAccount(a).owner(), alice);
        assertEq(GaplessAccount(a).operator().key, opKey);
        assertGt(GaplessAccount(a).perplAccountId(), 0, "activated in the same tx");
        assertEq(ex.getAccountById(GaplessAccount(a).perplAccountId()).balanceCNS, 50e6);
    }

    function test_createAccount_zeroDepositNoOperator() public {
        vm.prank(alice);
        address a = factory.createAccount(0, _noGrant());
        assertEq(GaplessAccount(a).perplAccountId(), 0);
        assertEq(GaplessAccount(a).operator().key, address(0));
    }

    function test_createAccount_sweepsPrefundedCounterfactual() public {
        address predicted = factory.accountOf(alice);
        ausd.mint(predicted, 12e6); // deposit address funded before deployment
        vm.prank(alice);
        address a = factory.createAccount(0, _noGrant());
        assertEq(ex.getAccountById(GaplessAccount(a).perplAccountId()).balanceCNS, 12e6);
    }

    function test_createAccount_twiceReverts() public {
        vm.prank(alice);
        address a = factory.createAccount(0, _noGrant());
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IGaplessFactory.AccountAlreadyExists.selector, a));
        factory.createAccount(0, _noGrant());
    }

    function test_createAccount_depositWithoutApprovalReverts() public {
        ausd.mint(alice, 50e6);
        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(IERC20Errors.ERC20InsufficientAllowance.selector, address(factory), 0, 50e6)
        );
        factory.createAccount(50e6, _noGrant());
    }

    function test_createAccount_perplFailureIsAtomic() public {
        ex.setWhitelistingEnabled(true);
        ausd.mint(alice, 50e6);
        vm.startPrank(alice);
        ausd.approve(address(factory), 50e6);
        address predicted = factory.accountOf(alice);
        vm.expectRevert(abi.encodeWithSelector(IPerplErrors.NotWhitelisted.selector, predicted));
        factory.createAccount(50e6, _noGrant());
        vm.stopPrank();
        assertFalse(factory.isAccount(predicted));
        assertEq(ausd.balanceOf(alice), 50e6);
    }

    // createAccountFor

    function test_createAccountFor_relayed() public {
        OperatorGrant memory g = _grant(opKey, uint64(block.timestamp + 1 days), 500e6);
        uint256 dl = block.timestamp + 1 hours;
        bytes memory sig = _createSig(alicePk, alice, g, dl);
        vm.prank(relay);
        address a = factory.createAccountFor(alice, g, dl, sig);
        assertEq(a, factory.accountOf(alice));
        assertEq(GaplessAccount(a).owner(), alice, "relay never becomes owner");
        assertEq(GaplessAccount(a).operator().key, opKey);
        assertEq(GaplessAccount(a).perplAccountId(), 0, "no funds move");
    }

    function test_createAccountFor_expired() public {
        uint256 dl = block.timestamp - 1;
        bytes memory sig = _createSig(alicePk, alice, _noGrant(), dl);
        vm.expectRevert(IGaplessFactory.SigExpired.selector);
        factory.createAccountFor(alice, _noGrant(), dl, sig);
    }

    function test_createAccountFor_tamperedGrant() public {
        OperatorGrant memory g = _grant(opKey, uint64(block.timestamp + 1 days), 500e6);
        uint256 dl = block.timestamp + 1 hours;
        bytes memory sig = _createSig(alicePk, alice, g, dl);
        g.key = relay; // relay swaps in its own operator key
        vm.expectRevert(IGaplessFactory.BadSig.selector);
        factory.createAccountFor(alice, g, dl, sig);
        g.key = opKey;
        g.maxNotionalPerTradeCNS = type(uint128).max;
        vm.expectRevert(IGaplessFactory.BadSig.selector);
        factory.createAccountFor(alice, g, dl, sig);
        g.maxNotionalPerTradeCNS = 500e6;
        g.maxNotionalPerDayCNS = 1; // N-03: the rolling budget is part of the signed grant
        vm.expectRevert(IGaplessFactory.BadSig.selector);
        factory.createAccountFor(alice, g, dl, sig);
    }

    function test_createAccountFor_wrongSigner() public {
        (, uint256 bobPk) = makeAddrAndKey("bob");
        uint256 dl = block.timestamp + 1 hours;
        bytes memory sig = _createSig(bobPk, alice, _noGrant(), dl);
        vm.expectRevert(IGaplessFactory.BadSig.selector);
        factory.createAccountFor(alice, _noGrant(), dl, sig);
    }

    function test_createAccountFor_zeroOwner() public {
        vm.expectRevert(IGaplessFactory.ZeroAddress.selector);
        factory.createAccountFor(address(0), _noGrant(), block.timestamp, "");
    }

    function test_createAccountFor_replayAfterCreate() public {
        uint256 dl = block.timestamp + 1 hours;
        bytes memory sig = _createSig(alicePk, alice, _noGrant(), dl);
        address a = factory.createAccountFor(alice, _noGrant(), dl, sig);
        vm.expectRevert(abi.encodeWithSelector(IGaplessFactory.AccountAlreadyExists.selector, a));
        factory.createAccountFor(alice, _noGrant(), dl, sig);
    }

    function test_createAccountFor_wrongChain() public {
        uint256 dl = block.timestamp + 1 hours;
        bytes memory sig = _createSig(alicePk, alice, _noGrant(), dl);
        vm.chainId(10_143);
        vm.expectRevert(IGaplessFactory.BadSig.selector);
        factory.createAccountFor(alice, _noGrant(), dl, sig);
    }

    function test_createAccountFor_erc1271Owner() public {
        (address signer, uint256 signerPk) = makeAddrAndKey("signer");
        ERC1271Wallet w = new ERC1271Wallet(signer);
        uint256 dl = block.timestamp + 1 hours;
        address a =
            factory.createAccountFor(address(w), _noGrant(), dl, _createSig(signerPk, address(w), _noGrant(), dl));
        assertEq(GaplessAccount(a).owner(), address(w));
    }

    function test_createAccountFor_erc1271ReentryIsStatic() public {
        (address signer, uint256 signerPk) = makeAddrAndKey("signer");
        ERC1271Wallet w = new ERC1271Wallet(signer);
        // A malicious wallet tries to re-enter the factory from isValidSignature; staticcall blocks state changes.
        w.setReenter(address(factory), abi.encodeCall(IGaplessFactory.createAccount, (0, _noGrant())));
        uint256 dl = block.timestamp + 1 hours;
        address a =
            factory.createAccountFor(address(w), _noGrant(), dl, _createSig(signerPk, address(w), _noGrant(), dl));
        assertEq(GaplessAccount(a).owner(), address(w));
        assertFalse(factory.isAccount(factory.accountOf(address(factory))));
    }

    // Front-running

    function test_frontRun_createForWithSameSigIsHarmless() public {
        OperatorGrant memory g = _grant(opKey, uint64(block.timestamp + 1 days), 500e6);
        uint256 dl = block.timestamp + 1 hours;
        bytes memory sig = _createSig(alicePk, alice, g, dl);
        address attacker = makeAddr("attacker");
        vm.prank(attacker);
        address a = factory.createAccountFor(alice, g, dl, sig);
        assertEq(GaplessAccount(a).owner(), alice);
        assertEq(GaplessAccount(a).operator().key, opKey, "attacker cannot change the grant");
    }

    function test_frontRun_attackerCannotTakeVictimAddress() public {
        address victimAccount = factory.accountOf(alice);
        address attacker = makeAddr("attacker");
        vm.prank(attacker);
        address a = factory.createAccount(0, _grant(attacker, type(uint64).max, type(uint128).max));
        assertTrue(a != victimAccount, "salt binds the address to msg.sender");
        vm.prank(alice);
        assertEq(factory.createAccount(0, _noGrant()), victimAccount);
        assertEq(GaplessAccount(victimAccount).operator().key, address(0));
    }

    function test_frontRun_directCloneOfImplIsNotRegistered() public {
        address rogue = Clones.cloneDeterministic(factory.IMPL(), keccak256(abi.encode(alice)));
        assertFalse(factory.isAccount(rogue), "only factory-made clones count (D13)");
        vm.expectRevert(IGaplessAccount.NotFactory.selector);
        GaplessAccount(rogue).initialize(alice, _noGrant());
    }

    function testFuzz_accountOfMatchesCreate(address who) public {
        vm.assume(who != address(0));
        address predicted = factory.accountOf(who);
        vm.prank(who);
        assertEq(factory.createAccount(0, _noGrant()), predicted);
        assertTrue(factory.isAccount(predicted));
    }
}
