// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {IERC5267} from "@openzeppelin/contracts/interfaces/IERC5267.sol";
import {OperatorGrant} from "../types/GaplessTypes.sol";

/// @title IGaplessFactory
/// @notice Deploys one GaplessAccount clone per owner (CREATE2, salt = keccak256(abi.encode(owner))) and is the
/// registry every payout and refund recipient is checked against (D13).
/// @dev No admin after deploy. The constructor deploys the account implementation, so IMPL.FACTORY() == this.
/// EIP-712 domain: name "GaplessFactory", version "1".
interface IGaplessFactory is IERC5267 {
    event AccountCreated(address indexed owner, address indexed account, address operator);

    error AccountAlreadyExists(address account);
    error SigExpired();
    error BadSig();
    error ZeroAddress();

    /// @notice Account implementation that every clone delegates to.
    function IMPL() external view returns (address);
    function MANAGER() external view returns (address);
    function AUSD() external view returns (address);

    /// @notice keccak256("CreateAccount(address owner,address key,uint64 expiry,uint128 maxNotional,uint128 maxNotionalPerDay,uint256 deadline)")
    function CREATE_ACCOUNT_TYPEHASH() external view returns (bytes32);
    function DOMAIN_SEPARATOR() external view returns (bytes32);

    /// @notice Counterfactual clone address for `owner`; valid before deployment (deposit address).
    function accountOf(address owner) external view returns (address predicted);
    /// @notice True only for clones deployed by this factory.
    function isAccount(address account) external view returns (bool);

    /// @notice Deploy the caller's account. Pulls `depositCNS` AUSD from the caller (approve the factory first)
    /// into the clone and opens the Perpl account if the clone's wallet AUSD >= getMinAccountOpenCNS().
    /// @param depositCNS AUSD to pull, may be 0.
    /// @param grant Initial operator; key 0 for none.
    /// @return account The deployed clone.
    function createAccount(uint256 depositCNS, OperatorGrant calldata grant) external returns (address account);

    /// @notice Deploy `owner`'s account from a relayed owner signature. Anyone may submit; no funds move.
    /// @param ownerSig EIP-712 CreateAccount signature (EOA or ERC-1271).
    function createAccountFor(address owner, OperatorGrant calldata grant, uint256 deadline, bytes calldata ownerSig)
        external
        returns (address account);
}
