// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {IGaplessFactory} from "./interfaces/IGaplessFactory.sol";
import {IGaplessAccount} from "./interfaces/IGaplessAccount.sol";
import {OperatorGrant} from "./types/GaplessTypes.sol";
import {GaplessAccount} from "./GaplessAccount.sol";
import {Constants} from "./Constants.sol";

/// @title GaplessFactory
/// @notice One GaplessAccount clone per owner (CREATE2, salt = keccak256(abi.encode(owner))) and the registry every
/// payout and refund recipient is checked against (D13).
/// @dev No admin. The salt binds the address to the owner and init runs in the deploying call, so a clone can be
/// neither front-run nor initialized by anyone but this factory.
contract GaplessFactory is IGaplessFactory, EIP712, ReentrancyGuardTransient {
    using SafeERC20 for IERC20;

    bytes32 public constant CREATE_ACCOUNT_TYPEHASH = Constants.CREATE_ACCOUNT_TYPEHASH;

    address public immutable IMPL;
    address public immutable MANAGER;
    address public immutable AUSD;

    mapping(address account => bool) public isAccount;

    /// @dev Deploys the account implementation so IMPL.FACTORY() == this (INTERFACES.md section 3).
    constructor(address ex, address ausd, address manager, address vault, uint8 builderId)
        EIP712(Constants.FACTORY_EIP712_NAME, Constants.EIP712_VERSION)
    {
        if (ex == address(0) || ausd == address(0) || manager == address(0) || vault == address(0)) {
            revert ZeroAddress();
        }
        MANAGER = manager;
        AUSD = ausd;
        IMPL = address(new GaplessAccount(ex, ausd, manager, vault, builderId));
    }

    /// @inheritdoc IGaplessFactory
    function createAccount(uint256 depositCNS, OperatorGrant calldata grant)
        external
        nonReentrant
        returns (address account)
    {
        account = _create(msg.sender, grant);
        if (depositCNS != 0) IERC20(AUSD).safeTransferFrom(msg.sender, account, depositCNS);
        IGaplessAccount(account).sweep();
    }

    /// @inheritdoc IGaplessFactory
    function createAccountFor(address owner, OperatorGrant calldata grant, uint256 deadline, bytes calldata ownerSig)
        external
        nonReentrant
        returns (address account)
    {
        if (owner == address(0)) revert ZeroAddress();
        if (block.timestamp > deadline) revert SigExpired();
        bytes32 digest = _hashTypedDataV4(
            keccak256(
                abi.encode(
                    CREATE_ACCOUNT_TYPEHASH,
                    owner,
                    grant.key,
                    grant.expiry,
                    grant.maxNotionalPerTradeCNS,
                    grant.maxNotionalPerDayCNS,
                    deadline
                )
            )
        );
        if (!SignatureChecker.isValidSignatureNowCalldata(owner, digest, ownerSig)) revert BadSig();
        account = _create(owner, grant);
    }

    /// @inheritdoc IGaplessFactory
    function accountOf(address owner) public view returns (address) {
        return Clones.predictDeterministicAddress(IMPL, _salt(owner));
    }

    function DOMAIN_SEPARATOR() external view returns (bytes32) {
        return _domainSeparatorV4();
    }

    function _create(address owner, OperatorGrant calldata grant) internal returns (address account) {
        if (owner == address(0)) revert ZeroAddress();
        bytes32 salt = _salt(owner);
        account = Clones.predictDeterministicAddress(IMPL, salt);
        if (isAccount[account]) revert AccountAlreadyExists(account);
        isAccount[account] = true;
        Clones.cloneDeterministic(IMPL, salt);
        IGaplessAccount(account).initialize(owner, grant);
        emit AccountCreated(owner, account, grant.key);
    }

    function _salt(address owner) internal pure returns (bytes32) {
        return keccak256(abi.encode(owner));
    }
}
