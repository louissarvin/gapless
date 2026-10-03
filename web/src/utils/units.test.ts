import { describe, expect, it } from 'vitest'
import {
  cnsToDecimal,
  decimalToCns,
  formatApproxDuration,
  formatCNS,
  formatSigned,
  lnsToSize,
  pnsToPrice,
  priceToPns,
  shortenAddress,
  sizeToLns,
} from './units'

describe('CNS (AUSD, 6 decimals)', () => {
  it('round-trips a whole AUSD amount', () => {
    expect(cnsToDecimal(1_000_000n)).toBe(1)
    expect(decimalToCns(1)).toBe(1_000_000n)
  })

  it('matches the rent floor example (MIN_FEE_CNS = 20_000 = 0.02 AUSD)', () => {
    expect(cnsToDecimal(20_000n)).toBeCloseTo(0.02, 10)
  })

  it('formats with grouping and a thin-space unit', () => {
    expect(formatCNS(1_234_560_000n)).toBe('1,234.56 AUSD')
  })
})

describe('PNS (BTC-PERP priceDecimals = 1)', () => {
  it('round-trips a price', () => {
    expect(pnsToPrice(624_315n, 1)).toBeCloseTo(62_431.5, 10)
    expect(priceToPns(62_431.5, 1)).toBe(624_315n)
  })
})

describe('LNS (BTC-PERP lotDecimals = 5, one lot = 1e-5 BTC)', () => {
  it('matches the RUNBOOK demo: 22 lots = 0.00022 BTC', () => {
    expect(lnsToSize(22n, 5)).toBeCloseTo(0.00022, 10)
    expect(sizeToLns(0.00022, 5)).toBe(22n)
  })
})

describe('formatSigned', () => {
  it('signs positive and negative values, zero stays unsigned', () => {
    expect(formatSigned(12.4)).toBe('+12.40')
    expect(formatSigned(-3.1)).toBe('−3.10')
    expect(formatSigned(0)).toBe('0.00')
  })
})

describe('shortenAddress', () => {
  it('keeps 6 hex chars after 0x and the last 4', () => {
    expect(shortenAddress('0xb07C20cb5328d5208A1453521b94beeB3Faa1771')).toBe(
      '0xb07C20…1771',
    )
  })

  it('rejects anything that is not a 20-byte hex address', () => {
    expect(() => shortenAddress('0x1234')).toThrow()
  })
})

describe('formatApproxDuration', () => {
  it('reads "now" once expired', () => {
    expect(formatApproxDuration(0)).toBe('now')
    expect(formatApproxDuration(-10)).toBe('now')
  })

  it('rounds to minutes under an hour', () => {
    expect(formatApproxDuration(45 * 60)).toBe('about 45 min')
  })

  it('rounds to hours under a day', () => {
    expect(formatApproxDuration(3 * 3600 + 10 * 60)).toBe('about 3 h')
  })

  it('rounds to days at or beyond 24 hours', () => {
    expect(formatApproxDuration(2 * 86_400)).toBe('about 2 d')
  })
})
