// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ICoverManager} from "../src/interfaces/ICoverManager.sol";
import {ICoverVault} from "../src/interfaces/ICoverVault.sol";
import {IPerplMin} from "../src/interfaces/perpl/IPerplMin.sol";
import {IAggregatorV3} from "../src/interfaces/external/IAggregatorV3.sol";
import {MarketConfig, MarketParams} from "../src/types/GaplessTypes.sol";
import {Constants} from "../src/Constants.sol";

/// @title ListMarket
/// @notice INTERFACES.md section 3 step 8 in three sessions, one key each: RISK_ADMIN lists BTC (perp 1) with the
/// canary params (`run`), the keeper posts sigma (`postSigma`), a separate LP key seeds the vault (`seed`).
/// The LP deposit never comes from RISK_ADMIN (SA2 N-08), so the role that sets the refund zone is not an LP.
/// @dev Simulate only from here: forge script script/ListMarket.s.sol with flag:rpc-url monad, flag:account <key>
/// and flag:sig "run()" | "postSigma()" | "seed()" (no flag:broadcast). Values: docs/CANARY_PARAMS.md.
/// Env (all sessions): MANAGER, VAULT.
/// Env (run, RISK_ADMIN key): KEEPER; MAX_COVER_NOTIONAL_CNS (default 20e6); MARKET_CAP_BPS (default 10000);
/// MAX_MATCHES_CLOSE (default 8, bounds [8, 200]; SA4-01 trigger gas).
/// Env (postSigma, keeper key): SIGMA_BPS_E2 (default 27).
/// Env (seed, LP key): SEED_DEPOSIT_CNS (default 3e6); the LP must not hold RISK_ADMIN_ROLE.
contract ListMarket is Script {
    struct Config {
        address manager;
        address vault;
        address riskAdmin; // lists the market
        address keeper; // SIGMA_ROLE
        address lp; // seeds the vault; never the RISK_ADMIN
        uint256 perpId;
        MarketConfig cfg;
        MarketParams params;
        uint32 sigmaBlkBpsE2;
        uint256 seedDepositCNS;
    }

    /// @dev Canary defaults (docs/CANARY_PARAMS.md): vault 1 dead seed + 3 LP = 4 AUSD; a 20 AUSD cover at maxGap
    /// 200 bps needs totalAssets >= 4 AUSD at a 100% market cap; <= 32 BTC lots while the stop is >= 62,500.
    uint256 public constant CANARY_SEED_DEPOSIT_CNS = 3e6;
    uint80 public constant CANARY_MAX_COVER_NOTIONAL_CNS = 20e6;
    uint16 public constant CANARY_MARKET_CAP_BPS = 10_000;
    /// @dev SA4-01: about 1.6M trigger gas on Perpl at 8 distinct makers (2.4M at 16); 22 lots take <= 3 fill calls.
    uint16 public constant CANARY_MAX_MATCHES_CLOSE = 8;

    /// @notice Session 1, RISK_ADMIN key: preflight and listMarket.
    function run() external {
        require(block.chainid == Constants.CHAIN_ID, "ListMarket: chain 143 only");
        Config memory c = _envConfig();
        c.riskAdmin = msg.sender;
        c.keeper = vm.envAddress("KEEPER");
        ICoverManager m = ICoverManager(c.manager);
        _preflightList(c, m);
        vm.startBroadcast(c.riskAdmin);
        m.listMarket(c.perpId, c.cfg, c.params);
        vm.stopBroadcast();
        require(m.marketConfig(c.perpId).listed, "ListMarket: not listed");
        console2.log("listed perp", c.perpId);
    }

    /// @notice Session 2, keeper key: first sigma post.
    function postSigma() external {
        require(block.chainid == Constants.CHAIN_ID, "ListMarket: chain 143 only");
        Config memory c = _envConfig();
        c.keeper = msg.sender;
        _postSigma(c, ICoverManager(c.manager));
    }

    /// @notice Session 3, LP key: the vault's first LP deposit.
    function seed() external {
        require(block.chainid == Constants.CHAIN_ID, "ListMarket: chain 143 only");
        Config memory c = _envConfig();
        c.lp = msg.sender;
        _seed(c, ICoverManager(c.manager));
    }

    /// @notice All three steps with their own keys (tests and local simulation).
    function list(Config memory c) public {
        ICoverManager m = ICoverManager(c.manager);
        _preflightList(c, m);
        vm.startBroadcast(c.riskAdmin);
        m.listMarket(c.perpId, c.cfg, c.params);
        vm.stopBroadcast();
        _postSigma(c, m);
        _seed(c, m);
        require(m.marketConfig(c.perpId).listed, "ListMarket: not listed");
        require(m.scaleOf(c.perpId) == c.cfg.scale, "ListMarket: scale");
    }

    /// @notice Constants.defaultMarketParams with the canary overrides.
    function canaryParams(uint80 maxCoverNotionalCNS, uint16 marketCapBps, uint16 maxMatchesClose)
        public
        pure
        returns (MarketParams memory p)
    {
        p = Constants.defaultMarketParams();
        p.maxCoverNotionalCNS = maxCoverNotionalCNS;
        p.marketCapBps = marketCapBps;
        p.maxMatchesClose = maxMatchesClose;
    }

    function _envConfig() internal view returns (Config memory c) {
        c.manager = vm.envAddress("MANAGER");
        c.vault = vm.envAddress("VAULT");
        c.perpId = Constants.PERP_BTC;
        c.cfg = Constants.btcMarketConfig();
        c.params = canaryParams(
            uint80(_envUint("MAX_COVER_NOTIONAL_CNS", CANARY_MAX_COVER_NOTIONAL_CNS, type(uint80).max)),
            uint16(_envUint("MARKET_CAP_BPS", CANARY_MARKET_CAP_BPS, type(uint16).max)),
            uint16(_envUint("MAX_MATCHES_CLOSE", CANARY_MAX_MATCHES_CLOSE, type(uint16).max))
        );
        c.sigmaBlkBpsE2 = uint32(_envUint("SIGMA_BPS_E2", Constants.SIGMA_BPS_E2_CALM, type(uint32).max));
        c.seedDepositCNS = vm.envOr("SEED_DEPOSIT_CNS", CANARY_SEED_DEPOSIT_CNS);
    }

    /// @dev SA3-I6: a mistyped override must fail here, not truncate into an in-bounds value.
    function _envUint(string memory name, uint256 dflt, uint256 max) internal view returns (uint256 v) {
        v = vm.envOr(name, dflt);
        require(v <= max, string.concat("ListMarket: ", name, " out of range"));
    }

    function _postSigma(Config memory c, ICoverManager m) internal {
        require(m.hasRole(Constants.SIGMA_ROLE, c.keeper), "ListMarket: keeper lacks SIGMA_ROLE");
        require(m.marketConfig(c.perpId).listed, "ListMarket: list first");
        vm.startBroadcast(c.keeper);
        m.postSigma(c.perpId, c.sigmaBlkBpsE2);
        vm.stopBroadcast();
        (uint32 s, uint48 b) = m.sigmaOf(c.perpId);
        require(s == c.sigmaBlkBpsE2 && b == block.number, "ListMarket: sigma");
        console2.log("sigma", s);
    }

    function _seed(Config memory c, ICoverManager m) internal {
        if (c.seedDepositCNS == 0) return;
        require(!m.hasRole(Constants.RISK_ADMIN_ROLE, c.lp), "ListMarket: LP holds RISK_ADMIN");
        require(m.VAULT() == c.vault, "ListMarket: vault mismatch");
        IERC20 ausd = IERC20(m.AUSD());
        require(ausd.balanceOf(c.lp) >= c.seedDepositCNS, "ListMarket: LP AUSD");
        vm.startBroadcast(c.lp);
        require(ausd.approve(c.vault, c.seedDepositCNS), "ListMarket: approve");
        ICoverVault(c.vault).deposit(c.seedDepositCNS, c.lp);
        vm.stopBroadcast();
        console2.log("seeded", c.seedDepositCNS);
    }

    /// @dev Fails fast with readable reasons before any state change (the manager enforces the same rules).
    function _preflightList(Config memory c, ICoverManager m) internal view {
        require(m.hasRole(Constants.RISK_ADMIN_ROLE, c.riskAdmin), "ListMarket: caller lacks RISK_ADMIN");
        require(m.hasRole(Constants.SIGMA_ROLE, c.keeper), "ListMarket: keeper lacks SIGMA_ROLE");
        require(m.factory() != address(0), "ListMarket: factory unset");
        require(m.VAULT() == c.vault, "ListMarket: vault mismatch");
        IPerplMin.PerpetualInfo memory info = IPerplMin(m.EXCHANGE()).getPerpetualInfo(c.perpId);
        require(
            info.priceDecimals == c.cfg.priceDecimals && info.lotDecimals == c.cfg.lotDecimals,
            "ListMarket: Perpl decimals differ"
        );
        require(info.status == Constants.PERP_STATUS_ACTIVE, "ListMarket: perp not active");
        uint16 mm = c.params.maxMatchesClose;
        require(
            mm >= Constants.MAX_MATCHES_CLOSE_MIN && mm <= Constants.MAX_MATCHES_CLOSE_MAX,
            "ListMarket: maxMatchesClose out of bounds"
        );
        if (c.cfg.feed != address(0)) {
            require(IAggregatorV3(c.cfg.feed).decimals() == c.cfg.feedDecimals, "ListMarket: feed decimals");
        }
    }
}
