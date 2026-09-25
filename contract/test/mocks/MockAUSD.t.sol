// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IERC1271} from "@openzeppelin/contracts/interfaces/IERC1271.sol";
import {IERC20Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {IAUSD} from "../../src/interfaces/external/IAUSD.sol";
import {Constants} from "../../src/Constants.sol";
import {MockAUSD} from "./MockAUSD.sol";

contract Wallet1271 is IERC1271 {
    address public immutable signer;

    constructor(address s) {
        signer = s;
    }

    function isValidSignature(bytes32 hash, bytes memory sig) external view returns (bytes4) {
        return ECDSA.recover(hash, sig) == signer ? IERC1271.isValidSignature.selector : bytes4(0xffffffff);
    }
}

/// Conformance of MockAUSD to AUSD on Monad (eth_call reads of 2026-10-05 and the verified implementation).
contract MockAUSDTest is Test {
    using SafeERC20 for IERC20;

    bytes32 internal constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 internal constant MAINNET_DOMAIN_SEPARATOR =
        0x995063441ebf2219c94dce05014a545da4390d2362f99b3d7ad456046678cafe;

    MockAUSD internal ausd;
    uint256 internal ownerKey = 0xA11CE;
    address internal owner;
    address internal spender = address(0xBEEF);

    function setUp() public {
        ausd = new MockAUSD();
        owner = vm.addr(ownerKey);
        ausd.mint(owner, 100e6);
    }

    function test_metadataDiffersFromEip712Name() public view {
        assertEq(ausd.name(), "AUSD");
        assertEq(ausd.symbol(), "AUSD");
        assertEq(ausd.decimals(), 6);
        (bytes1 fields, string memory n, string memory v, uint256 chainId, address vc,,) = ausd.eip712Domain();
        assertEq(fields, bytes1(0x0f));
        assertEq(n, "Agora Dollar");
        assertEq(v, "1");
        assertEq(chainId, block.chainid);
        assertEq(vc, address(ausd));
        assertEq(ausd.DOMAIN_SEPARATOR(), _separator("Agora Dollar", block.chainid, address(ausd)));
    }

    /// The formula reproduces the live mainnet DOMAIN_SEPARATOR read on 2026-10-05.
    function test_domainFormula_matchesMainnetSeparator() public pure {
        assertEq(_separator(Constants.AUSD_EIP712_NAME, Constants.CHAIN_ID, Constants.AUSD), MAINNET_DOMAIN_SEPARATOR);
        assertTrue(_separator("AUSD", Constants.CHAIN_ID, Constants.AUSD) != MAINNET_DOMAIN_SEPARATOR);
    }

    function test_permit_agoraDollarDomain() public {
        (uint8 v, bytes32 r, bytes32 s) = _signPermit(ausd.DOMAIN_SEPARATOR(), 5e6, 0, block.timestamp + 1);
        ausd.permit(owner, spender, 5e6, block.timestamp + 1, v, r, s);
        assertEq(ausd.allowance(owner, spender), 5e6);
        assertEq(ausd.nonces(owner), 1);
    }

    function test_permit_nameAusdDomainFails() public {
        bytes32 wrong = _separator("AUSD", block.chainid, address(ausd));
        (uint8 v, bytes32 r, bytes32 s) = _signPermit(wrong, 5e6, 0, block.timestamp + 1);
        vm.expectRevert(IAUSD.Erc2612InvalidSignature.selector);
        ausd.permit(owner, spender, 5e6, block.timestamp + 1, v, r, s);
    }

    function test_permit_expiredAndPaused() public {
        vm.warp(1000);
        (uint8 v, bytes32 r, bytes32 s) = _signPermit(ausd.DOMAIN_SEPARATOR(), 5e6, 0, 999);
        vm.expectRevert(abi.encodeWithSelector(IAUSD.Erc2612ExpiredSignature.selector, 999));
        ausd.permit(owner, spender, 5e6, 999, v, r, s);
        ausd.setIsSignatureVerificationPaused(true);
        vm.expectRevert(IAUSD.SignatureVerificationPaused.selector);
        ausd.permit(owner, spender, 5e6, 2000, v, r, s);
    }

    function test_permit_erc1271Owner() public {
        Wallet1271 w = new Wallet1271(owner);
        bytes32 digest = keccak256(
            abi.encodePacked(
                "\x19\x01",
                ausd.DOMAIN_SEPARATOR(),
                keccak256(abi.encode(ausd.PERMIT_TYPEHASH(), address(w), spender, 1e6, 0, block.timestamp))
            )
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(ownerKey, digest);
        ausd.permit(address(w), spender, 1e6, block.timestamp, abi.encodePacked(r, s, v));
        assertEq(ausd.allowance(address(w), spender), 1e6);
    }

    function test_transferToZeroAddress_succeedsAndCredits() public {
        uint256 supply = ausd.totalSupply();
        vm.prank(owner);
        assertTrue(ausd.transfer(address(0), 1e6));
        assertEq(ausd.balanceOf(address(0)), 1e6, "credited, not burned");
        assertEq(ausd.totalSupply(), supply);
    }

    function test_frozenSenderAndReceiverRevert_frozenSpenderDoesNot() public {
        address other = address(0xCAFE);
        ausd.freeze(owner);
        assertTrue(ausd.isAccountFrozen(owner));
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(IAUSD.AccountIsFrozen.selector, owner));
        ausd.transfer(other, 1);
        ausd.unfreeze(owner);

        ausd.freeze(other);
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(IAUSD.AccountIsFrozen.selector, other));
        ausd.transfer(other, 1);
        ausd.unfreeze(other);

        vm.prank(owner);
        ausd.approve(spender, 10);
        ausd.freeze(spender);
        vm.prank(spender);
        ausd.transferFrom(owner, other, 10);
        assertEq(ausd.balanceOf(other), 10);
    }

    function test_transferPaused() public {
        ausd.setIsTransferPaused(true);
        vm.prank(owner);
        vm.expectRevert(IAUSD.TransferPaused.selector);
        ausd.transfer(spender, 1);
    }

    function test_allowanceSemantics() public {
        vm.prank(owner);
        ausd.approve(spender, type(uint256).max);
        vm.prank(spender);
        ausd.transferFrom(owner, spender, 1e6);
        assertEq(ausd.allowance(owner, spender), type(uint256).max, "infinite not decremented");

        vm.prank(owner);
        ausd.approve(spender, 3e6);
        vm.prank(owner);
        ausd.approve(spender, 2e6); // nonzero to nonzero works
        vm.prank(spender);
        ausd.transferFrom(owner, spender, 1e6);
        assertEq(ausd.allowance(owner, spender), 1e6);
        vm.prank(spender);
        vm.expectRevert(abi.encodeWithSelector(IERC20Errors.ERC20InsufficientAllowance.selector, spender, 1e6, 2e6));
        ausd.transferFrom(owner, spender, 2e6);
    }

    function test_safeErc20Compatible() public {
        IERC20 token = IERC20(address(ausd));
        vm.prank(owner);
        token.forceApprove(address(this), 4e6);
        token.safeTransferFrom(owner, address(this), 4e6);
        token.safeTransfer(spender, 1e6);
        assertEq(ausd.balanceOf(address(this)), 3e6);
        vm.expectRevert(abi.encodeWithSelector(IERC20Errors.ERC20InsufficientBalance.selector, address(this), 3e6, 5e6));
        this.externalSafeTransfer(spender, 5e6);
    }

    function externalSafeTransfer(address to, uint256 v) external {
        IERC20(address(ausd)).safeTransfer(to, v);
    }

    function _separator(string memory n, uint256 chainId, address vc) internal pure returns (bytes32) {
        return keccak256(abi.encode(DOMAIN_TYPEHASH, keccak256(bytes(n)), keccak256("1"), chainId, vc));
    }

    function _signPermit(bytes32 separator, uint256 value, uint256 nonce, uint256 deadline)
        internal
        view
        returns (uint8, bytes32, bytes32)
    {
        bytes32 structHash = keccak256(abi.encode(ausd.PERMIT_TYPEHASH(), owner, spender, value, nonce, deadline));
        return vm.sign(ownerKey, keccak256(abi.encodePacked("\x19\x01", separator, structHash)));
    }
}
