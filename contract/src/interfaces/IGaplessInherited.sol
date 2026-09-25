// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

/// @title IGaplessInherited
/// @notice ABI-only: errors and events the Gapless contracts inherit from OpenZeppelin 5.6.1 and that the
/// interface ABIs cannot redeclare (OZ Pausable events clash). Offchain decoders merge this with the
/// interface ABIs; no contract implements it. Perpl errors bubbling out of trades are in IPerplErrors.
interface IGaplessInherited {
    // Pausable (CoverManager buys, CoverVault deposits)
    event Paused(address account);
    event Unpaused(address account);

    error EnforcedPause();
    error ExpectedPause();

    // ReentrancyGuardTransient (manager, vault, account, factory, CRE receiver)
    error ReentrancyGuardReentrantCall();

    // SafeERC20
    error SafeERC20FailedOperation(address token);
    error SafeERC20FailedDecreaseAllowance(address spender, uint256 currentAllowance, uint256 requestedDecrease);

    // ERC4626 and ERC20 (CoverVault shares)
    error ERC4626ExceededMaxDeposit(address receiver, uint256 assets, uint256 max);
    error ERC4626ExceededMaxMint(address receiver, uint256 shares, uint256 max);
    error ERC4626ExceededMaxWithdraw(address owner, uint256 assets, uint256 max);
    error ERC4626ExceededMaxRedeem(address owner, uint256 shares, uint256 max);
    error ERC20InsufficientBalance(address sender, uint256 balance, uint256 needed);
    error ERC20InvalidSender(address sender);
    error ERC20InvalidReceiver(address receiver);
    error ERC20InsufficientAllowance(address spender, uint256 allowance, uint256 needed);
    error ERC20InvalidApprover(address approver);
    error ERC20InvalidSpender(address spender);

    // SafeCast (packing into Cover and Quote fields)
    error SafeCastOverflowedUintDowncast(uint8 bits, uint256 value);
    error SafeCastOverflowedIntToUint(int256 value);
    error SafeCastOverflowedUintToInt(uint256 value);
    error SafeCastOverflowedIntDowncast(uint8 bits, int256 value);

    // Clones, ECDSA, Address
    error FailedDeployment();
    error FailedCall();
    error InsufficientBalance(uint256 balance, uint256 needed);
    error ECDSAInvalidSignature();
    error ECDSAInvalidSignatureLength(uint256 length);
    error ECDSAInvalidSignatureS(bytes32 s);
}
