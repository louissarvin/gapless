import { describe, expect, it } from 'vitest'
import { errorCopyFor, errorCopyForRevert } from './errors'

describe('errorCopyFor', () => {
  it('maps a known relay code to copy, never echoing the raw message', () => {
    const copy = errorCopyFor('NOT_FUNDED')
    expect(copy.title).toBe('Not funded yet')
    expect(copy.body.length).toBeGreaterThan(0)
  })

  it('maps a known decoded revert name', () => {
    expect(errorCopyFor('StopTooClose').title).toBe('Stop is too close')
  })

  it('falls back to a generic message for unknown or missing codes', () => {
    expect(errorCopyFor('SOMETHING_NEW').title).toBe('Something went wrong')
    expect(errorCopyFor(null).title).toBe('Something went wrong')
    expect(errorCopyFor(undefined).title).toBe('Something went wrong')
  })
})

describe('errorCopyForRevert', () => {
  it('fills in StopTooClose numbers from the decoded args (DESIGN 9.3 example)', () => {
    const copy = errorCopyForRevert({
      errorName: 'StopTooClose',
      args: [12n, 15n],
    })
    expect(copy.body).toBe(
      'Covers need the stop at least 15 bps from the mark. Yours is 12.',
    )
  })

  it("fills in OperatorBudgetExceeded's available amount", () => {
    const copy = errorCopyForRevert({
      errorName: 'OperatorBudgetExceeded',
      args: [100_000_000n, 21_400_000n],
    })
    expect(copy.body).toBe(
      'This trading key can move 100 AUSD a day and has 21.40 left.',
    )
  })

  it('falls back to the plain code mapping for everything else', () => {
    expect(
      errorCopyForRevert({ errorName: 'SigmaStale', args: [1n] }).title,
    ).toBe('Pricing needs a refresh')
  })

  it('returns the generic message for a null (undecoded) revert', () => {
    expect(errorCopyForRevert(null).title).toBe('Something went wrong')
  })
})
