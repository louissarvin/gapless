import { describe, expect } from "bun:test"
import { bigintToBytes, type EVMLog } from "@chainlink/cre-sdk"
import { EVM_PB } from "@chainlink/cre-sdk/pb"
import { test } from "@chainlink/cre-sdk/test"
import { encodeAbiParameters, encodeEventTopics, hexToBytes, parseAbiParameters, type Address, type Hex } from "viem"
import { ICoverManagerAbi } from "../../contracts/abi"
import { onArmed, onRefPrice, onWatch } from "../src/handlers"
import { KIND_ARMED_LOG, KIND_REF, KIND_WATCH, MONAD_MAINNET_SELECTOR, decodeReport, encodeReport } from "../src/report"
import { MANAGER, URLS, config, cronPayload, mockChain, mockHttp, mockPrices, runtimeWith } from "./helpers"
import { coverId } from "./vectors"

const SEQ = 1_791_300_030n
const ID0 = coverId(0n)
const ID1 = coverId(1n)
const ARMER: Address = "0x3333333333333333333333333333333333333333"

function armedLog(opts: { coverId?: Hex; perpId?: bigint; block?: bigint; address?: Address; removed?: boolean } = {}): EVMLog {
  const block = opts.block ?? 55_000_000n
  const topics = encodeEventTopics({
    abi: ICoverManagerAbi,
    eventName: "Armed",
    args: { coverId: opts.coverId ?? ID0, perpId: opts.perpId ?? 1n, armer: ARMER },
  }) as Hex[]
  const data = encodeAbiParameters(parseAbiParameters("uint256, uint256, uint256"), [block, 852_600n, 852_610n])
  return {
    address: hexToBytes(opts.address ?? MANAGER),
    topics: topics.map((t) => hexToBytes(t)),
    data: hexToBytes(data),
    txHash: new Uint8Array(32),
    blockHash: new Uint8Array(32),
    eventSig: hexToBytes(topics[0] as Hex),
    blockNumber: { absVal: bigintToBytes(block), sign: 1n },
    txIndex: 0,
    index: 0,
    removed: opts.removed ?? false,
  } as unknown as EVMLog
}

describe("onRefPrice (handler 0)", () => {
  test("writes one kind-1 report per market with the cron second as seq and gasRef", () => {
    mockPrices("85261.18000000", "85230.85", "85230.30000")
    const { writes } = mockChain()
    const runtime = runtimeWith()
    const out = JSON.parse(onRefPrice(runtime, cronPayload(SEQ)))
    expect(writes).toHaveLength(1)
    expect(writes[0]!.gasLimit).toBe("300000")
    expect(writes[0]!.payload).toBe(
      encodeReport({
        kind: KIND_REF,
        chainSelector: MONAD_MAINNET_SELECTOR,
        seq: SEQ,
        perpId: 1n,
        refPricePNS: 852_308n,
        toArm: [],
        toTrigger: [],
      }),
    )
    expect(out).toEqual({ kind: 1, seq: SEQ.toString(), txs: [`0x${"ab".repeat(32)}`] })
    expect(runtime.getLogs().some((l) => l.startsWith("write_report txHash=0xabab") && l.includes("gasLimit=300000"))).toBe(true)
  })

  test("seq clamps a future scheduled tick (non-interactive simulator) to now", () => {
    mockPrices("85261.18", "85230.85", "85230.3")
    const { writes } = mockChain()
    const runtime = runtimeWith(config(), Number(SEQ) * 1000 - 12_500)
    onRefPrice(runtime, cronPayload(SEQ))
    expect(decodeReport(writes[0]!.payload).seq).toBe(SEQ - 13n)
    expect(runtime.getLogs()).toContain(`seq_clamped scheduled=${SEQ} now=${SEQ - 13n}`)
  })

  test("refuses a payload without a scheduled time", () => {
    mockChain()
    expect(() => onRefPrice(runtimeWith(), {} as never)).toThrow("no scheduled time")
  })

  test("quorum failure writes nothing and fails the execution", () => {
    mockHttp({ [URLS.binance]: "throw", [URLS.coinbase]: "throw", [URLS.kraken]: { body: "{}" } })
    const { writes } = mockChain()
    const runtime = runtimeWith()
    expect(() => onRefPrice(runtime, cronPayload(SEQ))).toThrow("kind 1 failed for perps 1")
    expect(writes).toHaveLength(0)
    expect(runtime.getLogs().some((l) => l.startsWith("ref_report_failed perp=1"))).toBe(true)
  })

  test("a reverted tx is an error, not a silent success", () => {
    mockPrices("85261.18", "85230.85", "85230.3")
    mockChain({ txStatus: EVM_PB.TxStatus.REVERTED })
    expect(() => onRefPrice(runtimeWith(), cronPayload(SEQ))).toThrow("kind 1 failed")
  })
})

describe("onWatch (handler 1)", () => {
  test("empty watchList: one read with max = maxIdsPerReport, no HTTP, no write", () => {
    const calls = mockHttp({})
    const { writes, watchCalls } = mockChain()
    const out = JSON.parse(onWatch(runtimeWith(), cronPayload(SEQ)))
    expect(watchCalls).toEqual([{ perpId: 1n, max: 1n }])
    expect(calls).toHaveLength(0)
    expect(writes).toHaveLength(0)
    expect(out.markets).toEqual([{ perpId: 1, toArm: 0, toTrigger: 0, tx: null }])
  })

  test("non-empty watchList: kind-2 report with the ids and per-id gas", () => {
    mockPrices("85261.18", "85230.85", "85230.3")
    const { writes } = mockChain({ watch: () => [[ID0], [ID1]] })
    onWatch(runtimeWith(), cronPayload(SEQ))
    expect(writes).toHaveLength(1)
    expect(writes[0]!.gasLimit).toBe(String(150_000 + 300_000 + 2_400_000))
    const f = decodeReport(writes[0]!.payload)
    expect(f).toEqual({
      kind: KIND_WATCH,
      chainSelector: MONAD_MAINNET_SELECTOR,
      seq: SEQ,
      perpId: 1n,
      refPricePNS: 852_308n,
      toArm: [ID0],
      toTrigger: [ID1],
    })
  })

  test("ids beyond maxIdsPerReport are cut even if the contract returned more", () => {
    mockPrices("85261.18", "85230.85", "85230.3")
    const { writes } = mockChain({ watch: () => [[ID0, ID1], []] })
    onWatch(runtimeWith(), cronPayload(SEQ))
    expect(decodeReport(writes[0]!.payload).toArm).toEqual([ID0])
  })

  test("price quorum failure still sends the ids with refPricePNS 0", () => {
    mockHttp({ [URLS.binance]: "throw", [URLS.coinbase]: "throw", [URLS.kraken]: "throw" })
    const { writes } = mockChain({ watch: () => [[], [ID0]] })
    const runtime = runtimeWith()
    onWatch(runtime, cronPayload(SEQ))
    const f = decodeReport(writes[0]!.payload)
    expect(f.refPricePNS).toBe(0n)
    expect(f.toTrigger).toEqual([ID0])
    expect(runtime.getLogs().some((l) => l.startsWith("ref_failed perp=1"))).toBe(true)
  })

  test("a receiver revert throws", () => {
    mockPrices("85261.18", "85230.85", "85230.3")
    mockChain({ watch: () => [[ID0], []], receiverStatus: EVM_PB.ReceiverContractExecutionStatus.REVERTED })
    expect(() => onWatch(runtimeWith(), cronPayload(SEQ))).toThrow("receiver reverted")
  })
})

describe("onArmed (handler 2)", () => {
  test("decodes Armed and sends kind 3 with toTrigger = [coverId], seq = arm block", () => {
    mockPrices("85261.18", "85230.85", "85230.3")
    const { writes } = mockChain()
    const out = JSON.parse(onArmed(runtimeWith(), armedLog({ coverId: ID1, block: 55_123_456n })))
    expect(writes).toHaveLength(1)
    expect(writes[0]!.gasLimit).toBe(String(150_000 + 2_400_000))
    expect(decodeReport(writes[0]!.payload)).toEqual({
      kind: KIND_ARMED_LOG,
      chainSelector: MONAD_MAINNET_SELECTOR,
      seq: 55_123_456n,
      perpId: 1n,
      refPricePNS: 852_308n,
      toArm: [],
      toTrigger: [ID1],
    })
    expect(out.coverId).toBe(ID1)
  })

  test("ignores removed logs and logs from another emitter", () => {
    const { writes } = mockChain()
    const runtime = runtimeWith()
    expect(JSON.parse(onArmed(runtime, armedLog({ removed: true }))).ignored).toBe(true)
    expect(JSON.parse(onArmed(runtime, armedLog({ address: ARMER }))).ignored).toBe(true)
    expect(writes).toHaveLength(0)
    expect(runtime.getLogs()).toContain(`armed_ignored reason=foreign_emitter address=${ARMER}`)
  })

  test("an unconfigured perp still triggers, with refPricePNS 0", () => {
    const calls = mockHttp({})
    const { writes } = mockChain()
    onArmed(runtimeWith(), armedLog({ perpId: 20n }))
    expect(calls).toHaveLength(0)
    const f = decodeReport(writes[0]!.payload)
    expect(f.perpId).toBe(20n)
    expect(f.refPricePNS).toBe(0n)
  })

  test("logs a mismatch between the event field and the log block", () => {
    mockPrices("85261.18", "85230.85", "85230.3")
    mockChain()
    const log = armedLog({ block: 100n })
    log.blockNumber = { absVal: bigintToBytes(101n), sign: 1n } as never
    const runtime = runtimeWith()
    onArmed(runtime, log)
    expect(runtime.getLogs()).toContain("armed_block_mismatch event=100 log=101")
  })

  test("an event that is not Armed fails to decode", () => {
    mockChain()
    const log = armedLog()
    log.topics[0] = new Uint8Array(32).fill(1)
    expect(() => onArmed(runtimeWith(config()), log)).toThrow()
  })
})
