import { concatHex, encodeAbiParameters, keccak256, parseAbiParameters, type Address, type Hex } from "viem"
import {
  KIND_ARMED_LOG,
  KIND_REF,
  KIND_WATCH,
  MONAD_MAINNET_SELECTOR,
  REPORT_PARAMS,
  encodeReport,
  gasLimitFor,
  seenKey,
  type ReportFields,
} from "../src/report"

/** Canary gas config (D10), mirrored from config.staging.json. */
export const CANARY_GAS = {
  gasRef: 300_000n,
  gasBase: 150_000n,
  gasPerArm: 300_000n,
  gasPerTrigger: 2_400_000n,
  gasCap: 9_500_000n,
}

const MONAD_TESTNET_SELECTOR = 2_183_018_362_218_727_504n
const U64_MAX = (1n << 64n) - 1n
const U256_MAX = (1n << 256n) - 1n
const ACCOUNT: Address = "0x00000000000000000000000000000000000ca5e1"

/** coverId = keccak256(abi.encode(account, perpId, nonce)), as CoverManager derives it. */
export function coverId(nonce: bigint): Hex {
  return keccak256(encodeAbiParameters(parseAbiParameters("address, uint256, uint256"), [ACCOUNT, 1n, nonce]))
}

interface VectorSpec {
  name: string
  expect: "processed" | "WrongChain" | "processesFirst3"
  note: string
  fields: ReportFields
}

const ID0 = coverId(0n)
const ID1 = coverId(1n)
const ID2 = coverId(2n)
const ID3 = coverId(3n)

const base = { chainSelector: MONAD_MAINNET_SELECTOR, perpId: 1n }

const SPECS: VectorSpec[] = [
  {
    name: "kind1_ref_btc",
    expect: "processed",
    note: "handler 0: cron second seq, BTC 85261.2 at priceDecimals 1",
    fields: { ...base, kind: KIND_REF, seq: 1_791_300_000n, refPricePNS: 852_612n, toArm: [], toTrigger: [] },
  },
  {
    name: "kind1_extremes",
    expect: "processed",
    note: "decode bounds only: max uint64 seq is outside the sink window, so onReport returns silently",
    fields: {
      kind: KIND_REF,
      chainSelector: MONAD_MAINNET_SELECTOR,
      seq: U64_MAX,
      perpId: U256_MAX,
      refPricePNS: U256_MAX,
      toArm: [],
      toTrigger: [],
    },
  },
  {
    name: "kind2_watch_arm1",
    expect: "processed",
    note: "handler 1: one arm candidate (canary maxIdsPerReport 1)",
    fields: { ...base, kind: KIND_WATCH, seq: 1_791_300_030n, refPricePNS: 852_612n, toArm: [ID0], toTrigger: [] },
  },
  {
    name: "kind2_watch_trigger1_noref",
    expect: "processed",
    note: "handler 1: quorum failed, refPricePNS 0, one trigger candidate",
    fields: { ...base, kind: KIND_WATCH, seq: 1_791_300_060n, refPricePNS: 0n, toArm: [], toTrigger: [ID0] },
  },
  {
    name: "kind2_watch_max",
    expect: "processed",
    note: "MAX_IDS in both arrays",
    fields: {
      ...base,
      kind: KIND_WATCH,
      seq: 1_791_300_090n,
      refPricePNS: 852_612n,
      toArm: [ID0, ID1, ID2],
      toTrigger: [ID1, ID2, ID0],
    },
  },
  {
    name: "kind3_armed_log",
    expect: "processed",
    note: "handler 2: seq is the Armed block, toTrigger = [coverId] (D9)",
    fields: { ...base, kind: KIND_ARMED_LOG, seq: 55_000_000n, refPricePNS: 852_612n, toArm: [], toTrigger: [ID0] },
  },
  {
    name: "kind1_wrong_chain",
    expect: "WrongChain",
    note: "monad-testnet selector: onReport reverts WrongChain(2183018362218727504)",
    fields: { ...base, chainSelector: MONAD_TESTNET_SELECTOR, kind: KIND_REF, seq: 1_791_300_000n, refPricePNS: 852_612n, toArm: [], toTrigger: [] },
  },
]

function rawEncode(f: ReportFields): Hex {
  return encodeAbiParameters(REPORT_PARAMS, [f.kind, f.chainSelector, f.seq, f.perpId, f.refPricePNS, [...f.toArm], [...f.toTrigger]])
}

function fieldsJson(f: ReportFields) {
  return {
    kind: f.kind,
    chainSelector: f.chainSelector.toString(),
    seq: f.seq.toString(),
    perpId: f.perpId.toString(),
    refPricePNS: f.refPricePNS.toString(),
    toArm: [...f.toArm],
    toTrigger: [...f.toTrigger],
  }
}

/** Deterministic fixture content; test/fixtures/cre_report_vectors.json must equal this. */
export function buildVectors() {
  const vectors = SPECS.map((s) => {
    const report = encodeReport(s.fields)
    return {
      name: s.name,
      expect: s.expect,
      note: s.note,
      fields: fieldsJson(s.fields),
      report,
      reportLength: (report.length - 2) / 2,
      reportHash: seenKey(report),
      gasLimitCanary: gasLimitFor(s.fields.kind, s.fields.toArm.length, s.fields.toTrigger.length, CANARY_GAS).toString(),
    }
  })

  // The workflow never emits 4 ids; the sink must still decode and act on the first MAX_IDS only.
  const overCap: ReportFields = {
    ...base,
    kind: KIND_WATCH,
    seq: 1_791_300_120n,
    refPricePNS: 852_612n,
    toArm: [ID0, ID1, ID2, ID3],
    toTrigger: [],
  }
  const overCapReport = rawEncode(overCap)
  vectors.push({
    name: "kind2_over_cap_raw",
    expect: "processesFirst3",
    note: "hand-built (encodeReport refuses it): 4 toArm ids, the sink loops i < MAX_IDS",
    fields: fieldsJson(overCap),
    report: overCapReport,
    reportLength: (overCapReport.length - 2) / 2,
    reportHash: keccak256(overCapReport),
    gasLimitCanary: "",
  })

  // N-06: trailing bytes decode to the same content, so the seen key must not change.
  const canonical = vectors.find((v) => v.name === "kind2_watch_arm1")
  if (!canonical) throw new Error("missing base vector")
  const trailing = concatHex([canonical.report, `0x${"00".repeat(32)}`])
  const nonCanonical = [
    {
      name: "kind2_watch_arm1_trailing32",
      base: canonical.name,
      note: "canonical report plus 32 zero bytes; seen[reportHash] must already be true after the base vector",
      report: trailing,
      reportHash: canonical.reportHash,
      rawKeccak: keccak256(trailing),
    },
  ]

  return {
    schemaVersion: 1,
    generatedBy: "cre/gapless-cre/gapless-ref/scripts/gen-vectors.ts",
    abi: "abi.encode(uint8 kind, uint64 chainSelector, uint64 seq, uint256 perpId, uint256 refPricePNS, bytes32[] toArm, bytes32[] toTrigger)",
    seenKeyRule: "reportHash = keccak256(abi.encode(decoded fields)); equals keccak256(report) for canonical encodings",
    chainSelector: MONAD_MAINNET_SELECTOR.toString(),
    kinds: { ref: KIND_REF, watch: KIND_WATCH, armedLog: KIND_ARMED_LOG },
    seqWindows: { kinds12: "[block.timestamp - 120, block.timestamp + 2] seconds", kind3: "[block.number - 400, block.number]" },
    vectors,
    nonCanonical,
  }
}
