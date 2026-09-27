// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Test} from "forge-std/Test.sol";
import {
    IAccessControlDefaultAdminRules
} from "@openzeppelin/contracts/access/extensions/IAccessControlDefaultAdminRules.sol";
import {Deploy} from "../../script/Deploy.s.sol";
import {ListMarket} from "../../script/ListMarket.s.sol";
import {CoverManager} from "../../src/CoverManager.sol";
import {CoverVault} from "../../src/CoverVault.sol";
import {GaplessFactory} from "../../src/GaplessFactory.sol";
import {GaplessAccount} from "../../src/GaplessAccount.sol";
import {IPerplMin} from "../../src/interfaces/perpl/IPerplMin.sol";
import {Constants} from "../../src/Constants.sol";
import {
    CoverParams,
    Cover,
    CoverStatus,
    MarketConfig,
    MarketParams,
    OperatorGrant,
    VaultConfig
} from "../../src/types/GaplessTypes.sol";
import {MockAUSD} from "../mocks/MockAUSD.sol";
import {MockPerplExchange} from "../mocks/MockPerplExchange.sol";
import {MockFeed} from "../mocks/MockFeed.sol";
import {PerplTrader} from "../mocks/PerplTrader.sol";

/// @dev A script session's key: forge forbids pranks around vm.startBroadcast, so the scripts are called from code
/// etched at the key's address (its nonce stays 0, so CREATE addresses match an EOA's).
contract CanaryKey {
    function exec(address target, bytes calldata data) external returns (bytes memory ret) {
        bool ok;
        (ok, ret) = target.call(data);
        if (!ok) {
            assembly ("memory-safe") {
                revert(add(ret, 32), mload(ret))
            }
        }
    }
}

/// @title CanaryDeployTest
/// @notice RUNBOOK.md dry run: Deploy.s.sol, the three ListMarket sessions and the demo trade plus cover on an in-memory
/// chain 143, with the doubles etched at the mainnet Perpl, AUSD and BTC/USD feed addresses. No fork, no RPC.
/// @dev vm.setEnv is process wide and suites run in parallel, so every env value set here equals the one set by
/// Deploy.t.sol and ListMarketScript.t.sol (same deployer and nonces, hence the same MANAGER and VAULT); ADMIN,
/// RISK_ADMIN and PAUSER are never set (Deploy.t.sol asserts their fallback).
contract CanaryDeployTest is Test {
    uint256 internal constant BTC = Constants.PERP_BTC;
    // Mainnet shape at the 2026-10-06 preflight: BTC about 85,275 (pd 1), block and time near the head.
    uint256 internal constant BID = 852_750;
    uint256 internal constant ASK = 852_760;
    uint256 internal constant MARK = 852_755;
    uint256 internal constant T0 = 1_791_222_479;
    uint256 internal constant B0 = 110_815_681;

    // Demo cover (CANARY_PARAMS section 3): 22 lots, stop 50 bps under mark, maxGap 200, 12,000 blocks.
    uint256 internal constant DEMO_LOTS = 22;
    uint256 internal constant DEMO_STOP = MARK * 9950 / 10_000;
    uint128 internal constant GRANT_PER_TRADE = 25e6;
    uint128 internal constant GRANT_PER_DAY = 100e6;

    MockAUSD internal ausd = MockAUSD(Constants.AUSD);
    MockPerplExchange internal ex = MockPerplExchange(Constants.PERPL_EXCHANGE);
    MockFeed internal feed = MockFeed(Constants.FEED_BTC_USD);

    // Same labels as GaplessFixture and Deploy.t.sol: the shared env values must match (see contract NatSpec).
    address internal deployer = makeAddr("deployer");
    address internal treasury = makeAddr("treasury");
    address internal keeper = makeAddr("keeper");
    address internal lp = makeAddr("canaryLp");
    address internal relay = makeAddr("canaryRelay");
    address internal operatorKey = makeAddr("canaryOperator");

    function setUp() public {
        vm.chainId(Constants.CHAIN_ID);
        vm.warp(T0);
        vm.roll(B0);
        deployCodeTo("MockAUSD.sol:MockAUSD", Constants.AUSD);
        deployCodeTo("MockPerplExchange.sol:MockPerplExchange", abi.encode(Constants.AUSD), Constants.PERPL_EXCHANGE);
        deployCodeTo(
            "MockFeed.sol:MockFeed",
            abi.encode(Constants.FEED_DECIMALS, "BTC / USD", int256(MARK) * 1e7),
            Constants.FEED_BTC_USD
        );
        ausd.mint(address(ex), 1_000_000e6);
        ex.listPerp(BTC, "BTC", 1, 5, 1500, MARK);

        PerplTrader maker = new PerplTrader(ex, ausd);
        ausd.mint(address(maker), 1_000_000e6);
        maker.open(1_000_000e6);
        maker.rest(Constants.ORDER_OPEN_LONG, BTC, BID, 100_000);
        maker.rest(Constants.ORDER_OPEN_SHORT, BTC, ASK, 100_000);
    }

    /// @notice BUILD_PLAN section 0 canary: the deployer holds DEFAULT_ADMIN, RISK_ADMIN and PAUSER; the keeper holds
    /// SIGMA_ROLE; a separate LP key seeds. Every step goes through the scripts' env entry points.
    function test_canary_envEntryPoints_threeWallets() public {
        _threeWalletCanary();
    }

    /// @notice SA4-01: at the listed maxMatchesClose 8 the 22-lot demo cover closes against 22 one-lot bids from 22
    /// distinct accounts in exactly ceil(22 / 8) = 3 trigger calls, all inside the 40-block window.
    function test_canary_demoClose_threeFillCallsAtEightMatches() public {
        (Deploy.Deployment memory d, bytes32 id) = _threeWalletCanary();
        CoverManager m = CoverManager(d.manager);
        uint16 mm = m.marketParams(BTC).maxMatchesClose;
        assertEq(mm, 8);
        assertEq((DEMO_LOTS + mm - 1) / mm, 3, "fill calls for the demo cover");

        _roll(Constants.WARMUP_BLOCKS + 1);
        uint256 r = DEMO_STOP - 100;
        _refs(r);
        _trader(20_000e6).ioc(Constants.ORDER_OPEN_SHORT, BTC, BID, 100_000); // gap: the maker's bid is gone
        for (uint256 j; j < DEMO_LOTS; ++j) {
            _trader(20e6).rest(Constants.ORDER_OPEN_LONG, BTC, r - j, 1); // inside the step-0 limit R x (1 - 5 bps)
        }

        uint256[3] memory want = [uint256(8), 16, 22];
        for (uint256 i; i < 3; ++i) {
            _refs(r);
            vm.prank(keeper);
            m.trigger(id);
            Cover memory c = m.getCover(id);
            assertEq(c.filledLots, want[i], "8 matches per call");
            assertEq(uint8(c.status), uint8(CoverStatus.Triggered));
            assertLe(block.number - c.triggerBlock, Constants.WINDOW_BLOCKS, "inside the window");
            _roll(1);
        }
    }

    function _threeWalletCanary() internal returns (Deploy.Deployment memory d, bytes32 id) {
        vm.setEnv("TREASURY", vm.toString(treasury));
        vm.setEnv("KEEPER", vm.toString(keeper));
        ausd.mint(deployer, Constants.VAULT_SEED_CNS);

        // run() takes the deployer from msg.sender (flag:account), as do the three ListMarket sessions.
        deployCodeTo("CanaryDeploy.t.sol:CanaryKey", deployer);
        deployCodeTo("CanaryDeploy.t.sol:CanaryKey", keeper);
        deployCodeTo("CanaryDeploy.t.sol:CanaryKey", lp);
        Deploy script = new Deploy();
        d = abi.decode(CanaryKey(deployer).exec(address(script), abi.encodeCall(Deploy.run, ())), (Deploy.Deployment));
        // Shared env: MANAGER and VAULT must equal ListMarketScript's fixture (deployer nonces 1 and 2).
        assertEq(address(d.vault), vm.computeCreateAddress(deployer, 1), "vault nonce");
        assertEq(d.manager, vm.computeCreateAddress(deployer, 2), "manager nonce");
        assertEq(vm.getNonce(deployer), 11, "approve, 5 creates, 2 wirings, 4 grants (RUNBOOK tx list)");
        _assertDeployed(d, deployer, deployer, deployer, treasury);
        _assertNoPendingAdmin(d);

        vm.setEnv("MANAGER", vm.toString(d.manager));
        vm.setEnv("VAULT", vm.toString(address(d.vault)));
        ListMarket lm = new ListMarket();
        CanaryKey(deployer).exec(address(lm), abi.encodeCall(ListMarket.run, ()));
        vm.roll(block.number + 1);
        CanaryKey(keeper).exec(address(lm), abi.encodeCall(ListMarket.postSigma, ()));
        ausd.mint(lp, lm.CANARY_SEED_DEPOSIT_CNS());
        CanaryKey(lp).exec(address(lm), abi.encodeCall(ListMarket.seed, ()));

        _assertListedAndSeeded(d, lm);
        id = _demoTradeAndCover(d);
    }

    /// @notice Recommended split (I-01): separate ADMIN, RISK_ADMIN and PAUSER; ADMIN accepts on both contracts after
    /// ADMIN_DELAY, and defaultAdmin() is confirmed before listing (SA3 canary condition 5).
    function test_canary_splitRoles_adminAcceptedBeforeListing() public {
        address dep = makeAddr("canarySplitDeployer");
        address admin = makeAddr("canaryAdmin");
        address risk = makeAddr("canaryRiskAdmin");
        address pauser = makeAddr("canaryPauser");
        ausd.mint(dep, Constants.VAULT_SEED_CNS);

        Deploy.Deployment memory d = new Deploy()
            .deploy(
                Deploy.Config({
                    ex: Constants.PERPL_EXCHANGE,
                    ausd: Constants.AUSD,
                    deployer: dep,
                    treasury: dep,
                    keeper: keeper,
                    builderId: Constants.BUILDER_ID,
                    creForwarder: Constants.CRE_FORWARDER_SIM,
                    admin: admin,
                    riskAdmin: risk,
                    pauser: pauser
                })
            );
        _assertDeployed(d, dep, risk, pauser, dep);
        assertFalse(CoverManager(d.manager).hasRole(Constants.RISK_ADMIN_ROLE, dep));
        assertFalse(CoverManager(d.manager).hasRole(Constants.PAUSER_ROLE, dep));
        assertFalse(d.vault.hasRole(Constants.PAUSER_ROLE, dep));

        uint48 due = uint48(block.timestamp) + Constants.ADMIN_DELAY;
        _assertPending(IAccessControlDefaultAdminRules(d.manager), admin, due);
        _assertPending(IAccessControlDefaultAdminRules(address(d.vault)), admin, due);

        vm.warp(due);
        vm.expectRevert(abi.encodeWithSignature("AccessControlEnforcedDefaultAdminDelay(uint48)", due));
        vm.prank(admin);
        CoverManager(d.manager).acceptDefaultAdminTransfer();
        vm.warp(due + 1);
        _refs();
        vm.prank(admin);
        CoverManager(d.manager).acceptDefaultAdminTransfer();
        vm.prank(admin);
        d.vault.acceptDefaultAdminTransfer();
        assertEq(CoverManager(d.manager).defaultAdmin(), admin);
        assertEq(d.vault.defaultAdmin(), admin);
        assertFalse(CoverManager(d.manager).hasRole(bytes32(0), dep));
        assertFalse(d.vault.hasRole(bytes32(0), dep));
        _assertNoPendingAdmin(d);

        ListMarket lm = new ListMarket();
        ListMarket.Config memory c;
        c.manager = d.manager;
        c.vault = address(d.vault);
        c.riskAdmin = risk;
        c.keeper = keeper;
        c.lp = lp;
        c.perpId = BTC;
        c.cfg = Constants.btcMarketConfig();
        c.params = lm.canaryParams(
            lm.CANARY_MAX_COVER_NOTIONAL_CNS(), lm.CANARY_MARKET_CAP_BPS(), lm.CANARY_MAX_MATCHES_CLOSE()
        );
        c.sigmaBlkBpsE2 = Constants.SIGMA_BPS_E2_CALM;
        c.seedDepositCNS = lm.CANARY_SEED_DEPOSIT_CNS();
        ausd.mint(lp, c.seedDepositCNS);
        lm.list(c);

        _assertListedAndSeeded(d, lm);
        _demoTradeAndCover(d);
    }

    /// @dev Perpl mark, oracle and the feed at the current time (the mock ages them like mainnet).
    function _refs() internal {
        _refs(MARK);
    }

    function _refs(uint256 px) internal {
        ex.setMark(BTC, px);
        ex.setOracle(BTC, px);
        feed.setAnswer(int256(px) * 1e7);
    }

    function _roll(uint256 n) internal {
        vm.roll(block.number + n);
        vm.warp(block.timestamp + (n * 3 + 9) / 10);
    }

    /// @dev A distinct Perpl account per call (Monad prices each new maker as cold storage, SA4-01).
    function _trader(uint256 fund) internal returns (PerplTrader t) {
        t = new PerplTrader(ex, ausd);
        ausd.mint(address(t), fund);
        t.open(fund);
    }

    // Assertions

    function _assertDeployed(Deploy.Deployment memory d, address dep, address risk, address pauser, address treas)
        internal
        view
    {
        CoverManager m = CoverManager(d.manager);
        GaplessAccount impl = GaplessAccount(d.impl);

        assertEq(m.EXCHANGE(), Constants.PERPL_EXCHANGE);
        assertEq(m.AUSD(), Constants.AUSD);
        assertEq(m.VAULT(), address(d.vault));
        assertEq(m.factory(), address(d.factory));
        assertEq(d.vault.asset(), Constants.AUSD);
        assertEq(d.vault.manager(), d.manager);
        assertEq(d.vault.factory(), address(d.factory));
        assertEq(d.factory.IMPL(), d.impl);
        assertEq(d.factory.MANAGER(), d.manager);
        assertEq(d.factory.AUSD(), Constants.AUSD);
        assertEq(impl.FACTORY(), address(d.factory));
        assertEq(impl.MANAGER(), d.manager);
        assertEq(impl.VAULT(), address(d.vault));
        assertEq(impl.EX(), Constants.PERPL_EXCHANGE);
        assertEq(impl.BUILDER_ID(), Constants.BUILDER_ID);
        assertEq(impl.owner(), Constants.DEAD, "impl locked");
        assertEq(d.sink.forwarder(), Constants.CRE_FORWARDER_SIM);
        assertEq(d.sink.chainSelector(), Constants.CHAIN_SELECTOR);
        assertEq(d.sink.manager(), d.manager);

        VaultConfig memory vc = d.vault.config();
        assertEq(vc.treasury, treas);
        assertEq(vc.maxUtilizationBps, Constants.MAX_UTILIZATION_BPS);
        assertEq(vc.protocolFeeBps, Constants.PROTOCOL_FEE_BPS);
        assertEq(vc.minDepositCNS, Constants.MIN_DEPOSIT_CNS);
        assertEq(d.vault.totalAssets(), Constants.VAULT_SEED_CNS);
        assertEq(d.vault.balanceOf(Constants.DEAD), d.vault.totalSupply(), "dead seed holds every share");
        assertEq(ausd.balanceOf(dep), 0);
        assertEq(ausd.allowance(dep, address(d.vault)), 0);

        assertEq(m.defaultAdmin(), dep, "admin until accepted");
        assertEq(d.vault.defaultAdmin(), dep);
        assertEq(m.defaultAdminDelay(), Constants.ADMIN_DELAY);
        assertEq(d.vault.defaultAdminDelay(), Constants.ADMIN_DELAY);
        assertTrue(m.hasRole(Constants.RISK_ADMIN_ROLE, risk));
        assertTrue(m.hasRole(Constants.PAUSER_ROLE, pauser));
        assertTrue(d.vault.hasRole(Constants.PAUSER_ROLE, pauser));
        assertTrue(m.hasRole(Constants.SIGMA_ROLE, keeper));
        assertFalse(m.hasRole(Constants.SIGMA_ROLE, dep), "sigma key is the keeper only");
        assertFalse(m.hasRole(Constants.RISK_ADMIN_ROLE, keeper));
        assertFalse(m.hasRole(Constants.PAUSER_ROLE, keeper));
        assertFalse(m.hasRole(bytes32(0), keeper));
        assertFalse(m.paused());
        assertFalse(d.vault.paused());
        assertEq(m.listedPerps().length, 0);
    }

    function _assertPending(IAccessControlDefaultAdminRules c, address admin, uint48 due) internal view {
        (address pending, uint48 schedule) = c.pendingDefaultAdmin();
        assertEq(pending, admin);
        assertEq(schedule, due);
    }

    function _assertNoPendingAdmin(Deploy.Deployment memory d) internal view {
        _assertPending(IAccessControlDefaultAdminRules(d.manager), address(0), 0);
        _assertPending(IAccessControlDefaultAdminRules(address(d.vault)), address(0), 0);
    }

    function _assertListedAndSeeded(Deploy.Deployment memory d, ListMarket lm) internal view {
        CoverManager m = CoverManager(d.manager);
        uint256[] memory perps = m.listedPerps();
        assertEq(perps.length, 1);
        assertEq(perps[0], BTC);
        MarketConfig memory want = Constants.btcMarketConfig();
        MarketConfig memory got = m.marketConfig(BTC);
        assertTrue(got.listed);
        assertEq(abi.encode(got), abi.encode(want), "market config");
        assertEq(m.scaleOf(BTC), 1);

        MarketParams memory p = m.marketParams(BTC);
        assertEq(
            abi.encode(p),
            abi.encode(
                lm.canaryParams(
                    lm.CANARY_MAX_COVER_NOTIONAL_CNS(), lm.CANARY_MARKET_CAP_BPS(), lm.CANARY_MAX_MATCHES_CLOSE()
                )
            ),
            "canary params"
        );
        assertEq(p.maxCoverNotionalCNS, 20e6);
        assertEq(p.marketCapBps, 10_000);
        assertEq(p.maxMatchesClose, 8, "SA4-01 canary");
        assertGe(p.maxMatchesClose, Constants.MAX_MATCHES_CLOSE_MIN);
        assertLe(p.maxMatchesClose, Constants.MAX_MATCHES_CLOSE_MAX);
        assertEq(p.maxDurationBlocks, Constants.MAX_DURATION_BLOCKS);
        assertEq(p.sigmaMaxAgeBlocks, 6000);
        (uint32 s, uint48 posted) = m.sigmaOf(BTC);
        assertEq(s, Constants.SIGMA_BPS_E2_CALM);
        assertEq(posted, block.number);

        assertEq(d.vault.totalAssets(), 4e6, "1 dead seed + 3 LP");
        assertEq(d.vault.reservedTotal(), 0);
        assertEq(d.vault.balanceOf(lp), d.vault.totalSupply() - d.vault.balanceOf(Constants.DEAD));
        assertEq(d.vault.lockUntil(lp), block.number + Constants.DEPOSIT_LOCK_BLOCKS);
        assertFalse(m.hasRole(Constants.RISK_ADMIN_ROLE, lp), "LP never RISK_ADMIN (N-08)");
        assertEq(ausd.balanceOf(lp), 0);
    }

    /// @dev RUNBOOK demo: fund accountOf(owner) with 10 AUSD, relay createAccountFor, sweep (/activate), then the
    /// operator's tradeAndCover at the canary grant. The 4 AUSD vault fits the 22-lot cover (share cap TA / 10).
    function _demoTradeAndCover(Deploy.Deployment memory d) internal returns (bytes32 id) {
        GaplessAccount a = _demoAccount(d.factory);
        IPerplMin.OrderDesc memory o;
        o.perpId = BTC;
        o.orderType = Constants.ORDER_OPEN_LONG;
        o.pricePNS = ASK * 10_030 / 10_000;
        o.lotLNS = DEMO_LOTS;
        o.immediateOrCancel = true;
        o.leverageHdths = 1000; // 10x passes D40 at a 50 bps stop, 20x does not (CANARY_PARAMS)
        o.maxNegPnlCollatBPS = Constants.USER_MAX_NEG_PNL_BPS;
        CoverParams memory p = CoverParams(
            BTC, true, DEMO_LOTS, DEMO_STOP, Constants.COVER_MAX_GAP_BPS_DEFAULT, Constants.COVER_DURATION_DEFAULT
        );
        vm.prank(operatorKey);
        id = a.tradeAndCover(o, p, 50_000);

        Cover memory c = CoverManager(d.manager).getCover(id);
        uint256 cap = DEMO_LOTS * DEMO_STOP * 200 / 10_000;
        assertEq(uint8(c.status), uint8(CoverStatus.Live));
        assertEq(c.capCNS, cap);
        assertLe(cap * 10, d.vault.totalAssets(), "per-cover share cap (L-09)");
        assertEq(c.rentCNS, Constants.MIN_FEE_CNS, "rent at the 0.02 floor for 12,000 blocks");
        assertLt(c.escrowCNS, 15_000);
        assertEq(d.vault.reservedTotal(), cap);
        assertEq(d.vault.reserved(BTC), cap);
        (uint256 used,) = a.operatorUsage();
        assertLe(used, GRANT_PER_DAY);
        emit log_named_uint("demo cap CNS", cap);
        emit log_named_uint("demo escrow CNS", c.escrowCNS);
        emit log_named_uint("operator budget used CNS", used);
    }

    /// @dev Fund first (SE1 H-2), then the relay's createAccountFor with the owner's 4-field grant, then sweep.
    function _demoAccount(GaplessFactory f) internal returns (GaplessAccount a) {
        (address owner, uint256 ownerPk) = makeAddrAndKey("canaryDemoOwner");
        OperatorGrant memory g =
            OperatorGrant(operatorKey, uint64(block.timestamp + 6 hours), GRANT_PER_TRADE, GRANT_PER_DAY);
        address predicted = f.accountOf(owner);
        ausd.mint(owner, 10e6);
        vm.prank(owner);
        ausd.transfer(predicted, 10e6);

        uint256 deadline = block.timestamp + 1 hours;
        bytes32 structHash = keccak256(
            abi.encode(
                Constants.CREATE_ACCOUNT_TYPEHASH,
                owner,
                g.key,
                g.expiry,
                g.maxNotionalPerTradeCNS,
                g.maxNotionalPerDayCNS,
                deadline
            )
        );
        (uint8 v, bytes32 r, bytes32 s) =
            vm.sign(ownerPk, keccak256(abi.encodePacked("\x19\x01", f.DOMAIN_SEPARATOR(), structHash)));
        vm.prank(relay);
        a = GaplessAccount(f.createAccountFor(owner, g, deadline, abi.encodePacked(r, s, v)));
        assertEq(address(a), predicted);
        vm.prank(relay);
        a.sweep();
        assertGt(a.perplAccountId(), 0);
        assertEq(ex.getAccountById(a.perplAccountId()).balanceCNS, 10e6);
    }
}
