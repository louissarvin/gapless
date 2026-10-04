/**
 * Order recipe and bigint math for `/trade` (ARCHITECTURE phase 2 ADR-W19,
 * ADR-W13, DESIGN 8.2). Every value that reaches calldata is parsed and
 * computed as bigint here; `src/utils/units.ts`'s float helpers are display
 * only and never feed this module.
 *
 * Vectors (`withinMarkBand`, `openLimit`, `maxPremiumFromQuote`, `capOf`) are
 * copied, not imported, from `plugin/src/lib/cover.ts` and
 * `plugin/src/lib/units.ts` (ADR-W19): the two packages ship separately and
 * must not share a runtime dependency.
 */

export const BPS = 10_000n

/** Constants.sol `OPERATOR_MAX_LIMIT_DEVIATION_BPS`: GaplessAccount._checkOperator's M-01 band. */
export const OPERATOR_MAX_LIMIT_DEVIATION_BPS = 500n

export const DEFAULT_SLIPPAGE_BPS = 50n
export const DEFAULT_MAX_PREMIUM_BPS = 200n
export const MAX_PREMIUM_BPS_CAP = 1_000n

/** DESIGN 5.1 order recipe: IOC, 32 matches, 300 bps max negative PnL collateral, 3x default leverage. */
export const ORDER_RECIPE = {
  maxMatches: 32n,
  maxNegPnlCollatBPS: 300n,
  leverageHdths: 300n,
} as const

export const ORDER_TYPE = {
  OPEN_LONG: 0,
  OPEN_SHORT: 1,
  CLOSE_LONG: 2,
  CLOSE_SHORT: 3,
} as const

export class OrderInputError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'OrderInputError'
  }
}

export interface CoverParams {
  perpId: bigint
  isLong: boolean
  lots: bigint
  stopPNS: bigint
  maxGapBps: number
  durationBlocks: number
}

/** `IPerplMin.OrderDesc` (ABI field order, `src/abi/IGaplessAccount.ts`). */
export interface OrderDesc {
  orderDescId: bigint
  perpId: bigint
  orderType: number
  orderId: bigint
  pricePNS: bigint
  lotLNS: bigint
  expiryBlock: bigint
  postOnly: boolean
  fillOrKill: boolean
  immediateOrCancel: boolean
  maxMatches: bigint
  leverageHdths: bigint
  lastExecutionBlock: bigint
  amountCNS: bigint
  maxNegPnlCollatBPS: bigint
}

const DECIMAL_RE = /^\d{1,30}(\.\d{1,30})?$/

/** Exact decimal string to integer units; rejects excess precision instead of rounding (ADR-W19). */
export function parseDecimalToUnits(
  raw: string,
  decimals: number,
  field: string,
): bigint {
  const v = raw.trim()
  if (!DECIMAL_RE.test(v)) {
    throw new OrderInputError(`${field} must be a positive decimal`)
  }
  const [intPart = '0', fracPart = ''] = v.split('.')
  if (fracPart.length > decimals) {
    throw new OrderInputError(`${field} allows at most ${decimals} decimals`)
  }
  return (
    BigInt(intPart) * 10n ** BigInt(decimals) +
    BigInt(fracPart.padEnd(decimals, '0') || '0')
  )
}

function ceilDiv(a: bigint, b: bigint): bigint {
  return (a + b - 1n) / b
}

/** Contract M-01: |limit - mark| <= 500 bps of mark (same integer test as GaplessAccount._checkOperator). */
export function withinMarkBand(
  limitPNS: bigint,
  markPNS: bigint,
  maxDeviationBps: bigint = OPERATOR_MAX_LIMIT_DEVIATION_BPS,
): boolean {
  if (markPNS === 0n) return false
  const dev = limitPNS > markPNS ? limitPNS - markPNS : markPNS - limitPNS
  return dev * BPS <= markPNS * maxDeviationBps
}

export interface BookContext {
  markPNS: bigint
  bestBidPNS: bigint
  bestAskPNS: bigint
  slippageBps?: bigint
}

/**
 * Open limit = best opposite onchain price moved by slippage, mark when that
 * side is empty (DESIGN 5.1 order recipe; opening a long buys from asks).
 */
export function openLimit(isLong: boolean, book: BookContext): bigint {
  const slip = book.slippageBps ?? DEFAULT_SLIPPAGE_BPS
  const ref = isLong
    ? book.bestAskPNS > 0n
      ? book.bestAskPNS
      : book.markPNS
    : book.bestBidPNS > 0n
      ? book.bestBidPNS
      : book.markPNS
  return isLong ? ceilDiv(ref * (BPS + slip), BPS) : (ref * (BPS - slip)) / BPS
}

/**
 * Close limit = best same-side onchain price moved by slippage (closing a
 * long sells into bids; closing a short buys from asks), mark when empty.
 */
export function closeLimit(isLong: boolean, book: BookContext): bigint {
  const slip = book.slippageBps ?? DEFAULT_SLIPPAGE_BPS
  const ref = isLong
    ? book.bestBidPNS > 0n
      ? book.bestBidPNS
      : book.markPNS
    : book.bestAskPNS > 0n
      ? book.bestAskPNS
      : book.markPNS
  return isLong ? (ref * (BPS - slip)) / BPS : ceilDiv(ref * (BPS + slip), BPS)
}

export function buildOpenDesc(p: {
  perpId: bigint
  isLong: boolean
  lots: bigint
  limitPNS: bigint
}): OrderDesc {
  return {
    orderDescId: 0n, // overwritten by the account
    perpId: p.perpId,
    orderType: p.isLong ? ORDER_TYPE.OPEN_LONG : ORDER_TYPE.OPEN_SHORT,
    orderId: 0n,
    pricePNS: p.limitPNS,
    lotLNS: p.lots,
    expiryBlock: 0n,
    postOnly: false,
    fillOrKill: false,
    immediateOrCancel: true,
    maxMatches: ORDER_RECIPE.maxMatches,
    leverageHdths: ORDER_RECIPE.leverageHdths,
    lastExecutionBlock: 0n,
    amountCNS: 0n,
    maxNegPnlCollatBPS: ORDER_RECIPE.maxNegPnlCollatBPS,
  }
}

/** Guarantee-off close (ADR-W13): a plain `trade()` call, lots capped to the open position by the caller. */
export function buildCloseDesc(p: {
  perpId: bigint
  isLong: boolean
  lots: bigint
  limitPNS: bigint
}): OrderDesc {
  return {
    orderDescId: 0n,
    perpId: p.perpId,
    orderType: p.isLong ? ORDER_TYPE.CLOSE_LONG : ORDER_TYPE.CLOSE_SHORT,
    orderId: 0n,
    pricePNS: p.limitPNS,
    lotLNS: p.lots,
    expiryBlock: 0n,
    postOnly: false,
    fillOrKill: false,
    immediateOrCancel: true,
    maxMatches: ORDER_RECIPE.maxMatches,
    leverageHdths: ORDER_RECIPE.leverageHdths,
    lastExecutionBlock: 0n,
    amountCNS: 0n,
    maxNegPnlCollatBPS: ORDER_RECIPE.maxNegPnlCollatBPS,
  }
}

/**
 * Mirrors `GaplessAccount._checkOperator`'s notional: lots x max(limit, mark),
 * scaled from PNS/LNS to CNS (6 decimals). Used for the daily-budget check
 * the UI previews before sending (the contract is still the source of truth).
 */
export function tradeNotionalCNS(params: {
  lotLNS: bigint
  limitPNS: bigint
  markPNS: bigint
  priceDecimals: number
  lotDecimals: number
}): bigint {
  const scaleExp = 6 - params.priceDecimals - params.lotDecimals
  if (scaleExp < 0) {
    throw new Error('tradeNotionalCNS: priceDecimals + lotDecimals exceeds 6')
  }
  const px = params.limitPNS > params.markPNS ? params.limitPNS : params.markPNS
  return params.lotLNS * px * 10n ** BigInt(scaleExp)
}

/** Cover notional and cap preview (CoverManager's own math), mirrors `capOf` in plugin/src/lib/cover.ts. */
export function capOf(p: {
  lots: bigint
  stopPNS: bigint
  maxGapBps: number
  scale: bigint
}): { notionalCNS: bigint; capCNS: bigint } {
  const notionalCNS = p.lots * p.stopPNS * p.scale
  return { notionalCNS, capCNS: (notionalCNS * BigInt(p.maxGapBps)) / BPS }
}

/** Cover stops (not order limits) must sit at least `minDistanceBps` from mark (`StopTooClose`). */
export function stopDistanceBps(stopPNS: bigint, markPNS: bigint): bigint {
  if (markPNS === 0n) return 0n
  const dev = stopPNS > markPNS ? stopPNS - markPNS : markPNS - stopPNS
  return (dev * BPS) / markPNS
}

/** maxPremium = quote x (1 + bps / 1e4), floored so the bound never exceeds what the user allowed. */
export function maxPremiumFromQuote(
  quotedCNS: bigint,
  bps: bigint = DEFAULT_MAX_PREMIUM_BPS,
): bigint {
  if (bps > MAX_PREMIUM_BPS_CAP) {
    throw new OrderInputError('max-premium-bps exceeds the allowed cap')
  }
  return quotedCNS + (quotedCNS * bps) / BPS
}
