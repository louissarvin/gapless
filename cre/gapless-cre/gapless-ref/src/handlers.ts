import {
  EVMClient,
  bytesToHex,
  consensusMedianAggregation,
  protoBigIntToBigint,
  type CronPayload,
  type EVMLog,
  type Runtime,
} from "@chainlink/cre-sdk"
import { decodeEventLog, isAddressEqual, type Hex } from "viem"
import { ICoverManagerAbi } from "../../contracts/abi"
import { readWatchList, resolveSelector, submitReport } from "./chain"
import type { Config, Market } from "./config"
import { e8ToPNS, errMsg, nodeRefPriceE8 } from "./price"
import { KIND_ARMED_LOG, KIND_REF, KIND_WATCH, encodeReport, gasLimitFor } from "./report"

const U64_MAX = (1n << 64n) - 1n

/**
 * Kinds 1 and 2: the scheduled cron second, accepted by the sink within [now - 120 s, now + 2 s].
 * Clamped to runtime.now() because the non-interactive simulator reports the next tick (up to 30 s ahead).
 */
export function cronSeq(runtime: Runtime<Config>, payload: CronPayload): bigint {
  const scheduled = payload.scheduledExecutionTime?.seconds
  if (scheduled === undefined || scheduled <= 0n) throw new Error("cron payload has no scheduled time")
  const now = BigInt(Math.floor(runtime.now().getTime() / 1000))
  if (scheduled <= now) return scheduled
  runtime.log(`seq_clamped scheduled=${scheduled} now=${now}`)
  return now
}

/** DON median of each node's outlier-filtered median, in Perpl PNS. Throws when the quorum fails. */
export function refPricePNS(runtime: Runtime<Config>, market: Market): bigint {
  const e8 = runtime.runInNodeMode(nodeRefPriceE8, consensusMedianAggregation<bigint>())(market).result()
  return e8ToPNS(e8, market.priceDecimals)
}

/** Kinds 2 and 3: the ids are what matter, the price is display-only, so a failed quorum sends 0. */
function refPriceOrZero(runtime: Runtime<Config>, market: Market | undefined, perpId: bigint): bigint {
  if (!market) {
    runtime.log(`ref_skipped perp=${perpId} reason=market_not_configured`)
    return 0n
  }
  try {
    return refPricePNS(runtime, market)
  } catch (e) {
    runtime.log(`ref_failed perp=${perpId} reason=${errMsg(e)}`)
    return 0n
  }
}

/** Handler 0: consensus reference price, one kind-1 report per market. */
export function onRefPrice(runtime: Runtime<Config>, payload: CronPayload): string {
  const cfg = runtime.config
  const selector = resolveSelector(cfg.chainSelectorName)
  const evm = new EVMClient(selector)
  const seq = cronSeq(runtime, payload)
  const sent: string[] = []
  const failed: string[] = []
  for (const m of cfg.markets) {
    try {
      const ref = refPricePNS(runtime, m)
      const report = encodeReport({
        kind: KIND_REF,
        chainSelector: selector,
        seq,
        perpId: BigInt(m.perpId),
        refPricePNS: ref,
        toArm: [],
        toTrigger: [],
      })
      runtime.log(`ref perp=${m.perpId} seq=${seq} refPricePNS=${ref}`)
      sent.push(submitReport(runtime, evm, report, gasLimitFor(KIND_REF, 0, 0, cfg)))
    } catch (e) {
      runtime.log(`ref_report_failed perp=${m.perpId} reason=${errMsg(e)}`)
      failed.push(String(m.perpId))
    }
  }
  if (failed.length > 0) throw new Error(`kind 1 failed for perps ${failed.join(",")}; sent ${sent.length}`)
  return JSON.stringify({ kind: KIND_REF, seq: seq.toString(), txs: sent })
}

/** Handler 1: watchtower. Reports watchList ids so the sink can arm or trigger when the keeper is down. */
export function onWatch(runtime: Runtime<Config>, payload: CronPayload): string {
  const cfg = runtime.config
  const selector = resolveSelector(cfg.chainSelectorName)
  const evm = new EVMClient(selector)
  const seq = cronSeq(runtime, payload)
  const out: { perpId: number; toArm: number; toTrigger: number; tx: string | null }[] = []
  for (const m of cfg.markets) {
    const perpId = BigInt(m.perpId)
    const { toArm, toTrigger } = readWatchList(runtime, evm, cfg.coverManager, perpId, cfg.maxIdsPerReport)
    runtime.log(`watch perp=${m.perpId} seq=${seq} toArm=${toArm.length} toTrigger=${toTrigger.length}`)
    if (toArm.length === 0 && toTrigger.length === 0) {
      out.push({ perpId: m.perpId, toArm: 0, toTrigger: 0, tx: null })
      continue
    }
    const ref = refPriceOrZero(runtime, m, perpId)
    const report = encodeReport({
      kind: KIND_WATCH,
      chainSelector: selector,
      seq,
      perpId,
      refPricePNS: ref,
      toArm,
      toTrigger,
    })
    const tx = submitReport(runtime, evm, report, gasLimitFor(KIND_WATCH, toArm.length, toTrigger.length, cfg))
    out.push({ perpId: m.perpId, toArm: toArm.length, toTrigger: toTrigger.length, tx })
  }
  return JSON.stringify({ kind: KIND_WATCH, seq: seq.toString(), markets: out })
}

export interface ArmedEvent {
  coverId: Hex
  perpId: bigint
  armer: Hex
  blockNumber: bigint
}

/** Decodes a CoverManager Armed log; returns null for anything the handler must not act on. */
export function decodeArmed(runtime: Runtime<Config>, log: EVMLog): ArmedEvent | null {
  if (log.removed) {
    runtime.log("armed_ignored reason=removed")
    return null
  }
  const emitter = bytesToHex(log.address)
  if (!isAddressEqual(emitter, runtime.config.coverManager)) {
    runtime.log(`armed_ignored reason=foreign_emitter address=${emitter}`)
    return null
  }
  const topics = log.topics.map((t) => bytesToHex(t))
  if (topics.length === 0) return null
  const ev = decodeEventLog({
    abi: ICoverManagerAbi,
    eventName: "Armed",
    data: bytesToHex(log.data),
    topics: topics as [Hex, ...Hex[]],
  })
  const { coverId, perpId, armer, blockNumber } = ev.args
  if (blockNumber > U64_MAX) throw new Error("Armed blockNumber exceeds uint64")
  if (log.blockNumber !== undefined) {
    const logBlock = protoBigIntToBigint(log.blockNumber)
    if (logBlock !== blockNumber) runtime.log(`armed_block_mismatch event=${blockNumber} log=${logBlock}`)
  }
  return { coverId, perpId, armer, blockNumber }
}

/** Handler 2: an Armed log yields a kind-3 report with toTrigger = [coverId] and seq = the arm block (D9). */
export function onArmed(runtime: Runtime<Config>, log: EVMLog): string {
  const cfg = runtime.config
  const ev = decodeArmed(runtime, log)
  if (!ev) return JSON.stringify({ kind: KIND_ARMED_LOG, ignored: true })
  const selector = resolveSelector(cfg.chainSelectorName)
  const evm = new EVMClient(selector)
  runtime.log(`armed coverId=${ev.coverId} perp=${ev.perpId} armer=${ev.armer} block=${ev.blockNumber}`)
  const market = cfg.markets.find((m) => BigInt(m.perpId) === ev.perpId)
  const ref = refPriceOrZero(runtime, market, ev.perpId)
  const report = encodeReport({
    kind: KIND_ARMED_LOG,
    chainSelector: selector,
    seq: ev.blockNumber,
    perpId: ev.perpId,
    refPricePNS: ref,
    toArm: [],
    toTrigger: [ev.coverId],
  })
  const tx = submitReport(runtime, evm, report, gasLimitFor(KIND_ARMED_LOG, 0, 1, cfg))
  return JSON.stringify({ kind: KIND_ARMED_LOG, coverId: ev.coverId, seq: ev.blockNumber.toString(), tx })
}
