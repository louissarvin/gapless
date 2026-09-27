// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {GaplessFixture} from "../utils/GaplessFixture.sol";
import {ListMarket} from "../../script/ListMarket.s.sol";
import {CoverManager} from "../../src/CoverManager.sol";
import {Constants} from "../../src/Constants.sol";
import {MarketConfig, MarketParams} from "../../src/types/GaplessTypes.sol";

/// @dev Stands in for a key in script mode: forge forbids pranks around vm.startBroadcast.
contract Caller {
    function exec(address target, bytes calldata data) external {
        (bool ok, bytes memory ret) = target.call(data);
        if (!ok) {
            assembly ("memory-safe") {
                revert(add(ret, 32), mload(ret))
            }
        }
    }
}

/// @dev Exposes the env reader; a test-only variable name keeps parallel tests off the script's real env.
contract ListMarketHarness is ListMarket {
    function envUint(string memory name, uint256 dflt, uint256 max) external view returns (uint256) {
        return _envUint(name, dflt, max);
    }
}

interface MockFeedLike {
    function setAnswer(int256 answer) external;
}

/// @notice ListMarket's three sessions (RISK_ADMIN, keeper, LP) through their env entry points, with the canary
/// defaults of docs/CANARY_PARAMS.md. Env names match the script NatSpec; KEEPER matches Deploy.t.sol.
contract ListMarketScriptTest is GaplessFixture {
    CoverManager internal cm;
    ListMarket internal lm;

    function setUp() public {
        useRealManager = true;
        _setUpGapless();
        cm = CoverManager(manager);
        lm = new ListMarket();
        vm.setEnv("MANAGER", vm.toString(manager));
        vm.setEnv("VAULT", vm.toString(address(vault)));
        vm.setEnv("KEEPER", vm.toString(keeper));
    }

    function test_threeSessions_canaryDefaults() public {
        Caller risk = new Caller();
        Caller sigma = new Caller();
        Caller lpKey = new Caller();
        vm.startPrank(deployer);
        cm.grantRole(Constants.RISK_ADMIN_ROLE, address(risk));
        cm.grantRole(Constants.SIGMA_ROLE, address(sigma));
        vm.stopPrank();
        // The script lists the mainnet BTC config; the fixture's feed stands in at the mainnet address.
        vm.etch(Constants.FEED_BTC_USD, address(feed).code);
        MockFeedLike(Constants.FEED_BTC_USD).setAnswer(int256(BID) * 1e7);
        risk.exec(address(lm), abi.encodeCall(ListMarket.run, ()));
        MarketParams memory p = cm.marketParams(BTC);
        assertEq(p.maxCoverNotionalCNS, lm.CANARY_MAX_COVER_NOTIONAL_CNS());
        assertEq(p.marketCapBps, lm.CANARY_MARKET_CAP_BPS());
        assertEq(p.maxMatchesClose, lm.CANARY_MAX_MATCHES_CLOSE());
        assertEq(p.maxMatchesClose, 8, "SA4-01");
        assertEq(p.slipAllowanceBps, Constants.SLIP_ALLOWANCE_BPS);

        sigma.exec(address(lm), abi.encodeCall(ListMarket.postSigma, ()));
        (uint32 s,) = cm.sigmaOf(BTC);
        assertEq(s, Constants.SIGMA_BPS_E2_CALM);

        ausd.mint(address(risk), 3e6);
        vm.expectRevert("ListMarket: LP holds RISK_ADMIN");
        risk.exec(address(lm), abi.encodeCall(ListMarket.seed, ()));
        ausd.mint(address(lpKey), 3e6);
        lpKey.exec(address(lm), abi.encodeCall(ListMarket.seed, ()));
        assertEq(vault.totalAssets(), 4e6, "1 dead seed + 3 LP");
        assertEq(vault.balanceOf(address(risk)), 0);
    }

    /// @notice A MAX_MATCHES_CLOSE override outside [8, 200] fails in the script preflight, before listMarket.
    function test_list_maxMatchesCloseOutOfBounds() public {
        MarketConfig memory cfg = Constants.btcMarketConfig();
        cfg.feed = address(feed);
        ListMarket.Config memory c;
        c.manager = manager;
        c.vault = address(vault);
        c.riskAdmin = deployer;
        c.keeper = keeper;
        c.perpId = BTC;
        c.cfg = cfg;
        c.params = lm.canaryParams(20e6, 10_000, Constants.MAX_MATCHES_CLOSE_MIN - 1);
        vm.expectRevert("ListMarket: maxMatchesClose out of bounds");
        lm.list(c);
        c.params.maxMatchesClose = Constants.MAX_MATCHES_CLOSE_MAX + 1;
        vm.expectRevert("ListMarket: maxMatchesClose out of bounds");
        lm.list(c);
    }

    function test_run_requiresRiskAdmin() public {
        vm.expectRevert("ListMarket: caller lacks RISK_ADMIN");
        lm.run();
        vm.prank(deployer);
        cm.grantRole(Constants.SIGMA_ROLE, address(this));
        vm.expectRevert("ListMarket: list first");
        lm.postSigma();
    }

    /// @notice SA3-I6: an override that does not fit the field reverts instead of truncating (75,000 as uint16 is 9,464).
    function test_envOverride_outOfRangeReverts() public {
        ListMarketHarness h = new ListMarketHarness();
        string memory name = "GAPLESS_TEST_LISTMARKET_U16";
        assertEq(h.envUint(name, 10_000, type(uint16).max), 10_000, "default when unset");
        vm.setEnv(name, "65535");
        assertEq(h.envUint(name, 10_000, type(uint16).max), 65_535);
        vm.setEnv(name, "75000");
        vm.expectRevert(bytes("ListMarket: GAPLESS_TEST_LISTMARKET_U16 out of range"));
        h.envUint(name, 10_000, type(uint16).max);
    }

    function test_canaryParamsWithinBounds() public {
        MarketParams memory p = lm.canaryParams(20e6, 10_000, 8);
        assertEq(p.maxMatchesClose, Constants.MAX_MATCHES_CLOSE_MIN, "canary sits at the lower bound");
        MarketConfig memory cfg = Constants.btcMarketConfig();
        cfg.feed = address(feed);
        vm.prank(deployer);
        cm.listMarket(BTC, cfg, p); // reverts ParamOutOfBounds if any canary value is out of bounds
        assertEq(cm.marketParams(BTC).maxCoverNotionalCNS, 20e6);
        assertEq(cm.marketParams(BTC).maxMatchesClose, 8);
    }
}
