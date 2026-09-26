// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Test} from "forge-std/Test.sol";
import {Deploy} from "../../script/Deploy.s.sol";
import {CoverVault} from "../../src/CoverVault.sol";
import {GaplessFactory} from "../../src/GaplessFactory.sol";
import {GaplessAccount} from "../../src/GaplessAccount.sol";
import {GaplessCreSink} from "../../src/cre/GaplessCreSink.sol";
import {IPerplMin} from "../../src/interfaces/perpl/IPerplMin.sol";
import {OperatorGrant, CoverParams} from "../../src/types/GaplessTypes.sol";
import {Constants} from "../../src/Constants.sol";
import {MockAUSD} from "../mocks/MockAUSD.sol";
import {MockPerplExchange} from "../mocks/MockPerplExchange.sol";
import {MockFeed} from "../mocks/MockFeed.sol";
import {PerplTrader} from "../mocks/PerplTrader.sol";
import {ManagerStub} from "../unit/stubs/ManagerStub.sol";

/// @notice Deploy.s.sol with the manager swapped for the interim stub until S2's CoverManager lands.
contract DeployHarness is Deploy {
    bool internal immutable useRealManager;

    constructor(bool useRealManager_) {
        useRealManager = useRealManager_;
    }

    function _deployManager(Config memory c, address vault) internal override returns (address) {
        if (useRealManager) return super._deployManager(c, vault);
        return address(new ManagerStub(c.ex, c.ausd, vault, c.deployer));
    }

    /// @notice Re-runs the post-deploy checks on a deployment (tests mutate it first).
    function check(Config memory c, Deployment memory d) external view {
        _check(c, d);
    }
}

/// @title GaplessFixture
/// @notice Shared S1/S2 fixture: mocks on chain 143, then the real stack through Deploy.s.sol (INTERFACES section 3).
/// @dev Set `useRealManager = true` before `_setUpGapless()` once src/CoverManager.sol exists.
abstract contract GaplessFixture is Test {
    uint256 internal constant BTC = Constants.PERP_BTC;
    uint256 internal constant BID = 861_740; // 86,174.0 (pd 1)
    uint256 internal constant ASK = 861_750;
    uint256 internal constant T0 = 1_791_190_979;
    uint256 internal constant B0 = 110_711_378;
    uint256 internal constant EX_FLOAT = 1_000_000e6;
    uint256 internal constant LEV = 1000; // 10x

    MockAUSD internal ausd;
    MockPerplExchange internal ex;
    MockFeed internal feed;
    PerplTrader internal maker;

    CoverVault internal vault;
    GaplessFactory internal factory;
    GaplessAccount internal impl;
    address internal manager;
    ManagerStub internal stub; // zero when useRealManager
    GaplessCreSink internal sink;

    address internal deployer = makeAddr("deployer");
    address internal treasury = makeAddr("treasury");
    address internal keeper = makeAddr("keeper");
    address internal seedLp = makeAddr("seedLp"); // ListMarket's LP key, never RISK_ADMIN
    bool internal useRealManager;

    function _setUpGapless() internal {
        vm.chainId(Constants.CHAIN_ID);
        vm.warp(T0);
        vm.roll(B0);

        ausd = new MockAUSD();
        ex = new MockPerplExchange(ausd);
        ausd.mint(address(ex), EX_FLOAT);
        ex.listPerp(BTC, "BTC", 1, 5, 1500, BID);
        feed = new MockFeed(Constants.FEED_DECIMALS, "BTC / USD", int256(BID) * 1e7);

        maker = new PerplTrader(ex, ausd);
        ausd.mint(address(maker), 1_000_000e6);
        maker.open(1_000_000e6);
        maker.rest(Constants.ORDER_OPEN_LONG, BTC, BID, 100_000);
        maker.rest(Constants.ORDER_OPEN_LONG, BTC, BID - 1000, 100_000);
        maker.rest(Constants.ORDER_OPEN_SHORT, BTC, ASK, 100_000);
        maker.rest(Constants.ORDER_OPEN_SHORT, BTC, ASK + 1000, 100_000);

        ausd.mint(deployer, Constants.VAULT_SEED_CNS);
        DeployHarness h = new DeployHarness(useRealManager);
        Deploy.Deployment memory d = h.deploy(
            Deploy.Config({
                ex: address(ex),
                ausd: address(ausd),
                deployer: deployer,
                treasury: treasury,
                keeper: keeper,
                builderId: Constants.BUILDER_ID,
                creForwarder: Constants.CRE_FORWARDER_SIM,
                admin: deployer,
                riskAdmin: deployer,
                pauser: deployer
            })
        );
        vault = d.vault;
        factory = d.factory;
        impl = GaplessAccount(d.impl);
        manager = d.manager;
        sink = d.sink;
        if (!useRealManager) stub = ManagerStub(manager);

        vm.label(address(ausd), "AUSD");
        vm.label(address(ex), "Perpl");
        vm.label(address(vault), "CoverVault");
        vm.label(address(factory), "GaplessFactory");
        vm.label(manager, "CoverManager");
    }

    // Helpers

    function _lp(address who, uint256 amount) internal returns (uint256 shares) {
        ausd.mint(who, amount);
        vm.startPrank(who);
        ausd.approve(address(vault), amount);
        shares = vault.deposit(amount, who);
        vm.stopPrank();
    }

    function _noGrant() internal pure returns (OperatorGrant memory g) {}

    /// @dev Per-trade cap `cap`, unlimited rolling budget (N-03 tests set maxNotionalPerDayCNS explicitly).
    function _grant(address key, uint64 expiry, uint128 cap) internal pure returns (OperatorGrant memory) {
        return OperatorGrant(key, expiry, cap, type(uint128).max);
    }

    /// @notice Owner creates an account through the factory with `deposit` AUSD (activates Perpl at >= 10 AUSD).
    function _account(address owner_, uint256 deposit, OperatorGrant memory g) internal returns (GaplessAccount a) {
        ausd.mint(owner_, deposit);
        vm.startPrank(owner_);
        ausd.approve(address(factory), deposit);
        a = GaplessAccount(factory.createAccount(deposit, g));
        vm.stopPrank();
    }

    function _order(uint8 t, uint256 px, uint256 lots) internal pure returns (IPerplMin.OrderDesc memory d) {
        d.perpId = BTC;
        d.orderType = t;
        d.pricePNS = px;
        d.lotLNS = lots;
        d.immediateOrCancel = true;
        d.leverageHdths = LEV;
        d.maxNegPnlCollatBPS = Constants.USER_MAX_NEG_PNL_BPS;
    }

    function _openLong(GaplessAccount a, uint256 lots) internal {
        vm.prank(a.owner());
        a.trade(_order(Constants.ORDER_OPEN_LONG, ASK * 101 / 100, lots));
    }

    function _openShort(GaplessAccount a, uint256 lots) internal {
        vm.prank(a.owner());
        a.trade(_order(Constants.ORDER_OPEN_SHORT, BID * 99 / 100, lots));
    }

    function _coverParams(uint256 lots, bool isLong) internal pure returns (CoverParams memory p) {
        p.perpId = BTC;
        p.isLong = isLong;
        p.lots = lots;
        p.stopPNS = isLong ? BID * 98 / 100 : ASK * 102 / 100;
        p.maxGapBps = Constants.COVER_MAX_GAP_BPS_DEFAULT;
        p.durationBlocks = Constants.COVER_DURATION_DEFAULT;
    }

    /// @notice EIP-712 signature (r, s, v packed) over `structHash` in `domainSeparator`.
    function _sign(uint256 pk, bytes32 domainSeparator, bytes32 structHash) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) =
            vm.sign(pk, keccak256(abi.encodePacked("\x19\x01", domainSeparator, structHash)));
        return abi.encodePacked(r, s, v);
    }

    function _domain(string memory name, address verifying) internal view returns (bytes32) {
        return keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256(bytes(name)),
                keccak256("1"),
                block.chainid,
                verifying
            )
        );
    }

    function _position(GaplessAccount a) internal view returns (IPerplMin.PositionInfo memory p) {
        (p,,) = ex.getPosition(BTC, a.perplAccountId());
    }

    function _perplBalance(GaplessAccount a) internal view returns (uint256) {
        return ex.getAccountById(a.perplAccountId()).balanceCNS;
    }
}
