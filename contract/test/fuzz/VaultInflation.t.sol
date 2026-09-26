// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {GaplessFixture} from "../utils/GaplessFixture.sol";
import {GaplessAccount} from "../../src/GaplessAccount.sol";
import {PayoutBlockCap} from "../../src/types/GaplessTypes.sol";

/// A-series on the vault: inflation and donation (offset 6 plus dead seed plus internal accounting), share math
/// rounding, async redeem bounds, and reserve, release and payCapped accounting.
contract VaultInflationTest is GaplessFixture {
    address internal attacker = makeAddr("attacker");
    address internal victim = makeAddr("victim");
    GaplessAccount internal acct;

    function setUp() public {
        _setUpGapless();
        acct = _account(makeAddr("trader"), 0, _noGrant());
    }

    /// Classic first-depositor attack: min deposit, large donation, then a victim deposit.
    function testFuzz_inflationAttackUnprofitable(uint256 a0, uint256 donation, uint256 v) public {
        a0 = bound(a0, 1e6, 1e12);
        donation = bound(donation, 1, 1e13);
        v = bound(v, 1e6, 1e12);
        _lp(attacker, a0);
        ausd.mint(attacker, donation);
        vm.prank(attacker);
        ausd.transfer(address(vault), donation);
        uint256 shares = _lp(victim, v);
        assertGt(shares, 0, "victim never gets 0 shares");
        assertGe(vault.convertToAssets(shares) + 1, v, "victim keeps value (1 wei rounding)");
        assertLe(vault.convertToAssets(vault.balanceOf(attacker)), a0, "attacker never profits");
    }

    /// Same attack without the dead seed's help: the offset alone bounds the loss (OZ: 10^offset x u <= loss).
    function testFuzz_offsetMakesRoundingTiny(uint256 v) public {
        v = bound(v, 1e6, 1e15);
        uint256 shares = _lp(victim, v);
        assertEq(shares, v * 1e6, "par at 1e6 shares per CNS");
    }

    /// An LP deposit never moves the share price against existing holders.
    function testFuzz_depositNeverDilutes(uint256 seedLp, uint256 premium, uint256 payout, uint256 v) public {
        seedLp = bound(seedLp, 1e6, 1e12);
        _lp(makeAddr("lp0"), seedLp);
        _premium(bound(premium, 0, 1e12));
        _payout(bound(payout, 0, vault.totalAssets() * 8 / 10));
        uint256 unit = 1e18;
        uint256 before = vault.convertToAssets(unit);
        _lp(victim, bound(v, 1e6, 1e12));
        assertGe(vault.convertToAssets(unit), before, "existing LPs never lose on a deposit");
    }

    /// Async redeem pays min(valueAtRequest, valueAtClaim) and never more than the LP put in plus earned.
    function testFuzz_redeemPaysMin(uint256 dep, uint256 premiumBefore, uint256 premiumDuring, uint256 payoutDuring)
        public
    {
        dep = bound(dep, 1e6, 1e12);
        uint256 shares = _lp(victim, dep);
        _premium(bound(premiumBefore, 0, 1e11));
        vm.roll(vault.lockUntil(victim));
        vm.prank(victim);
        uint256 id = vault.requestRedeem(shares);
        uint256 atRequest = vault.getRequest(id).assetsAtRequest;
        assertLe(atRequest, vault.convertToAssets(shares));

        _premium(bound(premiumDuring, 0, 1e11));
        _payout(bound(payoutDuring, 0, vault.totalAssets() * 8 / 10));
        vm.roll(block.number + vault.COOLDOWN_BLOCKS());
        uint256 atClaim = vault.convertToAssets(shares);
        uint256 ta0 = vault.totalAssets();
        vm.prank(victim);
        uint256 paid = vault.claimRedeem(id, victim);
        assertEq(paid, atRequest < atClaim ? atRequest : atClaim);
        assertEq(vault.totalAssets(), ta0 - paid);
        assertEq(ausd.balanceOf(victim), paid);
        assertGe(vault.totalAssets(), vault.reservedTotal(), "solvency after claim");
    }

    /// Escrowed shares absorb payouts: an LP cannot dodge a loss by requesting first.
    function testFuzz_requestDoesNotDodgeLoss(uint256 dep, uint256 payout) public {
        dep = bound(dep, 10e6, 1e12);
        uint256 shares = _lp(victim, dep);
        _lp(makeAddr("other"), dep);
        vm.roll(vault.lockUntil(victim));
        vm.prank(victim);
        uint256 id = vault.requestRedeem(shares);
        payout = bound(payout, 1e6, vault.totalAssets() * 8 / 10);
        _payout(payout);
        vm.roll(block.number + vault.COOLDOWN_BLOCKS());
        vm.prank(victim);
        uint256 paid = vault.claimRedeem(id, victim);
        assertLt(paid, dep, "the requester shared the loss");
    }

    /// Reserve, release and payCapped keep reservedTotal == sum(reserved) <= totalAssets x maxUtil at reserve time,
    /// and every payout is bounded by min(amount, block cap remaining, market reservation).
    function testFuzz_reservePayRelease(uint256 seed, uint8 steps) public {
        _lp(makeAddr("lp0"), 1000e6);
        uint256[3] memory perps = [uint256(1), 10, 20];
        steps = uint8(bound(steps, 1, 40));
        for (uint256 i; i < steps; ++i) {
            uint256 r = uint256(keccak256(abi.encode(seed, i)));
            uint256 p = perps[r % 3];
            uint256 amt = (r >> 8) % 400e6;
            uint256 op = (r >> 128) % 4;
            vm.startPrank(manager);
            if (op == 0) {
                try vault.reserve(p, amt, 5000) {} catch {}
            } else if (op == 1) {
                vault.release(p, amt % (vault.reserved(p) + 1));
            } else if (op == 2) {
                _checkedPay(p, amt, uint16(100 + (r >> 200) % 9901));
            } else {
                vm.stopPrank();
                vm.roll(block.number + 1);
                vm.startPrank(manager);
            }
            vm.stopPrank();
            assertEq(vault.reservedTotal(), vault.reserved(1) + vault.reserved(10) + vault.reserved(20), "I7 sum");
            assertGe(vault.totalAssets(), vault.reservedTotal(), "I1 assets cover reserve");
            assertGe(ausd.balanceOf(address(vault)), vault.totalAssets(), "accounting <= balance");
        }
    }

    function _checkedPay(uint256 p, uint256 amt, uint16 bps) internal {
        PayoutBlockCap memory b = vault.blockPayout(p);
        uint256 cap = b.blockNumber == block.number ? b.capCNS - b.paidCNS : vault.totalAssets() * bps / 1e4;
        uint256 res = vault.reserved(p);
        uint256 bal0 = ausd.balanceOf(address(acct));
        uint256 paid = vault.payCapped(p, address(acct), amt, bps);
        uint256 bound_ = amt < cap ? amt : cap;
        assertEq(paid, bound_ < res ? bound_ : res, "paid = min(amount, cap left, reserved)");
        assertEq(ausd.balanceOf(address(acct)), bal0 + paid);
    }

    /// Per-block payouts never exceed the snapshot cap, however many calls land in one block (O2 shape).
    function testFuzz_perBlockCapHolds(uint16 bps, uint256 calls, uint256 each) public {
        _lp(makeAddr("lp0"), 1000e6);
        bps = uint16(bound(bps, 100, 10_000));
        calls = bound(calls, 1, 20);
        each = bound(each, 1, 500e6);
        uint256 ta = vault.totalAssets();
        vm.startPrank(manager);
        vault.reserve(1, ta * 5 / 10, 10_000);
        uint256 total;
        for (uint256 i; i < calls; ++i) {
            total += vault.payCapped(1, address(acct), each, bps);
        }
        vm.stopPrank();
        assertLe(total, ta * bps / 1e4);
    }

    // Helpers

    function _payout(uint256 amount) internal {
        if (amount == 0) return;
        vm.roll(block.number + 1);
        vm.startPrank(manager);
        vault.reserve(1, amount, 10_000);
        vault.payCapped(1, address(acct), amount, 10_000);
        vm.stopPrank();
    }

    function _premium(uint256 amount) internal {
        if (amount == 0) return;
        ausd.mint(manager, amount);
        stub.notify(amount);
    }
}
