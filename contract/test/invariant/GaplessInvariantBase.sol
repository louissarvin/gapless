// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {GaplessFixture} from "../utils/GaplessFixture.sol";
import {ListMarket} from "../../script/ListMarket.s.sol";
import {CoverManager} from "../../src/CoverManager.sol";
import {GaplessAccount} from "../../src/GaplessAccount.sol";
import {Constants} from "../../src/Constants.sol";
import {MarketConfig} from "../../src/types/GaplessTypes.sol";
import {PerplTrader} from "../mocks/PerplTrader.sol";
import {Ghost} from "./handlers/Ghost.sol";
import {HandlerBase} from "./handlers/HandlerBase.sol";
import {LPHandler} from "./handlers/LPHandler.sol";
import {TraderHandler} from "./handlers/TraderHandler.sol";
import {KeeperHandler} from "./handlers/KeeperHandler.sol";
import {MarketHandler} from "./handlers/MarketHandler.sol";
import {AttackerHandler} from "./handlers/AttackerHandler.sol";
import {AdminHandler} from "./handlers/AdminHandler.sol";

/// @notice Invariant harness on S1's real stack (Deploy.s.sol via GaplessFixture with the real CoverManager),
/// ListMarket, and the six handlers of spec 7 / 05 section 6.
abstract contract GaplessInvariantBase is GaplessFixture {
    CoverManager internal cm;
    Ghost internal ghost;
    PerplTrader internal mm;
    LPHandler internal lpH;
    TraderHandler internal traderH;
    KeeperHandler internal keeperH;
    MarketHandler internal marketH;
    AttackerHandler internal attackerH;
    AdminHandler internal adminH;
    GaplessAccount[] internal traders;
    GaplessAccount internal atk;

    function setUp() public virtual {
        useRealManager = true;
        _setUpGapless();
        cm = CoverManager(manager);
        ausd.mint(seedLp, 2e6);
        MarketConfig memory cfg = Constants.btcMarketConfig();
        cfg.feed = address(feed);
        new ListMarket().list(
            ListMarket.Config({
                manager: manager,
                vault: address(vault),
                riskAdmin: deployer,
                keeper: keeper,
                lp: seedLp,
                perpId: BTC,
                cfg: cfg,
                params: Constants.defaultMarketParams(),
                sigmaBlkBpsE2: 27,
                seedDepositCNS: 2e6
            })
        );
        _lp(makeAddr("lp0"), 2000e6);

        mm = new PerplTrader(ex, ausd);
        ausd.mint(address(mm), 50_000_000e6);
        mm.open(50_000_000e6);

        for (uint256 i; i < 3; ++i) {
            GaplessAccount a = _account(makeAddr(string.concat("trader", vm.toString(i))), 2000e6, _noGrant());
            traders.push(a);
            if (i == 2) _openShort(a, 50);
            else _openLong(a, 50);
        }
        atk = _account(makeAddr("attacker"), 5000e6, _noGrant());
        PerplTrader col = new PerplTrader(ex, ausd);
        ausd.mint(address(col), 100_000e6);
        col.open(100_000e6);
        GaplessAccount victim = _account(makeAddr("huntVictim"), 5000e6, _noGrant());
        PerplTrader hunter = new PerplTrader(ex, ausd);
        ausd.mint(address(hunter), 1_000_000e6);
        hunter.open(1_000_000e6);

        ghost = new Ghost();
        ghost.setMaxSlip(Constants.SLIP_ALLOWANCE_BPS);
        HandlerBase.Env memory env = HandlerBase.Env(ausd, ex, feed, cm, vault, mm, ghost, BTC, keeper);
        lpH = new LPHandler(env);
        traderH = new TraderHandler(env, traders);
        keeperH = new KeeperHandler(env, traders);
        marketH = new MarketHandler(env, traders);
        attackerH = new AttackerHandler(env, atk, col, victim, hunter);
        adminH = new AdminHandler(env, deployer);

        targetContract(address(lpH));
        targetContract(address(traderH));
        targetContract(address(keeperH));
        targetContract(address(marketH));
        targetContract(address(attackerH));
        targetContract(address(adminH));
    }

    /// @dev O1 optimization target: the best single self-deal episode against the vault (int256 min before any).
    function _optO1() internal view returns (int256) {
        return ghost.episodes() == 0 ? type(int256).min : ghost.worstEpisode();
    }

    /// @dev O2 optimization target: this block's payouts over the per-block cap snapshot.
    function _optO2() internal view returns (int256) {
        return int256(uint256(vault.blockPayout(BTC).paidCNS)) - int256(uint256(vault.blockPayout(BTC).capCNS));
    }
}
