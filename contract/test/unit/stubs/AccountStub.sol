// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {IPerplMin} from "../../../src/interfaces/perpl/IPerplMin.sol";
import {ICoverManager} from "../../../src/interfaces/ICoverManager.sol";
import {CoverParams, CloseResult} from "../../../src/types/GaplessTypes.sol";

/// @notice S2 interim account: owns a Perpl account on the mock and implements the manager hooks with the
/// closeForCover recipe (01 section 8) measured by storage deltas. Test knobs fake a broken account.
contract AccountStub {
    using SafeERC20 for IERC20;
    using SafeCast for uint256;

    IPerplMin public immutable EX;
    IERC20 public immutable AUSD;
    ICoverManager public immutable MANAGER;
    uint256 public perplAccountId;
    uint256 internal descId;

    int256 public lieFilledDelta; // added to the reported filledLots
    bool public creditReverts;
    uint256 public closeCalls;
    bytes32 public reenterId; // closeForCover re-enters manager.trigger(reenterId) when set
    uint256 public lastCloseGas; // gas spent inside the last closeForCover (Perpl walk included)
    bool public measureBalanceOnly; // pre-CR1 measure, to show the self-match unlock leak

    error NotManager();

    constructor(IPerplMin ex, IERC20 ausd, ICoverManager manager) {
        EX = ex;
        AUSD = ausd;
        MANAGER = manager;
    }

    modifier onlyManager() {
        if (msg.sender != address(MANAGER)) revert NotManager();
        _;
    }

    // Test driver

    function activate(uint256 amountCNS) external {
        AUSD.forceApprove(address(EX), amountCNS);
        perplAccountId = EX.createAccount(amountCNS);
    }

    function deposit(uint256 amountCNS) external {
        AUSD.forceApprove(address(EX), amountCNS);
        EX.depositCollateral(amountCNS);
    }

    /// @notice User IOC order (types 0 to 3), then syncCover when a cover is active, like GaplessAccount.trade.
    function trade(uint8 orderType, uint256 perpId, uint256 pricePNS, uint256 lots, uint256 leverageHdths) public {
        IPerplMin.OrderDesc memory d;
        d.orderDescId = ++descId;
        d.perpId = perpId;
        d.orderType = orderType;
        d.pricePNS = pricePNS;
        d.lotLNS = lots;
        d.immediateOrCancel = true;
        d.leverageHdths = leverageHdths;
        d.maxNegPnlCollatBPS = 300;
        EX.execOrder(d);
        if (MANAGER.activeCoverOf(address(this), perpId) != bytes32(0)) MANAGER.syncCover(address(this), perpId);
    }

    function buyCover(CoverParams calldata p, uint256 maxPremiumCNS) external returns (bytes32 id) {
        AUSD.forceApprove(address(MANAGER), maxPremiumCNS);
        id = MANAGER.openCover(address(this), p, maxPremiumCNS);
        AUSD.forceApprove(address(MANAGER), 0);
    }

    function cancelCover(bytes32 id) external {
        MANAGER.cancelCover(address(this), id);
    }

    function sync(uint256 perpId) external {
        MANAGER.syncCover(address(this), perpId);
    }

    function setLie(int256 d) external {
        lieFilledDelta = d;
    }

    function setMeasureBalanceOnly(bool b) external {
        measureBalanceOnly = b;
    }

    /// @notice Resting (non-IOC) order owned by the trader, e.g. a bid on the covered perp.
    function rest(uint8 orderType, uint256 perpId, uint256 pricePNS, uint256 lots) external returns (uint256) {
        IPerplMin.OrderDesc memory d;
        d.orderDescId = ++descId;
        d.perpId = perpId;
        d.orderType = orderType;
        d.pricePNS = pricePNS;
        d.lotLNS = lots;
        d.leverageHdths = 1000;
        d.maxNegPnlCollatBPS = 300;
        return EX.execOrder(d).orderId;
    }

    function setReenter(bytes32 id) external {
        reenterId = id;
    }

    function setCreditReverts(bool r) external {
        creditReverts = r;
    }

    function position(uint256 perpId) external view returns (IPerplMin.PositionInfo memory p) {
        (p,,) = EX.getPosition(perpId, perplAccountId);
    }

    /// @dev CR1: free + locked, so a self-match unlock of the trader's own resting order is not counted as proceeds.
    function _equity(uint256 id) internal view returns (uint256) {
        IPerplMin.AccountInfo memory a = EX.getAccountById(id);
        if (measureBalanceOnly) return a.balanceCNS;
        return a.balanceCNS + a.lockedBalanceCNS;
    }

    // Manager hooks

    function closeForCover(uint256 perpId, bool isLong, uint256 lots, uint256 limitPNS, uint256 maxMatches)
        external
        onlyManager
        returns (CloseResult memory r)
    {
        uint256 g0 = gasleft();
        ++closeCalls;
        if (reenterId != bytes32(0)) MANAGER.trigger(reenterId);
        uint256 id = perplAccountId;
        if (id == 0 || lots == 0) return r;
        (IPerplMin.PositionInfo memory p0,,) = EX.getPosition(perpId, id);
        if (p0.lotLNS == 0 || p0.positionType != (isLong ? 0 : 1)) return r;
        (, uint256[8] memory taker,) = EX.getPerpFeeSchedule(perpId);
        uint256 fee = taker[EX.getAccountFeeTier(id)];
        uint256 bal0 = _equity(id);

        IPerplMin.OrderDesc memory d;
        d.orderDescId = ++descId;
        d.perpId = perpId;
        d.orderType = isLong ? 2 : 3;
        d.pricePNS = limitPNS;
        d.lotLNS = Math.min(lots, p0.lotLNS);
        d.immediateOrCancel = true;
        d.maxMatches = maxMatches;
        d.lastExecutionBlock = block.number;
        EX.execOrder(d);

        (IPerplMin.PositionInfo memory p1,,) = EX.getPosition(perpId, id);
        if (p1.lotLNS >= p0.lotLNS) return r;
        r.filledLots = p0.lotLNS - p1.lotLNS;
        r.releasedDepositCNS = p0.depositCNS - p1.depositCNS;
        r.realizedCNS = (measureBalanceOnly ? EX.getAccountById(id).balanceCNS : _equity(id)).toInt256()
            - bal0.toInt256();
        r.entryPNS = p0.pricePNS;
        r.fundingCNS = p0.premiumPnlCNS * int256(r.filledLots) / int256(p0.lotLNS);
        r.takerFeePpm = fee;
        if (lieFilledDelta != 0) r.filledLots = uint256(int256(r.filledLots) + lieFilledDelta);
        lastCloseGas = g0 - gasleft();
    }

    function creditToPerpl(uint256 amountCNS) external onlyManager {
        if (creditReverts) revert("credit");
        uint256 amt = Math.min(amountCNS, AUSD.balanceOf(address(this)));
        if (amt == 0 || perplAccountId == 0) return;
        AUSD.forceApprove(address(EX), amt);
        try EX.depositCollateral(amt) {} catch {}
        AUSD.forceApprove(address(EX), 0);
    }
}
