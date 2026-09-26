// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IPerplMin} from "../../src/interfaces/perpl/IPerplMin.sol";
import {ICoverManager} from "../../src/interfaces/ICoverManager.sol";
import {CoverManager} from "../../src/CoverManager.sol";
import {Constants} from "../../src/Constants.sol";
import {CoverParams, Cover, CoverStatus, MarketConfig, MarketParams, Quote} from "../../src/types/GaplessTypes.sol";
import {MockAUSD} from "../mocks/MockAUSD.sol";
import {MockPerplExchange} from "../mocks/MockPerplExchange.sol";
import {MockFeed} from "../mocks/MockFeed.sol";
import {PerplTrader} from "../mocks/PerplTrader.sol";
import {AccountStub} from "./stubs/AccountStub.sol";
import {VaultStub, FactoryStub} from "./stubs/VaultStub.sol";

/// @notice Unit harness: real CoverManager over MockPerplExchange, MockAUSD, MockFeed and S2 stubs.
/// BTC-like perp (pd 1, ld 5, scale 1), mark 83,500.0, a 50-lot long at the mark and a 50 bps stop.
abstract contract CoverManagerBase is Test {
    uint256 internal constant PERP = 1;
    uint256 internal constant MARK = 835_000;
    uint256 internal constant STOP = 830_825; // 50 bps below MARK
    uint256 internal constant LOTS = 50;
    uint256 internal constant VAULT_ASSETS = 1000e6;
    uint256 internal constant T0 = 1_760_000_000;
    uint256 internal constant B0 = 1_000_000;

    MockAUSD internal ausd;
    MockPerplExchange internal ex;
    MockFeed internal feed;
    VaultStub internal vault;
    FactoryStub internal fac;
    CoverManager internal cm;
    PerplTrader internal maker;
    AccountStub internal acct;

    address internal admin = makeAddr("admin");
    address internal keeper = makeAddr("keeper");
    address internal keeper2 = makeAddr("keeper2");

    function setUp() public virtual {
        vm.warp(T0);
        vm.roll(B0);
        ausd = new MockAUSD();
        ex = new MockPerplExchange(ausd);
        ausd.mint(address(ex), 1_000_000e6);
        ex.listPerp(PERP, "BTC", 1, 5, 2000, MARK);
        feed = new MockFeed(8, "BTC/USD", int256(MARK) * 1e7);
        fac = new FactoryStub();
        vault = new VaultStub(ausd, address(fac));
        cm = new CoverManager(address(ex), address(ausd), address(vault), admin);
        vault.setManager(address(cm));

        vm.startPrank(admin);
        cm.setFactory(address(fac));
        cm.grantRole(Constants.RISK_ADMIN_ROLE, admin);
        cm.grantRole(Constants.SIGMA_ROLE, keeper);
        cm.grantRole(Constants.PAUSER_ROLE, admin);
        cm.listMarket(PERP, _cfg(), Constants.defaultMarketParams());
        vm.stopPrank();
        vm.prank(keeper);
        cm.postSigma(PERP, 27);

        ausd.mint(address(this), VAULT_ASSETS);
        ausd.approve(address(vault), VAULT_ASSETS);
        vault.fund(VAULT_ASSETS);

        maker = new PerplTrader(IPerplMin(address(ex)), IERC20(address(ausd)));
        ausd.mint(address(maker), 100_000e6);
        maker.open(100_000e6);

        acct = _newAccount(100e6);
        _openLong(acct, LOTS);
    }

    // Helpers

    function _cfg() internal view returns (MarketConfig memory c) {
        c = Constants.btcMarketConfig();
        c.feed = address(feed);
    }

    function _newAccount(uint256 fundCNS) internal returns (AccountStub a) {
        a = new AccountStub(IPerplMin(address(ex)), IERC20(address(ausd)), ICoverManager(address(cm)));
        fac.register(address(a));
        ausd.mint(address(a), fundCNS + 10e6);
        a.activate(fundCNS);
    }

    /// @dev Maker rests an ask at MARK, the account lifts it at 10x.
    function _openLong(AccountStub a, uint256 lots) internal {
        maker.rest(1, PERP, MARK, lots);
        a.trade(0, PERP, MARK, lots, 1000);
    }

    function _openShort(AccountStub a, uint256 lots) internal {
        maker.rest(0, PERP, MARK, lots);
        a.trade(1, PERP, MARK, lots, 1000);
    }

    function _params() internal pure returns (CoverParams memory p) {
        p = CoverParams({
            perpId: PERP,
            isLong: true,
            lots: LOTS,
            stopPNS: STOP,
            maxGapBps: 200,
            durationBlocks: 12_000
        });
    }

    function _buy() internal returns (bytes32 id) {
        id = acct.buyCover(_params(), 1e6);
    }

    function _buy(AccountStub a, CoverParams memory p) internal returns (bytes32 id) {
        id = a.buyCover(p, 10e6);
    }

    function _cover(bytes32 id) internal view returns (Cover memory) {
        return cm.getCover(id);
    }

    function _status(bytes32 id) internal view returns (CoverStatus) {
        return cm.getCover(id).status;
    }

    function _roll(uint256 blocks) internal {
        vm.roll(block.number + blocks);
        vm.warp(block.timestamp + (blocks * 3 + 9) / 10); // about 300 ms per block
    }

    /// @dev Moves mark, oracle and feed together (fresh) to `px`.
    function _setRefs(uint256 px) internal {
        ex.setMark(PERP, px);
        ex.setOracle(PERP, px);
        feed.setAnswer(int256(px) * 1e7);
    }

    /// @dev Clears the maker's resting bids by a taker sell, then rests one bid level.
    function _restBid(uint256 px, uint256 lots) internal returns (uint256 oid) {
        oid = maker.rest(0, PERP, px, lots);
    }

    function _restAsk(uint256 px, uint256 lots) internal returns (uint256 oid) {
        oid = maker.rest(1, PERP, px, lots);
    }

    function _pastWarmup() internal {
        _roll(Constants.WARMUP_BLOCKS);
        _setRefs(MARK);
    }

    /// @dev Price gaps to `ref`; best bid sits at `bid` with depth `depth`.
    function _crash(uint256 ref, uint256 bid, uint256 depth) internal {
        _setRefs(ref);
        _restBid(bid, depth);
    }

    function _armAndTrigger(bytes32 id) internal returns (uint256 paid) {
        vm.prank(keeper);
        assertTrue(cm.arm(id));
        _roll(1);
        vm.prank(keeper);
        paid = cm.trigger(id);
    }

    function _managerBalanceMatchesLive(bytes32[] memory ids) internal view returns (bool) {
        uint256 sum;
        for (uint256 i; i < ids.length; ++i) {
            Cover memory c = cm.getCover(ids[i]);
            if (uint8(c.status) <= uint8(CoverStatus.Triggered) && c.status != CoverStatus.None) {
                sum += uint256(c.escrowCNS) + c.rentCNS;
            }
        }
        return ausd.balanceOf(address(cm)) == sum;
    }
}
