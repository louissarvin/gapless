import { type Address, encodeFunctionData } from "viem";
import { ICoverManagerAbi, IGaplessAccountAbi } from "../abi/index.js";
import { type Gapless, type Market, read } from "./chain.js";
import { BPS, DEFAULTS, MAX_LIMIT_DEVIATION_BPS, MAX_PREMIUM_BPS_CAP, OPEN_ORDER, PERPL_MAX_PRICE_PNS, PERPL_MIN_PRICE_PNS } from "./config.js";
import { decodeRevert, fail, revertData, toCommandError } from "./errors.js";
import { ausd, ceilDiv, parseDecimal, parseInteger, parseLeverage, price } from "./units.js";

export type CoverParams = {
  perpId: bigint;
  isLong: boolean;
  lots: bigint;
  stopPNS: bigint;
  maxGapBps: number;
  durationBlocks: number;
};

export type OrderDesc = {
  orderDescId: bigint;
  perpId: bigint;
  orderType: number;
  orderId: bigint;
  pricePNS: bigint;
  lotLNS: bigint;
  expiryBlock: bigint;
  postOnly: boolean;
  fillOrKill: boolean;
  immediateOrCancel: boolean;
  maxMatches: bigint;
  leverageHdths: bigint;
  lastExecutionBlock: bigint;
  amountCNS: bigint;
  maxNegPnlCollatBPS: bigint;
};

export type PositionInputs = { side: string; size?: string; stop?: string; maxGapBps?: string; blocks?: string };

function checkPrice(pns: bigint, field: string) {
  if (pns < PERPL_MIN_PRICE_PNS || pns > PERPL_MAX_PRICE_PNS) {
    fail("GAPLESS_BAD_INPUT", `--${field} is outside Perpl's price range.`, "Check the price and the market's decimals.");
  }
}

export function coverParams(m: Market, r: PositionInputs): CoverParams {
  if (r.side !== "long" && r.side !== "short") fail("GAPLESS_BAD_INPUT", "--side must be long or short.", "Pass long or short.");
  const lots = parseDecimal(r.size, m.lotDecimals, "size");
  if (lots === 0n) fail("GAPLESS_BAD_INPUT", "--size must be at least one lot.", `One lot is ${price(1n, m.lotDecimals)}.`);
  const stopPNS = parseDecimal(r.stop, m.priceDecimals, "stop");
  checkPrice(stopPNS, "stop");
  return {
    perpId: m.perpId,
    isLong: r.side === "long",
    lots,
    stopPNS,
    maxGapBps: Number(parseInteger(r.maxGapBps ?? DEFAULTS.maxGapBps, "max-gap-bps", 1n, 10_000n)),
    durationBlocks: Number(parseInteger(r.blocks ?? DEFAULTS.durationBlocks, "blocks", 1n, 4_294_967_295n)),
  };
}

/** Contract M-01: |limit - mark| <= 500 bps of mark (same integer test as GaplessAccount._checkOperator). */
export function withinMarkBand(limitPNS: bigint, markPNS: bigint): boolean {
  if (markPNS === 0n) return false;
  const dev = limitPNS > markPNS ? limitPNS - markPNS : markPNS - limitPNS;
  return dev * BPS <= markPNS * MAX_LIMIT_DEVIATION_BPS;
}

/** Explicit --limit, else best opposite book price moved by slippage (mark when that side is empty). */
export function openLimit(m: Market, isLong: boolean, r: { limit?: string; slippageBps?: string }): bigint {
  let limit: bigint;
  if (r.limit?.trim()) {
    limit = parseDecimal(r.limit, m.priceDecimals, "limit");
  } else {
    const slip = parseInteger(r.slippageBps ?? DEFAULTS.slippageBps, "slippage-bps", 0n, MAX_LIMIT_DEVIATION_BPS);
    const ref = (isLong ? m.bestAskPNS : m.bestBidPNS) ?? m.markPNS;
    limit = isLong ? ceilDiv(ref * (BPS + slip), BPS) : (ref * (BPS - slip)) / BPS;
  }
  checkPrice(limit, "limit");
  if (!withinMarkBand(limit, m.markPNS)) {
    fail(
      "GAPLESS_LIMIT_OFF_MARKET",
      `Limit ${price(limit, m.priceDecimals)} is more than 5% from the mark ${price(m.markPNS, m.priceDecimals)}.`,
      "Pass a --limit within 5% of the mark (contract rule M-01).",
    );
  }
  return limit;
}

export function openDesc(p: CoverParams, limitPNS: bigint, leverage: string | undefined): OrderDesc {
  return {
    orderDescId: 0n, // overwritten by the account
    perpId: p.perpId,
    orderType: p.isLong ? 0 : 1,
    orderId: 0n,
    pricePNS: limitPNS,
    lotLNS: p.lots,
    expiryBlock: 0n,
    postOnly: false,
    fillOrKill: false,
    immediateOrCancel: true,
    maxMatches: OPEN_ORDER.maxMatches,
    leverageHdths: parseLeverage(leverage ?? DEFAULTS.leverage),
    lastExecutionBlock: 0n,
    amountCNS: 0n,
    maxNegPnlCollatBPS: OPEN_ORDER.maxNegPnlCollatBPS,
  };
}

/** maxPremium = quote x (1 + bps / 1e4), floored so the bound never exceeds what the user allowed. */
export function maxPremium(quoteCNS: bigint, bpsRaw: string | undefined): bigint {
  const bps = parseInteger(bpsRaw ?? DEFAULTS.maxPremiumBps, "max-premium-bps", 0n, MAX_PREMIUM_BPS_CAP);
  return quoteCNS + (quoteCNS * bps) / BPS;
}

export type CoverQuote = {
  notionalCNS: bigint;
  capCNS: bigint;
  escrowCNS: bigint;
  rentCNS: bigint;
  feeBpsE2: bigint;
  utilAfterBps: bigint;
  distanceBps: bigint;
  minDistanceBps: bigint;
  expiryBlock: bigint;
};

export async function quoteExisting(g: Gapless, account: Address, p: CoverParams): Promise<CoverQuote> {
  return read("CoverManager.quote", () =>
    g.client.readContract({ address: g.manager, abi: ICoverManagerAbi, functionName: "quote", args: [account, p] }),
  );
}

/**
 * quote() needs an open position, so an open-and-cover is priced by simulating tradeAndCover with
 * maxPremium 0: the account reverts PremiumTooHigh(need, 0) with the exact escrow + rent after the trade.
 */
export async function probeOpenPremium(g: Gapless, from: Address, account: Address, d: OrderDesc, p: CoverParams): Promise<bigint> {
  const data = encodeFunctionData({ abi: IGaplessAccountAbi, functionName: "tradeAndCover", args: [d, p, 0n] });
  try {
    await g.client.call({ account: from, to: account, data, value: 0n });
  } catch (err) {
    const raw = revertData(err);
    const dec = raw ? decodeRevert(raw) : undefined;
    if (dec?.name === "PremiumTooHigh" && dec.args.quotedCNS !== undefined) return BigInt(dec.args.quotedCNS);
    throw toCommandError(err, "Simulation of tradeAndCover");
  }
  return fail("GAPLESS_PROBE_FAILED", "Could not price the cover: the zero-premium probe did not revert.", "Report this; do not submit.");
}

export function capOf(p: CoverParams, scale: bigint): { notionalCNS: bigint; capCNS: bigint } {
  const notionalCNS = p.lots * p.stopPNS * scale;
  return { notionalCNS, capCNS: (notionalCNS * BigInt(p.maxGapBps)) / BPS };
}

export const side = (isLong: boolean) => (isLong ? "long" : "short");

export function describe(m: Market, p: CoverParams) {
  return {
    market: m.symbol,
    perpId: m.perpId.toString(),
    side: side(p.isLong),
    lots: p.lots.toString(),
    size: price(p.lots, m.lotDecimals),
    stopPNS: p.stopPNS.toString(),
    stop: price(p.stopPNS, m.priceDecimals),
    mark: price(m.markPNS, m.priceDecimals),
    maxGapBps: p.maxGapBps,
    durationBlocks: p.durationBlocks,
  };
}

export function money(cns: bigint) {
  return { cns: cns.toString(), ausd: ausd(cns) };
}
