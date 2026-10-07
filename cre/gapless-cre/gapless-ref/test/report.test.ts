import { describe, expect, test } from "bun:test"
import { join } from "node:path"
import { concatHex, keccak256, type Hex } from "viem"
import {
  KIND_ARMED_LOG,
  KIND_REF,
  KIND_WATCH,
  MONAD_MAINNET_SELECTOR,
  decodeReport,
  encodeReport,
  gasLimitFor,
  seenKey,
  type ReportFields,
} from "../src/report"
import { CANARY_GAS, buildVectors, coverId } from "./vectors"

const ID = coverId(0n)
const ref: ReportFields = {
  kind: KIND_REF,
  chainSelector: MONAD_MAINNET_SELECTOR,
  seq: 1_791_300_000n,
  perpId: 1n,
  refPricePNS: 852_612n,
  toArm: [],
  toTrigger: [],
}

describe("encodeReport", () => {
  test("kind 1 is the flat 7-field tuple: 7 head words plus two empty array lengths", () => {
    const r = encodeReport(ref)
    expect((r.length - 2) / 2).toBe(9 * 32)
    const words = r.slice(2).match(/.{64}/g) as string[]
    expect(BigInt(`0x${words[0]}`)).toBe(1n)
    expect(BigInt(`0x${words[1]}`)).toBe(MONAD_MAINNET_SELECTOR)
    expect(BigInt(`0x${words[2]}`)).toBe(1_791_300_000n)
    expect(BigInt(`0x${words[3]}`)).toBe(1n)
    expect(BigInt(`0x${words[4]}`)).toBe(852_612n)
    expect(BigInt(`0x${words[5]}`)).toBe(7n * 32n)
    expect(BigInt(`0x${words[6]}`)).toBe(8n * 32n)
  })

  test("round-trips through decodeReport", () => {
    const f: ReportFields = { ...ref, kind: KIND_WATCH, toArm: [ID], toTrigger: [coverId(1n)] }
    expect(decodeReport(encodeReport(f))).toEqual(f)
  })

  test("seen key is keccak256 of the canonical bytes and ignores trailing bytes (N-06)", () => {
    const r = encodeReport({ ...ref, kind: KIND_WATCH, toArm: [ID] })
    expect(seenKey(r)).toBe(keccak256(r))
    const padded = concatHex([r, `0x${"00".repeat(32)}`])
    expect(seenKey(padded)).toBe(keccak256(r))
    expect(keccak256(padded)).not.toBe(keccak256(r))
  })

  test("enforces the kind rules the handlers rely on", () => {
    expect(() => encodeReport({ ...ref, toArm: [ID] })).toThrow("kind 1 carries no ids")
    expect(() => encodeReport({ ...ref, kind: KIND_WATCH })).toThrow("kind 2 needs ids")
    expect(() => encodeReport({ ...ref, kind: KIND_ARMED_LOG, toTrigger: [] })).toThrow("exactly one")
    expect(() => encodeReport({ ...ref, kind: KIND_ARMED_LOG, toArm: [ID], toTrigger: [ID] })).toThrow("exactly one")
    expect(() => encodeReport({ ...ref, kind: 4 as never })).toThrow("bad kind")
  })

  test("rejects more than MAX_IDS, malformed ids and out-of-range integers", () => {
    const four = [ID, ID, ID, ID]
    expect(() => encodeReport({ ...ref, kind: KIND_WATCH, toArm: four })).toThrow("more than 3")
    expect(() => encodeReport({ ...ref, kind: KIND_WATCH, toArm: ["0x1234" as Hex] })).toThrow("bytes32")
    expect(() => encodeReport({ ...ref, seq: 1n << 64n })).toThrow("seq out of range")
    expect(() => encodeReport({ ...ref, seq: -1n })).toThrow("seq out of range")
    expect(() => encodeReport({ ...ref, chainSelector: 1n << 64n })).toThrow("chainSelector")
    expect(() => encodeReport({ ...ref, refPricePNS: 1n << 256n })).toThrow("refPricePNS")
  })
})

describe("gasLimitFor (D10)", () => {
  test("kind 1 uses gasRef", () => {
    expect(gasLimitFor(KIND_REF, 0, 0, CANARY_GAS)).toBe(300_000n)
  })
  test("kinds 2 and 3 scale with ids", () => {
    expect(gasLimitFor(KIND_WATCH, 1, 0, CANARY_GAS)).toBe(450_000n)
    expect(gasLimitFor(KIND_WATCH, 1, 1, CANARY_GAS)).toBe(2_850_000n)
    expect(gasLimitFor(KIND_ARMED_LOG, 0, 1, CANARY_GAS)).toBe(2_550_000n)
    expect(gasLimitFor(KIND_WATCH, 3, 3, CANARY_GAS)).toBe(8_250_000n)
  })
  test("never exceeds gasCap", () => {
    expect(gasLimitFor(KIND_WATCH, 3, 3, { ...CANARY_GAS, gasCap: 5_000_000n })).toBe(5_000_000n)
    expect(gasLimitFor(KIND_REF, 0, 0, { ...CANARY_GAS, gasCap: 200_000n })).toBe(200_000n)
  })
})

const onDisk = await Bun.file(join(import.meta.dir, "fixtures/cre_report_vectors.json")).json()

describe("parity fixture", () => {
  test("file equals the generator output (run `bun run vectors` after a change)", () => {
    expect(onDisk).toEqual(JSON.parse(JSON.stringify(buildVectors())))
  })

  test("every vector decodes to its fields and hashes to its seen key", () => {
    for (const v of onDisk.vectors) {
      const f = decodeReport(v.report)
      expect(f.kind).toBe(v.fields.kind)
      expect(f.chainSelector.toString()).toBe(v.fields.chainSelector)
      expect(f.seq.toString()).toBe(v.fields.seq)
      expect(f.perpId.toString()).toBe(v.fields.perpId)
      expect(f.refPricePNS.toString()).toBe(v.fields.refPricePNS)
      expect([...f.toArm]).toEqual(v.fields.toArm)
      expect([...f.toTrigger]).toEqual(v.fields.toTrigger)
      expect(seenKey(v.report)).toBe(v.reportHash)
    }
    for (const n of onDisk.nonCanonical) expect(seenKey(n.report)).toBe(n.reportHash)
  })
})
