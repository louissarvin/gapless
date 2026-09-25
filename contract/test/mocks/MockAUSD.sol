// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";
import {IERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Permit.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";
import {IAUSD} from "../../src/interfaces/external/IAUSD.sol";

/// @title MockAUSD
/// @notice Test double of Agora Dollar on Monad, mirroring the verified implementation (Erc20Core, Erc2612).
/// @dev Reproduced quirks: name() "AUSD" but EIP-712 name "Agora Dollar" v"1"; 6 decimals; transfer to
/// address(0) succeeds and credits balanceOf(0) (mainnet balanceOf(0) > 0); frozen sender or receiver reverts
/// AccountIsFrozen, frozen spender is not checked; transfer pause reverts TransferPaused; infinite allowance is
/// not decremented; permit takes EOA or ERC-1271 signatures and consumes the nonce before verifying.
/// Admin hooks (mint, freeze, pause) are unrestricted: this is a test double.
contract MockAUSD is IAUSD, IERC20Errors, EIP712 {
    string public constant override name = "AUSD";
    string public constant override symbol = "AUSD";
    uint8 public constant override decimals = 6;
    bytes32 public constant PERMIT_TYPEHASH =
        keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)");

    uint256 public override totalSupply;
    mapping(address => uint256) public override balanceOf;
    mapping(address => mapping(address => uint256)) public override allowance;
    mapping(address => uint256) public override nonces;
    mapping(address => bool) public override isAccountFrozen;
    bool public override isTransferPaused;
    bool public isSignatureVerificationPaused;

    constructor() EIP712("Agora Dollar", "1") {}

    // ERC-20

    function transfer(address to, uint256 value) external override returns (bool) {
        _transfer(msg.sender, to, value);
        return true;
    }

    function transferFrom(address from, address to, uint256 value) external override returns (bool) {
        uint256 current = allowance[from][msg.sender];
        if (current != type(uint256).max) {
            if (current < value) revert ERC20InsufficientAllowance(msg.sender, current, value);
            unchecked {
                allowance[from][msg.sender] = current - value;
            }
        }
        _transfer(from, to, value);
        return true;
    }

    function approve(address spender, uint256 value) external override returns (bool) {
        _approve(msg.sender, spender, value);
        return true;
    }

    // ERC-2612

    function permit(address owner, address spender, uint256 value, uint256 deadline, uint8 v, bytes32 r, bytes32 s)
        external
        override
    {
        permit(owner, spender, value, deadline, abi.encodePacked(r, s, v));
    }

    function permit(address owner, address spender, uint256 value, uint256 deadline, bytes memory signature) public {
        if (isSignatureVerificationPaused) revert SignatureVerificationPaused();
        if (block.timestamp > deadline) revert Erc2612ExpiredSignature(deadline);
        uint256 nonce = nonces[owner]++;
        bytes32 digest =
            _hashTypedDataV4(keccak256(abi.encode(PERMIT_TYPEHASH, owner, spender, value, nonce, deadline)));
        if (!SignatureChecker.isValidSignatureNow(owner, digest, signature)) revert Erc2612InvalidSignature();
        _approve(owner, spender, value);
    }

    function DOMAIN_SEPARATOR() external view override returns (bytes32) {
        return _domainSeparatorV4();
    }

    // Test hooks

    function mint(address to, uint256 value) external {
        totalSupply += value;
        balanceOf[to] += value;
        emit Transfer(address(0), to, value);
    }

    function batchFreeze(address[] calldata accounts) external {
        for (uint256 i; i < accounts.length; ++i) {
            isAccountFrozen[accounts[i]] = true;
        }
    }

    function batchUnfreeze(address[] calldata accounts) external {
        for (uint256 i; i < accounts.length; ++i) {
            isAccountFrozen[accounts[i]] = false;
        }
    }

    function freeze(address account) external {
        isAccountFrozen[account] = true;
    }

    function unfreeze(address account) external {
        isAccountFrozen[account] = false;
    }

    function setIsTransferPaused(bool paused) external {
        isTransferPaused = paused;
    }

    function setIsSignatureVerificationPaused(bool paused) external {
        isSignatureVerificationPaused = paused;
    }

    // Internal

    /// @dev Same order as Erc20Core._transfer: sender frozen, balance, then receiver frozen. No zero-address check.
    function _transfer(address from, address to, uint256 value) internal {
        if (isTransferPaused) revert TransferPaused();
        if (isAccountFrozen[from]) revert AccountIsFrozen(from);
        uint256 bal = balanceOf[from];
        if (bal < value) revert ERC20InsufficientBalance(from, bal, value);
        unchecked {
            balanceOf[from] = bal - value;
        }
        if (isAccountFrozen[to]) revert AccountIsFrozen(to);
        balanceOf[to] += value;
        emit Transfer(from, to, value);
    }

    function _approve(address owner, address spender, uint256 value) internal {
        allowance[owner][spender] = value;
        emit Approval(owner, spender, value);
    }
}
