// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {IERC5267} from "@openzeppelin/contracts/interfaces/IERC5267.sol";
import {IPerplMin} from "./perpl/IPerplMin.sol";
import {CoverParams, OperatorGrant, CloseResult} from "../types/GaplessTypes.sol";

/// @title IGaplessAccount
/// @notice User-owned clone that owns one direct Perpl account, trades it, buys covers and receives payouts.
/// @dev Owner = Mera idx0 key (or agent wallet). Operator = scoped idx1 key: trade and cover only, never withdraw.
/// Operator is live iff msg.sender == operator.key && block.timestamp < operator.expiry.
/// EIP-712 domain per clone: name "GaplessAccount", version "1", verifyingContract = the clone.
/// Manager hooks (closeForCover, creditToPerpl) are never invoked from inside an account-originated call.
interface IGaplessAccount is IERC5267 {
    event OperatorSet(address indexed key, uint64 expiry, uint128 maxNotionalPerTradeCNS, uint128 maxNotionalPerDayCNS);
    event PerplActivated(uint256 indexed perplAccountId, uint256 depositCNS);
    event Traded(uint256 indexed perpId, uint8 orderType, uint256 lotLNS, uint256 pricePNS, address indexed by);
    event Withdrawn(address indexed to, uint256 amountCNS);
    /// @notice Wallet AUSD moved into Perpl (sweep, permit deposit, or activation).
    event Swept(uint256 amountCNS);
    /// @notice Manager payout received; `toPerpl` false when it stayed in the wallet. Refunds arrive as plain AUSD
    /// transfers (no event here).
    event Credited(uint256 amountCNS, bool toPerpl);

    error NotOwner();
    error NotOwnerOrOperator();
    error OperatorExpired(uint64 expiry);
    error NotionalCapExceeded(uint256 notionalCNS, uint256 capCNS);
    error BadOrderType(uint8 orderType);
    error PerpLocked(uint256 perpId); // cover Armed or Triggered on this perp
    error NotManager();
    error NotFactory();
    error AlreadyInitialized();
    error PerplNotActive();
    error SigExpired();
    error BadSig();
    error ZeroAmount();
    error ZeroAddress();
    error PremiumUnfunded(uint256 needCNS, uint256 availableCNS);
    error LimitOffMarket(uint256 limitPNS, uint256 markPNS);
    error CloseExceedsPosition(uint256 lots, uint256 positionLots);
    /// @notice N-03: the operator's rolling notional budget (maxNotionalPerDayCNS) cannot absorb this order or cover.
    error OperatorBudgetExceeded(uint256 notionalCNS, uint256 availableCNS);

    /// @notice One-time setup by the factory right after cloning.
    function initialize(address owner_, OperatorGrant calldata grant) external;

    function EX() external view returns (address);
    function AUSD() external view returns (address);
    function FACTORY() external view returns (address);
    function MANAGER() external view returns (address);
    function VAULT() external view returns (address);
    /// @notice Perpl builder id; 0 means `execOrderV2` is sent with an empty extension.
    function BUILDER_ID() external view returns (uint8);
    /// @notice keccak256("Withdraw(address account,uint256 amount,uint256 nonce,uint256 deadline)")
    function WITHDRAW_TYPEHASH() external view returns (bytes32);
    /// @notice keccak256("SetOperator(address account,address key,uint64 expiry,uint128 maxNotional,uint128 maxNotionalPerDay,uint256 nonce,uint256 deadline)")
    function SET_OPERATOR_TYPEHASH() external view returns (bytes32);
    function DOMAIN_SEPARATOR() external view returns (bytes32);

    function owner() external view returns (address);
    function operator() external view returns (OperatorGrant memory);
    /// @notice N-03 budget: notional charged in the rolling window (decays linearly over OPERATOR_WINDOW_SEC) and
    /// what the operator may still trade or cover now.
    function operatorUsage() external view returns (uint256 usedCNS, uint256 availableCNS);
    /// @return Perpl account id, 0 until activated.
    function perplAccountId() external view returns (uint256);
    /// @return Next EIP-712 nonce shared by Withdraw and SetOperator; setOperator and revokeOperator also bump it.
    function opNonce() external view returns (uint256);

    /// @notice Permissionless. Deposits all wallet AUSD into Perpl, or opens the Perpl account when inactive
    /// and wallet AUSD >= getMinAccountOpenCNS(). No-op below the minimum.
    function sweep() external;

    /// @notice Pull `amountCNS` from the owner with an AUSD permit (domain "Agora Dollar"), then sweep.
    /// @dev Anyone may relay. A front-run permit must not brick the call (check allowance on permit failure).
    function depositWithPermit(uint256 amountCNS, uint256 deadline, uint8 v, bytes32 r, bytes32 s) external;

    /// @notice Owner or live operator. orderType 0..6; account overwrites orderDescId. Operator orders (M-01):
    /// limit within OPERATOR_MAX_LIMIT_DEVIATION_BPS of mark (types 0, 1, 2, 3, 6); notional of types 0, 1, 6 =
    /// lotLNS * max(pricePNS, mark) * 10^(6 - pd - ld) <= maxNotionalPerTradeCNS; closes (2, 3) <= position lots.
    /// Every operator order except 4 and 5 (closes included) is charged lotLNS * max(pricePNS, mark) * scale to the
    /// rolling budget maxNotionalPerDayCNS (N-03, OperatorBudgetExceeded); operator buys are charged the cover notional.
    /// Reverts PerpLocked while the perp's cover is Armed or Triggered. Calls manager.syncCover when a cover is active.
    function trade(IPerplMin.OrderDesc calldata d) external;

    /// @notice trade() then buy a cover on the resulting position in one tx.
    /// @param maxPremiumCNS Upper bound on escrow + rent; paid from wallet AUSD first, then Perpl free balance.
    function tradeAndCover(IPerplMin.OrderDesc calldata d, CoverParams calldata p, uint256 maxPremiumCNS)
        external
        returns (bytes32 coverId);

    /// @notice Owner or live operator. Buys a cover on an existing position.
    function buyCover(CoverParams calldata p, uint256 maxPremiumCNS) external returns (bytes32 coverId);

    /// @notice Owner or live operator (also with no budget left, SA3-I5). Live covers only; rent to the vault, escrow refunded to this wallet only when
    /// the cover was never armed and the price is at least the purchase-time minDistance from the stop (M-03, N-02),
    /// else kept by the vault. Past expiry it resolves exactly like expire.
    function cancelCover(bytes32 coverId) external;

    /// @notice Owner only. Pays the owner from wallet AUSD first, then Perpl free balance.
    function withdraw(uint256 amountCNS) external;
    /// @notice Anyone relays an owner Withdraw signature; always pays the owner.
    function withdrawWithSig(uint256 amountCNS, uint256 deadline, bytes calldata ownerSig) external;
    /// @notice Owner only. The daily budget is checkpointed at the old grant's rate first, so a new cap applies only
    /// from now on (SA3-I4); revoking stops decay until the next grant.
    function setOperator(OperatorGrant calldata g) external;
    function setOperatorWithSig(OperatorGrant calldata g, uint256 deadline, bytes calldata ownerSig) external;
    function revokeOperator() external;

    /// @notice Manager only. Reduce-only IOC close (spec 3.8 recipe) measured by storage deltas.
    /// @dev Clamps lots to the position; returns a zero result when the position is gone or on the other side.
    function closeForCover(uint256 perpId, bool isLong, uint256 lots, uint256 limitPNS, uint256 maxMatches)
        external
        returns (CloseResult memory r);

    /// @notice Manager only. Deposits `amountCNS` of received AUSD into Perpl; keeps it in the wallet when
    /// Perpl is inactive or the deposit fails, so a payout never reverts on the account side.
    function creditToPerpl(uint256 amountCNS) external;
}
