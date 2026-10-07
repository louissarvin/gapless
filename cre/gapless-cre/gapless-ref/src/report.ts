import { decodeAbiParameters, encodeAbiParameters, keccak256, parseAbiParameters, type Hex } from "viem"
import { SINK_MAX_IDS, type Config } from "./config"

/** Constants.CHAIN_SELECTOR; the sink reverts WrongChain on anything else. */
export const MONAD_MAINNET_SELECTOR = 8_481_857_512_324_358_265n

export const KIND_REF = 1
export const KIND_WATCH = 2
export const KIND_ARMED_LOG = 3
export type Kind = typeof KIND_REF | typeof KIND_WATCH | typeof KIND_ARMED_LOG

/** Frozen layout decoded by GaplessCreReceiver.onReport (INTERFACES 5.6). */
export const REPORT_PARAMS = parseAbiParameters(
  "uint8 kind, uint64 chainSelector, uint64 seq, uint256 perpId, uint256 refPricePNS, bytes32[] toArm, bytes32[] toTrigger",
)

export interface ReportFields {
  kind: Kind
  chainSelector: bigint
  seq: bigint
  perpId: bigint
  refPricePNS: bigint
  toArm: readonly Hex[]
  toTrigger: readonly Hex[]
}

const U64_MAX = (1n << 64n) - 1n
const U256_MAX = (1n << 256n) - 1n
const BYTES32 = /^0x[0-9a-fA-F]{64}$/

function checkUint(name: string, v: bigint, max: bigint): void {
  if (v < 0n || v > max) throw new Error(`${name} out of range`)
}

function checkIds(name: string, ids: readonly Hex[]): void {
  if (ids.length > SINK_MAX_IDS) throw new Error(`${name} has more than ${SINK_MAX_IDS} ids`)
  for (const id of ids) if (!BYTES32.test(id)) throw new Error(`${name} id is not bytes32`)
}

/** Validates the fields against the sink's rules, then abi-encodes them as a flat tuple. */
export function encodeReport(f: ReportFields): Hex {
  if (f.kind !== KIND_REF && f.kind !== KIND_WATCH && f.kind !== KIND_ARMED_LOG) throw new Error("bad kind")
  checkUint("chainSelector", f.chainSelector, U64_MAX)
  checkUint("seq", f.seq, U64_MAX)
  checkUint("perpId", f.perpId, U256_MAX)
  checkUint("refPricePNS", f.refPricePNS, U256_MAX)
  checkIds("toArm", f.toArm)
  checkIds("toTrigger", f.toTrigger)
  if (f.kind === KIND_REF && (f.toArm.length > 0 || f.toTrigger.length > 0)) throw new Error("kind 1 carries no ids")
  if (f.kind === KIND_WATCH && f.toArm.length + f.toTrigger.length === 0) throw new Error("kind 2 needs ids")
  if (f.kind === KIND_ARMED_LOG && (f.toArm.length !== 0 || f.toTrigger.length !== 1)) {
    throw new Error("kind 3 carries exactly one toTrigger id")
  }
  return encodeAbiParameters(REPORT_PARAMS, [
    f.kind,
    f.chainSelector,
    f.seq,
    f.perpId,
    f.refPricePNS,
    [...f.toArm],
    [...f.toTrigger],
  ])
}

export function decodeReport(report: Hex): ReportFields {
  const [kind, chainSelector, seq, perpId, refPricePNS, toArm, toTrigger] = decodeAbiParameters(REPORT_PARAMS, report)
  return { kind: kind as Kind, chainSelector, seq, perpId, refPricePNS, toArm, toTrigger }
}

/** The sink's `seen` key: keccak256 of the canonical re-encoding of the decoded fields (N-06). */
export function seenKey(report: Hex): Hex {
  const f = decodeReport(report)
  return keccak256(
    encodeAbiParameters(REPORT_PARAMS, [
      f.kind,
      f.chainSelector,
      f.seq,
      f.perpId,
      f.refPricePNS,
      [...f.toArm],
      [...f.toTrigger],
    ]),
  )
}

type GasConfig = Pick<Config, "gasRef" | "gasBase" | "gasPerArm" | "gasPerTrigger" | "gasCap">

/** D10: Monad bills the gas limit, so size it per report instead of one large constant. */
export function gasLimitFor(kind: Kind, nArm: number, nTrigger: number, g: GasConfig): bigint {
  if (kind === KIND_REF) return g.gasRef < g.gasCap ? g.gasRef : g.gasCap
  const want = g.gasBase + g.gasPerArm * BigInt(nArm) + g.gasPerTrigger * BigInt(nTrigger)
  return want < g.gasCap ? want : g.gasCap
}
