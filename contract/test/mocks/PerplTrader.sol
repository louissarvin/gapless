// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IPerplMin} from "../../src/interfaces/perpl/IPerplMin.sol";

/// @title PerplTrader
/// @notice Contract-owned Perpl account for tests (port of the fork gate's SettleProbe): market maker,
/// counterparty or self-dealing attacker against MockPerplExchange.
contract PerplTrader {
    struct Snap {
        uint256 balance;
        uint256 locked;
        uint256 lots;
        uint256 deposit;
        uint256 entryPNS;
        int256 premium;
        uint8 positionType;
    }

    IPerplMin public immutable ex;
    IERC20 public immutable ausd;
    uint256 public accountId;
    uint256 internal descId;

    constructor(IPerplMin ex_, IERC20 ausd_) {
        ex = ex_;
        ausd = ausd_;
    }

    function open(uint256 amountCNS) external {
        ausd.approve(address(ex), amountCNS);
        accountId = ex.createAccount(amountCNS);
    }

    function deposit(uint256 amountCNS) external {
        ausd.approve(address(ex), amountCNS);
        ex.depositCollateral(amountCNS);
    }

    function withdraw(uint256 amountCNS) external {
        ex.withdrawCollateral(amountCNS);
    }

    function snap(uint256 perpId) public view returns (Snap memory s) {
        IPerplMin.AccountInfo memory a = ex.getAccountById(accountId);
        (IPerplMin.PositionInfo memory p,,) = ex.getPosition(perpId, accountId);
        s = Snap(a.balanceCNS, a.lockedBalanceCNS, p.lotLNS, p.depositCNS, p.pricePNS, p.premiumPnlCNS, p.positionType);
    }

    function desc(uint8 t, uint256 perpId, uint256 px, uint256 lots, bool isIoc)
        public
        returns (IPerplMin.OrderDesc memory d)
    {
        d.orderDescId = ++descId;
        d.perpId = perpId;
        d.orderType = t;
        d.pricePNS = px;
        d.lotLNS = lots;
        d.immediateOrCancel = isIoc;
        d.leverageHdths = 1000;
        d.maxNegPnlCollatBPS = 300;
    }

    /// @notice IOC order with the fork gate's parameters (10x, maxMatches 0 = 1000, no deadline).
    function ioc(uint8 t, uint256 perpId, uint256 px, uint256 lots) public returns (uint256) {
        return ex.execOrder(desc(t, perpId, px, lots, true)).orderId;
    }

    /// @notice Resting limit order; returns the order id.
    function rest(uint8 t, uint256 perpId, uint256 px, uint256 lots) external returns (uint256) {
        return ex.execOrder(desc(t, perpId, px, lots, false)).orderId;
    }

    function exec(IPerplMin.OrderDesc memory d) external returns (IPerplMin.OrderSignature memory) {
        return ex.execOrder(d);
    }

    function execV2(IPerplMin.OrderDesc memory d, bytes memory ext) external returns (IPerplMin.OrderSignature memory) {
        return ex.execOrderV2(d, ext);
    }

    function execBatch(IPerplMin.OrderDesc[] memory ds, bool revertOnFail)
        external
        returns (IPerplMin.OrderSignature[] memory)
    {
        return ex.execOrders(ds, revertOnFail);
    }

    /// @notice Open then close inside one external call (G0 round trip).
    function roundTrip(uint256 perpId, uint256 lots, uint256 openPx, uint256 closePx)
        external
        returns (Snap memory s0, Snap memory s1, Snap memory s2)
    {
        s0 = snap(perpId);
        ioc(0, perpId, openPx, lots);
        s1 = snap(perpId);
        ioc(2, perpId, closePx, lots);
        s2 = snap(perpId);
    }

    /// @notice The Gapless trigger shape: reduce-only IOC close with balance read before and after in one call.
    function closeAndMeasure(uint256 perpId, uint256 lots, uint256 floorPx)
        external
        returns (Snap memory pre, Snap memory post)
    {
        pre = snap(perpId);
        ioc(pre.positionType == 0 ? 2 : 3, perpId, floorPx, lots);
        post = snap(perpId);
    }
}
