// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Test, console2} from "forge-std/Test.sol";
import {GaplessFactory} from "gapless/GaplessFactory.sol";
import {IGaplessAccount} from "gapless/interfaces/IGaplessAccount.sol";
import {OperatorGrant} from "gapless/types/GaplessTypes.sol";
import {Constants} from "gapless/Constants.sol";

/// Pins the CreateAccount typehash, domain separator, digest and signature used in test/sponsor.test.ts.
contract CreateAccountParity is Test {
    uint256 constant PK = 0xa11ce;
    uint256 constant DEADLINE = 1_791_202_200;
    GaplessFactory f;

    function _digest(address owner, OperatorGrant memory g) internal view returns (bytes32 structHash, bytes32 digest) {
        structHash = keccak256(
            abi.encode(
                Constants.CREATE_ACCOUNT_TYPEHASH, owner, g.key, g.expiry, g.maxNotionalPerTradeCNS, g.maxNotionalPerDayCNS, DEADLINE
            )
        );
        digest = keccak256(abi.encodePacked("\x19\x01", f.DOMAIN_SEPARATOR(), structHash));
    }

    function test_createAccountDigest() public {
        vm.chainId(143);
        vm.warp(1_791_201_600); // 2026-10-05T12:00:00Z
        f = new GaplessFactory(address(0x1), address(0x2), address(0x3), address(0x4), 0);
        address owner = vm.addr(PK);
        OperatorGrant memory g = OperatorGrant(address(0xA1), 1_791_223_200, 25e6, 100e6);
        (bytes32 structHash, bytes32 digest) = _digest(owner, g);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(PK, digest);
        bytes memory sig = abi.encodePacked(r, s, v);
        address acct = f.createAccountFor(owner, g, DEADLINE, sig);
        assertTrue(f.isAccount(acct));
        assertEq(IGaplessAccount(acct).operator().maxNotionalPerDayCNS, 100e6);
        console2.log("factory", address(f));
        console2.log("owner", owner);
        console2.logBytes32(f.CREATE_ACCOUNT_TYPEHASH());
        console2.logBytes32(f.DOMAIN_SEPARATOR());
        console2.logBytes32(structHash);
        console2.logBytes32(digest);
        console2.logBytes(sig);
    }

    function test_tamperedDailyBudgetFails() public {
        vm.chainId(143);
        vm.warp(1_791_201_600);
        f = new GaplessFactory(address(0x1), address(0x2), address(0x3), address(0x4), 0);
        address owner = vm.addr(PK);
        (, bytes32 digest) = _digest(owner, OperatorGrant(address(0xA1), 1_791_223_200, 25e6, 100e6));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(PK, digest);
        OperatorGrant memory t = OperatorGrant(address(0xA1), 1_791_223_200, 25e6, 100e6 + 1);
        vm.expectRevert();
        f.createAccountFor(owner, t, DEADLINE, abi.encodePacked(r, s, v));
    }
}
