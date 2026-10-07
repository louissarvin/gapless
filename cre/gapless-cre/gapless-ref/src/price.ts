import { HTTPClient, text, type NodeRuntime } from "@chainlink/cre-sdk"
import type { Config, Market } from "./config"

const E8 = 100_000_000n
const DECIMAL = /^(\d{1,20})(?:\.(\d{1,30}))?$/
const MAX_BODY_BYTES = 64 * 1024

export class QuorumError extends Error {}

/** "83828.95" to 8382895000000n (1e8 scale); floors past 8 decimals, never uses floats. */
export function parseDecimalE8(s: string): bigint {
  const m = DECIMAL.exec(s)
  if (!m) throw new Error("price is not a plain decimal")
  const frac = ((m[2] ?? "") + "00000000").slice(0, 8)
  const v = BigInt(m[1] as string) * E8 + BigInt(frac)
  if (v === 0n) throw new Error("price is zero")
  return v
}

/** Walks own properties only, so a config path can never reach a prototype. */
export function pickString(obj: unknown, path: readonly string[]): string {
  let cur: unknown = obj
  for (const key of path) {
    if (cur === null || typeof cur !== "object" || !Object.prototype.hasOwnProperty.call(cur, key)) {
      throw new Error(`missing ${path.join(".")}`)
    }
    cur = (cur as Record<string, unknown>)[key]
  }
  if (typeof cur !== "string") throw new Error(`${path.join(".")} is not a string`)
  return cur
}

export function medianBig(xs: readonly bigint[]): bigint {
  if (xs.length === 0) throw new Error("median of nothing")
  const s = [...xs].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
  const mid = Math.floor(s.length / 2)
  return s.length % 2 === 1 ? (s[mid] as bigint) : ((s[mid - 1] as bigint) + (s[mid] as bigint)) / 2n
}

/** Node-level aggregation: median, drop sources further than maxDevBps from it, median of the rest. */
export function aggregateE8(prices: readonly bigint[], maxDevBps: number, minSources: number): bigint {
  if (prices.length < minSources) throw new QuorumError(`quorum: ${prices.length} of ${minSources} sources`)
  const m = medianBig(prices)
  const dev = BigInt(maxDevBps)
  const kept = prices.filter((p) => (p > m ? p - m : m - p) * 10_000n <= dev * m)
  if (kept.length < minSources) throw new QuorumError(`quorum: ${kept.length} sources agree`)
  return medianBig(kept)
}

/** Perpl PNS = price x 10^priceDecimals; floors the 1e8 value. */
export function e8ToPNS(e8: bigint, priceDecimals: number): bigint {
  if (priceDecimals < 0 || priceDecimals > 8) throw new Error("priceDecimals out of range")
  return e8 / 10n ** BigInt(8 - priceDecimals)
}

/** Runs on every DON node; one failing source is tolerated, the quorum is not. */
export function nodeRefPriceE8(nodeRuntime: NodeRuntime<Config>, market: Market): bigint {
  const cfg = nodeRuntime.config
  const http = new HTTPClient()
  const prices: bigint[] = []
  for (const src of market.sources) {
    try {
      const resp = http.sendRequest(nodeRuntime, { url: src.url, method: "GET", timeout: cfg.httpTimeout }).result()
      if (resp.statusCode !== 200) throw new Error(`status ${resp.statusCode}`)
      if (resp.body.length > MAX_BODY_BYTES) throw new Error("body too large")
      prices.push(parseDecimalE8(pickString(JSON.parse(text(resp)), src.path)))
    } catch (e) {
      nodeRuntime.log(`source_failed perp=${market.perpId} source=${src.name} reason=${errMsg(e)}`)
    }
  }
  return aggregateE8(prices, cfg.maxSourceDevBps, cfg.minSources)
}

export function errMsg(e: unknown): string {
  const s = e instanceof Error ? e.message : String(e)
  return s.length > 200 ? `${s.slice(0, 200)}...` : s
}
