// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IPerplMin} from "../../src/interfaces/perpl/IPerplMin.sol";
import {IPerplErrors} from "../../src/interfaces/perpl/IPerplErrors.sol";
import {IPerplEvents} from "../../src/interfaces/perpl/IPerplEvents.sol";

/// @title MockPerplExchange
/// @notice Honest test double of Perpl Exchange v1.7.5 for direct contract accounts. Encodes the 12 G0
/// fork-gate behaviors (see INTERFACES.md) and the measured native stop rule
/// (IOC limit = best opposing book price x (1 -/+ 1%), fired on mark).
/// @dev Model: isolated margin per position, price-time priority book, one taker settlement per order with the
/// fee charged once on the aggregate notional (ceil, ppm), maker fee per fill, PnL realized exactly per level.
/// Not modeled (documented in INTERFACES.md): maxNegPnlCollatBPS, automatic liquidation, funding sums,
/// frozen accounts, VWAP tick rounding of realized PnL (at most 1 tick x lots vs mainnet).
/// Fund the mock with an AUSD float: realized profit can be withdrawn before the counterparty loss is.
contract MockPerplExchange is IPerplMin, IPerplErrors {
    using SafeERC20 for IERC20;

    uint256 public constant FUNDING_INTERVAL = 8571;
    uint256 public constant NATIVE_STOP_SLIPPAGE_BPS = 100;
    uint256 internal constant MAX_MATCHES = 1000;
    uint256 internal constant MAX_ONS = type(uint24).max;
    /// @dev Mainnet execOrder bound (eth_call 2026-10-05): PriceOutOfRange(p, 1, 16777215) on base-0 perps.
    uint256 internal constant MAX_PRICE = 16_777_215;
    uint256 internal constant LIQ_USER_PER_100K = 80_000;

    error OnlySelf();

    struct Account {
        address addr;
        uint256 balance;
        uint256 locked;
    }

    struct Perp {
        bool exists;
        uint8 status;
        uint8 pd;
        uint8 ld;
        string name;
        string symbol;
        uint256 maxLevHdths;
        uint256 refMaxAgeSec;
        uint256 basePricePNS;
        uint256 markPNS;
        uint256 markTs;
        uint256 oraclePNS;
        uint256 oracleTs;
        uint256 lastPNS;
        uint256 lastTs;
        uint256 longOI;
        uint256 shortOI;
        uint256 feeSchedId;
        uint256 nextOrderId;
        uint256[8] taker;
        uint256[8] maker;
        bool ignOracle;
    }

    struct Pos {
        uint8 ptype;
        uint256 lots;
        uint256 entryNotional; // sum(price * lots) of the open lots, exact
        uint256 deposit;
        int256 premium;
        uint256 entryBlock;
    }

    struct Order {
        uint256 accountId;
        uint8 orderType;
        bool isBid;
        uint256 pricePNS;
        uint256 lots;
        uint256 expiryBlock;
        uint256 leverageHdths;
        uint256 lockedCNS;
    }

    struct Exec {
        uint256 perpId;
        uint256 accountId;
        uint8 orderType;
        bool isBuy;
        uint256 limit;
        uint256 lots;
        uint256 remaining;
        uint256 maxMatches;
        uint256 leverageHdths;
        uint256 filled;
        uint256 fillNotional; // sum(price * lots) of this order's fills
        int256 delta; // taker balance change before fees
        uint256 builderId;
        uint256 builderFeePer100K;
        uint256 feeCNS;
        uint256 builderFeeCNS;
        int256 amountCNS; // taker balance change after fees
    }

    IERC20 public immutable collateral;
    uint256 public minAccountOpenCNS = 10e6;
    bool public override whitelistingEnabled;
    mapping(address => bool) public override whitelisted;
    bool public halted;
    uint256 public withdrawAllowanceCNS = type(uint256).max;
    uint256 public numberOfAccounts;
    uint256 public protocolBalanceCNS;

    mapping(address => uint256) public accountIdOf;
    mapping(uint256 => uint256) public feeTierOf;
    mapping(uint256 => Account) internal accounts;
    mapping(uint256 => Perp) internal perps;
    mapping(uint256 => mapping(uint256 => Pos)) internal positions;
    mapping(uint256 => mapping(uint256 => Order)) internal orders;
    mapping(uint256 => uint256[]) internal bidIds; // best (highest) first, FIFO within a price
    mapping(uint256 => uint256[]) internal askIds; // best (lowest) first, FIFO within a price

    constructor(IERC20 collateral_) {
        collateral = collateral_;
    }

    // Accounts and collateral

    function createAccount(uint256 amountCNS) external override returns (uint256 id) {
        if (halted) revert ExchangeHalted();
        _checkWhitelist(msg.sender);
        if (accountIdOf[msg.sender] != 0) revert AccountExists(msg.sender, accountIdOf[msg.sender]);
        if (amountCNS < minAccountOpenCNS) revert InsufficentAmountToOpenAccount(msg.sender, amountCNS);
        id = ++numberOfAccounts;
        accountIdOf[msg.sender] = id;
        accounts[id] = Account(msg.sender, amountCNS, 0);
        collateral.safeTransferFrom(msg.sender, address(this), amountCNS);
        emit IPerplEvents.AccountCreated(msg.sender, id);
        emit IPerplEvents.CollateralDeposit(id, amountCNS, amountCNS);
    }

    function depositCollateral(uint256 amountCNS) external override {
        if (halted) revert ExchangeHalted();
        uint256 id = _accountOf(msg.sender);
        _checkWhitelist(msg.sender);
        accounts[id].balance += amountCNS;
        collateral.safeTransferFrom(msg.sender, address(this), amountCNS);
        emit IPerplEvents.CollateralDeposit(id, amountCNS, accounts[id].balance);
    }

    function withdrawCollateral(uint256 amountCNS) external override {
        if (halted) revert ExchangeHalted();
        uint256 id = _accountOf(msg.sender);
        Account storage a = accounts[id];
        if (amountCNS > a.balance) revert InsufficientFunds(a.balance, amountCNS);
        if (amountCNS > withdrawAllowanceCNS) {
            revert WithdrawRateLimitExceeded(amountCNS, withdrawAllowanceCNS, 0, block.number);
        }
        if (withdrawAllowanceCNS != type(uint256).max) withdrawAllowanceCNS -= amountCNS;
        a.balance -= amountCNS;
        collateral.safeTransfer(msg.sender, amountCNS);
        emit IPerplEvents.CollateralWithdrawal(id, amountCNS, a.balance);
    }

    function increasePositionCollateral(uint256 perpId, uint256 amountCNS) external override {
        if (halted) revert ExchangeHalted();
        _increaseCollateral(_accountOf(msg.sender), perpId, amountCNS);
    }

    // Orders

    function execOrder(OrderDesc memory d) external override returns (OrderSignature memory) {
        return _exec(_accountOf(msg.sender), d, 0, 0);
    }

    /// @dev extension = abi.encode(uint16 version, abi.encode(uint256 builderId, uint256 feePer100K)); "" = none.
    function execOrderV2(OrderDesc memory d, bytes memory extension)
        external
        override
        returns (OrderSignature memory)
    {
        (uint256 builderId, uint256 feePer100K) = _decodeExtension(extension);
        return _exec(_accountOf(msg.sender), d, builderId, feePer100K);
    }

    /// @dev revertOnFail = false skips failing orders (signature orderId 0) instead of reverting.
    function execOrders(OrderDesc[] memory ds, bool revertOnFail)
        external
        override
        returns (OrderSignature[] memory sigs)
    {
        uint256 id = _accountOf(msg.sender);
        sigs = new OrderSignature[](ds.length);
        for (uint256 i; i < ds.length; ++i) {
            if (revertOnFail) {
                sigs[i] = _exec(id, ds[i], 0, 0);
            } else {
                try this.selfExec(id, ds[i]) returns (OrderSignature memory s) {
                    sigs[i] = s;
                } catch {
                    sigs[i] = OrderSignature(ds[i].perpId, 0);
                }
            }
        }
    }

    /// @dev Internal plumbing for execOrders(revertOnFail = false).
    function selfExec(uint256 accountId, OrderDesc memory d) external returns (OrderSignature memory) {
        if (msg.sender != address(this)) revert OnlySelf();
        return _exec(accountId, d, 0, 0);
    }

    /// @dev Internal plumbing: one maker fill in its own frame so a failed maker settlement is skipped.
    function makerFill(uint256 perpId, uint256 orderId, uint256 lots, bool takerIsBuy) external {
        if (msg.sender != address(this)) revert OnlySelf();
        _makerFill(perpId, orderId, lots, takerIsBuy);
    }

    // Views

    function getAccountByAddr(address addr) external view override returns (AccountInfo memory info) {
        uint256 id = accountIdOf[addr];
        if (id == 0) revert AccountDoesNotExist(addr);
        return _info(id);
    }

    function getAccountById(uint256 id) external view override returns (AccountInfo memory) {
        if (accounts[id].addr == address(0)) revert AccountIdDoesNotExist(id);
        return _info(id);
    }

    function getPosition(uint256 perpId, uint256 accountId)
        external
        view
        override
        returns (PositionInfo memory p, uint256 markPricePNS, bool markPriceValid)
    {
        Perp storage pp = perps[perpId];
        markPricePNS = pp.markPNS;
        markPriceValid = pp.exists && !_stale(pp.markTs, pp.refMaxAgeSec);
        Pos storage ps = positions[perpId][accountId];
        if (ps.lots == 0) return (p, markPricePNS, markPriceValid);
        p.accountId = accountId;
        p.positionType = ps.ptype;
        p.depositCNS = ps.deposit;
        p.pricePNS = ps.entryNotional / ps.lots;
        p.lotLNS = ps.lots;
        p.entryBlock = ps.entryBlock;
        p.pnlCNS = _pnl(ps.ptype, ps.entryNotional, pp.markPNS * ps.lots, _scale(perpId));
        p.premiumPnlCNS = ps.premium;
    }

    function getPerpetualInfo(uint256 perpId) external view override returns (PerpetualInfo memory info) {
        Perp storage pp = perps[perpId];
        if (!pp.exists) revert ContractDoesNotExist(perpId);
        info.name = pp.name;
        info.symbol = pp.symbol;
        info.priceDecimals = pp.pd;
        info.lotDecimals = pp.ld;
        info.priceTolPer100K = 5000;
        info.marginTol = 100;
        info.marginTolDecimals = 9;
        info.refPriceMaxAgeSec = pp.refMaxAgeSec;
        info.markPNS = pp.markPNS;
        info.markTimestamp = pp.markTs;
        info.lastPNS = pp.lastPNS;
        info.lastTimestamp = pp.lastTs;
        info.oraclePNS = pp.oraclePNS;
        info.oracleTimestampSec = pp.oracleTs;
        info.longOpenInterestLNS = pp.longOI;
        info.shortOpenInterestLNS = pp.shortOI;
        info.absFundingClampPctPer100K = 10;
        info.status = pp.status;
        info.basePricePNS = pp.basePricePNS;
        info.ignOracle = pp.ignOracle;
        (info.maxBidPriceONS, info.minBidPriceONS) = _range(bidIds[perpId], perpId, pp.basePricePNS);
        (info.minAskPriceONS, info.maxAskPriceONS) = _range(askIds[perpId], perpId, pp.basePricePNS);
        info.numOrders = bidIds[perpId].length + askIds[perpId].length;
    }

    function getNextPriceBelowWithOrders(uint256 perpId, uint256 priceONS) external view override returns (uint256 r) {
        uint256 px = perps[perpId].basePricePNS + priceONS;
        uint256 best;
        for (uint256 side; side < 2; ++side) {
            uint256[] storage ids = side == 0 ? bidIds[perpId] : askIds[perpId];
            for (uint256 i; i < ids.length; ++i) {
                uint256 p = orders[perpId][ids[i]].pricePNS;
                if (p < px && p > best) best = p;
            }
        }
        r = best == 0 ? 0 : best - perps[perpId].basePricePNS;
    }

    function getNextPriceAboveWithOrders(uint256 perpId, uint256 priceONS) external view override returns (uint256 r) {
        uint256 px = perps[perpId].basePricePNS + priceONS;
        uint256 best = type(uint256).max;
        for (uint256 side; side < 2; ++side) {
            uint256[] storage ids = side == 0 ? bidIds[perpId] : askIds[perpId];
            for (uint256 i; i < ids.length; ++i) {
                uint256 p = orders[perpId][ids[i]].pricePNS;
                if (p > px && p < best) best = p;
            }
        }
        r = best == type(uint256).max ? 0 : best - perps[perpId].basePricePNS;
    }

    function getVolumeAtBookPrice(uint256 perpId, uint256 priceONS)
        external
        view
        override
        returns (uint256 bids, uint256 expBids, uint256 asks, uint256 expAsks)
    {
        uint256 px = perps[perpId].basePricePNS + priceONS;
        (bids, expBids) = _volumeAt(bidIds[perpId], perpId, px);
        (asks, expAsks) = _volumeAt(askIds[perpId], perpId, px);
    }

    function getAccountFeeTier(uint256 accountId) external view override returns (uint256) {
        return feeTierOf[accountId];
    }

    function getPerpFeeSchedule(uint256 perpId)
        external
        view
        override
        returns (uint256, uint256[8] memory, uint256[8] memory)
    {
        Perp storage pp = perps[perpId];
        return (pp.feeSchedId, pp.taker, pp.maker);
    }

    function getTakerFee(uint256 perpId) external view override returns (uint256) {
        return perps[perpId].taker[0];
    }

    function getMinAccountOpenCNS() external view override returns (uint256) {
        return minAccountOpenCNS;
    }

    function getWithdrawAllowanceData(uint256)
        external
        view
        override
        returns (uint256 allowanceCNS, uint256 expiryBlock, uint256 lastAllowanceBlock, uint256 cnsPerBlock)
    {
        return (withdrawAllowanceCNS, 0, 0, 0);
    }

    function getFundingInterval() external pure override returns (uint256) {
        return FUNDING_INTERVAL;
    }

    function getContractVersion() external pure override returns (uint256, uint256, uint256) {
        return (1, 7, 5);
    }

    function isHalted() external view override returns (bool) {
        return halted;
    }

    /// @notice Limit the native stop engine would send now: best opposing x (1 -/+ 1%); 0 when that side is empty.
    function nativeStopLimitPNS(uint256 perpId, bool isLong) public view returns (uint256) {
        Perp storage pp = perps[perpId];
        if (isLong) {
            (uint256 bestBid,) = _range(bidIds[perpId], perpId, pp.basePricePNS);
            return bestBid == 0 ? 0 : (pp.basePricePNS + bestBid) * (1e4 - NATIVE_STOP_SLIPPAGE_BPS) / 1e4;
        }
        (uint256 bestAsk,) = _range(askIds[perpId], perpId, pp.basePricePNS);
        return bestAsk == 0 ? 0 : (pp.basePricePNS + bestAsk) * (1e4 + NATIVE_STOP_SLIPPAGE_BPS) / 1e4;
    }

    // Test hooks (unrestricted: test double)

    /// @notice List a perp with the mainnet fee schedule 1021 and fresh mark and oracle at `pricePNS`.
    function listPerp(uint256 perpId, string calldata sym, uint8 pd, uint8 ld, uint256 maxLevHdths, uint256 pricePNS)
        external
    {
        require(pd + ld <= 6, "pd+ld");
        Perp storage pp = perps[perpId];
        pp.exists = true;
        pp.status = 4;
        pp.pd = pd;
        pp.ld = ld;
        pp.name = string.concat(sym, " Perp");
        pp.symbol = sym;
        pp.maxLevHdths = maxLevHdths;
        pp.refMaxAgeSec = 60;
        pp.feeSchedId = 1021;
        pp.taker = [uint256(345), 300, 250, 210, 175, 150, 125, 0];
        pp.maker = [uint256(45), 25, 15, 0, 0, 0, 0, 0];
        _setMark(perpId, pricePNS, block.timestamp);
        _setOracle(perpId, pricePNS, block.timestamp);
    }

    function setMark(uint256 perpId, uint256 pricePNS) external {
        _setMark(perpId, pricePNS, block.timestamp);
    }

    function setMarkAt(uint256 perpId, uint256 pricePNS, uint256 ts) external {
        _setMark(perpId, pricePNS, ts);
    }

    function setOracle(uint256 perpId, uint256 pricePNS) external {
        _setOracle(perpId, pricePNS, block.timestamp);
    }

    function setOracleAt(uint256 perpId, uint256 pricePNS, uint256 ts) external {
        _setOracle(perpId, pricePNS, ts);
    }

    function setPerpStatus(uint256 perpId, uint8 status) external {
        perps[perpId].status = status;
        emit IPerplEvents.ContractPaused(perpId, status == 0);
    }

    function setHalted(bool h) external {
        halted = h;
        emit IPerplEvents.ExchangeHalted(h);
    }

    function setWhitelistingEnabled(bool enabled) external {
        whitelistingEnabled = enabled;
        emit IPerplEvents.WhitelistingEnabledChanged(enabled);
    }

    function setWhitelisted(address addr, bool allowed) external {
        whitelisted[addr] = allowed;
    }

    function setFeeTier(uint256 accountId, uint256 tier) external {
        require(tier < 8, "tier");
        feeTierOf[accountId] = tier;
    }

    function setFeeSchedule(uint256 perpId, uint256 schedId, uint256[8] calldata taker, uint256[8] calldata maker)
        external
    {
        perps[perpId].feeSchedId = schedId;
        perps[perpId].taker = taker;
        perps[perpId].maker = maker;
    }

    function setMinAccountOpenCNS(uint256 v) external {
        minAccountOpenCNS = v;
    }

    function setWithdrawAllowanceCNS(uint256 v) external {
        withdrawAllowanceCNS = v;
    }

    function setBasePricePNS(uint256 perpId, uint256 base) external {
        perps[perpId].basePricePNS = base;
    }

    /// @notice Perpl's flag to ignore its own oracle (references then skip it).
    function setIgnOracle(uint256 perpId, bool ign) external {
        perps[perpId].ignOracle = ign;
    }

    function setRefPriceMaxAgeSec(uint256 perpId, uint256 sec) external {
        perps[perpId].refMaxAgeSec = sec;
    }

    /// @notice Add accrued funding to a position (positive credits the trader); realized pro rata on reduce.
    function accrueFunding(uint256 perpId, uint256 accountId, int256 deltaCNS) external {
        require(positions[perpId][accountId].lots > 0, "no position");
        positions[perpId][accountId].premium += deltaCNS;
    }

    /// @notice Liquidate the whole position at mark: it disappears and the trader keeps 80% of positive equity.
    function liquidate(uint256 perpId, uint256 accountId) external {
        Pos storage ps = positions[perpId][accountId];
        require(ps.lots > 0, "no position");
        Perp storage pp = perps[perpId];
        int256 pnl = _pnl(ps.ptype, ps.entryNotional, pp.markPNS * ps.lots, _scale(perpId));
        int256 equity = int256(ps.deposit) + pnl + ps.premium;
        if (equity > 0) accounts[accountId].balance += uint256(equity) * LIQ_USER_PER_100K / 100_000;
        _oi(perpId, ps.ptype, ps.lots, false);
        emit IPerplEvents.PositionClosed(perpId, accountId, ps.ptype, pp.markPNS, pnl, ps.premium);
        delete positions[perpId][accountId];
    }

    /// @notice Auto-deleverage `lots` at mark, no fee.
    function adl(uint256 perpId, uint256 accountId, uint256 lots) external {
        Pos storage ps = positions[perpId][accountId];
        require(lots > 0 && lots <= ps.lots, "lots");
        int256 d = _reduce(perpId, accountId, lots, perps[perpId].markPNS);
        _credit(accountId, d);
    }

    /// @notice Simulate Perpl's native stop execution (execFwdPositionOpsV2) for a whole position: reduce-only
    /// IOC at best opposing x (1 -/+ 1%), maxMatches 1000. Empty opposing side fills nothing.
    /// @return filled Lots closed.
    function execNativeStop(uint256 accountId, uint256 perpId) external returns (uint256 filled) {
        Pos storage ps = positions[perpId][accountId];
        uint256 lots = ps.lots;
        require(lots > 0, "no position");
        bool isLong = ps.ptype == 0;
        uint256 limit = nativeStopLimitPNS(perpId, isLong);
        emit IPerplEvents.TriggerOrderExecution();
        if (limit == 0) {
            emit IPerplEvents.ImmediateOrCancelExecuted(lots, lots);
            return 0;
        }
        OrderDesc memory d;
        d.perpId = perpId;
        d.orderType = isLong ? 2 : 3;
        d.pricePNS = limit;
        d.lotLNS = lots;
        d.immediateOrCancel = true;
        _exec(accountId, d, 0, 0);
        filled = lots - positions[perpId][accountId].lots;
    }

    // Engine

    function _exec(uint256 acct, OrderDesc memory d, uint256 builderId, uint256 builderFeePer100K)
        internal
        returns (OrderSignature memory sig)
    {
        if (halted) revert ExchangeHalted();
        if (d.lastExecutionBlock != 0 && block.number > d.lastExecutionBlock) {
            revert ExceedsLastExecutionBlock(d.lastExecutionBlock);
        }
        Perp storage pp = perps[d.perpId];
        if (!pp.exists) revert ContractDoesNotExist(d.perpId);
        if (pp.status != 4) revert ContractNotOperational(d.perpId, PerpStatusEnum.wrap(pp.status));
        _emitOrderRequest(acct, d, builderId, builderFeePer100K);
        sig.perpId = d.perpId;
        uint8 t = d.orderType;
        if (t == 4) {
            _cancel(d.perpId, acct, d.orderId);
            return sig;
        }
        if (t == 5) {
            _increaseCollateral(acct, d.perpId, d.amountCNS);
            return sig;
        }
        if (t == 6) {
            sig.orderId = _change(d, acct);
            return sig;
        }
        if (t > 6) revert ValueOutsideRange(t, 0, 6);
        if (d.lotLNS == 0 || d.lotLNS > type(uint40).max) revert LotOutOfRange(d.lotLNS, 1, type(uint40).max);
        if (d.pricePNS == 0 || d.pricePNS > MAX_PRICE) revert PriceOutOfRange(d.pricePNS, 1, MAX_PRICE);
        if (t <= 1) {
            _checkWhitelist(accounts[acct].addr);
            if (_stale(pp.markTs, pp.refMaxAgeSec)) {
                revert MarkPriceAgeExceedsMax(d.perpId, pp.markTs, block.timestamp, pp.refMaxAgeSec);
            }
            if (_stale(pp.oracleTs, pp.refMaxAgeSec)) {
                revert OracleAgeExceedsMax(d.perpId, pp.oracleTs, block.timestamp, pp.refMaxAgeSec);
            }
            _checkLeverage(pp, d.leverageHdths);
        } else {
            _checkClose(d.perpId, acct, t, d.lotLNS);
        }

        Exec memory e;
        e.perpId = d.perpId;
        e.accountId = acct;
        e.orderType = t;
        e.isBuy = t == 0 || t == 3;
        e.limit = d.pricePNS;
        e.lots = d.lotLNS;
        e.remaining = d.lotLNS;
        e.maxMatches = d.maxMatches == 0 || d.maxMatches > MAX_MATCHES ? MAX_MATCHES : d.maxMatches;
        e.leverageHdths = d.leverageHdths;
        e.builderId = builderId;
        e.builderFeePer100K = builderFeePer100K;

        if (d.postOnly) _checkPostOnly(e);
        _match(e);
        if (d.fillOrKill && e.remaining > 0) revert UnmatchedLotRemainsInFillOrKill(e.perpId, acct, e.remaining);
        _settleTaker(e);

        if (d.immediateOrCancel || d.fillOrKill) {
            if (e.remaining > 0) emit IPerplEvents.ImmediateOrCancelExecuted(e.remaining, e.lots);
            return sig;
        }
        if (e.remaining > 0) {
            sig.orderId = _rest(e.perpId, acct, t, e.isBuy, d.pricePNS, e.remaining, d.expiryBlock, d.leverageHdths);
        }
    }

    function _match(Exec memory e) internal {
        uint256[] storage ids = e.isBuy ? askIds[e.perpId] : bidIds[e.perpId];
        uint256 i;
        uint256 matches;
        while (e.remaining > 0 && i < ids.length && matches < e.maxMatches) {
            uint256 oid = ids[i];
            Order storage o = orders[e.perpId][oid];
            if (o.expiryBlock != 0 && block.number > o.expiryBlock) {
                _dropOrder(e.perpId, ids, i, oid);
                continue;
            }
            if (e.isBuy ? o.pricePNS > e.limit : o.pricePNS < e.limit) break;
            ++matches;
            if (o.accountId == e.accountId) {
                emit IPerplEvents.ClearingSelfMatchingOrder(e.perpId, o.accountId, oid, o.lockedCNS, 0, 0, 0);
                _dropOrder(e.perpId, ids, i, oid);
                continue;
            }
            uint256 q = Math.min(e.remaining, o.lots);
            uint256 px = o.pricePNS;
            try this.makerFill(e.perpId, oid, q, e.isBuy) {
                e.delta += _applyFill(e.perpId, e.accountId, e.isBuy, q, px, e.leverageHdths);
                e.filled += q;
                e.fillNotional += px * q;
                e.remaining -= q;
                if (orders[e.perpId][oid].lots == 0) {
                    _removeAt(ids, i);
                    delete orders[e.perpId][oid];
                }
            } catch {
                _dropOrder(e.perpId, ids, i, oid);
            }
        }
    }

    function _makerFill(uint256 perpId, uint256 oid, uint256 q, bool takerIsBuy) internal {
        Order storage o = orders[perpId][oid];
        uint256 acct = o.accountId;
        Account storage a = accounts[acct];
        uint256 lockPart = q == o.lots ? o.lockedCNS : o.lockedCNS * q / o.lots;
        o.lockedCNS -= lockPart;
        a.locked -= lockPart;
        a.balance += lockPart;
        if (o.orderType == 2 || o.orderType == 3) _checkClose(perpId, acct, o.orderType, q);
        uint256 px = o.pricePNS;
        int256 d = _applyFill(perpId, acct, !takerIsBuy, q, px, o.leverageHdths);
        uint256 fee = Math.mulDiv(px * q * _scale(perpId), perps[perpId].maker[feeTierOf[acct]], 1e6, Math.Rounding.Ceil);
        d -= int256(fee);
        protocolBalanceCNS += fee;
        _credit(acct, d);
        o.lots -= q;
        _setLast(perpId, px);
        emit IPerplEvents.MakerOrderFilledV2(perpId, acct, oid, px, q, fee, a.locked, d, a.balance, 0, 0);
    }

    function _settleTaker(Exec memory e) internal {
        if (e.filled == 0) return;
        uint256 notionalCNS = e.fillNotional * _scale(e.perpId);
        e.feeCNS = Math.mulDiv(notionalCNS, perps[e.perpId].taker[feeTierOf[e.accountId]], 1e6, Math.Rounding.Ceil);
        if (e.builderFeePer100K != 0) {
            e.builderFeeCNS = Math.mulDiv(notionalCNS, e.builderFeePer100K, 1e5, Math.Rounding.Ceil);
        }
        e.amountCNS = e.delta - int256(e.feeCNS) - int256(e.builderFeeCNS);
        protocolBalanceCNS += e.feeCNS + e.builderFeeCNS;
        _credit(e.accountId, e.amountCNS);
        _emitTakerFilled(e);
    }

    /// @dev collatPricePNS rounds the VWAP against the taker, pnlPricePNS the other way (G0 multi-level test).
    function _emitTakerFilled(Exec memory e) internal {
        uint256 down = e.fillNotional / e.filled;
        uint256 up = Math.ceilDiv(e.fillNotional, e.filled);
        uint256 collat = e.isBuy ? up : down;
        emit IPerplEvents.TakerOrderFilledV2(
            collat,
            collat,
            e.isBuy ? down : up,
            e.filled,
            e.feeCNS,
            e.amountCNS,
            accounts[e.accountId].balance,
            e.builderId,
            e.builderFeeCNS
        );
    }

    /// @return d Balance change: +(released deposit + PnL + funding) on reduce, -(new deposit) on increase.
    function _applyFill(uint256 perpId, uint256 acct, bool isBuy, uint256 q, uint256 px, uint256 lev)
        internal
        returns (int256 d)
    {
        Pos storage ps = positions[perpId][acct];
        if (ps.lots > 0 && (ps.ptype == 0) != isBuy) {
            uint256 r = Math.min(q, ps.lots);
            d += _reduce(perpId, acct, r, px);
            q -= r;
        }
        if (q > 0) d -= int256(_increase(perpId, acct, isBuy, q, px, lev));
    }

    struct Reduce {
        uint8 ptype;
        uint256 lots0;
        uint256 deposit0;
        uint256 basis;
        uint256 released;
        int256 funding;
        int256 pnl;
    }

    function _reduce(uint256 perpId, uint256 acct, uint256 r, uint256 px) internal returns (int256 d) {
        Pos storage ps = positions[perpId][acct];
        Reduce memory x;
        x.ptype = ps.ptype;
        x.lots0 = ps.lots;
        x.deposit0 = ps.deposit;
        bool full = r == x.lots0;
        x.basis = full ? ps.entryNotional : ps.entryNotional * r / x.lots0;
        x.released = full ? x.deposit0 : x.deposit0 * r / x.lots0;
        x.funding = full ? ps.premium : ps.premium * int256(r) / int256(x.lots0);
        x.pnl = _pnl(x.ptype, x.basis, px * r, _scale(perpId));
        _oi(perpId, x.ptype, r, false);
        if (full) {
            delete positions[perpId][acct];
            emit IPerplEvents.PositionClosed(perpId, acct, x.ptype, px, x.pnl, x.funding);
        } else {
            ps.lots = x.lots0 - r;
            ps.entryNotional -= x.basis;
            ps.deposit = x.deposit0 - x.released;
            ps.premium -= x.funding;
            _emitDecreased(perpId, acct, x, ps.deposit, ps.lots);
        }
        d = int256(x.released) + x.pnl + x.funding;
    }

    function _emitDecreased(uint256 perpId, uint256 acct, Reduce memory x, uint256 deposit1, uint256 lots1) internal {
        emit IPerplEvents.PositionDecreased(perpId, acct, x.ptype, x.deposit0, deposit1, x.lots0, lots1, x.pnl, x.funding);
    }

    function _increase(uint256 perpId, uint256 acct, bool isLong, uint256 q, uint256 px, uint256 lev)
        internal
        returns (uint256 depositAdd)
    {
        Perp storage pp = perps[perpId];
        uint256 levEff = lev == 0 ? pp.maxLevHdths : lev;
        depositAdd = Math.mulDiv(px * q * _scale(perpId), 100, levEff, Math.Rounding.Ceil);
        Pos storage ps = positions[perpId][acct];
        if (ps.lots == 0) {
            ps.ptype = isLong ? 0 : 1;
            ps.entryBlock = block.number;
        }
        ps.lots += q;
        ps.entryNotional += px * q;
        ps.deposit += depositAdd;
        _oi(perpId, ps.ptype, q, true);
    }

    function _rest(uint256 perpId, uint256 acct, uint8 t, bool isBid, uint256 px, uint256 lots, uint256 expiry, uint256 lev)
        internal
        returns (uint256 oid)
    {
        Perp storage pp = perps[perpId];
        if (px < pp.basePricePNS || px - pp.basePricePNS > MAX_ONS) {
            revert OrderBookPriceOutOfRange(px < pp.basePricePNS ? 0 : px - pp.basePricePNS, MAX_ONS);
        }
        if (expiry != 0 && expiry < block.number) revert InvalidExpiryBlock(expiry, block.number);
        oid = ++pp.nextOrderId;
        if (oid > type(uint16).max) revert OrderBookFull(perpId);
        uint256 lock;
        if (t <= 1) {
            uint256 notionalCNS = px * lots * _scale(perpId);
            lock = Math.mulDiv(notionalCNS, 100, lev == 0 ? pp.maxLevHdths : lev, Math.Rounding.Ceil)
                + Math.mulDiv(notionalCNS, pp.maker[feeTierOf[acct]], 1e6, Math.Rounding.Ceil);
            Account storage a = accounts[acct];
            if (a.balance < lock) revert InsufficientFunds(a.balance, lock);
            a.balance -= lock;
            a.locked += lock;
        }
        orders[perpId][oid] = Order(acct, t, isBid, px, lots, expiry, lev, lock);
        _insert(isBid ? bidIds[perpId] : askIds[perpId], perpId, oid, px, isBid);
    }

    function _cancel(uint256 perpId, uint256 acct, uint256 oid) internal {
        Order storage o = orders[perpId][oid];
        if (o.lots == 0) revert OrderDoesNotExist(perpId, oid);
        if (o.accountId != acct) revert WrongAccountForOrder(perpId, oid, acct);
        uint256[] storage ids = o.isBid ? bidIds[perpId] : askIds[perpId];
        for (uint256 i; i < ids.length; ++i) {
            if (ids[i] == oid) {
                _dropOrder(perpId, ids, i, oid);
                return;
            }
        }
    }

    /// @dev Change = cancel then re-post the same order type at the new price, lots and expiry (new id).
    function _change(OrderDesc memory d, uint256 acct) internal returns (uint256) {
        Order memory o = orders[d.perpId][d.orderId];
        _cancel(d.perpId, acct, d.orderId);
        Exec memory e;
        e.perpId = d.perpId;
        e.accountId = acct;
        e.isBuy = o.isBid;
        e.limit = d.pricePNS;
        _checkPostOnly(e);
        return _rest(d.perpId, acct, o.orderType, o.isBid, d.pricePNS, d.lotLNS, d.expiryBlock, o.leverageHdths);
    }

    function _increaseCollateral(uint256 acct, uint256 perpId, uint256 amountCNS) internal {
        Pos storage ps = positions[perpId][acct];
        if (ps.lots == 0) revert PositionDoesNotExist(perpId, acct);
        Account storage a = accounts[acct];
        if (amountCNS > a.balance) revert InsufficientFunds(a.balance, amountCNS);
        a.balance -= amountCNS;
        ps.deposit += amountCNS;
    }

    function _checkClose(uint256 perpId, uint256 acct, uint8 t, uint256 lots) internal view {
        Pos storage ps = positions[perpId][acct];
        if (ps.lots > 0 && ps.ptype != t - 2) {
            revert CloseOrderPositionMismatch(PositionEnum.wrap(ps.ptype), OrderEnum.wrap(t));
        }
        if (lots > ps.lots) revert CloseOrderExceedsPosition(ps.lots, lots);
    }

    function _checkPostOnly(Exec memory e) internal view {
        uint256[] storage ids = e.isBuy ? askIds[e.perpId] : bidIds[e.perpId];
        for (uint256 i; i < ids.length; ++i) {
            Order storage o = orders[e.perpId][ids[i]];
            if (o.expiryBlock != 0 && block.number > o.expiryBlock) continue;
            if (e.isBuy ? o.pricePNS <= e.limit : o.pricePNS >= e.limit) {
                revert CrossesBook(e.perpId, e.accountId, e.limit, e.isBuy, o.pricePNS, false);
            }
            return;
        }
    }

    function _checkLeverage(Perp storage pp, uint256 lev) internal view {
        if (lev > pp.maxLevHdths) revert ValueExceedsMaximum(lev, pp.maxLevHdths);
    }

    function _checkWhitelist(address addr) internal view {
        if (whitelistingEnabled && !whitelisted[addr]) revert NotWhitelisted(addr);
    }

    function _decodeExtension(bytes memory ext) internal pure returns (uint256 builderId, uint256 feePer100K) {
        if (ext.length == 0) return (0, 0);
        if (ext.length > 256) revert ValueExceedsMaximum(ext.length, 256);
        (uint16 version, bytes memory payload) = abi.decode(ext, (uint16, bytes));
        if (version != 1) revert InvalidOrderExtensionVersion(version);
        (builderId, feePer100K) = abi.decode(payload, (uint256, uint256));
        if (builderId > type(uint8).max) revert ValueExceedsMaximum(builderId, type(uint8).max);
        if (feePer100K > 1000) revert ValueExceedsMaximum(feePer100K, 1000);
    }

    function _credit(uint256 acct, int256 d) internal {
        Account storage a = accounts[acct];
        if (d < 0) {
            uint256 debit = uint256(-d);
            if (debit > a.balance) revert InsufficientFunds(a.balance, debit);
            a.balance -= debit;
        } else {
            a.balance += uint256(d);
        }
    }

    function _dropOrder(uint256 perpId, uint256[] storage ids, uint256 i, uint256 oid) internal {
        Order storage o = orders[perpId][oid];
        Account storage a = accounts[o.accountId];
        a.locked -= o.lockedCNS;
        a.balance += o.lockedCNS;
        _removeAt(ids, i);
        delete orders[perpId][oid];
    }

    function _insert(uint256[] storage ids, uint256 perpId, uint256 oid, uint256 px, bool isBid) internal {
        uint256 n = ids.length;
        uint256 slot = n;
        for (uint256 i; i < n; ++i) {
            uint256 p = orders[perpId][ids[i]].pricePNS;
            if (isBid ? px > p : px < p) {
                slot = i;
                break;
            }
        }
        ids.push(0);
        for (uint256 j = n; j > slot; j -= 1) {
            ids[j] = ids[j - 1];
        }
        ids[slot] = oid;
    }

    function _removeAt(uint256[] storage ids, uint256 i) internal {
        uint256 n = ids.length;
        for (uint256 j = i; j + 1 < n; ++j) {
            ids[j] = ids[j + 1];
        }
        ids.pop();
    }

    function _setMark(uint256 perpId, uint256 px, uint256 ts) internal {
        perps[perpId].markPNS = px;
        perps[perpId].markTs = ts;
        emit IPerplEvents.MarkUpdated(perpId, px);
    }

    function _setOracle(uint256 perpId, uint256 px, uint256 ts) internal {
        perps[perpId].oraclePNS = px;
        perps[perpId].oracleTs = ts;
        emit IPerplEvents.LinkPriceUpdated(perpId, px, ts);
    }

    function _setLast(uint256 perpId, uint256 px) internal {
        perps[perpId].lastPNS = px;
        perps[perpId].lastTs = block.timestamp;
    }

    function _oi(uint256 perpId, uint8 ptype, uint256 lots, bool add) internal {
        Perp storage pp = perps[perpId];
        if (ptype == 0) pp.longOI = add ? pp.longOI + lots : pp.longOI - lots;
        else pp.shortOI = add ? pp.shortOI + lots : pp.shortOI - lots;
    }

    function _emitOrderRequest(uint256 acct, OrderDesc memory d, uint256 builderId, uint256 feePer100K) internal {
        bytes memory ext = builderId == 0 && feePer100K == 0
            ? bytes("")
            : abi.encode(uint16(1), abi.encode(builderId, feePer100K));
        // Encoded in parts: 18 event fields exceed the legacy codegen stack.
        bytes memory head1 = abi.encode(
            d.perpId, acct, d.orderDescId, d.orderId, d.orderType, d.pricePNS, d.lotLNS, d.expiryBlock, d.postOnly
        );
        bytes memory head2 = abi.encode(
            d.fillOrKill,
            d.immediateOrCancel,
            d.maxMatches,
            d.leverageHdths,
            d.lastExecutionBlock,
            d.amountCNS,
            d.maxNegPnlCollatBPS,
            gasleft(),
            uint256(18 * 32)
        );
        bytes memory data = bytes.concat(head1, head2, abi.encodePacked(ext.length), ext, new bytes((32 - ext.length % 32) % 32));
        bytes32 topic = IPerplEvents.OrderRequestV2.selector;
        assembly ("memory-safe") {
            log1(add(data, 32), mload(data), topic)
        }
    }

    function _info(uint256 id) internal view returns (AccountInfo memory info) {
        Account storage a = accounts[id];
        info.accountId = id;
        info.balanceCNS = a.balance;
        info.lockedBalanceCNS = a.locked;
        info.accountAddr = a.addr;
    }

    function _accountOf(address addr) internal view returns (uint256 id) {
        id = accountIdOf[addr];
        if (id == 0) revert AccountDoesNotExist(addr);
    }

    /// @return best First live price as ONS, 0 when empty. @return worst Last live price as ONS.
    function _range(uint256[] storage ids, uint256 perpId, uint256 base) internal view returns (uint256 best, uint256 worst) {
        for (uint256 i; i < ids.length; ++i) {
            Order storage o = orders[perpId][ids[i]];
            if (o.expiryBlock != 0 && block.number > o.expiryBlock) continue;
            if (best == 0) best = o.pricePNS - base;
            worst = o.pricePNS - base;
        }
    }

    function _volumeAt(uint256[] storage ids, uint256 perpId, uint256 px) internal view returns (uint256 live, uint256 exp) {
        for (uint256 i; i < ids.length; ++i) {
            Order storage o = orders[perpId][ids[i]];
            if (o.pricePNS != px) continue;
            if (o.expiryBlock != 0 && block.number > o.expiryBlock) exp += o.lots;
            else live += o.lots;
        }
    }

    function _scale(uint256 perpId) internal view returns (uint256) {
        Perp storage pp = perps[perpId];
        return 10 ** (6 - pp.pd - pp.ld);
    }

    /// @dev Same rule as the SDK's is_mark_price_obsolete: ts + maxAge <= now.
    function _stale(uint256 ts, uint256 maxAge) internal view returns (bool) {
        return ts + maxAge <= block.timestamp;
    }

    function _pnl(uint8 ptype, uint256 basis, uint256 exitNotional, uint256 scale) internal pure returns (int256) {
        int256 diff = int256(exitNotional) - int256(basis);
        return (ptype == 0 ? diff : -diff) * int256(scale);
    }
}
