# Gapless mechanism

How a guaranteed stop actually works, with the real formulas from the deployed contracts (`contract/src/CoverManager.sol`, `contract/src/CoverVault.sol`, `contract/src/libraries/PayoutMath.sol`). Addresses in this doc are the live canary deployment — see `README.md` for the full list.

## 1. Buying a cover

A trader opens or already holds a position on Perpl, then buys a cover alongside their stop:

```
premium = escrowCNS + rentCNS
```

- `escrowCNS` funds the potential payout if the gap happens.
- `rentCNS` is the ongoing cost of holding the guarantee, paid regardless of outcome.

At purchase time:
1. `premium` is pulled from the trader into `CoverManager`.
2. `CoverVault.reserve(perpId, capCNS, marketCapBps)` locks up to `capCNS` (the trader's chosen max payout) from the vault's existing capital. No money moves yet — this just marks capacity as spoken for.

## 2. What happens if the stop is never touched

```solidity
uint256 refund = (expired ? c.armedBlock == 0 : _escrowRefundable(c)) ? escrow : 0;
```

Two different outcomes, both real and both matter:

- **Price never gets near the stop** (cover expires, never Armed): the trader gets their **full escrow back**. Only `rentCNS` is kept — the cost of holding the guarantee.
- **Price got close enough to Arm, then reversed and never crossed for real**: the trader's **entire escrow is forfeited** to the vault (`EscrowForfeited` event), even though no payout happened. Arming means the keeper was actively watching and the vault's capacity was genuinely at risk — that risk earns the premium whether or not it materializes.

## 3. What happens if the stop triggers

The keeper watches every ~300-400ms block. When price crosses the stop, it arms in one block and triggers in the next — the position closes with a reduce-only IOC order, and any shortfall gets paid in the same transaction.

The payout is bounded three ways, and the trader gets whichever is smallest:

```solidity
payout = min(gRealCNS, gRefCNS + stopNotional * slipAllowanceBps / BPS, stopNotional * maxGapBps / BPS)
```

- **`gRealCNS`** — the real measured shortfall: how much worse the actual fill was than filling exactly at the stop price, after fees.
- **`gRefCNS + allowance`** — an independent Chainlink-oracle-checked bound. This exists specifically so a trader can't game their own payout (e.g. self-trading on a thin book to fake a big gap). The payout can never exceed what an independent price feed says the market actually moved, plus a small slippage allowance.
- **`maxGapBps` cap** — a hard ceiling the trader chose when buying the cover. This also sets the premium: a bigger cap costs more.

A trader never gets *more* than made-whole-at-the-stop — there's no upside beyond that, by design. On a severe gap, a trader who bought a smaller (cheaper) cap only gets partial compensation up to their chosen limit.

## 4. How LPs get paid

```solidity
uint256 toTreasury = amountCNS * protocolFeeBps / BPS;   // 1000 bps = 10%, live value on the deployed vault
```

When a cover's lifecycle ends (expires, finalizes, or gets cancelled without a full payout), its premium income flows into the vault via `notifyPremium()`:
- **10%** goes straight to the protocol treasury.
- **90%** stays in the vault, raising the share price for every existing LP proportionally.

This is a standard ERC-4626 vault — LPs don't claim anything manually, their shares are just worth more over time as premiums accumulate, and worth less when payouts happen. It's the same economic model as selling insurance: LPs are compensated for underwriting the risk, not guaranteed a return.

Two hard caps bound how much risk LPs are exposed to at once:
- `maxUtilizationBps` (80% on this deployment) — the manager can never reserve more than 80% of total vault assets across all markets combined.
- A per-market cap (`marketCapBps`) on top of that, so one market can't concentrate all the risk.

## 5. Exiting as an LP

Two-step, not instant:
1. `requestRedeem(shares)` — shares are escrowed inside the vault, a cooldown starts (48,300 blocks, ~4 hours on this deployment).
2. `claimRedeem(requestId, receiver)` — after cooldown, pays `min(value at request time, value at claim time)`.

That last rule is deliberately asymmetric: if the vault lost value during your cooldown (a payout happened), you absorb that loss. If it gained value (more premiums came in), you don't get the upside — it stays with LPs who are still in. This stops people timing redemption requests to dodge losses.

## 6. Why this needs Monad specifically

The mechanism depends on observing, filling, measuring, and paying atomically, before the opportunity to game it exists. That requires:
- The venue's order book to be a smart contract (Perpl's is — not an off-chain matching engine).
- Block times fast enough that "arm this block, trigger next block" is a real same-transaction-class guarantee, not a multi-second race. Monad's ~300-400ms blocks make arm-to-trigger land in under a second of wall-clock time.

This isn't portable to a chain with slower blocks or a venue whose book isn't itself a contract.
