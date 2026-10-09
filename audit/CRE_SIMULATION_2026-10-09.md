# CRE workflow simulation evidence
Latest run: 2026-10-09T19:34:31Z (re-run; first run at 07:07:52Z hit a transient network TLS
interception on Kraken’s cert, logged below the fresh run as prior evidence; re-verified clean with
all 3 sources reachable: Binance, Coinbase, Kraken all returned real market data).
CLI: cre 1.37.0, target staging-settings, chain 143 (monad-mainnet)

## Handler 0: onRefPrice (trigger-index 0), clean 3-source run
```
$ bun scripts/simulate.ts ref

running: cre workflow simulate gapless-ref --target staging-settings --non-interactive --trigger-index 0
Initializing...
Loading settings...
Checking RPC connectivity...
Compiling workflow...
✓ Workflow compiled
✓ Simulation limits enabled
  Binary hash: d8d6616ccffff44a6412de525d35dc8d177585125e0158e85cbcd30179efc227
  Config hash: 82bbfd03ffbc4ef4c8f2fefcd8f38c06526f1b86248e404467b661bc502c4878
2026-10-09T19:34:31Z [SIMULATION] Simulator Initialized

2026-10-09T19:34:31Z [SIMULATION] Running trigger trigger=cron-trigger@1.0.0
2026-10-09T19:34:31Z [USER LOG] seq_clamped scheduled=1791549300 now=1791549271
2026-10-09T19:34:32Z [USER LOG] ref perp=1 seq=1791549271 refPricePNS=831134
2026-10-09T19:34:33Z [USER LOG] write_report txHash=0x0000000000000000000000000000000000000000000000000000000000000000 txStatus=2 receiverStatus=0 gasLimit=300000

✓ Workflow Simulation Result:
"{\"kind\":1,\"seq\":\"1791549271\",\"txs\":[\"0x0000000000000000000000000000000000000000000000000000000000000000\"]}"

2026-10-09T19:34:33Z [SIMULATION] Execution finished signal received
```
No `source_failed` log lines this run: all 3 sources (Binance, Coinbase, Kraken) contributed to the
DON consensus median, refPricePNS=831134 (= $83,113.4), matching real BTC spot at the time
(direct `curl api.kraken.com` check moments earlier returned $83,085.30).

## Handler 1: onWatch (trigger-index 1), clean run
```
$ bun scripts/simulate.ts watch

running: cre workflow simulate gapless-ref --target staging-settings --non-interactive --trigger-index 1
Initializing...
Loading settings...
Checking RPC connectivity...
Compiling workflow...
✓ Workflow compiled
2026-10-09T19:34:47Z [SIMULATION] Simulator Initialized

2026-10-09T19:34:47Z [SIMULATION] Running trigger trigger=cron-trigger@1.0.0
2026-10-09T19:34:47Z [USER LOG] seq_clamped scheduled=1791549300 now=1791549287
2026-10-09T19:34:47Z [USER LOG] watch perp=1 seq=1791549287 toArm=0 toTrigger=0

✓ Workflow Simulation Result:
"{\"kind\":2,\"seq\":\"1791549287\",\"markets\":[{\"perpId\":1,\"toArm\":0,\"toTrigger\":0,\"tx\":null}]}"

2026-10-09T19:34:47Z [SIMULATION] Execution finished signal received
```
`toArm=0, toTrigger=0` correctly reflects real on-chain state: zero live covers exist on this
deployment as of this run (CoverManager.liveCount(1) = 0).

## Prior run (2026-10-09T07:07:52Z) with the transient Kraken TLS failure, kept for the record
```
2026-10-09T14:08:12Z [USER LOG] source_failed perp=1 source=kraken reason=[2]Unknown: Get "https://api.kraken.com/0/public/Ticker?pair=XBTUSD": tls: failed to verify certificate: x509: certificate is valid for internetsehatku.com, www.internetsehatku.com, not api.kraken.com
2026-10-09T14:08:12Z [USER LOG] ref perp=1 seq=1791529690 refPricePNS=824721
```
Root cause: local network middlebox (DNS/TLS content filter) intercepting the Kraken TLS handshake at
that moment, not a bug in the workflow or Kraken’s API. Direct `curl https://api.kraken.com/...` now
returns a clean 200 with a valid cert; re-run above confirms the 3rd source resolves normally.

## Handler 2: onArmed (trigger-index 2)
Not runnable yet: requires a real on-chain Armed event to replay via sim:armed <txHash> <logIndex>. No cover has been armed on this deployment (0 accounts, 0 covers as of this run). Re-run once a real Armed event exists.
