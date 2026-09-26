// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

/// @notice Shared ghost state for the invariant handlers (written by handlers, read by the invariants).
contract Ghost {
    bytes32[] public ids;
    mapping(bytes32 => uint16) public aAtBuy; // slipAllowanceBps when bought (I13)
    mapping(bytes32 => uint256) public notionalAtBuy;
    uint16 public maxSlipEver; // A only loosens I2, so the bound uses the largest A ever set
    uint256 public donatedToManager;
    int256 public attackerPnL; // O1: payouts - escrow kept - rent over attacker covers (vault side)
    int256 public worstEpisode; // largest single-episode protocol PnL
    int256 public attackerMtm; // O1 report: both colluding accounts marked at the unchanged reference
    int256 public bestMtm;
    uint256 public episodes;
    uint256 public attackerTriggers;
    uint256 public maxBlockPaid; // O2: largest single-block payout seen per market
    uint256 public triggers;
    uint256 public finalizes;
    uint256 public violations; // I3, I9, I10, I12 checks done inside handlers
    bool public outage; // reference publishers down (set and cleared by the market handler)
    string public lastViolation;
    int256 public hunterPnL; // H-01: stop hunter's PnL at fair value, summed over hunts
    int256 public bestHunt; // best single hunt
    uint256 public hunts;
    uint256 public huntCloses; // hunts that closed any covered lot (must stay 0 with honest references)
    uint256 public touchEpisodes; // self-deals on a genuine touch of the stop
    // I14 model of the short-close chain (N-01, C7), kept independently of Cover.shortBlock / shortSteps.
    mapping(bytes32 => uint256) public chainBlock; // most recent attempt of the touch that kept or advanced it
    mapping(bytes32 => uint256) public chainSteps; // step of the next attempt in a later block
    mapping(bytes32 => bool) public chainHeld; // the attempt at chainBlock kept its step (match-limited, SA3-02)
    uint256 public chainHolds; // match-limited attempts that restarted a running chain's gap (C7)
    mapping(bytes32 => uint256) public allowCNS; // sum over fills of min(stop, R_trig) x F x allowance(step)
    uint256 public relapses; // touch, recovery, later touch scenarios (N-05)
    uint256 public chainWidened; // fills at a step above 0

    function addCover(bytes32 id, uint16 a, uint256 notional) external {
        ids.push(id);
        aAtBuy[id] = a;
        notionalAtBuy[id] = notional;
    }

    function count() external view returns (uint256) {
        return ids.length;
    }

    function setMaxSlip(uint16 a) external {
        if (a > maxSlipEver) maxSlipEver = a;
    }

    function donate(uint256 amt) external {
        donatedToManager += amt;
    }

    function episode(int256 pnl, int256 mtm, bool triggered_) external {
        attackerPnL += pnl;
        attackerMtm += mtm;
        if (episodes == 0 || pnl > worstEpisode) worstEpisode = pnl;
        if (episodes == 0 || mtm > bestMtm) bestMtm = mtm;
        ++episodes;
        if (triggered_) ++attackerTriggers;
    }

    function hunt(int256 pnl, bool closed) external {
        hunterPnL += pnl;
        if (hunts == 0 || pnl > bestHunt) bestHunt = pnl;
        ++hunts;
        if (closed) ++huntCloses;
    }

    function touched() external {
        ++touchEpisodes;
    }

    function resetChain(bytes32 id) external {
        delete chainBlock[id];
        delete chainSteps[id];
        delete chainHeld[id];
    }

    function setChain(bytes32 id, uint256 b, uint256 steps, bool held) external {
        chainBlock[id] = b;
        chainSteps[id] = steps;
        chainHeld[id] = held;
        if (held) ++chainHolds;
    }

    function addAllow(bytes32 id, uint256 a, bool widened) external {
        allowCNS[id] += a;
        if (widened) ++chainWidened;
    }

    function relapsed() external {
        ++relapses;
    }

    function blockPaid(uint256 paid) external {
        if (paid > maxBlockPaid) maxBlockPaid = paid;
    }

    function triggered() external {
        ++triggers;
    }

    function finalized() external {
        ++finalizes;
    }

    mapping(bytes4 => uint256) public reasonCount;
    bytes4[] public reasons;

    function note(bytes memory err) external {
        bytes4 sel = err.length >= 4 ? bytes4(err) : bytes4(0);
        if (reasonCount[sel] == 0) reasons.push(sel);
        ++reasonCount[sel];
    }

    function reasonsLength() external view returns (uint256) {
        return reasons.length;
    }

    function setOutage(bool o) external {
        outage = o;
    }

    function violate(string calldata why) external {
        ++violations;
        lastViolation = why;
    }
}
