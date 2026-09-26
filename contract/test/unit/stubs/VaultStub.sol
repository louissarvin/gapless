// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {ICoverVault} from "../../../src/interfaces/ICoverVault.sol";
import {VaultConfig, PayoutBlockCap} from "../../../src/types/GaplessTypes.sol";

interface IIsAccount {
    function isAccount(address) external view returns (bool);
}

interface IIsSettling {
    function isSettling() external view returns (bool);
}

/// @notice S2 test double for the manager-facing ICoverVault surface (frozen semantics of section 5.5):
/// internal asset accounting, utilization and market caps, per-block payout cap, isAccount guard.
contract VaultStub {
    using SafeERC20 for IERC20;

    IERC20 public immutable asset;
    address public manager;
    IIsAccount public factory;
    uint256 public totalAssets;
    uint256 public reservedTotal;
    mapping(uint256 => uint256) public reserved;
    mapping(uint256 => PayoutBlockCap) internal _bp;
    VaultConfig internal _config;
    bool public payReverts;
    uint256 public premiumIn;
    uint256 public paidOut;
    bool public sawSettling;
    uint256 public owedTotal;

    constructor(IERC20 asset_, address factory_) {
        asset = asset_;
        factory = IIsAccount(factory_);
        _config = VaultConfig(address(0xBEEF), 8000, 1000, 1e6);
    }

    modifier onlyManager() {
        if (msg.sender != manager) revert ICoverVault.OnlyManager();
        _;
    }

    function setManager(address m) external {
        manager = m;
    }

    /// @notice LP deposit (test): pull AUSD and count it.
    function fund(uint256 amount) external {
        asset.safeTransferFrom(msg.sender, address(this), amount);
        totalAssets += amount;
    }

    function setPayReverts(bool r) external {
        payReverts = r;
    }

    function setTotalAssets(uint256 v) external {
        totalAssets = v;
    }

    function setMaxUtil(uint16 bps) external {
        _config.maxUtilizationBps = bps;
    }

    function config() external view returns (VaultConfig memory) {
        return _config;
    }

    function blockPayout(uint256 perpId) external view returns (PayoutBlockCap memory) {
        return _bp[perpId];
    }

    function reserve(uint256 perpId, uint256 amount, uint16 marketCapBps) external onlyManager {
        uint256 totalAfter = reservedTotal + amount;
        if (totalAfter * 1e4 > totalAssets * _config.maxUtilizationBps) {
            revert ICoverVault.UtilizationExceeded(totalAfter, _config.maxUtilizationBps);
        }
        uint256 mAfter = reserved[perpId] + amount;
        uint256 limit = totalAssets * marketCapBps / 1e4;
        if (mAfter > limit) revert ICoverVault.MarketCapExceeded(perpId, mAfter, limit);
        reserved[perpId] = mAfter;
        reservedTotal = totalAfter;
    }

    function release(uint256 perpId, uint256 amount) external onlyManager {
        if (amount > reserved[perpId]) revert ICoverVault.ReleaseExceedsReserved(perpId, amount, reserved[perpId]);
        reserved[perpId] -= amount;
        reservedTotal -= amount;
    }

    function payCapped(uint256 perpId, address account, uint256 amount, uint16 capBps)
        external
        onlyManager
        returns (uint256 paid)
    {
        if (payReverts) revert("pay");
        sawSettling = IIsSettling(manager).isSettling();
        if (account == address(0) || !factory.isAccount(account)) revert ICoverVault.NotAccount(account);
        PayoutBlockCap memory b = _bp[perpId];
        if (b.blockNumber != block.number) b = PayoutBlockCap(uint48(block.number), uint80(totalAssets * capBps / 1e4), 0);
        paid = Math.min(Math.min(amount, b.capCNS - b.paidCNS), reserved[perpId]);
        if (paid == 0) return 0;
        b.paidCNS += uint80(paid);
        _bp[perpId] = b;
        reserved[perpId] -= paid;
        reservedTotal -= paid;
        totalAssets -= paid;
        paidOut += paid;
        asset.safeTransfer(account, paid);
    }

    function updateOwed(uint256 fromCNS, uint256 toCNS) external onlyManager {
        owedTotal = owedTotal + toCNS - fromCNS;
    }

    function notifyPremium(uint256 amount) external onlyManager {
        totalAssets += amount;
        premiumIn += amount;
    }
}

/// @notice Registry double for factory.isAccount.
contract FactoryStub {
    mapping(address => bool) public isAccount;

    function register(address a) external {
        isAccount[a] = true;
    }
}
