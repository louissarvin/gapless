import { describe, expect, it } from 'vitest'
import {
  ZERO_COVER_ID,
  hasActiveCover,
  totalBalanceCNS,
} from './useHomeChainState'
import type { HomeChainState } from './useHomeChainState'

const OPERATOR = '0x00000000000000000000000000000000000000A1' as const
const COVER_ID =
  '0xaaaa000000000000000000000000000000000000000000000000000000000001' as const

const BASE: HomeChainState = {
  walletAusdCNS: 10_000_000n,
  perplFreeCNS: 5_000_000n,
  perplLockedCNS: 0n,
  positionDepositCNS: 2_000_000n,
  positionLotLNS: 0n,
  positionPricePNS: 0n,
  positionPnlCNS: 0n,
  activeCoverId: ZERO_COVER_ID,
  operatorGrant: {
    key: OPERATOR,
    expiry: 9_999_999_999n,
    maxNotionalPerTradeCNS: 25_000_000n,
    maxNotionalPerDayCNS: 100_000_000n,
  },
  operatorUsedCNS: 0n,
  operatorAvailableCNS: 100_000_000n,
  operatorMonBalanceWei: 1n,
}

describe('totalBalanceCNS', () => {
  it('sums wallet AUSD, Perpl free balance and the position deposit (ARCHITECTURE 5.4)', () => {
    expect(totalBalanceCNS(BASE)).toBe(17_000_000n)
  })

  it('still sums correctly with no open position', () => {
    expect(totalBalanceCNS({ ...BASE, positionDepositCNS: 0n })).toBe(
      15_000_000n,
    )
  })
})

describe('hasActiveCover', () => {
  it('is false for the zero cover id', () => {
    expect(hasActiveCover(BASE)).toBe(false)
  })

  it('is true for any non-zero cover id', () => {
    expect(hasActiveCover({ ...BASE, activeCoverId: COVER_ID })).toBe(true)
  })
})
