import type { Enum, EvmOnEventContext, Stats } from "envio";

export type Ctx = EvmOnEventContext;
export type CoverStatus = Enum<"CoverStatus">;

export type EventMeta = {
  readonly block: { readonly number: number; readonly timestamp: number };
  readonly transaction: { readonly hash: string };
  readonly logIndex: number;
};

export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
export const DEAD_ADDRESS = "0x000000000000000000000000000000000000dead";
export const STATS_ID = "global";
/** Upper bucket edges (blocks) of Stats.armToTriggerHist; one extra bucket for anything above. */
export const ARM_TO_TRIGGER_EDGES = [1, 2, 3, 4, 6, 10, 20, 40, 100, 200] as const;

const INT32_MAX = 2_147_483_647n;

/** One entity id per log; the indexer runs a single chain. */
export const logId = (e: EventMeta): string => `${e.block.number}-${e.logIndex}`;

export const meta = (e: EventMeta) => ({
  blockNumber: e.block.number,
  timestamp: e.block.timestamp,
  txHash: e.transaction.hash,
  logIndex: e.logIndex,
});

/** Narrows an onchain uint to a GraphQL Int; out of range means the ABI changed, so fail loudly. */
export function toInt(v: bigint, field: string): number {
  if (v < 0n || v > INT32_MAX) throw new Error(`${field} out of Int range: ${v}`);
  return Number(v);
}

/** Decoded event params as JSON-safe values (bigint to decimal string). */
export function jsonParams(v: unknown): unknown {
  if (typeof v === "bigint") return v.toString();
  if (Array.isArray(v)) return v.map(jsonParams);
  if (v !== null && typeof v === "object") {
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, jsonParams(x)]));
  }
  return v;
}

export const ceilDiv = (a: bigint, b: bigint): bigint => (a + b - 1n) / b;

const COVER_STATUS_BY_CODE: readonly (CoverStatus | undefined)[] = [
  undefined, "LIVE", "ARMED", "TRIGGERED", "FINALIZED", "CANCELLED", "EXPIRED", "VOIDED",
];
const END_REASON_BY_CODE: readonly Enum<"CoverEndReason">[] = [
  "NONE", "OWNER_CANCEL", "EXPIRED", "POSITION_REDUCED", "POSITION_CLOSED_OR_FLIPPED", "LIQUIDATED_OR_ADL",
];
const DISARM_REASON_BY_CODE = ["CONDITION_GONE", "ARM_TTL_ELAPSED", "VENUE_UNAVAILABLE"] as const;

function byCode<T>(table: readonly (T | undefined)[], code: bigint, what: string): T {
  const v = code < BigInt(table.length) ? table[Number(code)] : undefined;
  if (v === undefined) throw new Error(`unknown ${what} code ${code}`);
  return v;
}

export const coverStatusOf = (code: bigint) => byCode(COVER_STATUS_BY_CODE, code, "CoverStatus");
export const endReasonOf = (code: bigint) => byCode(END_REASON_BY_CODE, code, "EndReason");
export const disarmReasonOf = (code: bigint) => byCode(DISARM_REASON_BY_CODE, code, "DisarmReason");

export const TERMINAL: ReadonlySet<CoverStatus> = new Set(["FINALIZED", "CANCELLED", "EXPIRED", "VOIDED"]);

const STATUS_FIELD = {
  LIVE: "coversLive",
  ARMED: "coversArmed",
  TRIGGERED: "coversTriggered",
  FINALIZED: "coversFinalized",
  CANCELLED: "coversCancelled",
  EXPIRED: "coversExpired",
  VOIDED: "coversVoided",
} as const satisfies Record<CoverStatus, keyof Stats>;

/** Moves one cover between the per-status counters. */
export function moveStatus(s: Stats, from: CoverStatus | undefined, to: CoverStatus): Stats {
  if (from === to) return s;
  const next = { ...s, [STATUS_FIELD[to]]: s[STATUS_FIELD[to]] + 1 };
  if (from !== undefined) next[STATUS_FIELD[from]] = s[STATUS_FIELD[from]] - 1;
  return next;
}

export function armToTriggerBucket(blocks: number): number {
  const i = ARM_TO_TRIGGER_EDGES.findIndex((edge) => blocks <= edge);
  return i === -1 ? ARM_TO_TRIGGER_EDGES.length : i;
}

export function emptyStats(): Stats {
  return {
    id: STATS_ID,
    coversTotal: 0,
    coversLive: 0,
    coversArmed: 0,
    coversTriggered: 0,
    coversFinalized: 0,
    coversCancelled: 0,
    coversExpired: 0,
    coversVoided: 0,
    owners: 0,
    accounts: 0,
    notionalCoveredCNS: 0n,
    rentCNS: 0n,
    escrowToVaultCNS: 0n,
    premiumReceivedCNS: 0n,
    premiumToLpsCNS: 0n,
    premiumToTreasuryCNS: 0n,
    payoutCount: 0,
    paidCNS: 0n,
    owedCNS: 0n,
    armCount: 0,
    fillCount: 0,
    triggerNoFillCount: 0,
    armToTriggerCount: 0,
    armToTriggerSum: 0,
    armToTriggerMax: 0,
    armToTriggerHist: new Array<number>(ARM_TO_TRIGGER_EDGES.length + 1).fill(0),
    lpCount: 0,
    vaultGrossAssetsCNS: 0n,
    vaultTotalAssetsCNS: 0n,
    vaultReservedTotalCNS: 0n,
    vaultUtilizationBps: 0,
    creReports: 0,
    creArmed: 0,
    creTriggered: 0,
    trades: 0,
    vaultDeployTx: undefined,
    firstCoverTx: undefined,
    firstTriggerTx: undefined,
    updatedBlock: 0,
  };
}

export async function loadStats(context: Ctx): Promise<Stats> {
  return (await context.Stats.get(STATS_ID)) ?? emptyStats();
}

/** Recomputes the vault's ERC-4626 totalAssets (gross net of owed) and utilization (reserved / gross). */
export function withVaultTotals(s: Stats): Stats {
  const gross = s.vaultGrossAssetsCNS;
  const total = gross > s.owedCNS ? gross - s.owedCNS : 0n;
  const util = gross === 0n ? 0n : (s.vaultReservedTotalCNS * 10_000n) / gross;
  return { ...s, vaultTotalAssetsCNS: total, vaultUtilizationBps: Number(util > INT32_MAX ? INT32_MAX : util) };
}
