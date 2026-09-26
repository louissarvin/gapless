// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {AccessControlDefaultAdminRules} from
    "@openzeppelin/contracts/access/extensions/AccessControlDefaultAdminRules.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {TransientSlot} from "@openzeppelin/contracts/utils/TransientSlot.sol";
import {EnumerableSet} from "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

import {ICoverManager} from "./interfaces/ICoverManager.sol";
import {ICoverVault} from "./interfaces/ICoverVault.sol";
import {IGaplessAccount} from "./interfaces/IGaplessAccount.sol";
import {IGaplessFactory} from "./interfaces/IGaplessFactory.sol";
import {IPerplMin} from "./interfaces/perpl/IPerplMin.sol";
import {IAUSD} from "./interfaces/external/IAUSD.sol";
import {IAggregatorV3} from "./interfaces/external/IAggregatorV3.sol";
import {
    CoverStatus,
    EndReason,
    DisarmReason,
    CoverParams,
    Quote,
    Cover,
    MarketConfig,
    MarketParams,
    SigmaState,
    CloseResult
} from "./types/GaplessTypes.sol";
import {Constants} from "./Constants.sol";
import {PremiumMath} from "./libraries/PremiumMath.sol";
import {ReferenceLib} from "./libraries/ReferenceLib.sol";
import {PayoutMath} from "./libraries/PayoutMath.sol";

/// @title CoverManager
/// @notice Guaranteed-stop covers on Perpl positions: quote, buy, arm, trigger (close and pay in one tx),
/// observe, finalize, and the end paths. Holds escrow and rent in AUSD until a cover ends.
/// @dev Trust: the keeper is untrusted (every lifecycle call re-derives its conditions); accounts are factory clones;
/// the vault, Perpl and AUSD make no callbacks. Payout = min(G_real, G_ref + A, Cap) always, with A, floorSlack,
/// minDistance, warmup and window snapshotted per cover. The first close of a touch is floored at R x (1 - A); the
/// allowance doubles per thin-book short attempt of the same touch, capped at floorSlack, while each attempt lands
/// within STEP_MAX_GAP_BLOCKS of the previous one (H-01, N-01, N-04, SA3-02, C7).
contract CoverManager is ICoverManager, AccessControlDefaultAdminRules, Pausable, ReentrancyGuardTransient {
    using SafeERC20 for IERC20;
    using SafeCast for uint256;
    using EnumerableSet for EnumerableSet.Bytes32Set;
    using TransientSlot for *;

    bytes32 public constant RISK_ADMIN_ROLE = Constants.RISK_ADMIN_ROLE;
    bytes32 public constant SIGMA_ROLE = Constants.SIGMA_ROLE;
    bytes32 public constant PAUSER_ROLE = Constants.PAUSER_ROLE;

    /// @dev ParamOutOfBounds index for a postSigma value outside [5, 2000] (CR5).
    uint8 public constant F_SIGMA_POST = Constants.F_SIGMA_POST;
    /// @dev Max live covers inspected per watchList/housekeeping call; larger sets rotate by block number.
    uint256 public constant SCAN_LIMIT = 512;
    bytes32 private constant SETTLING_SLOT = keccak256("gapless.CoverManager.settling"); // transient flag

    address public immutable EXCHANGE;
    address public immutable AUSD;
    address public immutable VAULT;
    address public factory;

    mapping(address account => uint256) public coverNonce;
    mapping(bytes32 coverId => Cover) internal _covers;
    mapping(address account => mapping(uint256 perpId => bytes32)) internal _active;
    mapping(uint256 perpId => EnumerableSet.Bytes32Set) internal _live;
    mapping(uint256 perpId => MarketConfig) internal _cfg;
    mapping(uint256 perpId => MarketParams) internal _params;
    mapping(uint256 perpId => SigmaState) internal _sigma;
    uint256[] internal _listed;
    mapping(uint256 perpId => bool) public marketPaused;
    mapping(address account => uint256) public refundOwed;
    uint256 public refundOwedTotal;
    /// @dev C7: block of a cover's last held (match-limited) attempt, so a same-block retry keeps that step.
    mapping(bytes32 coverId => uint256) internal _heldBlock;

    struct Market {
        MarketParams p;
        MarketConfig c;
        IPerplMin.PerpetualInfo info;
    }

    modifier settles() {
        SETTLING_SLOT.asBoolean().tstore(true);
        _;
        SETTLING_SLOT.asBoolean().tstore(false);
    }

    constructor(address exchange_, address ausd_, address vault_, address admin)
        AccessControlDefaultAdminRules(Constants.ADMIN_DELAY, admin)
    {
        if (exchange_ == address(0) || ausd_ == address(0) || vault_ == address(0)) revert ZeroAddress();
        EXCHANGE = exchange_;
        AUSD = ausd_;
        VAULT = vault_;
    }

    // Views

    /// @inheritdoc ICoverManager
    function quote(address account, CoverParams calldata p) external view returns (Quote memory q) {
        (q,) = _quote(account, p);
    }

    function getCover(bytes32 coverId) external view returns (Cover memory) {
        return _covers[coverId];
    }

    function activeCoverOf(address account, uint256 perpId) external view returns (bytes32) {
        return _active[account][perpId];
    }

    function isLocked(address account, uint256 perpId) external view returns (bool) {
        bytes32 id = _active[account][perpId];
        if (id == 0) return false;
        Cover storage c = _covers[id];
        CoverStatus st = _effStatus(c);
        return st == CoverStatus.Triggered || (st == CoverStatus.Armed && block.number <= c.expiryBlock);
    }

    function referencePrice(uint256 perpId, bool isLong, uint256 minTs)
        external
        view
        returns (uint256 refPNS, uint8 nFresh)
    {
        Market memory m = _market(perpId);
        return _ref(m, _sources(m), isLong, minTs);
    }

    /// @inheritdoc ICoverManager
    function watchList(uint256 perpId, uint256 max)
        external
        view
        returns (bytes32[] memory toArm, bytes32[] memory toTrigger)
    {
        max = Math.min(max, SCAN_LIMIT);
        toArm = new bytes32[](max);
        toTrigger = new bytes32[](max);
        uint256 nArm;
        uint256 nTrig;
        if (_cfg[perpId].listed && max > 0) {
            Market memory m = _market(perpId);
            if (_venueOk(m.info)) {
                ReferenceLib.Sources memory s = _sources(m);
                EnumerableSet.Bytes32Set storage set = _live[perpId];
                (uint256 start, uint256 count) = _scanWindow(set.length());
                for (uint256 k; k < count && (nArm < max || nTrig < max); ++k) {
                    bytes32 id = set.at((start + k) % set.length());
                    uint8 kind = _watchKind(_covers[id], m, s);
                    if (kind == 1 && nArm < max) toArm[nArm++] = id;
                    else if (kind == 2 && nTrig < max) toTrigger[nTrig++] = id;
                }
            }
        }
        _shrink(toArm, nArm);
        _shrink(toTrigger, nTrig);
    }

    /// @inheritdoc ICoverManager
    function housekeeping(uint256 perpId, uint256 max)
        external
        view
        returns (
            bytes32[] memory toObserve,
            bytes32[] memory toFinalize,
            bytes32[] memory toExpire,
            bytes32[] memory toVoid
        )
    {
        max = Math.min(max, SCAN_LIMIT);
        toObserve = new bytes32[](max);
        toFinalize = new bytes32[](max);
        toExpire = new bytes32[](max);
        toVoid = new bytes32[](max);
        uint256[4] memory n;
        if (_cfg[perpId].listed && max > 0) {
            Market memory m = _marketSoft(perpId);
            ReferenceLib.Sources memory s = _sources(m);
            EnumerableSet.Bytes32Set storage set = _live[perpId];
            (uint256 start, uint256 count) = _scanWindow(set.length());
            for (uint256 k; k < count; ++k) {
                bytes32 id = set.at((start + k) % set.length());
                uint8 kind = _houseKind(_covers[id], m, s);
                if (kind == 1 && n[0] < max) toObserve[n[0]++] = id;
                else if (kind == 2 && n[1] < max) toFinalize[n[1]++] = id;
                else if (kind == 3 && n[2] < max) toExpire[n[2]++] = id;
                else if (kind == 4 && n[3] < max) toVoid[n[3]++] = id;
            }
        }
        _shrink(toObserve, n[0]);
        _shrink(toFinalize, n[1]);
        _shrink(toExpire, n[2]);
        _shrink(toVoid, n[3]);
    }

    function liveCount(uint256 perpId) external view returns (uint256) {
        return _live[perpId].length();
    }

    function isSettling() external view returns (bool) {
        return SETTLING_SLOT.asBoolean().tload();
    }

    function scaleOf(uint256 perpId) external view returns (uint256) {
        return _cfg[perpId].scale;
    }

    function marketConfig(uint256 perpId) external view returns (MarketConfig memory) {
        return _cfg[perpId];
    }

    function marketParams(uint256 perpId) external view returns (MarketParams memory) {
        return _params[perpId];
    }

    function sigmaOf(uint256 perpId) external view returns (uint32 sigmaBlkBpsE2, uint48 postedBlock) {
        SigmaState memory s = _sigma[perpId];
        return (s.sigmaBlkBpsE2, s.postedBlock);
    }

    function listedPerps() external view returns (uint256[] memory) {
        return _listed;
    }

    function paused() public view override(ICoverManager, Pausable) returns (bool) {
        return super.paused();
    }

    // Account-only

    /// @inheritdoc ICoverManager
    function openCover(address account, CoverParams calldata p, uint256 maxPremiumCNS)
        external
        nonReentrant
        returns (bytes32 coverId)
    {
        _onlyAccount(account);
        (Quote memory q, MarketParams memory mp) = _quote(account, p);
        uint256 premium = q.escrowCNS + q.rentCNS;
        if (premium > maxPremiumCNS) revert PremiumTooHigh(premium, maxPremiumCNS);

        coverId = keccak256(abi.encode(account, p.perpId, coverNonce[account]++));
        Cover storage c = _covers[coverId];
        c.account = account;
        c.perpId = uint16(p.perpId); // listMarket bounds perpId to uint16
        c.status = CoverStatus.Live;
        c.isLong = p.isLong;
        c.maxGapBps = p.maxGapBps;
        c.lots = p.lots.toUint40();
        c.stopPNS = p.stopPNS.toUint32();
        c.startBlock = block.number.toUint48();
        c.expiryBlock = q.expiryBlock.toUint48();
        c.capCNS = q.capCNS.toUint80();
        c.escrowCNS = q.escrowCNS.toUint80();
        c.rentCNS = q.rentCNS.toUint80();
        c.slipAllowanceBps = mp.slipAllowanceBps;
        c.floorSlackBps = mp.floorSlackBps;
        c.minDistanceBps = q.minDistanceBps.toUint16();
        c.warmupBlocks = uint256(mp.warmupBlocks).toUint16();
        c.windowBlocks = uint256(mp.windowBlocks).toUint8();
        _live[p.perpId].add(coverId);
        _active[account][p.perpId] = coverId;
        _emitBought(coverId, account, p, q);

        IERC20(AUSD).safeTransferFrom(account, address(this), premium);
        ICoverVault(VAULT).reserve(p.perpId, q.capCNS, mp.marketCapBps);
    }

    /// @inheritdoc ICoverManager
    function syncCover(address account, uint256 perpId) external nonReentrant {
        _onlyAccount(account);
        bytes32 id = _active[account][perpId];
        if (id == 0) return;
        Cover storage c = _covers[id];
        if (c.status == CoverStatus.Triggered) return;
        if (block.number > c.expiryBlock) return _end(id, c, CoverStatus.Expired, EndReason.Expired);
        IPerplMin.PositionInfo memory pos = _position(account, perpId);
        if (pos.lotLNS == 0 || _flipped(c, pos)) {
            _end(id, c, CoverStatus.Voided, EndReason.PositionClosedOrFlipped);
        } else if (pos.lotLNS < c.lots) {
            _resize(id, c, pos.lotLNS);
        }
    }

    /// @inheritdoc ICoverManager
    function cancelCover(address account, bytes32 coverId) external nonReentrant {
        _onlyAccount(account);
        Cover storage c = _covers[coverId];
        if (c.account != account) revert NotCoverAccount(coverId);
        CoverStatus st = _effStatus(c);
        // N-02: past expiry a cancel resolves exactly like expire (Armed included), so there is no race.
        bool expired = block.number > c.expiryBlock && (st == CoverStatus.Live || st == CoverStatus.Armed);
        if (st != CoverStatus.Live && !expired) revert BadStatus(coverId, st);
        _end(coverId, c, CoverStatus.Cancelled, EndReason.OwnerCancel);
    }

    // Permissionless, state-checked

    /// @inheritdoc ICoverManager
    function arm(bytes32 coverId) external nonReentrant returns (bool armed) {
        Cover storage c = _covers[coverId];
        CoverStatus st = _effStatus(c);
        if (st != CoverStatus.Live) revert BadStatus(coverId, st);
        Market memory m = _market(c.perpId);
        if (!_venueOk(m.info)) return false;
        uint256 ready = uint256(c.startBlock) + c.warmupBlocks;
        if (block.number < ready) revert TooEarly(ready);
        // SA3-01: a trigger needs block > armedBlock, so an arm in the expiry block could never fire.
        if (block.number >= c.expiryBlock) revert CoverExpired(c.expiryBlock);
        if (_broken(c, _position(c.account, c.perpId))) {
            _end(coverId, c, CoverStatus.Voided, EndReason.LiquidatedOrAdl);
            return false;
        }
        (uint256 ref, uint8 n) = _ref(m, _sources(m), c.isLong, 0);
        if (n == 0) revert NoReference();
        (uint256 book, bool crossed) = _bookCrossed(c, m.info);
        // H-01: a crossed book alone is a wick; the reference itself must be at or through the stop.
        if (!crossed || !_through(c, ref)) revert ConditionNotMet();
        if (c.status == CoverStatus.Armed) emit Disarmed(coverId, DisarmReason.ArmTtlElapsed);
        c.status = CoverStatus.Armed;
        c.armedBlock = block.number.toUint48();
        c.armer = msg.sender;
        _resetChain(coverId, c);
        emit Armed(coverId, c.perpId, msg.sender, block.number, book, ref);
        return true;
    }

    /// @inheritdoc ICoverManager
    function trigger(bytes32 coverId) external nonReentrant settles returns (uint256 paidNowCNS) {
        Cover storage c = _covers[coverId];
        CoverStatus stored = c.status;
        if (stored == CoverStatus.Triggered) return _triggerRemainder(coverId, c);
        if (stored != CoverStatus.Live && stored != CoverStatus.Armed) revert BadStatus(coverId, stored);
        if (block.number > c.expiryBlock) revert CoverExpired(c.expiryBlock);

        Market memory m = _market(c.perpId);
        (uint256 ref, uint8 n) = _ref(m, _sources(m), c.isLong, 0);
        bool fast = _fastPath(c, m);
        if (_effStatus(c) == CoverStatus.Armed) {
            // SA3-01: the fast path is single-block by design, so the arm block does not hold it back.
            if (!fast && block.number <= c.armedBlock) revert TooEarly(uint256(c.armedBlock) + 1);
            // L-02: the fast path is open to anyone, and the armer's window never reaches the expiry block.
            if (!fast && msg.sender != c.armer && _exclusive(c, m.p)) revert NotArmer(msg.sender, c.armer);
            if (!fast) {
                if (!_venueOk(m.info)) return _disarm(coverId, c, DisarmReason.VenueUnavailable);
                (, bool crossed) = _bookCrossed(c, m.info);
                // n == 0 (oracle outage after arming) still closes: G_ref = 0 bounds the payout to A x SN <= escrow.
                if (!crossed || (n > 0 && !_refWithinTol(c, m.p, ref))) {
                    return _disarm(coverId, c, DisarmReason.ConditionGone);
                }
            }
        } else if (stored == CoverStatus.Armed) {
            // N-01: a lapsed arm ends its touch (chain cleared); the fast path may still close at the tight floor.
            _disarm(coverId, c, DisarmReason.ArmTtlElapsed);
            if (!fast) return 0;
        } else if (!fast) {
            revert ConditionNotMet();
        }

        IPerplMin.PositionInfo memory pos = _position(c.account, c.perpId);
        if (_broken(c, pos)) {
            _end(coverId, c, CoverStatus.Voided, EndReason.LiquidatedOrAdl);
            return 0;
        }
        return _close(coverId, c, m.p, m.c.scale, ref, _through(c, ref), pos.lotLNS, true);
    }

    /// @inheritdoc ICoverManager
    function observe(bytes32 coverId) external nonReentrant returns (bool observed) {
        Cover storage c = _covers[coverId];
        if (c.status != CoverStatus.Triggered || c.observed) revert BadStatus(coverId, c.status);
        Market memory m = _market(c.perpId);
        if (block.number <= c.triggerBlock) revert TooEarly(uint256(c.triggerBlock) + 1);
        if (block.number > uint256(c.triggerBlock) + c.windowBlocks) revert ConditionNotMet();
        (uint256 ref, bool ok) = _postRef(c, m, _sources(m));
        if (!ok) return false;
        c.refPostPNS = _toPNS32(ref);
        c.observed = true;
        emit Observed(coverId, ref, block.number);
        return true;
    }

    /// @inheritdoc ICoverManager
    function finalize(bytes32 coverId) external nonReentrant settles returns (uint256 topUpCNS) {
        Cover storage c = _covers[coverId];
        if (c.status != CoverStatus.Triggered) revert BadStatus(coverId, c.status);
        MarketParams memory p = _params[c.perpId];
        uint256 windowEnd = uint256(c.triggerBlock) + c.windowBlocks;
        // Early finalize needs the post-trigger publish and a full fill, so remainder retries keep the window.
        if (block.number <= windowEnd && !(c.observed && c.filledLots == c.lots)) revert TooEarly(windowEnd + 1);

        uint256 scale = _cfg[c.perpId].scale;
        uint256 gTrig = PayoutMath.gRefCNS(c.stopPNS, c.refTrigPNS, c.filledLots, scale, c.isLong);
        uint256 gPost = c.observed ? PayoutMath.gRefCNS(c.stopPNS, c.refPostPNS, c.filledLots, scale, c.isLong) : 0;
        topUpCNS = _settle(coverId, c, p, scale, Math.max(gTrig, gPost));
        if (c.owedCNS > 0) {
            _releaseExcess(c);
            return topUpCNS;
        }
        _closeOut(coverId, c, topUpCNS, gPost > gTrig ? c.refPostPNS : c.refTrigPNS);
    }

    /// @inheritdoc ICoverManager
    function expire(bytes32 coverId) external nonReentrant {
        Cover storage c = _covers[coverId];
        CoverStatus st = c.status;
        if (st != CoverStatus.Live && st != CoverStatus.Armed) revert BadStatus(coverId, st);
        if (block.number <= c.expiryBlock) revert TooEarly(uint256(c.expiryBlock) + 1);
        _end(coverId, c, CoverStatus.Expired, EndReason.Expired);
    }

    /// @inheritdoc ICoverManager
    function voidCover(bytes32 coverId) external nonReentrant {
        Cover storage c = _covers[coverId];
        CoverStatus st = c.status;
        if (st != CoverStatus.Live && st != CoverStatus.Armed) revert BadStatus(coverId, st);
        if (block.number > c.expiryBlock) return _end(coverId, c, CoverStatus.Expired, EndReason.Expired);
        (bool ok, IPerplMin.PositionInfo memory pos) = _tryPosition(c.account, c.perpId);
        if (!ok) revert VenueUnavailable(); // cannot prove the position broke; expiry still ends the cover
        if (!_broken(c, pos)) revert PositionIntact(coverId);
        _end(coverId, c, CoverStatus.Voided, EndReason.LiquidatedOrAdl);
    }

    /// @inheritdoc ICoverManager
    function claimRefund(address account) external nonReentrant returns (uint256 amountCNS) {
        amountCNS = refundOwed[account];
        if (amountCNS == 0) revert NoRefundOwed(account);
        refundOwed[account] = 0;
        refundOwedTotal -= amountCNS;
        emit RefundClaimed(account, amountCNS);
        IERC20(AUSD).safeTransfer(account, amountCNS);
    }

    // Roles

    function setFactory(address factory_) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (factory != address(0)) revert FactoryAlreadySet();
        if (factory_ == address(0)) revert ZeroAddress();
        factory = factory_;
        emit FactorySet(factory_);
    }

    /// @inheritdoc ICoverManager
    function listMarket(uint256 perpId, MarketConfig calldata cfg, MarketParams calldata p)
        external
        onlyRole(RISK_ADMIN_ROLE)
    {
        if (_cfg[perpId].listed) revert MarketAlreadyListed(perpId);
        _checkConfig(perpId, cfg);
        _checkParams(p);
        MarketConfig memory c = cfg;
        c.listed = true;
        _cfg[perpId] = c;
        _params[perpId] = p;
        _listed.push(perpId);
        emit MarketListed(perpId, c);
        MarketParams memory empty;
        emit MarketParamsSet(perpId, empty, p);
    }

    /// @notice RISK_ADMIN. Live covers keep their purchase snapshot of A, floorSlack, minDistance, warmup and window
    /// (L-03); the rest is read at use (see docs/C5_FIXES.md for why each is safe).
    function setMarketParams(uint256 perpId, MarketParams calldata p) external onlyRole(RISK_ADMIN_ROLE) {
        if (!_cfg[perpId].listed) revert MarketNotListed(perpId);
        _checkParams(p);
        MarketParams memory old = _params[perpId];
        _params[perpId] = p;
        emit MarketParamsSet(perpId, old, p);
    }

    /// @notice SIGMA_ROLE. Bounded per post to [SIGMA_BPS_E2_MIN, SIGMA_BPS_E2_MAX].
    function postSigma(uint256 perpId, uint32 sigmaBlkBpsE2) external onlyRole(SIGMA_ROLE) {
        if (!_cfg[perpId].listed) revert MarketNotListed(perpId);
        if (sigmaBlkBpsE2 < Constants.SIGMA_BPS_E2_MIN || sigmaBlkBpsE2 > Constants.SIGMA_BPS_E2_MAX) {
            revert ParamOutOfBounds(F_SIGMA_POST);
        }
        _sigma[perpId] = SigmaState(sigmaBlkBpsE2, block.number.toUint48());
        emit SigmaPosted(perpId, sigmaBlkBpsE2, block.number);
    }

    function pauseBuys() external onlyRole(PAUSER_ROLE) {
        _pause();
    }

    function unpauseBuys() external onlyRole(PAUSER_ROLE) {
        _unpause();
    }

    function pauseMarket(uint256 perpId) external onlyRole(PAUSER_ROLE) {
        _setMarketPause(perpId, true);
    }

    function unpauseMarket(uint256 perpId) external onlyRole(PAUSER_ROLE) {
        _setMarketPause(perpId, false);
    }

    function _setMarketPause(uint256 perpId, bool on) internal {
        if (!_cfg[perpId].listed) revert MarketNotListed(perpId);
        marketPaused[perpId] = on;
        emit MarketPauseSet(perpId, on);
    }

    // Internal: quote

    function _quote(address account, CoverParams calldata cp)
        internal
        view
        returns (Quote memory q, MarketParams memory p)
    {
        Market memory m;
        m.c = _cfg[cp.perpId];
        if (!m.c.listed) revert MarketNotListed(cp.perpId);
        _requireNotPaused();
        if (marketPaused[cp.perpId]) revert MarketPaused(cp.perpId);
        IPerplMin ex = IPerplMin(EXCHANGE);
        if (ex.whitelistingEnabled() && !ex.whitelisted(account)) revert WhitelistingOn();
        m.info = ex.getPerpetualInfo(cp.perpId);
        if (!_venueOk(m.info)) revert VenueUnavailable();
        if (IAUSD(AUSD).isAccountFrozen(account)) revert AusdFrozen(account);
        if (IAUSD(AUSD).isAccountFrozen(VAULT)) revert AusdFrozen(VAULT);
        bytes32 existing = _active[account][cp.perpId];
        if (existing != 0) revert CoverExists(existing);
        if (cp.lots == 0) revert ZeroLots();
        cp.lots.toUint40(); // quote reverts like openCover on overflow
        cp.stopPNS.toUint32();
        IPerplMin.PositionInfo memory pos = _position(account, cp.perpId);
        if (pos.lotLNS == 0) revert LotsExceedPosition(cp.lots, 0);
        if ((pos.positionType == Constants.POSITION_LONG) != cp.isLong) revert WrongSide();
        if (cp.lots > pos.lotLNS) revert LotsExceedPosition(cp.lots, pos.lotLNS);

        m.p = _params[cp.perpId];
        p = m.p;
        if (
            m.info.markPNS == 0
                || !ReferenceLib.isFresh(
                    m.info.markTimestamp, p.refFreshSec, Constants.REF_TS_TOLERANCE_SEC, block.timestamp, 0
                )
        ) revert MarkStale(m.info.markTimestamp);
        SigmaState memory sg = _sigma[cp.perpId];
        if (sg.postedBlock == 0 || block.number - sg.postedBlock > p.sigmaMaxAgeBlocks) {
            revert SigmaStale(sg.postedBlock);
        }

        // M-02: distance from the least favorable of the fresh mark, oracle, feed and the book top.
        (uint256 px,) = _worstPx(m, cp.isLong, true);
        q = PremiumMath.quote(p, _quoteInput(cp, px, m.c.scale, sg.sigmaBlkBpsE2));
        _checkCapacity(cp.perpId, q, p.marketCapBps);
        _checkBuffer(cp, pos, q.capCNS, m.c.scale, p.maxLossToDepositBps);
    }

    function _quoteInput(CoverParams calldata cp, uint256 markPNS, uint256 scale, uint256 sigma)
        internal
        view
        returns (PremiumMath.QuoteInput memory qi)
    {
        ICoverVault v = ICoverVault(VAULT);
        qi = PremiumMath.QuoteInput({
            lots: cp.lots,
            stopPNS: cp.stopPNS,
            isLong: cp.isLong,
            maxGapBps: cp.maxGapBps,
            durationBlocks: cp.durationBlocks,
            markPNS: markPNS,
            scale: scale,
            sigmaBlkBpsE2: sigma,
            reservedTotalCNS: v.reservedTotal(),
            totalAssetsCNS: v.totalAssets(),
            blockNumber: block.number
        });
    }

    /// @dev Mirrors the vault's reserve checks so quote() reverts like openCover; the vault stays authoritative.
    function _checkCapacity(uint256 perpId, Quote memory q, uint16 marketCapBps) internal view {
        ICoverVault v = ICoverVault(VAULT);
        uint256 maxUtil = v.config().maxUtilizationBps;
        if (q.utilAfterBps > maxUtil) revert ICoverVault.UtilizationExceeded(q.utilAfterBps, maxUtil);
        uint256 after_ = v.reserved(perpId) + q.capCNS;
        uint256 limit = v.totalAssets() * marketCapBps / Constants.BPS;
        if (after_ > limit) revert ICoverVault.MarketCapExceeded(perpId, after_, limit);
        // L-09: one cover may hold at most a fixed share of the market, so pinning capacity takes many positions.
        uint256 shareLimit = limit * Constants.MAX_COVER_CAP_SHARE_BPS / Constants.BPS;
        if (q.capCNS > shareLimit) revert CoverShareExceeded(q.capCNS, shareLimit);
    }

    /// @dev D40: loss at stop + Cap <= maxLossToDeposit of the deposit backing the covered lots (pro rata).
    function _checkBuffer(
        CoverParams calldata cp,
        IPerplMin.PositionInfo memory pos,
        uint256 cap,
        uint256 scale,
        uint16 maxLossBps
    ) internal pure {
        uint256 entry = pos.pricePNS;
        uint256 lossPx = cp.isLong
            ? (entry > cp.stopPNS ? entry - cp.stopPNS : 0)
            : (cp.stopPNS > entry ? cp.stopPNS - entry : 0);
        uint256 lossPlusCap = lossPx * cp.lots * scale + cap;
        uint256 limit = Math.mulDiv(pos.depositCNS * maxLossBps, cp.lots, pos.lotLNS * Constants.BPS);
        if (lossPlusCap > limit) revert LiquidationBufferTooThin(lossPlusCap, limit);
    }

    // Internal: lifecycle

    /// @dev L-07: each call fills min(remaining, position) or consumes maxMatchesClose resting orders (each at
    /// least one lot) and may repeat within a block, so dust spam costs at most ceil(lots / maxMatches) calls.
    function _triggerRemainder(bytes32 id, Cover storage c) internal returns (uint256) {
        Market memory m = _market(c.perpId);
        if (c.filledLots >= c.lots || block.number > uint256(c.triggerBlock) + c.windowBlocks) {
            revert ConditionNotMet();
        }
        IPerplMin.PositionInfo memory pos = _position(c.account, c.perpId);
        if (pos.lotLNS == 0 || _flipped(c, pos)) revert ConditionNotMet();
        uint256 refTrig = c.refTrigPNS;
        (uint256 refNow,) = _ref(m, _sources(m), c.isLong, 0);
        bool through = _through(c, refNow) && _through(c, refTrig);
        return _close(id, c, m.p, m.c.scale, refTrig, through, pos.lotLNS, false);
    }

    /// @dev Reduce-only IOC through the account, then pay the bounded entitlement. Lots clamp to the position.
    /// `through`: the fresh reference (and for a remainder also R_trig) is at or through the stop.
    function _close(
        bytes32 id,
        Cover storage c,
        MarketParams memory p,
        uint256 scale,
        uint256 refTrig,
        bool through,
        uint256 posLots,
        bool first
    ) internal returns (uint256 paidNow) {
        uint256 k = _step(id, c, through);
        (CloseResult memory r, uint256 limit, uint256 lots) = _closeCall(c, p, refTrig, k, posLots);
        bool shortThrough = through && r.filledLots < lots;
        if (!shortThrough) _resetChain(id, c);
        // SA3-02: short with the book still at or better than the limit means maxMatches ran out (dust,
        // self-match), not liquidity: the step holds (C7: timed from this attempt).
        else if (_bookThin(c, limit)) _advance(id, c, k);
        else _hold(id, c, k);
        if (r.filledLots == 0) {
            emit TriggerNoFill(id, block.number, limit);
            return 0;
        }
        if (first) {
            c.status = CoverStatus.Triggered;
            c.triggerBlock = block.number.toUint48();
            c.triggerTs = block.timestamp.toUint40();
            c.refTrigPNS = _toPNS32(refTrig);
        }
        return _applyFill(id, c, p, scale, r);
    }

    function _applyFill(bytes32 id, Cover storage c, MarketParams memory p, uint256 scale, CloseResult memory r)
        internal
        returns (uint256 paidNow)
    {
        c.filledLots += uint40(r.filledLots); // r.filledLots <= remaining lots (uint40), checked in _closeCall
        c.gRealCumCNS += PayoutMath.gRealCNS(r, c.stopPNS, scale, c.isLong).toUint128();
        uint256 gRef = PayoutMath.gRefCNS(c.stopPNS, c.refTrigPNS, c.filledLots, scale, c.isLong);
        paidNow = _settle(id, c, p, scale, gRef);
        _emitTriggered(id, c, r, paidNow);
    }

    function _closeCall(Cover storage c, MarketParams memory p, uint256 ref, uint256 k, uint256 posLots)
        internal
        returns (CloseResult memory r, uint256 limit, uint256 lots)
    {
        lots = Math.min(uint256(c.lots) - c.filledLots, posLots);
        limit = _closeLimit(c, ref, k);
        r = IGaplessAccount(c.account).closeForCover(c.perpId, c.isLong, lots, limit, p.maxMatchesClose);
        if (r.filledLots == 0) return (r, limit, lots);
        // Measure, do not trust: the reported fill must equal the position delta and stay within the request.
        uint256 delta = posLots - _position(c.account, c.perpId).lotLNS;
        if (r.filledLots > lots || r.filledLots != delta) revert LotsExceedPosition(r.filledLots, delta);
    }

    /// @dev Step 0: R x (1 -/+ A). Step k >= 1 (k short attempts of this touch, R through): min(stop, R) widened by
    /// min(floorSlack, A x 2^k). R = 0 keeps the D49 floor. Clamped to Perpl's range (L-06).
    function _closeLimit(Cover storage c, uint256 ref, uint256 k) internal view returns (uint256 limit) {
        if (ref == 0) {
            limit = PayoutMath.closeLimitPNS(c.stopPNS, 0, c.maxGapBps, c.floorSlackBps, c.isLong);
        } else if (k == 0) {
            limit = PayoutMath.tightLimitPNS(ref, c.slipAllowanceBps, c.isLong);
        } else {
            limit = PayoutMath.closeLimitPNS(c.stopPNS, ref, c.maxGapBps, _allowanceBps(c, k), c.isLong);
        }
        limit = Math.min(Math.max(limit, Constants.PERPL_MIN_PRICE_PNS), Constants.PERPL_MAX_PRICE_PNS);
    }

    /// @return min(floorSlack, A x 2^k) for k <= CLOSE_FLOOR_MAX_STEPS.
    function _allowanceBps(Cover storage c, uint256 k) internal view returns (uint16) {
        return uint16(Math.min(c.floorSlackBps, uint256(c.slipAllowanceBps) << k)); // <= floorSlack (uint16)
    }

    /// @dev N-01, C7: the step of this attempt. A chain continues while R is through the stop and the touch's most
    /// recent attempt (shortBlock) is at most STEP_MAX_GAP_BLOCKS back; a same-block retry reuses that attempt's step.
    function _step(bytes32 id, Cover storage c, bool through) internal view returns (uint256) {
        uint256 sb = c.shortBlock;
        if (!through || sb == 0 || block.number - sb > Constants.STEP_MAX_GAP_BLOCKS) return 0;
        if (block.number != sb) return c.shortSteps;
        return _heldBlock[id] == sb ? c.shortSteps : c.shortSteps - 1; // shortSteps >= 1 whenever sb != 0
    }

    /// @dev Thin book after a short attempt at step k: the next block uses k + 1. One step per block: a later
    /// attempt in the same block advances only if this block's earlier attempt held.
    function _advance(bytes32 id, Cover storage c, uint256 k) internal {
        if (c.shortBlock == block.number) {
            if (_heldBlock[id] != block.number) return;
            delete _heldBlock[id];
        }
        c.shortBlock = block.number.toUint48();
        c.shortSteps = uint8(Math.min(k + 1, Constants.CLOSE_FLOOR_MAX_STEPS)); // <= 6
    }

    /// @dev Match-limited attempt (SA3-02): a running chain keeps step k (== shortSteps) and its gap restarts here
    /// (C7, SE2-H1). No chain (k == 0 from another block) is not started.
    function _hold(bytes32 id, Cover storage c, uint256 k) internal {
        if (k == 0 || c.shortBlock == block.number) return;
        c.shortBlock = block.number.toUint48();
        _heldBlock[id] = block.number;
    }

    /// @dev Closing side empty, or its best level worse than the limit (long: best bid < limit; short: ask > limit).
    function _bookThin(Cover storage c, uint256 limit) internal view returns (bool) {
        (uint256 book, bool empty) = ReferenceLib.bookPNS(IPerplMin(EXCHANGE).getPerpetualInfo(c.perpId), c.isLong);
        return empty || (c.isLong ? book < limit : book > limit);
    }

    function _resetChain(bytes32 id, Cover storage c) internal {
        uint256 sb = c.shortBlock;
        if (sb == 0) return;
        if (sb == block.number) delete _heldBlock[id]; // a chain restarted in this block must not read this hold
        c.shortBlock = 0;
        c.shortSteps = 0;
    }

    function _emitTriggered(bytes32 id, Cover storage c, CloseResult memory r, uint256 paidNow) internal {
        emit Triggered(
            id, c.perpId, block.number, r.filledLots, r.realizedCNS, c.gRealCumCNS, c.refTrigPNS, paidNow, c.owedCNS
        );
    }

    /// @dev Pays min(bound, Cap) - paid through the vault's per-block cap; any shortfall is owed (deferral).
    function _settle(bytes32 id, Cover storage c, MarketParams memory p, uint256 scale, uint256 gRef)
        internal
        returns (uint256 paid)
    {
        uint256 sn = uint256(c.stopPNS) * c.filledLots * scale;
        uint256 entitled =
            Math.min(PayoutMath.boundCNS(c.gRealCumCNS, gRef, sn, c.slipAllowanceBps, c.maxGapBps), c.capCNS);
        uint256 owe = entitled > c.paidCNS ? entitled - c.paidCNS : 0;
        if (owe > 0) {
            address account = c.account;
            try ICoverVault(VAULT).payCapped(c.perpId, account, owe, p.perBlockPayoutCapBps) returns (uint256 x) {
                paid = x;
            } catch {}
            if (paid > 0) {
                try IGaplessAccount(account).creditToPerpl(paid) {} catch {}
            }
        }
        uint256 owedBefore = c.owedCNS;
        c.paidCNS += paid.toUint80();
        c.owedCNS = (owe - paid).toUint80();
        if (owe > paid) emit PayoutDeferred(id, owe - paid);
        // L-08: the vault nets deferred payouts out of totalAssets.
        if (owedBefore != owe - paid) ICoverVault(VAULT).updateOwed(owedBefore, owe - paid);
    }

    /// @dev L-05: once the entitlement is final but still owed (cap or frozen account), keep only paid + owed reserved.
    function _releaseExcess(Cover storage c) internal {
        uint256 keep = uint256(c.paidCNS) + c.owedCNS;
        uint256 cap = c.capCNS;
        if (cap <= keep) return;
        c.capCNS = uint80(keep); // keep < cap (uint80)
        ICoverVault(VAULT).release(c.perpId, cap - keep);
    }

    /// @dev Terminal step of finalize: escrow pro rata to the vault (ceil), rent to the vault, refund, release.
    function _closeOut(bytes32 id, Cover storage c, uint256 topUp, uint256 refFinal) internal {
        (uint256 toVault, uint256 refund) = PayoutMath.escrowSplit(c.escrowCNS, c.filledLots, c.lots);
        uint256 income = toVault + c.rentCNS;
        uint256 release = uint256(c.capCNS) - c.paidCNS;
        address account = c.account;
        uint256 perpId = c.perpId;
        c.status = CoverStatus.Finalized;
        _live[perpId].remove(id);
        delete _active[account][perpId];
        emit Finalized(id, topUp, c.paidCNS, refFinal, toVault);

        IERC20 ausd = IERC20(AUSD);
        if (income > 0) {
            ausd.safeTransfer(VAULT, income);
            ICoverVault(VAULT).notifyPremium(income);
        }
        if (refund > 0) _refund(account, refund);
        if (release > 0) ICoverVault(VAULT).release(perpId, release);
    }

    /// @dev Cancel, expire, void and owner close (M-03, N-02). Past expiryBlock every path is an expiry: the escrow is
    /// refunded unless the cover was ever armed, whoever calls and whenever. Before expiry the zone rule applies.
    /// Refunds are plain transfers (C6, L-05 claim on failure). Rent always goes to the vault; Cap is released.
    function _end(bytes32 id, Cover storage c, CoverStatus status, EndReason reason) internal {
        uint256 escrow = c.escrowCNS;
        bool expired = block.number > c.expiryBlock;
        if (expired) (status, reason) = (CoverStatus.Expired, EndReason.Expired);
        uint256 refund = (expired ? c.armedBlock == 0 : _escrowRefundable(c)) ? escrow : 0;
        uint256 income = c.rentCNS + escrow - refund;
        uint256 cap = c.capCNS;
        address account = c.account;
        uint256 perpId = c.perpId;
        c.status = status;
        _live[perpId].remove(id);
        delete _active[account][perpId];
        emit CoverEnded(id, status, reason, refund);
        if (escrow > refund) emit EscrowForfeited(id, escrow - refund);

        if (refund > 0) _refund(account, refund);
        _toVault(income);
        if (cap > 0) ICoverVault(VAULT).release(perpId, cap);
    }

    /// @dev The escrow freed by a shrink follows the same M-03 rule as _end.
    function _resize(bytes32 id, Cover storage c, uint256 newLots) internal {
        (uint256 newCap, uint256 newEscrow) = PayoutMath.resize(c.capCNS, c.escrowCNS, c.lots, newLots);
        uint256 released = uint256(c.capCNS) - newCap;
        uint256 freed = uint256(c.escrowCNS) - newEscrow;
        uint256 refund = _escrowRefundable(c) ? freed : 0;
        c.lots = uint40(newLots); // newLots < c.lots
        c.capCNS = uint80(newCap); // newCap <= capCNS
        c.escrowCNS = uint80(newEscrow); // newEscrow <= escrowCNS
        emit CoverResized(id, newLots, released, refund);
        if (freed > refund) emit EscrowForfeited(id, freed - refund);
        if (refund > 0) _refund(c.account, refund);
        _toVault(freed - refund);
        if (released > 0) ICoverVault(VAULT).release(c.perpId, released);
    }

    /// @dev L-05: a frozen account cannot brick an end path; the refund waits in the manager for claimRefund.
    function _refund(address account, uint256 amount) internal {
        if (IERC20(AUSD).trySafeTransfer(account, amount)) return;
        refundOwed[account] += amount;
        refundOwedTotal += amount;
        emit RefundOwed(account, amount);
    }

    function _toVault(uint256 amount) internal {
        if (amount == 0) return;
        IERC20(AUSD).safeTransfer(VAULT, amount);
        ICoverVault(VAULT).notifyPremium(amount);
    }

    function _disarm(bytes32 id, Cover storage c, DisarmReason reason) internal returns (uint256) {
        c.status = CoverStatus.Live;
        _resetChain(id, c);
        emit Disarmed(id, reason);
        return 0;
    }

    // Internal: conditions

    /// @dev Armed past armTtl reads as Live everywhere (lazy).
    function _effStatus(Cover storage c) internal view returns (CoverStatus st) {
        st = c.status;
        if (st == CoverStatus.Armed && block.number > uint256(c.armedBlock) + _params[c.perpId].armTtlBlocks) {
            st = CoverStatus.Live;
        }
    }

    /// @dev Book crossed at the stop, or the closing side empty (C1: 0 or max ONS reads as no book).
    function _bookCrossed(Cover storage c, IPerplMin.PerpetualInfo memory info)
        internal
        view
        returns (uint256 book, bool crossed)
    {
        bool empty;
        (book, empty) = ReferenceLib.bookPNS(info, c.isLong);
        crossed = empty || (c.isLong ? book <= c.stopPNS : book >= c.stopPNS);
    }

    /// @dev Reference at or through the stop (long R <= stop, short R >= stop); R = 0 is never through.
    function _through(Cover storage c, uint256 ref) internal view returns (bool) {
        if (ref == 0) return false;
        return c.isLong ? ref <= c.stopPNS : ref >= c.stopPNS;
    }

    /// @dev Armer-only window, and only when it ends before the expiry block (L-02).
    function _exclusive(Cover storage c, MarketParams memory p) internal view returns (bool) {
        uint256 end = uint256(c.armedBlock) + p.exclusiveBlocks;
        return block.number <= end && end < c.expiryBlock;
    }

    /// @dev M-03 before expiry: never armed, and the least favorable fresh reference is at least the purchase-time
    /// minDistance from the stop (N-02: no live sigma or params). No fresh reference reads as not provably far.
    /// A reverting Perpl view drops mark and oracle instead of bricking the end path.
    function _escrowRefundable(Cover storage c) internal view returns (bool) {
        if (c.armedBlock != 0) return false;
        (uint256 px, uint8 n) = _worstPx(_marketSoft(c.perpId), c.isLong, false);
        uint256 stop = c.stopPNS;
        if (n == 0 || (c.isLong ? px <= stop : px >= stop)) return false;
        uint256 d = c.isLong ? (px - stop) * Constants.BPS / px : (stop - px) * Constants.BPS / px;
        return d >= c.minDistanceBps;
    }

    /// @dev Least favorable fresh source for the holder (long: lowest, feed floored); `withBook` adds the book top.
    function _worstPx(Market memory m, bool isLong, bool withBook) internal view returns (uint256 px, uint8 n) {
        uint256[4] memory vals;
        (vals, n) = ReferenceLib.collect(_sources(m), m.p, m.c, !isLong, block.timestamp, 0);
        for (uint256 i; i < n; ++i) {
            if (i == 0 || (isLong ? vals[i] < px : vals[i] > px)) px = vals[i];
        }
        if (withBook) {
            (uint256 book, bool empty) = ReferenceLib.bookPNS(m.info, isLong);
            if (!empty && (px == 0 || (isLong ? book < px : book > px))) px = book;
        }
    }

    /// @dev L-01: a post-trigger reference needs two fresh sources, or one that is not Perpl's mark. Mark alone counts
    /// only on a market with no other source (no feed and Perpl ignoring its oracle).
    function _postRef(Cover storage c, Market memory m, ReferenceLib.Sources memory s)
        internal
        view
        returns (uint256 ref, bool ok)
    {
        uint256 minTs = uint256(c.triggerTs) + 1;
        uint8 n;
        (ref, n) = _ref(m, s, c.isLong, minTs);
        if (n != 1) return (ref, n > 1);
        bool markOnly = s.markPNS > 0
            && ReferenceLib.isFresh(s.markTs, m.p.refFreshSec, Constants.REF_TS_TOLERANCE_SEC, block.timestamp, minTs);
        ok = !markOnly || (m.c.feed == address(0) && m.info.ignOracle);
    }

    /// @dev Long: R <= floor(stop * (1e4 + tol) / 1e4). Short: R >= ceil(stop * (1e4 - tol) / 1e4).
    function _refWithinTol(Cover storage c, MarketParams memory p, uint256 ref) internal view returns (bool) {
        uint256 stop = c.stopPNS;
        if (c.isLong) return ref <= stop * (Constants.BPS + p.refTolBps) / Constants.BPS;
        return ref >= Math.mulDiv(stop, Constants.BPS - p.refTolBps, Constants.BPS, Math.Rounding.Ceil);
    }

    /// @dev Single-block path: past warm-up, venue up, fresh mark at or through the stop.
    function _fastPath(Cover storage c, Market memory m) internal view returns (bool) {
        if (block.number < uint256(c.startBlock) + c.warmupBlocks || !_venueOk(m.info)) return false;
        return _markThrough(c, m);
    }

    function _markThrough(Cover storage c, Market memory m) internal view returns (bool) {
        uint256 mark = m.info.markPNS;
        if (
            mark == 0
                || !ReferenceLib.isFresh(
                    m.info.markTimestamp, m.p.refFreshSec, Constants.REF_TS_TOLERANCE_SEC, block.timestamp, 0
                )
        ) return false;
        return c.isLong ? mark <= c.stopPNS : mark >= c.stopPNS;
    }

    /// @dev Position below the uncovered remainder, gone, or flipped: liquidation or ADL (D40).
    function _broken(Cover storage c, IPerplMin.PositionInfo memory pos) internal view returns (bool) {
        return pos.lotLNS == 0 || pos.lotLNS < uint256(c.lots) - c.filledLots || _flipped(c, pos);
    }

    function _flipped(Cover storage c, IPerplMin.PositionInfo memory pos) internal view returns (bool) {
        return (pos.positionType == Constants.POSITION_LONG) != c.isLong;
    }

    function _venueOk(IPerplMin.PerpetualInfo memory info) internal view returns (bool) {
        return info.status == Constants.PERP_STATUS_ACTIVE && !IPerplMin(EXCHANGE).isHalted();
    }

    function _onlyAccount(address account) internal view {
        address f = factory;
        if (msg.sender != account || f == address(0) || !IGaplessFactory(f).isAccount(account)) revert NotAccount();
    }

    // Internal: reads

    function _market(uint256 perpId) internal view returns (Market memory m) {
        m.p = _params[perpId];
        m.c = _cfg[perpId];
        if (!m.c.listed) revert MarketNotListed(perpId);
        m.info = IPerplMin(EXCHANGE).getPerpetualInfo(perpId);
    }

    /// @dev Like _market, but a reverting Perpl view leaves `info` zeroed (no mark, no oracle, no book, venue down).
    function _marketSoft(uint256 perpId) internal view returns (Market memory m) {
        m.p = _params[perpId];
        m.c = _cfg[perpId];
        try IPerplMin(EXCHANGE).getPerpetualInfo(perpId) returns (IPerplMin.PerpetualInfo memory info) {
            m.info = info;
        } catch {}
    }

    function _position(address account, uint256 perpId) internal view returns (IPerplMin.PositionInfo memory pos) {
        uint256 id = IGaplessAccount(account).perplAccountId();
        if (id == 0) return pos;
        (pos,,) = IPerplMin(EXCHANGE).getPosition(perpId, id);
    }

    function _tryPosition(address account, uint256 perpId)
        internal
        view
        returns (bool ok, IPerplMin.PositionInfo memory pos)
    {
        uint256 id = IGaplessAccount(account).perplAccountId();
        if (id == 0) return (true, pos);
        try IPerplMin(EXCHANGE).getPosition(perpId, id) returns (
            IPerplMin.PositionInfo memory p, uint256, bool
        ) {
            return (true, p);
        } catch {}
    }

    /// @dev Mark and oracle from Perpl (oracle ignored when Perpl flags ignOracle), Chainlink via try/catch.
    function _sources(Market memory m) internal view returns (ReferenceLib.Sources memory s) {
        s.markPNS = m.info.markPNS;
        s.markTs = m.info.markTimestamp;
        if (!m.info.ignOracle) {
            s.oraclePNS = m.info.oraclePNS;
            s.oracleTs = m.info.oracleTimestampSec;
        }
        if (m.c.feed != address(0)) {
            try IAggregatorV3(m.c.feed).latestRoundData() returns (uint80, int256 answer, uint256, uint256 updatedAt, uint80) {
                // answeredInRound is deprecated (Chainlink docs); updatedAt == 0 marks an incomplete round.
                s.feedOk = updatedAt != 0;
                s.feedAnswer = answer;
                s.feedUpdatedAt = updatedAt;
            } catch {}
        }
    }

    function _ref(Market memory m, ReferenceLib.Sources memory s, bool isLong, uint256 minTs)
        internal
        view
        returns (uint256 ref, uint8 n)
    {
        uint256[4] memory vals;
        (vals, n) = ReferenceLib.collect(s, m.p, m.c, isLong, block.timestamp, minTs);
        ref = ReferenceLib.aggregate(vals, n, isLong);
    }

    /// @return 1 arm candidate, 2 trigger candidate, 0 neither.
    function _watchKind(Cover storage c, Market memory m, ReferenceLib.Sources memory s)
        internal
        view
        returns (uint8)
    {
        CoverStatus st = _effStatus(c);
        if (st == CoverStatus.Triggered) {
            return c.filledLots < c.lots && block.number <= uint256(c.triggerBlock) + c.windowBlocks ? 2 : 0;
        }
        if (block.number > c.expiryBlock) return 0;
        if (st == CoverStatus.Armed) return block.number > c.armedBlock || _markThrough(c, m) ? 2 : 0;
        if (st != CoverStatus.Live || block.number < uint256(c.startBlock) + c.warmupBlocks) return 0;
        if (_markThrough(c, m)) return 2;
        if (block.number == c.expiryBlock) return 0; // SA3-01: arm rejects the expiry block
        (uint256 ref, uint8 n) = _ref(m, s, c.isLong, 0);
        (, bool crossed) = _bookCrossed(c, m.info);
        return crossed && _through(c, ref) && n > 0 ? 1 : 0;
    }

    /// @return 1 observe, 2 finalize, 3 expire, 4 void, 0 none.
    function _houseKind(Cover storage c, Market memory m, ReferenceLib.Sources memory s)
        internal
        view
        returns (uint8)
    {
        CoverStatus st = c.status;
        if (st == CoverStatus.Triggered) {
            uint256 windowEnd = uint256(c.triggerBlock) + c.windowBlocks;
            if (block.number > windowEnd || (c.observed && c.filledLots == c.lots)) return 2;
            if (!c.observed && block.number > c.triggerBlock) {
                (, bool ok) = _postRef(c, m, s);
                if (ok) return 1;
            }
            return 0;
        }
        if (st != CoverStatus.Live && st != CoverStatus.Armed) return 0;
        if (block.number > c.expiryBlock) return 3;
        (bool known, IPerplMin.PositionInfo memory pos) = _tryPosition(c.account, c.perpId);
        return known && _broken(c, pos) ? 4 : 0;
    }

    function _scanWindow(uint256 len) internal view returns (uint256 start, uint256 count) {
        if (len <= SCAN_LIMIT) return (0, len);
        return ((block.number * SCAN_LIMIT) % len, SCAN_LIMIT);
    }

    // Internal: validation

    function _checkConfig(uint256 perpId, MarketConfig calldata cfg) internal view {
        uint8 f = Constants.F_MARKET_CONFIG;
        uint256 pd = cfg.priceDecimals;
        uint256 ld = cfg.lotDecimals;
        if (perpId > type(uint16).max || pd + ld > Constants.PERPL_MAX_PD_PLUS_LD) revert ParamOutOfBounds(f);
        if (cfg.scale != 10 ** (Constants.PERPL_MAX_PD_PLUS_LD - pd - ld) || cfg.creRefStore != address(0)) {
            revert ParamOutOfBounds(f);
        }
        if (cfg.feed != address(0)) {
            if (cfg.feedDecimals < pd || cfg.feed.code.length == 0) revert ParamOutOfBounds(f);
            if (IAggregatorV3(cfg.feed).decimals() != cfg.feedDecimals) revert ParamOutOfBounds(f);
        }
        IPerplMin.PerpetualInfo memory info = IPerplMin(EXCHANGE).getPerpetualInfo(perpId);
        if (info.priceDecimals != pd || info.lotDecimals != ld) revert ParamOutOfBounds(f);
        // L-06: Perpl's limit range [1, 2^24 - 1] is verified on markets with base 0 only.
        if (info.basePricePNS != 0) revert ParamOutOfBounds(f);
    }

    function _checkParams(MarketParams calldata p) internal pure {
        // forgefmt: disable-start
        _in(p.slipAllowanceBps, Constants.SLIP_ALLOWANCE_BPS_MIN, Constants.SLIP_ALLOWANCE_BPS_MAX, Constants.F_SLIP_ALLOWANCE);
        _in(p.maxGapBpsCap, Constants.MAX_GAP_BPS_CAP_MIN, Constants.MAX_GAP_BPS_CAP_MAX, Constants.F_MAX_GAP_CAP);
        _in(p.floorSlackBps, Constants.FLOOR_SLACK_BPS_MIN, Constants.FLOOR_SLACK_BPS_MAX, Constants.F_FLOOR_SLACK);
        _in(p.refTolBps, Constants.REF_TOL_BPS_MIN, Constants.REF_TOL_BPS_MAX, Constants.F_REF_TOL);
        _in(p.minStopDistanceBps, Constants.MIN_STOP_DISTANCE_BPS_MIN, Constants.MIN_STOP_DISTANCE_BPS_MAX, Constants.F_MIN_STOP_DISTANCE);
        _in(p.kDistE2, Constants.K_DIST_E2_MIN, Constants.K_DIST_E2_MAX, Constants.F_K_DIST);
        _in(p.loadBps, Constants.LOAD_BPS_MIN, Constants.LOAD_BPS_MAX, Constants.F_LOAD);
        _in(p.rentAprBps, Constants.RENT_APR_BPS_MIN, Constants.RENT_APR_BPS_MAX, Constants.F_RENT_APR);
        _in(p.uKinkBps, Constants.U_KINK_BPS_MIN, Constants.U_KINK_BPS_MAX, Constants.F_U_KINK);
        _in(p.slope1Bps, Constants.SLOPE1_BPS_MIN, Constants.SLOPE1_BPS_MAX, Constants.F_SLOPE1);
        _in(p.slope2Bps, Constants.SLOPE2_BPS_MIN, Constants.SLOPE2_BPS_MAX, Constants.F_SLOPE2);
        _in(p.marketCapBps, Constants.MARKET_CAP_BPS_MIN, Constants.MARKET_CAP_BPS_MAX, Constants.F_MARKET_CAP);
        _in(p.perBlockPayoutCapBps, Constants.PER_BLOCK_PAYOUT_CAP_BPS_MIN, Constants.PER_BLOCK_PAYOUT_CAP_BPS_MAX, Constants.F_PER_BLOCK_PAYOUT_CAP);
        _in(p.maxLossToDepositBps, Constants.MAX_LOSS_TO_DEPOSIT_BPS_MIN, Constants.MAX_LOSS_TO_DEPOSIT_BPS_MAX, Constants.F_MAX_LOSS_TO_DEPOSIT);
        _in(p.impactBpsPerKE2, Constants.IMPACT_BPS_PER_K_E2_MIN, Constants.IMPACT_BPS_PER_K_E2_MAX, Constants.F_IMPACT);
        _in(p.maxMatchesClose, Constants.MAX_MATCHES_CLOSE_MIN, Constants.MAX_MATCHES_CLOSE_MAX, Constants.F_MAX_MATCHES_CLOSE);
        _in(p.warmupBlocks, Constants.WARMUP_BLOCKS_MIN, Constants.WARMUP_BLOCKS_MAX, Constants.F_WARMUP);
        _in(p.armTtlBlocks, Constants.ARM_TTL_BLOCKS_MIN, Constants.ARM_TTL_BLOCKS_MAX, Constants.F_ARM_TTL);
        _in(p.exclusiveBlocks, Constants.EXCLUSIVE_BLOCKS_MIN, Constants.EXCLUSIVE_BLOCKS_MAX, Constants.F_EXCLUSIVE);
        _in(p.windowBlocks, Constants.WINDOW_BLOCKS_MIN, Constants.WINDOW_BLOCKS_MAX, Constants.F_WINDOW);
        _in(p.minDurationBlocks, Constants.DURATION_BLOCKS_MIN, Constants.DURATION_BLOCKS_MAX, Constants.F_MIN_DURATION);
        _in(p.maxDurationBlocks, Constants.DURATION_BLOCKS_MIN, Constants.DURATION_BLOCKS_MAX, Constants.F_MAX_DURATION);
        _in(p.sigmaMaxAgeBlocks, Constants.SIGMA_MAX_AGE_BLOCKS_MIN, Constants.SIGMA_MAX_AGE_BLOCKS_MAX, Constants.F_SIGMA_MAX_AGE);
        _in(p.refFreshSec, Constants.REF_FRESH_SEC_MIN, Constants.REF_FRESH_SEC_MAX, Constants.F_REF_FRESH);
        _in(p.feedMaxAgeSec, Constants.FEED_MAX_AGE_SEC_MIN, Constants.FEED_MAX_AGE_SEC_MAX, Constants.F_FEED_MAX_AGE);
        _in(p.minFeeCNS, Constants.MIN_FEE_CNS_MIN, Constants.MIN_FEE_CNS_MAX, Constants.F_MIN_FEE);
        _in(p.maxCoverNotionalCNS, Constants.MAX_COVER_NOTIONAL_CNS_MIN, Constants.MAX_COVER_NOTIONAL_CNS_MAX, Constants.F_MAX_COVER_NOTIONAL);
        // forgefmt: disable-end
        if (p.zEdgesE2[0] == 0) revert ParamOutOfBounds(Constants.F_Z_EDGES);
        for (uint256 i = 1; i < 8; ++i) {
            if (p.zEdgesE2[i] <= p.zEdgesE2[i - 1]) revert ParamOutOfBounds(Constants.F_Z_EDGES);
        }
        uint256 gapMax = uint256(p.maxGapBpsCap) * 100;
        for (uint256 i; i < 9; ++i) {
            if (p.gapBpsE2[i] > gapMax) revert ParamOutOfBounds(Constants.F_GAP_TABLE);
        }
        if (p.minDurationBlocks > p.maxDurationBlocks) revert ParamOutOfBounds(Constants.F_DURATION_ORDER);
        if (uint256(p.maxDurationBlocks) + p.windowBlocks + p.armTtlBlocks > Constants.COOLDOWN_BLOCKS) {
            revert ParamOutOfBounds(Constants.F_COOLDOWN_COVERAGE);
        }
        if (p.warmupBlocks >= p.minDurationBlocks) revert ParamOutOfBounds(Constants.F_WARMUP_VS_DURATION);
        // SA3-I6: step 1 must be at least 2A wide, so every widened step is wider than step 0 (A).
        if (p.floorSlackBps < 2 * uint256(p.slipAllowanceBps)) revert ParamOutOfBounds(Constants.F_FLOOR_SLACK_VS_SLIP);
    }

    function _in(uint256 v, uint256 lo, uint256 hi, uint8 field) internal pure {
        if (v < lo || v > hi) revert ParamOutOfBounds(field);
    }

    // Internal: helpers

    /// @dev References above uint32 max are clamped: long G_ref is 0 there anyway and short G_ref only shrinks.
    function _toPNS32(uint256 v) internal pure returns (uint32) {
        return uint32(Math.min(v, type(uint32).max));
    }

    function _shrink(bytes32[] memory a, uint256 n) internal pure {
        assembly ("memory-safe") {
            mstore(a, n)
        }
    }

    function _emitBought(bytes32 id, address account, CoverParams calldata p, Quote memory q) internal {
        emit CoverBought(
            id,
            account,
            p.perpId,
            p.isLong,
            p.lots,
            p.stopPNS,
            p.maxGapBps,
            q.escrowCNS,
            q.rentCNS,
            q.capCNS,
            q.expiryBlock
        );
    }
}
