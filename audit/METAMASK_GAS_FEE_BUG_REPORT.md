# Bug report: every transaction submission fails on chain 143 (Monad) — "invalid project id"

**Suggested venue:** `MetaMask/agent-wallet-plugin-template` issues (an independently-filed issue, #5,
for a related but distinct bug — stale `minCliVersion` template default — confirms this is an active
tracker for the `mm` CLI / Agent Wallet ecosystem), or wherever MetaMask's own Agent Wallet CLI repo
issues are filed.

## Summary
Every transaction submission on chain 143 (Monad mainnet) through the `mm` Agent Wallet CLI fails
with the same error, in both CLI versions 7.0.0 and 7.1.0, in both `guard` and `beast` trading modes,
and regardless of whether gas fees are left to auto-estimate or supplied explicitly:

```
Error: Gas fee/price estimation failed. Message: Unexpected token 'i', "invalid project id" is not valid JSON
```

Reads work completely fine on chain 143 (e.g. `mm wallet address`, `mm wallet balance`, any plugin's
`wallet-read` commands). Only transaction submission is affected.

## Environment
- `@metamask/agent-wallet` 7.0.0 and 7.1.0 (both tested, identical result)
- macOS (darwin-arm64), Node 24.9.0
- Chain 143 (Monad mainnet)
- Wallet mode: server-wallet, both `guard` and `beast` trading modes tested
- Real funds at risk: a real server wallet with real MON and AUSD on Monad mainnet is currently
  unable to send anything out, including a trivial zero-value self-send

## Steps to reproduce
1. `mm login qr`, `mm init --wallet server-wallet --mode guard` (or any init)
2. Fund the resulting wallet address with a small amount of MON and/or any ERC-20 on Monad mainnet
   (chain 143)
3. Attempt the simplest possible transaction, using only built-in `mm` commands (no third-party
   plugin involved):
   ```
   mm wallet send-transaction --chain-id 143 --payload '{"to":"<any address>","value":"0x0"}' --json
   ```
4. Observe the failure below. It is 100% reproducible, not intermittent.

## Exact failure
```
SyntaxError: Unexpected token 'i', "invalid project id" is not valid JSON
    at JSON.parse (<anonymous>)
    ...
Error: Gas fee/price estimation failed. Message: Unexpected token 'i', "invalid project id" is not valid JSON
    at e.GasFeeController._fetchGasFeeEstimateData (.../dist/chunks/bridge-*.js)
    at async e.TransactionController.getGasFeesForSpeed (.../dist/chunks/bridge-*.js)
    at async e.TransactionController.prepareTransaction (.../dist/chunks/bridge-*.js)
    at async zV.prepareViaController (.../dist/chunks/bridge-*.js)
    at async zV.submitTransaction (.../dist/chunks/bridge-*.js)
```

## Root cause, as far as we could isolate it without access to your backend
`GasFeeController` is constructed with a hardcoded endpoint:
`https://gas.api.cx.metamask.io/networks/<chain_id>/suggestedGasFees` (and the legacy equivalent
`.../gasPrices`), interpolating `<chain_id>` to `143`.

**Calling this exact URL directly with plain `curl`, unauthenticated, works perfectly** and returns
real, valid gas suggestions for Monad:
```
curl https://gas.api.cx.metamask.io/networks/143/suggestedGasFees
{"low":{...},"medium":{...},"high":{...},"estimatedBaseFee":"100.0",...}
```
The returned `estimatedBaseFee` of 100 gwei matches Monad's own documented minimum base fee exactly,
so this public endpoint genuinely supports and correctly prices Monad gas. The same endpoint for
chain 1 (Ethereum) also works fine via plain `curl`.

So this is **not** a "Monad isn't supported by this gas API" problem. The failure is specific to how
the authenticated `mm` CLI session calls this endpoint (or a related internal gateway) — something in
the CLI's own request plumbing for chain 143 sends or expects a "project id" that is missing or
invalid, server-side, which a plain unauthenticated request never encounters.

## This is not limited to gas estimation
Supplying explicit `maxFeePerGas`/`maxPriorityFeePerGas`/`gas` in the payload (to skip
`GasFeeController` entirely) does not avoid the bug — it immediately surfaces in a different internal
component, `PollingBlockTracker._fetchLatestBlock`, with the identical `"invalid project id"` message,
retried forever with no backoff limit observed. This component appears to be a hard prerequisite
before any send (not merely a post-submit confirmation poller): a `cast nonce` check on the target
wallet confirmed the nonce never advanced even after letting this run and then terminating the
process, i.e. nothing was ever actually broadcast to the chain.

## What we ruled out
- **Not our plugin's fault.** The built-in, first-party `mm wallet send-transaction` command fails
  identically with zero plugin code involved.
- **Not a CLI version regression.** Reproduced identically on both 7.0.0 and 7.1.0.
- **Not fixed by trading mode.** Reproduced identically in both `guard` and `beast` mode (switched via
  `mm wallet trading-mode set beast`, approved live via MetaMask Mobile push 2FA).
- **Not fixable by wallet mode (BYOK vs server-wallet).** Inspected the compiled bridge chunk directly:
  `GasFeeController`'s endpoints are hardcoded and constructed identically regardless of wallet mode;
  only the signing function (`signEthTx`) differs between BYOK and server-wallet. We did not attempt a
  live BYOK test because it would require funding a second, different address for a near-zero chance
  of a different outcome, given the above.
- **Reads are completely unaffected.** `mm wallet address`, `mm wallet balance`, and every `wallet-read`
  plugin command work correctly and return real, live chain 143 data throughout.

## Impact
Any Agent Wallet CLI user on Monad mainnet (chain 143) cannot currently submit any transaction at
all — not a plugin limitation, a CLI-wide one. For us specifically, this blocks the final live
submission proof for our hackathon project's MetaMask Agent Wallet plugin, and has real funds (small
amounts of MON and AUSD, intentionally kept small for exactly this kind of risk) stuck at a server
wallet address until this is fixed, since there is currently no way to move them out through the CLI.

## Reporter context
Building `mm-plugin-gapless`, a guaranteed-stop-loss plugin for Perpl perpetuals on Monad, for the
Monad Metropolis hackathon (MetaMask Best Agent Wallet Plugin bounty track). Happy to provide
`--verbose` logs, the exact wallet address involved, or anything else useful for debugging on request.
