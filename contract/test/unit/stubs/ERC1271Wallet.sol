// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {IERC1271} from "@openzeppelin/contracts/interfaces/IERC1271.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @notice Smart-wallet owner for ERC-1271 tests: valid iff `signer` signed the digest. `poke` lets a test
/// try state changes from inside isValidSignature (they must fail under staticcall).
contract ERC1271Wallet is IERC1271 {
    address public immutable signer;
    bool public tryReenter;
    address public target;
    bytes public reenterData;
    uint256 public pokes;

    constructor(address signer_) {
        signer = signer_;
    }

    function setReenter(address target_, bytes calldata data) external {
        tryReenter = true;
        target = target_;
        reenterData = data;
    }

    function isValidSignature(bytes32 hash, bytes memory sig) external view returns (bytes4) {
        if (tryReenter) {
            // Runs under staticcall from SignatureChecker: any state change reverts.
            (bool ok,) = target.staticcall(reenterData);
            ok;
        }
        (address rec, ECDSA.RecoverError err,) = ECDSA.tryRecover(hash, sig);
        return err == ECDSA.RecoverError.NoError && rec == signer ? IERC1271.isValidSignature.selector : bytes4(0);
    }

    function approve(IERC20 token, address spender, uint256 amount) external {
        token.approve(spender, amount);
    }

    function call(address to, bytes calldata data) external returns (bytes memory) {
        (bool ok, bytes memory ret) = to.call(data);
        require(ok, "call failed");
        return ret;
    }
}
