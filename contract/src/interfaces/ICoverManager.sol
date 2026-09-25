// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {IAccessControlDefaultAdminRules} from
    "@openzeppelin/contracts/access/extensions/IAccessControlDefaultAdminRules.sol";
import {
    CoverStatus,
    EndReason,
    DisarmReason,
    CoverParams,
    Quote,
    Cover,
    MarketConfig,
    MarketParams
} from "../types/GaplessTypes.sol";

/// @title ICoverManager
/// @notice Quotes, cover lifecycle, reference aggregation and payout math. Holds escrow and rent in AUSD.
/// @dev Roles: DEFAULT_ADMIN (OZ default admin rules, 1 h delay; one-time setFactory), RISK_ADMIN_ROLE
/// (listMarket, bounded setMarketParams), SIGMA_ROLE (bounded postSigma), PAUSER_ROLE (buys only, OZ Pausable:
/// openCover reverts EnforcedPause(); events Paused/Unpaused). Lifecycle functions are permissionless and
/// state-checked; openCover, syncCover and cancelCover require msg.sender == account and factory.isAccount.
/// coverId = keccak256(abi.encode(account, perpId, coverNonce[account]++)).
interface ICoverManager is IAccessControlDefaultAdminRules {
    event FactorySet(address factory);
    event MarketListed(uint256 indexed perpId, MarketConfig cfg);
    event MarketParamsSet(uint256 indexed perpId, MarketParams oldP, MarketParams newP);
    event SigmaPosted(uint256 indexed perpId, uint32 sigmaBlkBpsE2, uint256 blockNumber);
    event CoverBought(
        bytes32 indexed coverId,
        address indexed account,
        uint256 indexed perpId,
        bool isLong,
        uint256 lots,
        uint256 stopPNS,
        uint256 maxGapBps,
        uint256 escrowCNS,
        uint256 rentCNS,
        uint256 capCNS,
        uint256 expiryBlock
    );
    event CoverResized(bytes32 indexed coverId, uint256 newLots, uint256 releasedCapCNS, uint256 refundCNS);
    /// @dev CRE log trigger topic0 = keccak256("Armed(bytes32,uint256,address,uint256,uint256,uint256)").
    event Armed(
        bytes32 indexed coverId,
        uint256 indexed perpId,
        address indexed armer,
        uint256 blockNumber,
        uint256 bookPNS,
        uint256 refPNS
    );
    event Disarmed(bytes32 indexed coverId, DisarmReason reason);
    event TriggerNoFill(bytes32 indexed coverId, uint256 blockNumber, uint256 limitPNS);
    event Triggered(
        bytes32 indexed coverId,
        uint256 indexed perpId,
        uint256 blockNumber,
        uint256 filledLots,
        int256 realizedCNS,
        uint256 gRealCumCNS,
        uint256 refTrigPNS,
        uint256 paidNowCNS,
        uint256 owedCNS
    );
    event Observed(bytes32 indexed coverId, uint256 refPostPNS, uint256 blockNumber);
    event Finalized(
        bytes32 indexed coverId, uint256 topUpCNS, uint256 totalPaidCNS, uint256 refFinalPNS, uint256 escrowToVaultCNS
    );
    event CoverEnded(bytes32 indexed coverId, CoverStatus status, EndReason reason, uint256 refundCNS);
    event PayoutDeferred(bytes32 indexed coverId, uint256 owedCNS);
    /// @notice M-03: escrow kept by the vault on a non-trigger end (in the stop zone, or after an arm).
    event EscrowForfeited(bytes32 indexed coverId, uint256 amountCNS);
    /// @notice L-05: a refund to `account` failed (frozen AUSD); claimable later through claimRefund.
    event RefundOwed(address indexed account, uint256 amountCNS);
    event RefundClaimed(address indexed account, uint256 amountCNS);
    event MarketPauseSet(uint256 indexed perpId, bool paused);

    error NotAccount();
    error MarketNotListed(uint256 perpId);
    error MarketAlreadyListed(uint256 perpId);
    error VenueUnavailable(); // isHalted or perp status != 4
    error WhitelistingOn();
    error AusdFrozen(address who);
    error WrongSide();
    error ZeroLots();
    error LotsExceedPosition(uint256 coverLots, uint256 positionLots);
    error StopWrongSide();
    error StopTooClose(uint256 distanceBps, uint256 minBps);
    error LiquidationBufferTooThin(uint256 lossPlusCapCNS, uint256 limitCNS);
    error DurationOutOfRange(uint32 blocks);
    error MaxGapOutOfRange(uint16 bps);
    error NotionalTooLarge(uint256 notionalCNS);
    error MarkStale(uint256 markTimestamp);
    error SigmaStale(uint256 postedBlock);
    error NoReference();
    error PremiumTooHigh(uint256 quotedCNS, uint256 maxCNS);
    error CoverExists(bytes32 coverId);
    error NotCoverAccount(bytes32 coverId);
    error BadStatus(bytes32 coverId, CoverStatus status);
    error NotArmer(address caller, address armer);
    error TooEarly(uint256 readyBlock);
    error CoverExpired(uint256 expiryBlock);
    error ConditionNotMet();
    error PositionIntact(bytes32 coverId);
    error ParamOutOfBounds(uint8 fieldIndex); // Constants.F_* indices
    error FactoryAlreadySet();
    error ZeroAddress();
    error MarketPaused(uint256 perpId);
    error CoverShareExceeded(uint256 capCNS, uint256 limitCNS);
    error NoRefundOwed(address account);

    function RISK_ADMIN_ROLE() external view returns (bytes32);
    function SIGMA_ROLE() external view returns (bytes32);
    function PAUSER_ROLE() external view returns (bytes32);
    function EXCHANGE() external view returns (address);
    function AUSD() external view returns (address);
    function VAULT() external view returns (address);
    /// @return Factory set once by DEFAULT_ADMIN after deploy; address(0) before.
    function factory() external view returns (address);

    // views

    /// @notice Price a cover for `account`. Reverts with the same errors as openCover (except NotAccount).
    function quote(address account, CoverParams calldata p) external view returns (Quote memory q);
    function getCover(bytes32 coverId) external view returns (Cover memory);
    /// @return Non-terminal cover id for (account, perpId), or 0.
    function activeCoverOf(address account, uint256 perpId) external view returns (bytes32);
    /// @return True while the active cover on the perp is Armed (within armTtl, not past expiry) or Triggered.
    function isLocked(address account, uint256 perpId) external view returns (bool);
    /// @notice Spec 3.6 aggregate: median of fresh sources, least favorable to the claimant when even.
    /// @param minTs Only sources published at or after this unix second count (0 = any fresh).
    function referencePrice(uint256 perpId, bool isLong, uint256 minTs)
        external
        view
        returns (uint256 refPNS, uint8 nFresh);
    /// @notice Keeper and CRE watch list (CRE ABI). Bounded by `max` per array.
    function watchList(uint256 perpId, uint256 max)
        external
        view
        returns (bytes32[] memory toArm, bytes32[] memory toTrigger);
    function housekeeping(uint256 perpId, uint256 max)
        external
        view
        returns (
            bytes32[] memory toObserve,
            bytes32[] memory toFinalize,
            bytes32[] memory toExpire,
            bytes32[] memory toVoid
        );
    function liveCount(uint256 perpId) external view returns (uint256);
    /// @return True only inside trigger and finalize (transient); the vault blocks LP flows while set.
    function isSettling() external view returns (bool);
    function scaleOf(uint256 perpId) external view returns (uint256);
    function marketConfig(uint256 perpId) external view returns (MarketConfig memory);
    function marketParams(uint256 perpId) external view returns (MarketParams memory);
    /// @notice Keeper reads this to post sigma on demand (age > sigmaMaxAgeBlocks makes quotes revert).
    function sigmaOf(uint256 perpId) external view returns (uint32 sigmaBlkBpsE2, uint48 postedBlock);
    function listedPerps() external view returns (uint256[] memory);
    /// @return Nonce that the next cover bought by `account` will use.
    function coverNonce(address account) external view returns (uint256);
    function paused() external view returns (bool);
    /// @return True while PAUSER has paused buys on `perpId` (lifecycle calls never pause).
    function marketPaused(uint256 perpId) external view returns (bool);
    /// @return AUSD refunds that failed to reach `account` (frozen) and wait in the manager.
    function refundOwed(address account) external view returns (uint256);
    function refundOwedTotal() external view returns (uint256);

    // account-only

    /// @notice Pulls escrow + rent from `account` (safeTransferFrom; account approves exactly), reserves Cap.
    /// Snapshots A, floorSlack, minDistance, warmup and window into the cover (L-03, N-02). Rent is at least
    /// minFeeCNS per started RENT_FLOOR_PERIOD_BLOCKS (L-09). The stop distance is measured from the least favorable fresh
    /// source among mark, oracle, feed and the book top (M-02); one cover may use at most MAX_COVER_CAP_SHARE_BPS of
    /// the market's capacity (L-09).
    function openCover(address account, CoverParams calldata p, uint256 maxPremiumCNS)
        external
        returns (bytes32 coverId);
    /// @notice After any trade: shrink (CoverResized, PositionReduced) or void (PositionClosedOrFlipped).
    /// The freed escrow follows the M-03 rule of cancelCover. No-op on a Triggered cover. Past expiry it ends the
    /// cover exactly like expire (N-02).
    function syncCover(address account, uint256 perpId) external;
    /// @notice Live covers only (Live or Armed once past expiry). Before expiry (M-03, N-02): the escrow is refunded
    /// only if the cover was never armed and the least favorable fresh reference (mark, oracle, feed) is at least the
    /// purchase-time minDistance from the stop; otherwise the vault keeps it (EscrowForfeited). voidCover and
    /// syncCover use the same rule. Past expiryBlock every end path resolves as expire (status Expired). A refund to
    /// a frozen account becomes refundOwed. A reverting Perpl view drops mark and oracle instead of reverting.
    function cancelCover(address account, bytes32 coverId) external;

    // permissionless, state-checked

    /// @notice Book crossed at the stop and a fresh reference at or through it (H-01). Reverts CoverExpired from the
    /// expiry block on, since a trigger needs a later block (SA3-01).
    /// @return armed False (no revert) when the venue is unavailable or the position broke (cover voided).
    function arm(bytes32 coverId) external returns (bool armed);
    /// @notice Close limit at step k: R x (1 -/+ A) at k = 0, else min(stop, R) x (1 -/+ min(floorSlack, A x 2^k)).
    /// k counts thin-book short attempts of this touch with R through, each within STEP_MAX_GAP_BLOCKS of the previous
    /// attempt; rules in INTERFACES.md section 4 (N-01, SA3-02, C7). Fast path runs in the arm block (SA3-01).
    /// @return paidNowCNS 0 with no revert on disarm, arm TTL lapse, zero fill (TriggerNoFill) or void.
    function trigger(bytes32 coverId) external returns (uint256 paidNowCNS);
    /// @notice Needs two fresh post-trigger sources, or one that is not the mark (L-01); returns false otherwise.
    function observe(bytes32 coverId) external returns (bool observed);
    /// @notice Callable again while owedCNS > 0 (per-block cap deferral).
    function finalize(bytes32 coverId) external returns (uint256 topUpCNS);
    /// @notice Permissionless after expiryBlock. Refunds the escrow unless the cover was ever armed, whoever calls and
    /// whenever (N-02); reads no prices and no Perpl state.
    function expire(bytes32 coverId) external;
    /// @notice Position gone, flipped or below cover lots (LiquidatedOrAdl). Reverts PositionIntact otherwise, and
    /// VenueUnavailable if Perpl's position view reverts. Past expiry it resolves as expire.
    function voidCover(bytes32 coverId) external;
    /// @notice Pays `account` its recorded refunds (L-05). Permissionless; the recipient is always the account.
    function claimRefund(address account) external returns (uint256 amountCNS);

    // roles

    /// @notice DEFAULT_ADMIN, once. Must precede vault.setManager.
    function setFactory(address factory_) external;
    /// @notice RISK_ADMIN. Requires cfg.priceDecimals + cfg.lotDecimals <= 6, feedDecimals >= priceDecimals,
    /// perpId <= type(uint16).max and params within bounds.
    function listMarket(uint256 perpId, MarketConfig calldata cfg, MarketParams calldata p) external;
    function setMarketParams(uint256 perpId, MarketParams calldata p) external;
    function postSigma(uint256 perpId, uint32 sigmaBlkBpsE2) external;
    function pauseBuys() external;
    function unpauseBuys() external;
    /// @notice PAUSER. Blocks new covers on one market; live covers keep their lifecycle.
    function pauseMarket(uint256 perpId) external;
    function unpauseMarket(uint256 perpId) external;
}
