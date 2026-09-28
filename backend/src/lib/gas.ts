import { parseGwei } from 'viem';

/** Margin over fork-measured execution gas (fork rehearsal F2 convention, RUNBOOK 11.4). */
export const GAS_MARGIN_PCT = 115n;

/** Execution gas measured on the mainnet fork (integration rehearsal 2026-10-06, F-6); anvil reports real gasUsed. */
export const RELAY_GAS_MEASURED = { createAccountFor: 194_048n, sweep: 288_538n } as const;

/** Measured gas x GAS_MARGIN_PCT, rounded up. */
export function withGasMargin(measured: bigint): bigint {
  return (measured * GAS_MARGIN_PCT + 99n) / 100n;
}

/**
 * Gas limits per call. Monad bills the limit, not gas used, so every send passes one of these.
 * Calibrate from `cast estimate` or `debug_traceTransaction` inner frames, never receipt gasUsed (SA4-02: Monad
 * receipts report gasUsed == gasLimit).
 */
export const GAS = {
  arm: 300_000n,
  // SA4-01: sized for maxMatchesClose 8 (triggerGasFor(8) = 2.07M, fork 1.15 x 1.73M = 1.99M); remainders cost the same.
  trigger: 2_200_000n,
  // SA4-03: a step that meets one bid at landing fills and settles (0.75M on the fork, model 0.94M), so it must still fit.
  triggerStep: 1_100_000n,
  // SA4-01: one retry at this limit when a trigger simulation reverts without a decoded error (likely out of gas).
  triggerCeiling: 3_500_000n,
  observe: 250_000n,
  finalize: 600_000n,
  expire: 400_000n,
  voidCover: 400_000n,
  postSigma: 80_000n,
  // F-6: 223,156 and 331,819 (were 900K each). Sweep opens the Perpl account (createAccount plus deposit).
  createAccountFor: withGasMargin(RELAY_GAS_MEASURED.createAccountFor),
  sweep: withGasMargin(RELAY_GAS_MEASURED.sweep),
  transfer: 21_000n
} as const;

/** SA4-01 model, fork rehearsal 2026-10-06 (F2): manager side outside execOrder, Perpl first fill, each further maker fill. */
export const TRIGGER_GAS_MODEL = { manager: 550_000n, firstFill: 266_000n, perExtraFill: 141_000n, marginPct: GAS_MARGIN_PCT } as const;

/** Trigger gas for a close that consumes `maxMatches` resting orders: model x 1.15, capped at the ceiling. */
export function triggerGasFor(maxMatches: number): bigint {
  const m = TRIGGER_GAS_MODEL;
  const raw = m.manager + m.firstFill + m.perExtraFill * BigInt(Math.max(1, maxMatches) - 1);
  const gas = (raw * m.marginPct + 99n) / 100n;
  return gas < GAS.triggerCeiling ? gas : GAS.triggerCeiling;
}

/** Largest maxMatchesClose GAS.trigger covers (8): above it the keeper refuses to arm or trigger that market. */
export const MAX_MATCHES_CLOSE_SUPPORTED = (() => {
  let m = 1;
  while (triggerGasFor(m + 1) <= GAS.trigger) m++;
  return m;
})();

export type GasLabel = keyof typeof GAS;

/** Monad suggested tip is a fixed 2 gwei (02 §2.2, 03 §1.8). */
export const PRIORITY_FEE_WEI = parseGwei('2');
/** Monad minimum base fee (docs gas pricing); used when a block reports none. */
export const MIN_BASE_FEE_WEI = parseGwei('100');
/** Keeper MON budgets (env defaults, CLAUDE.md table) are sized for base fees up to this. */
export const DESIGN_BASE_FEE_WEI = parseGwei('110');

export interface FeeQuote {
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
}

/** maxFee = base * 2 + tip (spec §4.1). The base is floored at the protocol minimum. */
export function feeQuote(baseFeePerGas: bigint | null | undefined): FeeQuote {
  const base = baseFeePerGas && baseFeePerGas > MIN_BASE_FEE_WEI ? baseFeePerGas : MIN_BASE_FEE_WEI;
  return { maxFeePerGas: base * 2n + PRIORITY_FEE_WEI, maxPriorityFeePerGas: PRIORITY_FEE_WEI };
}

/** Price a receipt bills at this base fee (base + tip, under maxFee): what a send settles at in the governor. */
export function billedPriceWei(baseFeePerGas: bigint | null | undefined): bigint {
  const base = baseFeePerGas && baseFeePerGas > MIN_BASE_FEE_WEI ? baseFeePerGas : MIN_BASE_FEE_WEI;
  return base + PRIORITY_FEE_WEI;
}

/** Worst-case wei a send can cost: Monad charges gasLimit x price, price <= maxFee. */
export function maxCostWei(gas: bigint, fee: FeeQuote, value: bigint = 0n): bigint {
  return gas * fee.maxFeePerGas + value;
}
