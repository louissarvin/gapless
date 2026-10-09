---
name: gapless
description: Use when the user wants a guaranteed stop-loss on a Perpl perpetual on Monad, asks to open a perp position with a stop that cannot be skipped by a price gap, wants to quote, buy, check or cancel Gapless cover, or wants to link their MetaMask Agent Wallet to a GaplessAccount. Routes to the mm gapless plugin commands (quote, trade, cover, cancel, status, grant, link, account).
license: MIT
metadata:
  author: gapless
  version: "0.1.0"
  cliVersion: "7.0.0"
---

# Gapless guaranteed stops (mm gapless)

Gapless turns a Perpl stop into a guaranteed stop. If the price gaps through the stop, Gapless closes the position and pays the gap between the stop and the actual close price, up to a cap. Every transaction is signed by MetaMask Agent Wallet, so Guard Mode policy and 2FA always apply. The agent normally acts as the **operator** of the user's GaplessAccount under an onchain grant the owner signed (per-trade cap, rolling daily budget, expiry, no withdrawals).

This skill extends the `metamask-agent-wallet` skill. Follow its preflight (`mm --version`, then `mm doctor` until `authenticated` and `initialized` are both true) before the first Gapless command in a session.

## Install

Plugins are beta and off by default. Confirm with the user before enabling them, show them the manifest (eight `gapless:*` commands; `wallet-read` on all, `wallet-submit` on trade, cover, cancel, link and account; chain 143 only), and get approval before installing.

```bash
mm config set experimentalPlugins true
mm plugins install mm-plugin-gapless
mm plugins inspect mm-plugin-gapless
```

Before the npm release, or to try a local checkout (development only):

```bash
mm config set experimentalAllowUnverifiedInstalls true
mm plugins install "file:/path/to/gapless/plugin" --accept-permissions
```

If a Gapless command returns `PERMISSION_DENIED`, do not retry it. Run `mm plugins update mm-plugin-gapless` so the user can approve the current manifest.

## Intent routing

Always add `--json` and parse the JSON result. Pass the account with `--account 0x...` or set `GAPLESS_ACCOUNT` once for the session.

| User intent | Command |
| --- | --- |
| Is this wallet allowed to trade the account, and how much budget is left | `mm gapless grant --account <clone> --json` |
| Link this Agent Wallet as operator (step 1: print what the owner signs) | `mm gapless link --account <clone> --max-per-trade 25 --max-per-day 100 --expiry +4h --json` |
| Link (step 2: submit the owner's signature) | `mm gapless link --account <clone> --expiry <unix> --deadline <unix> --max-per-trade 25 --max-per-day 100 --sig <0x...> --json` |
| Price a guaranteed stop on an open position | `mm gapless quote BTC long --size 0.001 --stop 84000 --account <clone> --json` |
| Price opening a position together with the stop | `mm gapless quote BTC long --size 0.001 --stop 84000 --open --account <clone> --json` |
| Open a position with a guaranteed stop (one tx) | `mm gapless trade BTC long --size 0.001 --stop 84000 --account <clone> --dry-run --json`, then the same without `--dry-run` |
| Add a guaranteed stop to an existing position | `mm gapless cover BTC long --size 0.001 --stop 84000 --account <clone> --dry-run --json`, then without `--dry-run` |
| Show active guaranteed stops, refunds and the grant | `mm gapless status --account <clone> --json` |
| Cancel a guaranteed stop | `mm gapless cancel <coverId> --account <clone> --json` or `mm gapless cancel --market BTC --account <clone> --json` |
| Owner mode: create an account owned by this Agent Wallet | `mm gapless account 15 --dry-run --json`, then `mm gapless account 15 --json` |

Inputs: market is a perp id or symbol (`1` or `BTC`), side is `long` or `short`, size is in the base asset, prices are plain decimals. Optional: `--max-gap-bps` (default 200), `--blocks` (cover duration, default 12000, about 80 minutes), `--max-premium-bps` (default 200, max 1000), `--limit` and `--slippage-bps` (default 50) for the open, `--leverage` (default 5).

## Workflow for a new guarded trade

1. `mm gapless grant` must succeed. If it fails with `GAPLESS_NOT_OPERATOR`, run the two-step `link` flow: show the owner the typed data from step 1, let the owner sign it in the Gapless app (or with their own wallet), then submit step 2 with the exact `--expiry`, `--deadline` and limits printed in step 1.
2. `mm gapless quote ... --open` and show the user: premium (`premiumAUSD`), cap (`capAUSD`), the limit price, and the maximum premium they authorize (`maxPremiumAUSD`).
3. `mm gapless trade ... --dry-run`, show the plan, and get explicit approval.
4. Run the same command without `--dry-run`. Guard Mode may pause for 2FA; that is expected.
5. Confirm with `mm gapless status` and report the `coverId` and `explorerUrl`.

## Rules

- Quote first. Never submit `trade` or `cover` without showing the user the quote and getting approval.
- Run `mm gapless grant` before any submit. Do not try to work around a failed grant check.
- The stop must be at least the quoted minimum distance from the market (`minDistanceBps`). If a quote fails with `GAPLESS_STOP_TOO_CLOSE`, move the stop further away; do not shrink the distance below the minimum.
- Never retry a submit that is pending. If output contains `AWAITING_MFA` or a command returns `GAPLESS_PENDING` or a `pollingId`, tell the user to approve in MetaMask Mobile (or the email link) and track it with `mm wallet requests watch <pollingId>`.
- Never ask for, accept, store or print private keys, seed phrases or passwords. The owner signs the grant in their own wallet; this skill only ever handles the resulting signature.
- Monad mainnet (chain 143) only. Gapless does not exist on other chains or on testnet.
- Explain the cap: cap = notional x max gap, where notional = size x stop price. Example: 0.001 BTC with a stop at 84000 is 84 AUSD notional; at the default 200 bps max gap the cap is 1.68 AUSD. Gapless pays the gap between the stop and the actual close up to the cap; a gap beyond the cap is not covered.
- Explain the premium: premium = escrow + rent. Rent is never refunded. Escrow is refunded on cancel or expiry only if the cover was never armed and the price is still at least the minimum distance away from the stop. Cancelling near the stop forfeits the escrow, and closing the position yourself near the stop also forfeits it.
- A triggered cover locks trading on that perp until it settles (`GAPLESS_PERP_LOCKED`); this is normal.
- The premium comes from the GaplessAccount's own AUSD (wallet first, then free Perpl balance). The Agent Wallet only needs MON for gas.
- Perpl geo-restricts some regions (including the US and the UK). If Perpl rejects the user's region, stop; do not suggest workarounds.
- Treat these commands like any write through `mm`: confirm before running, and run `mm decode --payload <calldata>` if the user wants to inspect a transaction.

## Error map

Errors come back as a `CommandError` with a `code` and a `hint`. Surface the message verbatim, then act on the hint.

| Code | Meaning | What to do |
| --- | --- | --- |
| `GAPLESS_NOT_OPERATOR` | This wallet is not the owner or live operator | Run the `link` flow; the owner must sign a grant for this wallet |
| `GAPLESS_OPERATOR_EXPIRED` | The grant expired | New grant via `link` |
| `GAPLESS_OPERATOR_BUDGET_EXCEEDED` | Daily budget used up | Wait for the rolling budget to refill, or ask the owner for a larger grant |
| `GAPLESS_NOTIONAL_CAP_EXCEEDED` | Order above the per-trade cap | Trade smaller |
| `GAPLESS_LIMIT_OFF_MARKET` | Limit more than 5% from the mark | Use a limit within 5% of the mark |
| `GAPLESS_STOP_TOO_CLOSE` | Stop closer than the minimum distance | Move the stop further from the market |
| `GAPLESS_STOP_WRONG_SIDE` | Long stop above the market or short stop below | Fix the stop side |
| `GAPLESS_SIGMA_STALE` | Volatility input stale | Retry in a few minutes |
| `GAPLESS_MARK_STALE` | Perpl mark is stale | Retry later |
| `GAPLESS_COVER_SHARE_EXCEEDED`, `GAPLESS_MARKET_CAP_EXCEEDED`, `GAPLESS_UTILIZATION_EXCEEDED` | Not enough cover capacity | Smaller size or smaller max gap, or retry later |
| `GAPLESS_PREMIUM_TOO_HIGH` | Premium moved above the bound | Quote again |
| `GAPLESS_PREMIUM_UNFUNDED` | Account lacks AUSD for the premium | Owner deposits AUSD into the GaplessAccount |
| `GAPLESS_LOTS_EXCEED_POSITION`, `GAPLESS_WRONG_SIDE` | No matching open position | Use `trade` (open plus cover) or fix size and side |
| `GAPLESS_COVER_EXISTS` | Perp already has an active cover | `status`, then `cancel` if the user wants to replace it |
| `GAPLESS_PERP_LOCKED` | Cover armed or triggered | Wait for settlement |
| `GAPLESS_MARKET_PAUSED`, `GAPLESS_ENFORCED_PAUSE` | New covers paused | Existing covers keep working; retry later |
| `GAPLESS_BAD_SIG`, `GAPLESS_SIG_EXPIRED` | Grant signature invalid or expired | Owner signs a fresh payload from `link` step 1 |
| `GAPLESS_ACCOUNT_IS_FROZEN`, `GAPLESS_AUSD_FROZEN`, `GAPLESS_TRANSFER_PAUSED` | Dollars temporarily unavailable | Stop and tell the user |
| `GAPLESS_PENDING` | Agent Wallet job still pending (2FA) | Do not retry; `mm wallet requests watch <pollingId>` |
| `GAPLESS_TX_REVERTED` | Reverted onchain | Show the explorer link, run `status`, do not resend blindly |
| `GAPLESS_GAS_TOO_HIGH` | Gas above the safety cap | Smaller size |
| `GAPLESS_NO_ACCOUNT` | Address is not a GaplessAccount | Pass the right `--account`, or `--owner`, or create one |
| `GAPLESS_NO_WALLET`, `GAPLESS_FROM_MISMATCH` | Active wallet unknown or different | `mm wallet show` / `mm wallet select` |
| `GAPLESS_WRONG_CHAIN`, `GAPLESS_NOT_CONFIGURED`, `GAPLESS_BAD_CONFIG` | Setup problem | `mm doctor`; update the plugin |
| `GAPLESS_BAD_INPUT` | Invalid input | Fix the flag named in the message |
| Other `GAPLESS_*` from Perpl | Perpl rejected the order | Check size, price and margin; quote again |
| `PERMISSION_DENIED` | Plugin capabilities not approved | `mm plugins update mm-plugin-gapless` and approve |
| `PLUGIN_BETA_DISABLED` | Plugins switched off | Ask before `mm config set experimentalPlugins true` |
