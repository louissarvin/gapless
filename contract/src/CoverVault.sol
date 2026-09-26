// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC4626} from "@openzeppelin/contracts/interfaces/IERC4626.sol";
import {ERC4626} from "@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {
    AccessControlDefaultAdminRules
} from "@openzeppelin/contracts/access/extensions/AccessControlDefaultAdminRules.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {ICoverVault} from "./interfaces/ICoverVault.sol";
import {ICoverManager} from "./interfaces/ICoverManager.sol";
import {IGaplessFactory} from "./interfaces/IGaplessFactory.sol";
import {VaultConfig, RedeemRequest, PayoutBlockCap} from "./types/GaplessTypes.sol";
import {Constants} from "./Constants.sol";

/// @title CoverVault
/// @notice AUSD LP vault backing Gapless covers: ERC-4626 entry, ERC-7540-style async exit, per-market liability
/// reserve and a per-market per-block payout cap.
/// @dev totalAssets is internal accounting net of deferred payouts (L-08), so donations never move the share price
/// and known liabilities always do. Escrow and rent stay in the manager until notifyPremium.
/// Invariant: totalAssets + owedTotal >= reservedTotal >= reserved[perpId] >= owed share of perpId.
contract CoverVault is ICoverVault, ERC4626, AccessControlDefaultAdminRules, Pausable, ReentrancyGuardTransient {
    using SafeERC20 for IERC20;
    using SafeCast for uint256;

    uint256 internal constant BPS = Constants.BPS;

    bytes32 public constant PAUSER_ROLE = Constants.PAUSER_ROLE;
    uint256 public constant COOLDOWN_BLOCKS = Constants.COOLDOWN_BLOCKS;
    uint256 public constant DEPOSIT_LOCK_BLOCKS = Constants.DEPOSIT_LOCK_BLOCKS;

    address public manager;
    address public factory;
    uint256 public reservedTotal;
    uint256 public nextRequestId = 1;
    uint256 public owedTotal;
    mapping(uint256 perpId => uint256) public reserved;
    mapping(address lp => uint256) public lockUntil;

    uint256 internal _assets;
    VaultConfig internal _config;
    mapping(uint256 perpId => PayoutBlockCap) internal _blockPayout;
    mapping(uint256 requestId => RedeemRequest) internal _requests;
    mapping(address owner => uint256[]) internal _requestIds;
    mapping(uint256 requestId => uint256) internal _requestIndex;

    modifier onlyManager() {
        if (msg.sender != manager) revert OnlyManager();
        _;
    }

    modifier notSettling() {
        _checkNotSettling();
        _;
    }

    /// @param ausd Underlying asset (6 decimals).
    /// @param admin Default admin (1 h transfer delay).
    /// @param cfg Initial config; bounded like setConfig.
    /// @dev Pulls VAULT_SEED_CNS from msg.sender (pre-approve the predicted address) and mints its shares to 0xdEaD.
    constructor(IERC20 ausd, address admin, VaultConfig memory cfg)
        ERC20("Gapless Cover Vault", "gcvAUSD")
        ERC4626(ausd)
        AccessControlDefaultAdminRules(Constants.ADMIN_DELAY, admin)
    {
        if (address(ausd) == address(0)) revert ZeroAddress();
        _setConfig(cfg);
        uint256 seed = Constants.VAULT_SEED_CNS;
        uint256 shares = _convertToShares(seed, Math.Rounding.Floor);
        _assets = seed;
        _mint(Constants.DEAD, shares);
        ausd.safeTransferFrom(msg.sender, address(this), seed);
        emit Deposit(msg.sender, Constants.DEAD, seed, shares);
    }

    // LP

    /// @notice Deposit `assets` for shares; `receiver` must be the caller. Locks the caller for DEPOSIT_LOCK_BLOCKS.
    function deposit(uint256 assets, address receiver)
        public
        override(IERC4626, ERC4626)
        nonReentrant
        whenNotPaused
        notSettling
        returns (uint256)
    {
        if (receiver != msg.sender) revert ThirdPartyDeposit();
        if (assets < _config.minDepositCNS) revert BelowMinDeposit();
        return super.deposit(assets, receiver);
    }

    /// @notice Mint `shares` (assets rounded up); `receiver` must be the caller.
    function mint(uint256 shares, address receiver)
        public
        override(IERC4626, ERC4626)
        nonReentrant
        whenNotPaused
        notSettling
        returns (uint256)
    {
        if (receiver != msg.sender) revert ThirdPartyDeposit();
        if (previewMint(shares) < _config.minDepositCNS) revert BelowMinDeposit();
        return super.mint(shares, receiver);
    }

    /// @inheritdoc ICoverVault
    function requestRedeem(uint256 shares) external nonReentrant notSettling returns (uint256 requestId) {
        uint256 until = lockUntil[msg.sender];
        if (block.number < until) revert DepositLocked(until);
        uint256 bal = balanceOf(msg.sender);
        if (shares == 0 || shares > bal) revert ERC4626ExceededMaxRedeem(msg.sender, shares, bal);

        // Floor: the snapshot caps what the LP can ever claim.
        uint256 assets = _convertToAssets(shares, Math.Rounding.Floor);
        uint256 claimable = block.number + COOLDOWN_BLOCKS;
        requestId = nextRequestId++;
        _requests[requestId] = RedeemRequest(msg.sender, shares.toUint96(), assets.toUint80(), claimable.toUint48());
        _requestIndex[requestId] = _requestIds[msg.sender].length;
        _requestIds[msg.sender].push(requestId);
        // Escrow bypasses the non-transferable hook; escrowed shares keep absorbing payouts.
        ERC20._update(msg.sender, address(this), shares);
        emit RedeemRequested(msg.sender, requestId, shares, assets, claimable);
    }

    /// @inheritdoc ICoverVault
    function claimRedeem(uint256 requestId, address receiver)
        external
        nonReentrant
        notSettling
        returns (uint256 assets)
    {
        if (receiver == address(0)) revert ZeroAddress();
        RedeemRequest memory r = _requests[requestId];
        if (r.owner != msg.sender) revert NotRequestOwner(requestId);
        if (block.number < r.claimableBlock) revert CooldownActive(r.claimableBlock);

        // min(valueAtRequest, valueAtClaim): losses during cooldown are shared, gains stay with remaining LPs.
        assets = Math.min(r.assetsAtRequest, _convertToAssets(r.shares, Math.Rounding.Floor));
        uint256 free = freeAssets();
        if (assets > free) revert InsufficientFree(assets, free);

        _removeRequest(msg.sender, requestId);
        _assets -= assets;
        _burn(address(this), r.shares);
        IERC20(asset()).safeTransfer(receiver, assets);
        emit RedeemClaimed(msg.sender, requestId, receiver, assets, r.shares);
    }

    // Manager

    /// @inheritdoc ICoverVault
    function reserve(uint256 perpId, uint256 amountCNS, uint16 marketCapBps) external onlyManager nonReentrant {
        uint256 ta = _assets;
        uint256 totalAfter = reservedTotal + amountCNS;
        uint256 maxU = _config.maxUtilizationBps;
        if (totalAfter * BPS > ta * maxU) revert UtilizationExceeded(_bpsCeil(totalAfter, ta), maxU);
        uint256 marketAfter = reserved[perpId] + amountCNS;
        uint256 limit = ta * Math.min(marketCapBps, BPS) / BPS;
        if (marketAfter > limit) revert MarketCapExceeded(perpId, marketAfter, limit);

        reserved[perpId] = marketAfter;
        reservedTotal = totalAfter;
        emit Reserved(perpId, amountCNS, totalAfter);
    }

    /// @inheritdoc ICoverVault
    function release(uint256 perpId, uint256 amountCNS) external onlyManager nonReentrant {
        uint256 r = reserved[perpId];
        if (amountCNS > r) revert ReleaseExceedsReserved(perpId, amountCNS, r);
        reserved[perpId] = r - amountCNS;
        reservedTotal -= amountCNS;
        emit Released(perpId, amountCNS, reservedTotal);
    }

    /// @inheritdoc ICoverVault
    function payCapped(uint256 perpId, address account, uint256 amountCNS, uint16 perBlockCapBps)
        external
        onlyManager
        nonReentrant
        returns (uint256 paidCNS)
    {
        // D13: AUSD to address(0) credits balanceOf(0), so only registered clones are payable.
        if (account == address(0) || !IGaplessFactory(factory).isAccount(account)) revert NotAccount(account);

        PayoutBlockCap memory b = _blockPayout[perpId];
        if (b.blockNumber != block.number) {
            uint256 cap = _assets * Math.min(perBlockCapBps, BPS) / BPS;
            b = PayoutBlockCap(block.number.toUint48(), cap.toUint80(), 0);
        }
        uint256 r = reserved[perpId];
        paidCNS = Math.min(Math.min(amountCNS, b.capCNS - b.paidCNS), r);
        if (paidCNS == 0) return 0;

        // Safe: paidCNS <= capCNS - paidCNS (uint80), <= reserved[perpId] <= reservedTotal <= _assets.
        b.paidCNS += uint80(paidCNS);
        _blockPayout[perpId] = b;
        reserved[perpId] = r - paidCNS;
        reservedTotal -= paidCNS;
        _assets -= paidCNS;
        emit Paid(perpId, account, paidCNS);
        IERC20(asset()).safeTransfer(account, paidCNS);
    }

    /// @inheritdoc ICoverVault
    function notifyPremium(uint256 amountCNS) external onlyManager nonReentrant {
        IERC20 a = IERC20(asset());
        uint256 accounted = _assets + amountCNS;
        uint256 bal = a.balanceOf(address(this));
        if (bal < accounted) revert InsufficientFree(accounted, bal);

        // Floor: the treasury cut rounds toward LPs.
        uint256 toTreasury = amountCNS * _config.protocolFeeBps / BPS;
        _assets = accounted;
        // A frozen treasury must never block finalize or cancel, so its cut falls back to LPs.
        if (toTreasury != 0) {
            if (a.trySafeTransfer(_config.treasury, toTreasury)) _assets = accounted - toTreasury;
            else toTreasury = 0;
        }
        emit PremiumReceived(amountCNS, amountCNS - toTreasury, toTreasury);
    }

    /// @inheritdoc ICoverVault
    function updateOwed(uint256 fromCNS, uint256 toCNS) external onlyManager nonReentrant {
        owedTotal = owedTotal + toCNS - fromCNS;
        emit OwedUpdated(owedTotal);
    }

    // Admin

    /// @inheritdoc ICoverVault
    function setManager(address manager_) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (manager != address(0)) revert ManagerAlreadySet();
        if (manager_ == address(0)) revert ZeroAddress();
        if (manager_ == _config.treasury) revert ConfigOutOfBounds(Constants.C_TREASURY); // I-03
        address f = ICoverManager(manager_).factory();
        if (f == address(0)) revert ZeroAddress();
        manager = manager_;
        factory = f;
        emit ManagerSet(manager_, f);
    }

    /// @inheritdoc ICoverVault
    function setConfig(VaultConfig calldata c) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _setConfig(c);
    }

    function pause() external onlyRole(PAUSER_ROLE) {
        _pause();
    }

    function unpause() external onlyRole(PAUSER_ROLE) {
        _unpause();
    }

    // ERC-4626 overrides

    /// @dev Net of owedTotal (L-08); owed is part of reservedTotal, which is checked against the gross _assets.
    function totalAssets() public view override(IERC4626, ERC4626) returns (uint256) {
        uint256 a = _assets;
        uint256 o = owedTotal;
        return a > o ? a - o : 0;
    }

    function maxDeposit(address) public view override(IERC4626, ERC4626) returns (uint256) {
        return paused() ? 0 : type(uint256).max;
    }

    function maxMint(address) public view override(IERC4626, ERC4626) returns (uint256) {
        return paused() ? 0 : type(uint256).max;
    }

    /// @dev Sync exits are disabled (EIP-7540): max* return 0, preview* and the actions revert AsyncOnly.
    function maxWithdraw(address) public pure override(IERC4626, ERC4626) returns (uint256) {
        return 0;
    }

    function maxRedeem(address) public pure override(IERC4626, ERC4626) returns (uint256) {
        return 0;
    }

    function previewWithdraw(uint256) public pure override(IERC4626, ERC4626) returns (uint256) {
        revert AsyncOnly();
    }

    function previewRedeem(uint256) public pure override(IERC4626, ERC4626) returns (uint256) {
        revert AsyncOnly();
    }

    function withdraw(uint256, address, address) public pure override(IERC4626, ERC4626) returns (uint256) {
        revert AsyncOnly();
    }

    function redeem(uint256, address, address) public pure override(IERC4626, ERC4626) returns (uint256) {
        revert AsyncOnly();
    }

    // Views

    function config() external view returns (VaultConfig memory) {
        return _config;
    }

    function getRequest(uint256 requestId) external view returns (RedeemRequest memory) {
        return _requests[requestId];
    }

    function requestIdsOf(address owner) external view returns (uint256[] memory) {
        return _requestIds[owner];
    }

    function freeAssets() public view returns (uint256) {
        uint256 ta = _assets;
        uint256 rt = reservedTotal;
        return ta > rt ? ta - rt : 0;
    }

    /// @return reservedTotal / gross assets (totalAssets + owedTotal) in bps, floor. quote().utilAfterBps uses net
    /// totalAssets, so it reads slightly higher while payouts are owed.
    function utilizationBps() external view returns (uint256) {
        uint256 ta = _assets;
        return ta == 0 ? 0 : reservedTotal * BPS / ta;
    }

    function blockPayout(uint256 perpId) external view returns (PayoutBlockCap memory) {
        return _blockPayout[perpId];
    }

    function paused() public view override(ICoverVault, Pausable) returns (bool) {
        return super.paused();
    }

    // Internal

    function _deposit(address caller, address receiver, uint256 assets, uint256 shares) internal override {
        if (shares == 0) revert BelowMinDeposit();
        _assets += assets;
        lockUntil[receiver] = block.number + DEPOSIT_LOCK_BLOCKS;
        super._deposit(caller, receiver, assets, shares);
    }

    /// @dev Shares only move by mint and burn; request escrow calls ERC20._update directly.
    function _update(address from, address to, uint256 value) internal override {
        if (from != address(0) && to != address(0)) revert NonTransferable();
        super._update(from, to, value);
    }

    function _decimalsOffset() internal pure override returns (uint8) {
        return Constants.VAULT_DECIMALS_OFFSET;
    }

    function _setConfig(VaultConfig memory c) internal {
        if (c.treasury == address(0) || c.treasury == address(this) || c.treasury == manager) {
            revert ConfigOutOfBounds(Constants.C_TREASURY);
        }
        if (
            c.maxUtilizationBps < Constants.MAX_UTILIZATION_BPS_MIN
                || c.maxUtilizationBps > Constants.MAX_UTILIZATION_BPS_MAX
        ) {
            revert ConfigOutOfBounds(Constants.C_MAX_UTILIZATION);
        }
        if (c.protocolFeeBps > Constants.PROTOCOL_FEE_BPS_MAX) revert ConfigOutOfBounds(Constants.C_PROTOCOL_FEE);
        if (c.minDepositCNS < Constants.MIN_DEPOSIT_CNS_MIN || c.minDepositCNS > Constants.MIN_DEPOSIT_CNS_MAX) {
            revert ConfigOutOfBounds(Constants.C_MIN_DEPOSIT);
        }
        emit ConfigSet(_config, c);
        _config = c;
    }

    function _removeRequest(address owner, uint256 requestId) internal {
        uint256[] storage ids = _requestIds[owner];
        uint256 i = _requestIndex[requestId];
        uint256 last = ids[ids.length - 1];
        ids[i] = last;
        _requestIndex[last] = i;
        ids.pop();
        delete _requestIndex[requestId];
        delete _requests[requestId];
    }

    function _checkNotSettling() internal view {
        address m = manager;
        if (m != address(0) && ICoverManager(m).isSettling()) revert Settling();
    }

    function _bpsCeil(uint256 x, uint256 ta) internal pure returns (uint256) {
        return ta == 0 ? type(uint256).max : Math.mulDiv(x, BPS, ta, Math.Rounding.Ceil);
    }
}
