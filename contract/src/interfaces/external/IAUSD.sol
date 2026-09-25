// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {IERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Permit.sol";
import {IERC5267} from "@openzeppelin/contracts/interfaces/IERC5267.sol";

/// @title IAUSD
/// @notice Agora Dollar surface used by Gapless (impl 0xc1e3...12da, verified source on Sourcify).
/// @dev Quirks: EIP-712 name is "Agora Dollar" (not name() = "AUSD"), version "1"; transfers to address(0)
/// succeed and credit balanceOf(0); a frozen sender or receiver reverts AccountIsFrozen; a frozen spender is
/// not checked in transferFrom; infinite allowance is not decremented; permit accepts EOA or ERC-1271 sigs.
interface IAUSD is IERC20Metadata, IERC20Permit, IERC5267 {
    error AccountIsFrozen(address frozenAccount);
    error TransferPaused();
    error SignatureVerificationPaused();
    error Erc2612ExpiredSignature(uint256 deadline);
    error Erc2612InvalidSignature();

    function isAccountFrozen(address account) external view returns (bool);
    function isTransferPaused() external view returns (bool);
}
