// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {IERC4626} from "@openzeppelin/contracts/interfaces/IERC4626.sol";
import {IAccessControlDefaultAdminRules} from
    "@openzeppelin/contracts/access/extensions/IAccessControlDefaultAdminRules.sol";
import {VaultConfig, RedeemRequest, PayoutBlockCap} from "../types/GaplessTypes.sol";

/// @title ICoverVault
/// @notice AUSD ERC-4626 LP vault (decimalsOffset 6) with async redeem, per-market liability reserve and a
/// per-market per-block payout cap. Escrow and rent never sit in totalAssets until notifyPremium; deferred payouts
/// (owedTotal) are already subtracted from totalAssets.
/// @dev Sync exits disabled: withdraw/redeem revert AsyncOnly; maxWithdraw/maxRedeem return 0;
/// previewWithdraw/previewRedeem revert AsyncOnly (EIP-7540). Shares are non-transferable between users.
/// deposit/mint: receiver must equal msg.sender (lock griefing guard), sets lockUntil = block + DEPOSIT_LOCK_BLOCKS.
/// Constructor pulls Constants.VAULT_SEED_CNS from msg.sender (pre-approve the predicted address), mints to 0xdEaD.
/// Roles: DEFAULT_ADMIN (OZ default admin rules, 1 h delay; setManager once, bounded setConfig),
/// PAUSER_ROLE (deposits only, OZ Pausable: EnforcedPause(), events Paused/Unpaused).
/// deposit, mint, requestRedeem and claimRedeem revert Settling() while manager.isSettling().
interface ICoverVault is IERC4626, IAccessControlDefaultAdminRules {
    event ManagerSet(address manager, address factory);
    event ConfigSet(VaultConfig oldConfig, VaultConfig newConfig);
    event RedeemRequested(
        address indexed owner,
        uint256 indexed requestId,
        uint256 shares,
        uint256 assetsAtRequest,
        uint256 claimableBlock
    );
    event RedeemClaimed(
        address indexed owner, uint256 indexed requestId, address receiver, uint256 assets, uint256 shares
    );
    event Reserved(uint256 indexed perpId, uint256 amountCNS, uint256 reservedTotalCNS);
    event Released(uint256 indexed perpId, uint256 amountCNS, uint256 reservedTotalCNS);
    event Paid(uint256 indexed perpId, address indexed account, uint256 amountCNS);
    event PremiumReceived(uint256 amountCNS, uint256 toLpsCNS, uint256 toTreasuryCNS);
    event OwedUpdated(uint256 owedTotalCNS);

    error OnlyManager();
    error Settling();
    error AsyncOnly();
    error DepositLocked(uint256 untilBlock);
    error CooldownActive(uint256 readyBlock);
    error InsufficientFree(uint256 needCNS, uint256 freeCNS);
    error UtilizationExceeded(uint256 bpsAfter, uint256 maxBps);
    error MarketCapExceeded(uint256 perpId, uint256 reservedAfter, uint256 limit);
    error ReleaseExceedsReserved(uint256 perpId, uint256 amountCNS, uint256 reservedCNS);
    error NotAccount(address to);
    error NonTransferable();
    error BelowMinDeposit();
    error ThirdPartyDeposit();
    error NotRequestOwner(uint256 requestId);
    error ManagerAlreadySet();
    error ZeroAddress();
    error ConfigOutOfBounds(uint8 fieldIndex); // 0 treasury, 1 maxUtilizationBps, 2 protocolFeeBps, 3 minDepositCNS

    function PAUSER_ROLE() external view returns (bytes32);
    function COOLDOWN_BLOCKS() external view returns (uint256);
    function DEPOSIT_LOCK_BLOCKS() external view returns (uint256);
    function manager() external view returns (address);
    function factory() external view returns (address);
    function config() external view returns (VaultConfig memory);

    /// @notice Escrow `shares` in the vault; claimable after COOLDOWN_BLOCKS. Requires block >= lockUntil.
    function requestRedeem(uint256 shares) external returns (uint256 requestId);
    /// @notice Pays min(assetsAtRequest, convertToAssets(shares)) to `receiver` (nonzero), burns the shares.
    /// Reverts InsufficientFree when free liquidity is short (request stays open).
    function claimRedeem(uint256 requestId, address receiver) external returns (uint256 assets);
    function getRequest(uint256 requestId) external view returns (RedeemRequest memory);
    function requestIdsOf(address owner) external view returns (uint256[] memory);
    function nextRequestId() external view returns (uint256);

    /// @notice Manager only. Checks (reservedTotal + amt) <= grossAssets * maxUtilizationBps and
    /// (reserved[perpId] + amt) <= grossAssets * marketCapBps; grossAssets = totalAssets + owedTotal (L-08).
    function reserve(uint256 perpId, uint256 amountCNS, uint16 marketCapBps) external;
    /// @notice Manager only. Returns unused reservation.
    function release(uint256 perpId, uint256 amountCNS) external;
    /// @notice Manager only. Pays min(amount, per-block remaining, reserved[perpId]) to a factory-registered account
    /// and consumes the same reservation. Cap snapshot = grossAssets * perBlockCapBps / 1e4 at a block's first payout.
    function payCapped(uint256 perpId, address account, uint256 amountCNS, uint16 perBlockCapBps)
        external
        returns (uint256 paidCNS);
    /// @notice Manager only. AUSD already transferred in; protocolFeeBps goes to the treasury.
    function notifyPremium(uint256 amountCNS) external;
    /// @notice Manager only (L-08). A cover's deferred payout moved from `fromCNS` to `toCNS`; totalAssets nets it.
    function updateOwed(uint256 fromCNS, uint256 toCNS) external;
    /// @return Payouts owed by the manager but deferred (per-block cap or failed transfer); excluded from totalAssets.
    function owedTotal() external view returns (uint256);

    function reserved(uint256 perpId) external view returns (uint256);
    function reservedTotal() external view returns (uint256);
    /// @return grossAssets (totalAssets + owedTotal) - reservedTotal (0 if negative).
    function freeAssets() external view returns (uint256);
    function utilizationBps() external view returns (uint256);
    function lockUntil(address lp) external view returns (uint256);
    function blockPayout(uint256 perpId) external view returns (PayoutBlockCap memory);
    function paused() external view returns (bool);

    /// @notice DEFAULT_ADMIN, once. Reads factory from the manager (manager.setFactory must come first).
    function setManager(address manager_) external;
    function setConfig(VaultConfig calldata c) external;
    function pause() external;
    function unpause() external;
}
