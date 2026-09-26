// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Permit.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {IGaplessAccount} from "./interfaces/IGaplessAccount.sol";
import {ICoverManager} from "./interfaces/ICoverManager.sol";
import {IPerplMin} from "./interfaces/perpl/IPerplMin.sol";
import {CoverParams, OperatorGrant, CloseResult, Quote} from "./types/GaplessTypes.sol";
import {Constants} from "./Constants.sol";

/// @title GaplessAccount
/// @notice User-owned clone that owns one direct Perpl account, trades it, buys covers and receives payouts.
/// @dev Deployed once as the implementation by GaplessFactory (FACTORY = factory); users get EIP-1167 clones.
/// The implementation is locked (owner = 0xdEaD). Funds only ever leave to the owner, Perpl or the manager
/// (exact premium allowance, reset to 0). No delegatecall, no tx.origin, no user-supplied recipients.
contract GaplessAccount is IGaplessAccount, EIP712, ReentrancyGuardTransient {
    using SafeERC20 for IERC20;
    using SafeCast for uint256;

    bytes32 public constant WITHDRAW_TYPEHASH = Constants.WITHDRAW_TYPEHASH;
    bytes32 public constant SET_OPERATOR_TYPEHASH = Constants.SET_OPERATOR_TYPEHASH;
    uint256 internal constant MAX_FEE_TIER = 7;

    address public immutable EX;
    address public immutable AUSD;
    address public immutable FACTORY;
    address public immutable MANAGER;
    address public immutable VAULT;
    uint8 public immutable BUILDER_ID;

    address public owner;
    uint256 public perplAccountId;
    uint256 public opNonce;
    OperatorGrant internal _operator;
    uint256 internal _descId;
    /// @dev N-03 leaky bucket: operator notional charged, decaying linearly to 0 over OPERATOR_WINDOW_SEC.
    uint128 internal _opUsedCNS;
    uint64 internal _opUsedAt;

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier onlyManager() {
        if (msg.sender != MANAGER) revert NotManager();
        _;
    }

    /// @dev msg.sender is the factory. Setting owner locks initialize on the implementation itself.
    constructor(address ex, address ausd, address manager, address vault, uint8 builderId)
        EIP712(Constants.ACCOUNT_EIP712_NAME, Constants.EIP712_VERSION)
    {
        if (ex == address(0) || ausd == address(0) || manager == address(0) || vault == address(0)) {
            revert ZeroAddress();
        }
        EX = ex;
        AUSD = ausd;
        FACTORY = msg.sender;
        MANAGER = manager;
        VAULT = vault;
        BUILDER_ID = builderId;
        owner = Constants.DEAD;
    }

    /// @inheritdoc IGaplessAccount
    function initialize(address owner_, OperatorGrant calldata grant) external {
        if (msg.sender != FACTORY) revert NotFactory();
        if (owner != address(0)) revert AlreadyInitialized();
        if (owner_ == address(0)) revert ZeroAddress();
        owner = owner_;
        if (grant.key != address(0)) _setOperator(grant);
    }

    // Funding

    /// @inheritdoc IGaplessAccount
    function sweep() external nonReentrant {
        _sweep();
    }

    /// @inheritdoc IGaplessAccount
    function depositWithPermit(uint256 amountCNS, uint256 deadline, uint8 v, bytes32 r, bytes32 s)
        external
        nonReentrant
    {
        if (amountCNS == 0) revert ZeroAmount();
        address o = owner;
        IERC20 a = IERC20(AUSD);
        // A front-run permit consumes the nonce; proceed when the allowance is already in place.
        try IERC20Permit(AUSD).permit(o, address(this), amountCNS, deadline, v, r, s) {}
        catch {
            if (a.allowance(o, address(this)) < amountCNS) revert BadSig();
        }
        a.safeTransferFrom(o, address(this), amountCNS);
        _sweep();
    }

    // Trading and cover

    /// @inheritdoc IGaplessAccount
    function trade(IPerplMin.OrderDesc calldata d) external nonReentrant {
        _trade(d, _authorize());
    }

    /// @inheritdoc IGaplessAccount
    function tradeAndCover(IPerplMin.OrderDesc calldata d, CoverParams calldata p, uint256 maxPremiumCNS)
        external
        nonReentrant
        returns (bytes32 coverId)
    {
        bool isOperator = _authorize();
        _trade(d, isOperator);
        coverId = _buyCover(p, maxPremiumCNS, isOperator);
    }

    /// @inheritdoc IGaplessAccount
    function buyCover(CoverParams calldata p, uint256 maxPremiumCNS) external nonReentrant returns (bytes32 coverId) {
        coverId = _buyCover(p, maxPremiumCNS, _authorize());
    }

    /// @inheritdoc IGaplessAccount
    /// @dev Operators may cancel even with no budget left (SA3-I5, intended): no notional moves, the refund stays in
    /// this account, and the PWA cancel flow runs on the session key. A leaked key can at most forfeit one escrow.
    function cancelCover(bytes32 coverId) external nonReentrant {
        _authorize();
        ICoverManager(MANAGER).cancelCover(address(this), coverId);
    }

    // Owner

    /// @inheritdoc IGaplessAccount
    function withdraw(uint256 amountCNS) external nonReentrant onlyOwner {
        _payOwner(amountCNS);
    }

    /// @inheritdoc IGaplessAccount
    function withdrawWithSig(uint256 amountCNS, uint256 deadline, bytes calldata ownerSig) external nonReentrant {
        if (block.timestamp > deadline) revert SigExpired();
        bytes32 structHash = keccak256(abi.encode(WITHDRAW_TYPEHASH, address(this), amountCNS, opNonce++, deadline));
        _checkOwnerSig(structHash, ownerSig);
        _payOwner(amountCNS);
    }

    /// @inheritdoc IGaplessAccount
    /// @dev Bumps opNonce so an older signed SetOperator cannot resurrect a replaced key.
    function setOperator(OperatorGrant calldata g) external nonReentrant onlyOwner {
        ++opNonce;
        _setOperator(g);
    }

    /// @inheritdoc IGaplessAccount
    function setOperatorWithSig(OperatorGrant calldata g, uint256 deadline, bytes calldata ownerSig)
        external
        nonReentrant
    {
        if (block.timestamp > deadline) revert SigExpired();
        bytes32 structHash = keccak256(
            abi.encode(
                SET_OPERATOR_TYPEHASH,
                address(this),
                g.key,
                g.expiry,
                g.maxNotionalPerTradeCNS,
                g.maxNotionalPerDayCNS,
                opNonce++,
                deadline
            )
        );
        _checkOwnerSig(structHash, ownerSig);
        _setOperator(g);
    }

    /// @inheritdoc IGaplessAccount
    function revokeOperator() external nonReentrant onlyOwner {
        ++opNonce;
        _checkpointOperator();
        delete _operator;
        emit OperatorSet(address(0), 0, 0, 0);
    }

    // Manager

    /// @inheritdoc IGaplessAccount
    /// @dev Spec 3.8 recipe. A zero-fill IOC returns normally, so every field comes from re-read storage.
    function closeForCover(uint256 perpId, bool isLong, uint256 lots, uint256 limitPNS, uint256 maxMatches)
        external
        nonReentrant
        onlyManager
        returns (CloseResult memory r)
    {
        uint256 id = perplAccountId;
        if (id == 0 || lots == 0) return r;
        IPerplMin ex = IPerplMin(EX);
        (IPerplMin.PositionInfo memory p0,,) = ex.getPosition(perpId, id);
        uint8 side = isLong ? Constants.POSITION_LONG : Constants.POSITION_SHORT;
        if (p0.lotLNS == 0 || p0.positionType != side) return r;

        uint256 feePpm = _takerFeePpm(perpId, id);
        uint256 equity0 = _equityCNS(id);
        // Clamp: a close larger than the position reverts CloseOrderExceedsPosition.
        ex.execOrder(_closeDesc(perpId, isLong, Math.min(lots, p0.lotLNS), limitPNS, maxMatches));

        (IPerplMin.PositionInfo memory p1,,) = ex.getPosition(perpId, id);
        if (p1.lotLNS >= p0.lotLNS) return r;
        r.filledLots = p0.lotLNS - p1.lotLNS;
        r.releasedDepositCNS = p0.depositCNS > p1.depositCNS ? p0.depositCNS - p1.depositCNS : 0;
        r.realizedCNS = _equityCNS(id).toInt256() - equity0.toInt256();
        r.entryPNS = p0.pricePNS;
        r.fundingCNS = _fundingShare(p0.premiumPnlCNS, r.filledLots, p0.lotLNS);
        r.takerFeePpm = feePpm;
    }

    /// @inheritdoc IGaplessAccount
    /// @dev Never reverts on Perpl failure: the AUSD stays in the wallet and can be swept later.
    function creditToPerpl(uint256 amountCNS) external nonReentrant onlyManager {
        IERC20 a = IERC20(AUSD);
        uint256 amt = Math.min(amountCNS, a.balanceOf(address(this)));
        bool toPerpl;
        if (amt != 0 && perplAccountId != 0) {
            a.forceApprove(EX, amt);
            try IPerplMin(EX).depositCollateral(amt) {
                toPerpl = true;
            } catch {}
            a.forceApprove(EX, 0);
        }
        emit Credited(amt, toPerpl);
    }

    // Views

    function operator() external view returns (OperatorGrant memory) {
        return _operator;
    }

    /// @inheritdoc IGaplessAccount
    function operatorUsage() external view returns (uint256 usedCNS, uint256 availableCNS) {
        usedCNS = _opUsed(_operator.maxNotionalPerDayCNS);
        uint256 cap = _operator.maxNotionalPerDayCNS;
        availableCNS = cap > usedCNS ? cap - usedCNS : 0;
    }

    function DOMAIN_SEPARATOR() external view returns (bytes32) {
        return _domainSeparatorV4();
    }

    // Internal

    /// @return isOperator True when the caller is the live operator rather than the owner.
    function _authorize() internal view returns (bool isOperator) {
        if (msg.sender == owner) return false;
        OperatorGrant memory g = _operator;
        if (g.key == address(0) || msg.sender != g.key) revert NotOwnerOrOperator();
        if (block.timestamp >= g.expiry) revert OperatorExpired(g.expiry);
        return true;
    }

    function _trade(IPerplMin.OrderDesc calldata d, bool isOperator) internal {
        uint8 t = d.orderType;
        if (t > Constants.ORDER_CHANGE) revert BadOrderType(t);
        if (perplAccountId == 0) revert PerplNotActive();
        ICoverManager mgr = ICoverManager(MANAGER);
        if (mgr.isLocked(address(this), d.perpId)) revert PerpLocked(d.perpId);
        if (isOperator && t != Constants.ORDER_CANCEL && t != Constants.ORDER_INCREASE_COLLATERAL) {
            _chargeOperator(_checkOperator(d));
        }

        IPerplMin.OrderDesc memory m = d;
        m.orderDescId = ++_descId;
        IPerplMin(EX).execOrderV2(m, _extension());
        emit Traded(d.perpId, t, d.lotLNS, d.pricePNS, msg.sender);

        if (mgr.activeCoverOf(address(this), d.perpId) != bytes32(0)) mgr.syncCover(address(this), d.perpId);
    }

    /// @dev M-01: the limit must sit within OPERATOR_MAX_LIMIT_DEVIATION_BPS of mark (a sell limit is only a floor);
    /// opens and Change are capped at lots x max(limit, mark); closes may not exceed the position.
    /// @return notional lots x max(limit, mark) in CNS, charged to the rolling budget for every type (N-03).
    function _checkOperator(IPerplMin.OrderDesc calldata d) internal view returns (uint256 notional) {
        IPerplMin ex = IPerplMin(EX);
        IPerplMin.PerpetualInfo memory info = ex.getPerpetualInfo(d.perpId);
        uint256 mark = info.markPNS;
        uint256 px = d.pricePNS;
        uint256 dev = px > mark ? px - mark : mark - px;
        if (mark == 0 || dev * Constants.BPS > mark * Constants.OPERATOR_MAX_LIMIT_DEVIATION_BPS) {
            revert LimitOffMarket(px, mark);
        }
        notional = d.lotLNS * Math.max(px, mark) * 10 ** (6 - info.priceDecimals - info.lotDecimals);
        uint8 t = d.orderType;
        if (t == Constants.ORDER_CLOSE_LONG || t == Constants.ORDER_CLOSE_SHORT) {
            uint256 id = perplAccountId;
            (IPerplMin.PositionInfo memory pos,,) = ex.getPosition(d.perpId, id);
            if (d.lotLNS > pos.lotLNS) revert CloseExceedsPosition(d.lotLNS, pos.lotLNS);
            return notional;
        }
        // Change re-posts an order at new lots and price, so it is capped like an open.
        uint256 cap = _operator.maxNotionalPerTradeCNS;
        if (notional > cap) revert NotionalCapExceeded(notional, cap);
    }

    /// @dev N-03: round trips are bounded by the grant's rolling budget, not only per trade. The bucket survives grant
    /// changes (checkpointed in _setOperator), so re-issuing a grant does not refill it.
    function _chargeOperator(uint256 notional) internal {
        uint256 cap = _operator.maxNotionalPerDayCNS;
        uint256 used = _opUsed(cap);
        if (used + notional > cap) revert OperatorBudgetExceeded(notional, cap > used ? cap - used : 0);
        _opUsedCNS = uint128(used + notional); // <= cap (uint128)
        _opUsedAt = uint64(block.timestamp);
    }

    /// @return Charged notional after linear decay of `cap` per OPERATOR_WINDOW_SEC (decay rounds down).
    function _opUsed(uint256 cap) internal view returns (uint256) {
        uint256 used = _opUsedCNS;
        uint256 decay = Math.mulDiv(cap, block.timestamp - _opUsedAt, Constants.OPERATOR_WINDOW_SEC);
        return used > decay ? used - decay : 0;
    }

    /// @dev SA3-I4: settles decay at the outgoing grant's rate before the grant changes, so a new cap only applies
    /// from now on (no retroactive refill or re-charge). While revoked the cap is 0, so usage does not decay.
    function _checkpointOperator() internal {
        uint256 used = _opUsedCNS;
        if (used == 0) return;
        _opUsedCNS = uint128(_opUsed(_operator.maxNotionalPerDayCNS)); // <= stored value (uint128)
        _opUsedAt = uint64(block.timestamp);
    }

    function _buyCover(CoverParams calldata p, uint256 maxPremiumCNS, bool isOperator)
        internal
        returns (bytes32 coverId)
    {
        ICoverManager mgr = ICoverManager(MANAGER);
        Quote memory q = mgr.quote(address(this), p);
        if (isOperator) _chargeOperator(q.notionalCNS);
        uint256 need = q.escrowCNS + q.rentCNS;
        if (need > maxPremiumCNS) revert ICoverManager.PremiumTooHigh(need, maxPremiumCNS);
        _fundWallet(need);
        IERC20 a = IERC20(AUSD);
        a.forceApprove(address(mgr), need);
        coverId = mgr.openCover(address(this), p, maxPremiumCNS);
        a.forceApprove(address(mgr), 0);
    }

    /// @dev Spec 2.1: wallet AUSD first, then withdraw the shortfall from Perpl free balance; re-read after.
    function _fundWallet(uint256 need) internal {
        IERC20 a = IERC20(AUSD);
        uint256 wallet = a.balanceOf(address(this));
        if (wallet >= need) return;
        uint256 id = perplAccountId;
        uint256 shortfall = need - wallet;
        uint256 free = id == 0 ? 0 : IPerplMin(EX).getAccountById(id).balanceCNS;
        if (free < shortfall) revert PremiumUnfunded(need, wallet + free);
        IPerplMin(EX).withdrawCollateral(shortfall);
        uint256 got = a.balanceOf(address(this));
        if (got < need) revert PremiumUnfunded(need, got);
    }

    function _payOwner(uint256 amountCNS) internal {
        if (amountCNS == 0) revert ZeroAmount();
        IERC20 a = IERC20(AUSD);
        uint256 wallet = a.balanceOf(address(this));
        if (wallet < amountCNS) {
            if (perplAccountId == 0) revert PerplNotActive();
            IPerplMin(EX).withdrawCollateral(amountCNS - wallet);
        }
        address to = owner;
        a.safeTransfer(to, amountCNS);
        emit Withdrawn(to, amountCNS);
    }

    function _sweep() internal {
        IERC20 a = IERC20(AUSD);
        uint256 bal = a.balanceOf(address(this));
        if (bal == 0) return;
        IPerplMin ex = IPerplMin(EX);
        uint256 id = perplAccountId;
        if (id == 0 && bal < ex.getMinAccountOpenCNS()) return;
        a.forceApprove(EX, bal);
        if (id == 0) {
            id = ex.createAccount(bal);
            if (id == 0) revert PerplNotActive();
            perplAccountId = id;
            emit PerplActivated(id, bal);
        } else {
            ex.depositCollateral(bal);
        }
        a.forceApprove(EX, 0);
        emit Swept(bal);
    }

    function _setOperator(OperatorGrant calldata g) internal {
        _checkpointOperator();
        _operator = g;
        emit OperatorSet(g.key, g.expiry, g.maxNotionalPerTradeCNS, g.maxNotionalPerDayCNS);
    }

    /// @dev EOA (ECDSA, low-s enforced by OZ) or ERC-1271 owner.
    function _checkOwnerSig(bytes32 structHash, bytes calldata sig) internal view {
        if (!SignatureChecker.isValidSignatureNowCalldata(owner, _hashTypedDataV4(structHash), sig)) revert BadSig();
    }

    function _closeDesc(uint256 perpId, bool isLong, uint256 lots, uint256 limitPNS, uint256 maxMatches)
        internal
        returns (IPerplMin.OrderDesc memory d)
    {
        d.orderDescId = ++_descId;
        d.perpId = perpId;
        d.orderType = isLong ? Constants.ORDER_CLOSE_LONG : Constants.ORDER_CLOSE_SHORT;
        d.pricePNS = limitPNS;
        d.lotLNS = lots;
        d.immediateOrCancel = true;
        d.maxMatches = maxMatches;
        d.leverageHdths = Constants.CLOSE_LEVERAGE_HDTHS;
        d.lastExecutionBlock = block.number;
        d.maxNegPnlCollatBPS = Constants.CLOSE_MAX_NEG_PNL_BPS;
    }

    /// @dev balance + locked: clearing the trader's own resting orders during the close (self-match or expiry)
    /// unlocks collateral into balance, which must not count as close proceeds.
    function _equityCNS(uint256 id) internal view returns (uint256) {
        IPerplMin.AccountInfo memory a = IPerplMin(EX).getAccountById(id);
        return a.balanceCNS + a.lockedBalanceCNS;
    }

    function _takerFeePpm(uint256 perpId, uint256 id) internal view returns (uint256) {
        uint256 tier = IPerplMin(EX).getAccountFeeTier(id);
        (, uint256[8] memory taker,) = IPerplMin(EX).getPerpFeeSchedule(perpId);
        return taker[Math.min(tier, MAX_FEE_TIER)];
    }

    /// @dev Unreachable on the canary (BUILDER_ID 0); kept for a builder deployment.
    function _extension() internal view returns (bytes memory) {
        if (BUILDER_ID == 0) return "";
        return abi.encode(Constants.PERPL_EXT_VERSION, abi.encode(uint256(BUILDER_ID), Constants.BUILDER_FEE_PER_100K));
    }

    /// @dev premium * filled / lots, floored so the vault never overpays by rounding.
    function _fundingShare(int256 premium, uint256 filled, uint256 lots) internal pure returns (int256 f) {
        int256 num = premium * filled.toInt256();
        int256 den = lots.toInt256();
        f = num / den;
        if (num < 0 && f * den != num) f -= 1;
    }
}
