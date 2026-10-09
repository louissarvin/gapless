# CRE workflow simulation evidence
Run: 2026-10-09T07:07:52Z
CLI: cre 1.37.0, target staging-settings, chain 143 (monad-mainnet)

## Handler 0: onRefPrice (trigger-index 0)
```
$ bun scripts/simulate.ts ref

⚠️  Update available! You’re running 1.37.0, but 1.38.0 is the latest.
Run `cre update` or visit https://github.com/smartcontractkit/cre-cli/releases to upgrade.

running: cre workflow simulate gapless-ref --target staging-settings --non-interactive --trigger-index 0
Initializing...
Loading settings...
Checking RPC connectivity...
Compiling workflow...
✓ Workflow compiled
✓ Simulation limits enabled
  HTTP: req=120kb resp=250kb timeout=10s | ConfHTTP: req=125kb resp=500kb timeout=1m30s | Consensus obs=25kb | ChainWrite evm_report=50kb evm_gas=10000000 solana_report=265b solana_cu=300000 | WASM binary=100mb compressed=20mb
  Binary hash: d8d6616ccffff44a6412de525d35dc8d177585125e0158e85cbcd30179efc227
  Config hash: 82bbfd03ffbc4ef4c8f2fefcd8f38c06526f1b86248e404467b661bc502c4878
2026-10-09T14:08:10Z [SIMULATION] Simulator Initialized

2026-10-09T14:08:10Z [SIMULATION] Running trigger trigger=cron-trigger@1.0.0
2026-10-09T14:08:10Z [USER LOG] seq_clamped scheduled=1791529710 now=1791529690
2026-10-09T14:08:12Z [USER LOG] source_failed perp=1 source=kraken reason=[2]Unknown: Get "https://api.kraken.com/0/public/Ticker?pair=XBTUSD": tls: failed to verify certificate: x509: certificate is valid for internetsehatku.com, www.internetsehatku.com, not api.kraken.com
2026-10-09T14:08:12Z [USER LOG] ref perp=1 seq=1791529690 refPricePNS=824721
2026-10-09T14:08:12Z [USER LOG] write_report txHash=0x0000000000000000000000000000000000000000000000000000000000000000 txStatus=2 receiverStatus=0 gasLimit=300000

✓ Workflow Simulation Result:
"{\"kind\":1,\"seq\":\"1791529690\",\"txs\":[\"0x0000000000000000000000000000000000000000000000000000000000000000\"]}"

2026-10-09T14:08:12Z [SIMULATION] Execution finished signal received
2026-10-09T14:08:12Z [SIMULATION] Skipping WorkflowEngineV2

╭──────────────────────────────────────────────────────╮
│ Simulation complete! Ready to deploy your workflow?  │
│                                                      │
│ Run cre account access to request deployment access. │
╰──────────────────────────────────────────────────────╯

⚠️  Update available! You’re running 1.37.0, but 1.38.0 is the latest.
Run `cre update` or visit https://github.com/smartcontractkit/cre-cli/releases to upgrade.

```

## Handler 1: onWatch (trigger-index 1)
```
$ bun scripts/simulate.ts watch

⚠️  Update available! You’re running 1.37.0, but 1.38.0 is the latest.
Run `cre update` or visit https://github.com/smartcontractkit/cre-cli/releases to upgrade.

running: cre workflow simulate gapless-ref --target staging-settings --non-interactive --trigger-index 1
Initializing...
Loading settings...
Checking RPC connectivity...
Compiling workflow...
✓ Workflow compiled
✓ Simulation limits enabled
  HTTP: req=120kb resp=250kb timeout=10s | ConfHTTP: req=125kb resp=500kb timeout=1m30s | Consensus obs=25kb | ChainWrite evm_report=50kb evm_gas=10000000 solana_report=265b solana_cu=300000 | WASM binary=100mb compressed=20mb
  Binary hash: d8d6616ccffff44a6412de525d35dc8d177585125e0158e85cbcd30179efc227
  Config hash: 82bbfd03ffbc4ef4c8f2fefcd8f38c06526f1b86248e404467b661bc502c4878
2026-10-09T14:08:34Z [SIMULATION] Simulator Initialized

2026-10-09T14:08:34Z [SIMULATION] Running trigger trigger=cron-trigger@1.0.0
2026-10-09T14:08:34Z [USER LOG] seq_clamped scheduled=1791529740 now=1791529714
2026-10-09T14:08:34Z [USER LOG] watch perp=1 seq=1791529714 toArm=0 toTrigger=0

✓ Workflow Simulation Result:
"{\"kind\":2,\"seq\":\"1791529714\",\"markets\":[{\"perpId\":1,\"toArm\":0,\"toTrigger\":0,\"tx\":null}]}"

2026-10-09T14:08:34Z [SIMULATION] Execution finished signal received
2026-10-09T14:08:34Z [SIMULATION] Skipping WorkflowEngineV2

╭──────────────────────────────────────────────────────╮
│ Simulation complete! Ready to deploy your workflow?  │
│                                                      │
│ Run cre account access to request deployment access. │
╰──────────────────────────────────────────────────────╯

⚠️  Update available! You’re running 1.37.0, but 1.38.0 is the latest.
Run `cre update` or visit https://github.com/smartcontractkit/cre-cli/releases to upgrade.

```

## Handler 2: onArmed (trigger-index 2)
Not runnable yet: requires a real on-chain Armed event to replay via sim:armed <txHash> <logIndex>. No cover has been armed on this deployment (0 accounts, 0 covers as of this run). Re-run once a real Armed event exists.
