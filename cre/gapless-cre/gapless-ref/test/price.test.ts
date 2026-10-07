import { describe, expect, test as bunTest } from "bun:test"
import { test } from "@chainlink/cre-sdk/test"
import { refPricePNS } from "../src/handlers"
import { QuorumError, aggregateE8, e8ToPNS, medianBig, parseDecimalE8, pickString } from "../src/price"
import { BODIES, URLS, config, mockHttp, mockPrices, runtimeWith } from "./helpers"

describe("parseDecimalE8", () => {
  bunTest("scales strings to 1e8 without floats", () => {
    expect(parseDecimalE8("83828.95")).toBe(8_382_895_000_000n)
    expect(parseDecimalE8("85261.18000000")).toBe(8_526_118_000_000n)
    expect(parseDecimalE8("85230.30000")).toBe(8_523_030_000_000n)
    expect(parseDecimalE8("1")).toBe(100_000_000n)
    expect(parseDecimalE8("0.000000019")).toBe(1n)
  })
  bunTest("rejects anything that is not a plain positive decimal", () => {
    for (const bad of ["", "-1", "1e5", "1.", ".5", " 1", "1,000.0", "0x10", "NaN", "0", "0.000000001", "1".repeat(21)]) {
      expect(() => parseDecimalE8(bad)).toThrow()
    }
  })
})

describe("pickString", () => {
  const kraken = JSON.parse(BODIES.kraken("85230.3"))
  bunTest("walks objects and array indexes", () => {
    expect(pickString(kraken, ["result", "XXBTZUSD", "c", "0"])).toBe("85230.3")
  })
  bunTest("refuses missing keys, non-strings and prototype keys", () => {
    expect(() => pickString(kraken, ["result", "XETHZUSD", "c", "0"])).toThrow("missing")
    expect(() => pickString({ price: 85230.3 }, ["price"])).toThrow("not a string")
    expect(() => pickString({}, ["__proto__", "toString"])).toThrow("missing")
    expect(() => pickString({ a: "x" }, ["constructor"])).toThrow("missing")
  })
})

describe("aggregateE8", () => {
  bunTest("medians agreeing sources", () => {
    expect(aggregateE8([10_000n, 10_001n, 10_002n], 50, 2)).toBe(10_001n)
    expect(medianBig([4n, 1n, 3n, 2n])).toBe(2n)
  })
  bunTest("drops an outlier beyond maxDevBps and keeps quorum", () => {
    const p = [8_526_118_000_000n, 8_523_085_000_000n, 9_000_000_000_000n]
    expect(aggregateE8(p, 50, 2)).toBe((8_526_118_000_000n + 8_523_085_000_000n) / 2n)
  })
  bunTest("fails the quorum when too few sources answer or agree", () => {
    expect(() => aggregateE8([100n], 50, 2)).toThrow(QuorumError)
    expect(() => aggregateE8([100n, 200n, 400n], 50, 2)).toThrow("agree")
  })
  bunTest("converts to Perpl PNS by flooring", () => {
    expect(e8ToPNS(8_526_118_000_000n, 1)).toBe(852_611n)
    expect(e8ToPNS(8_526_118_000_000n, 8)).toBe(8_526_118_000_000n)
    expect(() => e8ToPNS(1n, 9)).toThrow()
  })
})

describe("refPricePNS (node mode + DON median)", () => {
  test("three sources agree", () => {
    const calls = mockPrices("85261.18000000", "85230.85", "85230.30000")
    const runtime = runtimeWith()
    expect(refPricePNS(runtime, config().markets[0]!)).toBe(852_308n)
    expect(calls).toEqual([URLS.binance, URLS.coinbase, URLS.kraken])
  })

  test("one source down (500) still meets quorum 2", () => {
    mockHttp({
      [URLS.binance]: { status: 500, body: "{}" },
      [URLS.coinbase]: { body: BODIES.coinbase("85230.85") },
      [URLS.kraken]: { body: BODIES.kraken("85230.30000") },
    })
    const runtime = runtimeWith()
    expect(refPricePNS(runtime, config().markets[0]!)).toBe(852_305n)
    expect(runtime.getLogs().some((l) => l.includes("source_failed perp=1 source=binance reason=status 500"))).toBe(true)
  })

  test("transport error, malformed JSON and a numeric price count as failed sources", () => {
    mockHttp({
      [URLS.binance]: "throw",
      [URLS.coinbase]: { body: "not json" },
      [URLS.kraken]: { body: JSON.stringify({ result: { XXBTZUSD: { c: [85230.3] } } }) },
    })
    const runtime = runtimeWith()
    expect(() => refPricePNS(runtime, config().markets[0]!)).toThrow("quorum")
    expect(runtime.getLogs().filter((l) => l.startsWith("source_failed")).length).toBe(3)
  })

  test("outlier dropped at 50 bps", () => {
    mockPrices("90000.00", "85230.85", "85230.30000")
    expect(refPricePNS(runtimeWith(), config().markets[0]!)).toBe(852_305n)
  })

  test("sources that disagree fail the quorum", () => {
    mockPrices("90000.00", "85230.85", "80000.00")
    expect(() => refPricePNS(runtimeWith(), config().markets[0]!)).toThrow("agree")
  })
})
