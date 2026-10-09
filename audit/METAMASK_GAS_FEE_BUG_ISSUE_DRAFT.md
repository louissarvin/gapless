Title: Every transaction submission on chain 143 (Monad) fails: "invalid project id"

Every transaction submission on chain 143 (Monad mainnet) fails, in both CLI 7.0.0 and 7.1.0, in both
`guard` and `beast` trading mode. Reads work fine; only submission is affected.

**Repro (built-in command only, no plugin involved):**
```
mm wallet send-transaction --chain-id 143 --payload '{"to":"<any address>","value":"0x0"}' --json
```

**Error:**
```
Error: Gas fee/price estimation failed. Message: Unexpected token 'i', "invalid project id" is not valid JSON
    at e.GasFeeController._fetchGasFeeEstimateData (.../dist/chunks/bridge-*.js)
    at async e.TransactionController.getGasFeesForSpeed (.../dist/chunks/bridge-*.js)
    at async e.TransactionController.prepareTransaction (.../dist/chunks/bridge-*.js)
```

**This is not a Monad-support gap.** `GasFeeController` hits
`https://gas.api.cx.metamask.io/networks/143/suggestedGasFees`. Calling that exact URL directly with
plain `curl`, unauthenticated, works perfectly and returns real data (`estimatedBaseFee: "100.0"`,
matching Monad's documented base fee floor). So the public endpoint supports Monad correctly — the
bug is specific to how the authenticated CLI session calls it.

**Supplying explicit `maxFeePerGas`/`maxPriorityFeePerGas`/`gas` doesn't avoid it either** — it then
hits the identical `"invalid project id"` error in `PollingBlockTracker._fetchLatestBlock`, which
appears to be a hard prerequisite before any send, retried forever. Confirmed via on-chain nonce check
that nothing is ever actually broadcast.

**Ruled out:**
- Not plugin-specific — reproduced with the first-party `mm wallet send-transaction` command.
- Not a version regression — identical on 7.0.0 and 7.1.0.
- Not fixed by trading mode — identical in `guard` and `beast` (switched live via Mobile 2FA).
- Not wallet-mode-dependent — `GasFeeController`'s endpoints are hardcoded in the compiled bundle,
  independent of BYOK vs server-wallet.

**Impact:** real funds (small amounts of MON and AUSD, intentionally kept small) are currently stuck
at a server wallet address with no way to move them out via the CLI, and our hackathon project's
MetaMask Agent Wallet plugin submission proof is blocked by this for Monad specifically.

Happy to share `--verbose` logs, the wallet address, or anything else useful on request.
