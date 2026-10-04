import { describe, expect, it } from 'vitest'
import { PROOF_PAIRING_WINDOW_BLOCKS, isValidPair } from './proofPairing'

const BASE = {
  gaplessPerpId: 1,
  gaplessIsLong: true,
  gaplessStopPNS: 624_300n,
  gaplessTriggerBlock: 111_000_000n,
  nativePerpId: 1,
  nativeSide: 'long' as const,
  nativeTriggerPNS: 624_300n,
  nativeExecutedBlock: 111_000_050n,
}

describe('isValidPair', () => {
  it('accepts a matching perp, side, stop and a block delta inside the window', () => {
    expect(isValidPair(BASE)).toBe(true)
  })

  it('accepts a delta exactly at the window boundary', () => {
    expect(
      isValidPair({
        ...BASE,
        nativeExecutedBlock:
          BASE.gaplessTriggerBlock + PROOF_PAIRING_WINDOW_BLOCKS,
      }),
    ).toBe(true)
  })

  it('rejects a delta one block past the window', () => {
    expect(
      isValidPair({
        ...BASE,
        nativeExecutedBlock:
          BASE.gaplessTriggerBlock + PROOF_PAIRING_WINDOW_BLOCKS + 1n,
      }),
    ).toBe(false)
  })

  it('rejects a non-BTC Gapless perp', () => {
    expect(isValidPair({ ...BASE, gaplessPerpId: 2 })).toBe(false)
  })

  it('rejects a non-BTC native perp', () => {
    expect(isValidPair({ ...BASE, nativePerpId: 2 })).toBe(false)
  })

  it('rejects a side mismatch', () => {
    expect(isValidPair({ ...BASE, nativeSide: 'short' })).toBe(false)
  })

  it('rejects a stop price mismatch', () => {
    expect(isValidPair({ ...BASE, nativeTriggerPNS: 624_301n })).toBe(false)
  })
})
