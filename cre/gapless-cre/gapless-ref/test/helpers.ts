import { EVM_PB } from "@chainlink/cre-sdk/pb"
import { EvmMock, HttpActionsMock, addContractMock, newTestRuntime, type WriteReportMockInput } from "@chainlink/cre-sdk/test"
import { bytesToHex, type Address, type Hex } from "viem"
import { ICoverManagerAbi, IGaplessCreSinkAbi } from "../../contracts/abi"
import { configSchema, type Config, type RawConfig } from "../src/config"
import { MONAD_MAINNET_SELECTOR } from "../src/report"

export const SINK: Address = "0x1111111111111111111111111111111111111111"
export const MANAGER: Address = "0x2222222222222222222222222222222222222222"
export const REPORT_METADATA_LENGTH = 109

export const URLS = {
  binance: "https://data-api.binance.vision/api/v3/ticker/price?symbol=BTCUSDT",
  coinbase: "https://api.exchange.coinbase.com/products/BTC-USD/ticker",
  kraken: "https://api.kraken.com/0/public/Ticker?pair=XBTUSD",
}

export function rawConfig(over: Partial<RawConfig> = {}): RawConfig {
  return {
    schedule: "*/30 * * * * *",
    chainSelectorName: "monad-mainnet",
    receiver: SINK,
    coverManager: MANAGER,
    logConfidence: "CONFIDENCE_LEVEL_SAFE",
    maxIdsPerReport: 1,
    gasRef: "300000",
    gasBase: "150000",
    gasPerArm: "300000",
    gasPerTrigger: "2400000",
    gasCap: "9500000",
    maxSourceDevBps: 50,
    minSources: 2,
    httpTimeout: "5s",
    markets: [
      {
        perpId: 1,
        priceDecimals: 1,
        sources: [
          { name: "binance", url: URLS.binance, path: ["price"] },
          { name: "coinbase", url: URLS.coinbase, path: ["price"] },
          { name: "kraken", url: URLS.kraken, path: ["result", "XXBTZUSD", "c", "0"] },
        ],
      },
    ],
    ...over,
  }
}

export function config(over: Partial<RawConfig> = {}): Config {
  return configSchema.parse(rawConfig(over))
}

/** Test clock: one second after the default cron seq used by the handler tests. */
export const NOW_MS = 1_791_300_031_000

export function runtimeWith(cfg: Config = config(), nowMs = NOW_MS) {
  const runtime = newTestRuntime<Config>(null, { timeProvider: () => nowMs })
  runtime.config = cfg
  return runtime
}

const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64")

export const BODIES = {
  binance: (p: string) => JSON.stringify({ symbol: "BTCUSDT", price: p }),
  coinbase: (p: string) => JSON.stringify({ ask: p, bid: p, price: p, volume: "1" }),
  kraken: (p: string) => JSON.stringify({ error: [], result: { XXBTZUSD: { a: [p, "1", "1"], c: [p, "0.1"] } } }),
}

type Reply = { status?: number; body: string } | "throw"

/** Routes HTTP GETs by URL; unknown URLs fail the test loudly. */
export function mockHttp(replies: Record<string, Reply>) {
  const http = HttpActionsMock.testInstance()
  const calls: string[] = []
  http.sendRequest = (req) => {
    calls.push(req.url)
    const r = replies[req.url]
    if (r === undefined) throw new Error(`unexpected url ${req.url}`)
    if (r === "throw") throw new Error("connection reset")
    return { statusCode: r.status ?? 200, body: b64(r.body) }
  }
  return calls
}

export function mockPrices(binance: string, coinbase: string, kraken: string) {
  return mockHttp({
    [URLS.binance]: { body: BODIES.binance(binance) },
    [URLS.coinbase]: { body: BODIES.coinbase(coinbase) },
    [URLS.kraken]: { body: BODIES.kraken(kraken) },
  })
}

export interface Written {
  payload: Hex
  gasLimit: string
}

/** Mocks the manager's watchList and the sink's writeReport, recording every write. */
export function mockChain(opts: {
  watch?: (perpId: bigint, max: bigint) => readonly [Hex[], Hex[]]
  txStatus?: EVM_PB.TxStatus
  receiverStatus?: EVM_PB.ReceiverContractExecutionStatus
} = {}) {
  const evm = EvmMock.testInstance(MONAD_MAINNET_SELECTOR)
  const writes: Written[] = []
  const watchCalls: { perpId: bigint; max: bigint }[] = []
  const manager = addContractMock(evm, { address: MANAGER, abi: ICoverManagerAbi })
  manager.watchList = (...args: readonly unknown[]) => {
    const [perpId, max] = args as [bigint, bigint]
    watchCalls.push({ perpId, max })
    return opts.watch ? opts.watch(perpId, max) : [[], []]
  }
  const sink = addContractMock(evm, { address: SINK, abi: IGaplessCreSinkAbi })
  sink.writeReport = (input: WriteReportMockInput) => {
    writes.push({
      payload: bytesToHex(input.report.rawReport.slice(REPORT_METADATA_LENGTH)),
      gasLimit: String(input.gasConfig.gasLimit),
    })
    // JSON form: enum names and base64 bytes, converted by the mock with fromJson.
    const tx = EVM_PB.TxStatus[opts.txStatus ?? EVM_PB.TxStatus.SUCCESS]
    const rcv = EVM_PB.ReceiverContractExecutionStatus[opts.receiverStatus ?? EVM_PB.ReceiverContractExecutionStatus.SUCCESS]
    return {
      txStatus: `TX_STATUS_${tx}`,
      receiverContractExecutionStatus: `RECEIVER_CONTRACT_EXECUTION_STATUS_${rcv}`,
      txHash: Buffer.from(new Uint8Array(32).fill(0xab)).toString("base64"),
      errorMessage: opts.txStatus === undefined ? "" : "mock failure",
    } as EVM_PB.WriteReportReplyJson
  }
  return { writes, watchCalls }
}

export function cronPayload(seconds: bigint) {
  return { scheduledExecutionTime: { seconds, nanos: 0 } } as never
}
