import { describe, expect, it } from 'vitest'
import {
  ORDER_TYPE,
  OrderInputError,
  buildCloseDesc,
  buildOpenDesc,
  capOf,
  closeLimit,
  maxPremiumFromQuote,
  openLimit,
  parseDecimalToUnits,
  tradeNotionalCNS,
  withinMarkBand,
} from './order'

describe('parseDecimalToUnits', () => {
  it('parses an exact decimal into integer units', () => {
    expect(parseDecimalToUnits('1.5', 1, 'stop')).toBe(15n)
    expect(parseDecimalToUnits('62431.5', 1, 'stop')).toBe(624315n)
    expect(parseDecimalToUnits('22', 5, 'size')).toBe(2_200_000n)
  })

  it('rejects more fractional digits than the market allows', () => {
    expect(() => parseDecimalToUnits('1.55', 1, 'stop')).toThrow(
      OrderInputError,
    )
  })

  it('rejects non-decimal input', () => {
    expect(() => parseDecimalToUnits('abc', 1, 'stop')).toThrow(OrderInputError)
    expect(() => parseDecimalToUnits('-1', 1, 'stop')).toThrow(OrderInputError)
  })
})

describe('withinMarkBand', () => {
  it('passes within 500 bps of mark', () => {
    expect(withinMarkBand(624_315n, 620_000n)).toBe(true)
  })

  it('fails past 500 bps of mark', () => {
    expect(withinMarkBand(700_000n, 620_000n)).toBe(false)
  })

  it('fails on a zero mark', () => {
    expect(withinMarkBand(1n, 0n)).toBe(false)
  })
})

describe('openLimit', () => {
  it('opening a long buys from the ask, moved up by slippage', () => {
    const limit = openLimit(true, {
      markPNS: 624_315n,
      bestBidPNS: 624_300n,
      bestAskPNS: 624_330n,
    })
    // 624330 * 1.005 = 627451.65 -> ceil
    expect(limit).toBe(627_452n)
  })

  it('opening a short sells into the bid, moved down by slippage', () => {
    const limit = openLimit(false, {
      markPNS: 624_315n,
      bestBidPNS: 624_300n,
      bestAskPNS: 624_330n,
    })
    // 624300 * 0.995 = 621178.5 -> floor
    expect(limit).toBe(621_178n)
  })

  it('falls back to mark when the opposite side is empty', () => {
    const limit = openLimit(true, {
      markPNS: 624_315n,
      bestBidPNS: 624_300n,
      bestAskPNS: 0n,
    })
    expect(limit).toBe(627_437n) // 624315 * 1.005, ceil
  })
})

describe('closeLimit', () => {
  it('closing a long sells into the bid, moved down by slippage', () => {
    const limit = closeLimit(true, {
      markPNS: 624_315n,
      bestBidPNS: 624_300n,
      bestAskPNS: 624_330n,
    })
    expect(limit).toBe(621_178n) // 624300 * 0.995, floor
  })

  it('closing a short buys from the ask, moved up by slippage', () => {
    const limit = closeLimit(false, {
      markPNS: 624_315n,
      bestBidPNS: 624_300n,
      bestAskPNS: 624_330n,
    })
    expect(limit).toBe(627_452n) // 624330 * 1.005, ceil
  })
})

describe('buildOpenDesc / buildCloseDesc', () => {
  it('encodes order type 0/1 for opens and 2/3 for closes', () => {
    expect(
      buildOpenDesc({
        perpId: 1n,
        isLong: true,
        lots: 2_200_000n,
        limitPNS: 1n,
      }).orderType,
    ).toBe(ORDER_TYPE.OPEN_LONG)
    expect(
      buildOpenDesc({
        perpId: 1n,
        isLong: false,
        lots: 2_200_000n,
        limitPNS: 1n,
      }).orderType,
    ).toBe(ORDER_TYPE.OPEN_SHORT)
    expect(
      buildCloseDesc({
        perpId: 1n,
        isLong: true,
        lots: 2_200_000n,
        limitPNS: 1n,
      }).orderType,
    ).toBe(ORDER_TYPE.CLOSE_LONG)
    expect(
      buildCloseDesc({
        perpId: 1n,
        isLong: false,
        lots: 2_200_000n,
        limitPNS: 1n,
      }).orderType,
    ).toBe(ORDER_TYPE.CLOSE_SHORT)
  })

  it('is always IOC with no post-chain fields set', () => {
    const d = buildOpenDesc({
      perpId: 1n,
      isLong: true,
      lots: 1n,
      limitPNS: 1n,
    })
    expect(d.immediateOrCancel).toBe(true)
    expect(d.fillOrKill).toBe(false)
    expect(d.expiryBlock).toBe(0n)
    expect(d.lastExecutionBlock).toBe(0n)
  })
})

describe('tradeNotionalCNS', () => {
  it('scales lots x max(limit, mark) to CNS for BTC (priceDecimals 1, lotDecimals 5)', () => {
    const notional = tradeNotionalCNS({
      lotLNS: 2_200_000n, // 22 lots
      limitPNS: 624_315n, // 62,431.5
      markPNS: 620_000n,
      priceDecimals: 1,
      lotDecimals: 5,
    })
    // scaleExp = 6 - 1 - 5 = 0
    expect(notional).toBe(2_200_000n * 624_315n)
  })
})

describe('capOf', () => {
  it('computes notional and cap from lots, stop and the market scale', () => {
    const { notionalCNS, capCNS } = capOf({
      lots: 2_200_000n,
      stopPNS: 621_190n,
      maxGapBps: 200,
      scale: 1n,
    })
    expect(notionalCNS).toBe(2_200_000n * 621_190n)
    expect(capCNS).toBe((notionalCNS * 200n) / 10_000n)
  })
})

describe('maxPremiumFromQuote', () => {
  it('adds the allowed slack on top of a fresh quote', () => {
    expect(maxPremiumFromQuote(1_840_000n, 200n)).toBe(1_876_800n)
  })

  it('refuses a bps above the cap', () => {
    expect(() => maxPremiumFromQuote(1_000_000n, 1_001n)).toThrow(
      OrderInputError,
    )
  })
})
