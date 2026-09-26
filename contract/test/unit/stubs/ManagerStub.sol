// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ICoverManager} from "../../../src/interfaces/ICoverManager.sol";
import {ICoverVault} from "../../../src/interfaces/ICoverVault.sol";
import {IGaplessFactory} from "../../../src/interfaces/IGaplessFactory.sol";
import {IGaplessAccount} from "../../../src/interfaces/IGaplessAccount.sol";
import {CoverParams, Quote, CloseResult} from "../../../src/types/GaplessTypes.sol";

/// @title ManagerStub
/// @notice Interim S1 test double for the ICoverManager calls the account, vault and Deploy make. Selectors are
/// pinned to ICoverManager by ManagerStubSelectorsTest. Deleted once the fixture uses the real manager.
/// @dev Escrow and rent are custodied here like the real manager; payouts and closes are driven by test helpers.
contract ManagerStub {
    using SafeERC20 for IERC20;

    struct StubCover {
        address account;
        uint256 perpId;
        uint256 escrow;
        uint256 rent;
        uint256 cap;
    }

    address public immutable EXCHANGE;
    address public immutable AUSD;
    address public immutable VAULT;
    address public factory;
    bool public isSettling;

    uint256 public escrowCNS = 2e6;
    uint256 public rentCNS = 20_000;
    uint256 public capCNS = 1e6;
    uint16 public marketCapBps = 5000;
    uint256 public syncCalls;
    bool public voidOnSync;

    mapping(address => uint256) public coverNonce;
    mapping(address => mapping(uint256 => bytes32)) public activeCoverOf;
    mapping(address => mapping(uint256 => bool)) internal _locked;
    mapping(bytes32 => StubCover) public covers;
    mapping(bytes32 => mapping(address => bool)) public hasRole;

    constructor(address ex, address ausd, address vault, address) {
        EXCHANGE = ex;
        AUSD = ausd;
        VAULT = vault;
    }

    // Wiring surface used by Deploy.s.sol

    function setFactory(address f) external {
        if (factory != address(0)) revert ICoverManager.FactoryAlreadySet();
        factory = f;
    }

    function grantRole(bytes32 role, address who) external {
        hasRole[role][who] = true;
    }

    // ICoverManager subset

    function quote(address, CoverParams calldata p) public view returns (Quote memory q) {
        q.notionalCNS = p.lots * p.stopPNS;
        q.capCNS = capCNS;
        q.escrowCNS = escrowCNS;
        q.rentCNS = rentCNS;
        q.expiryBlock = block.number + p.durationBlocks;
    }

    function isLocked(address account, uint256 perpId) external view returns (bool) {
        return _locked[account][perpId];
    }

    function openCover(address account, CoverParams calldata p, uint256 maxPremiumCNS)
        external
        returns (bytes32 coverId)
    {
        _onlyAccount(account);
        if (activeCoverOf[account][p.perpId] != 0) revert ICoverManager.CoverExists(activeCoverOf[account][p.perpId]);
        uint256 need = escrowCNS + rentCNS;
        if (need > maxPremiumCNS) revert ICoverManager.PremiumTooHigh(need, maxPremiumCNS);
        coverId = keccak256(abi.encode(account, p.perpId, coverNonce[account]++));
        covers[coverId] = StubCover(account, p.perpId, escrowCNS, rentCNS, capCNS);
        activeCoverOf[account][p.perpId] = coverId;
        IERC20(AUSD).safeTransferFrom(account, address(this), need);
        ICoverVault(VAULT).reserve(p.perpId, capCNS, marketCapBps);
    }

    function syncCover(address account, uint256 perpId) external {
        _onlyAccount(account);
        ++syncCalls;
        bytes32 id = activeCoverOf[account][perpId];
        if (voidOnSync && id != 0) _end(id);
    }

    function cancelCover(address account, bytes32 coverId) external {
        _onlyAccount(account);
        if (covers[coverId].account != account) revert ICoverManager.NotCoverAccount(coverId);
        _end(coverId);
    }

    // Test controls

    function setQuote(uint256 escrow, uint256 rent, uint256 cap) external {
        escrowCNS = escrow;
        rentCNS = rent;
        capCNS = cap;
    }

    function setMarketCapBps(uint16 bps) external {
        marketCapBps = bps;
    }

    function setLocked(address account, uint256 perpId, bool v) external {
        _locked[account][perpId] = v;
    }

    function setSettling(bool v) external {
        isSettling = v;
    }

    function setVoidOnSync(bool v) external {
        voidOnSync = v;
    }

    /// @notice Trigger-shaped payout: settling flag, try payCapped, then try creditToPerpl (INTERFACES 5.4).
    function settle(uint256 perpId, address account, uint256 amount, uint16 capBps) external returns (uint256 paid) {
        isSettling = true;
        try ICoverVault(VAULT).payCapped(perpId, account, amount, capBps) returns (uint256 p) {
            paid = p;
        } catch {}
        if (paid > 0) {
            try IGaplessAccount(account).creditToPerpl(paid) {} catch {}
        }
        isSettling = false;
    }

    function close(address account, uint256 perpId, bool isLong, uint256 lots, uint256 limitPNS, uint256 maxMatches)
        external
        returns (CloseResult memory)
    {
        return IGaplessAccount(account).closeForCover(perpId, isLong, lots, limitPNS, maxMatches);
    }

    function credit(address account, uint256 amount) external {
        IGaplessAccount(account).creditToPerpl(amount);
    }

    function pay(uint256 perpId, address account, uint256 amount, uint16 capBps) external returns (uint256) {
        return ICoverVault(VAULT).payCapped(perpId, account, amount, capBps);
    }

    function reserve(uint256 perpId, uint256 amount, uint16 bps) external {
        ICoverVault(VAULT).reserve(perpId, amount, bps);
    }

    function release(uint256 perpId, uint256 amount) external {
        ICoverVault(VAULT).release(perpId, amount);
    }

    function owe(uint256 fromCNS, uint256 toCNS) external {
        ICoverVault(VAULT).updateOwed(fromCNS, toCNS);
    }

    function notify(uint256 amount) external {
        IERC20(AUSD).safeTransfer(VAULT, amount);
        ICoverVault(VAULT).notifyPremium(amount);
    }

    function _end(bytes32 id) internal {
        StubCover memory c = covers[id];
        delete activeCoverOf[c.account][c.perpId];
        delete covers[id];
        ICoverVault(VAULT).release(c.perpId, c.cap);
        if (c.rent > 0) {
            IERC20(AUSD).safeTransfer(VAULT, c.rent);
            ICoverVault(VAULT).notifyPremium(c.rent);
        }
        // C6: refunds are plain transfers, never an account hook.
        if (c.escrow > 0) IERC20(AUSD).safeTransfer(c.account, c.escrow);
    }

    function _onlyAccount(address account) internal view {
        if (msg.sender != account || !IGaplessFactory(factory).isAccount(account)) revert ICoverManager.NotAccount();
    }
}
