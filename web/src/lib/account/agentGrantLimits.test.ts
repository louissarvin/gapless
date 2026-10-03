import { describe, expect, it } from 'vitest'
import {
  hasAgentGrantLimitsErrors,
  validateAgentGrantLimits,
} from './agentGrantLimits'

const NOW = 1_700_000_000
const BOUNDS = {
  maxPerTradeCNS: 25_000_000n,
  maxPerDayCNS: 100_000_000n,
  maxExpirySeconds: 24 * 60 * 60,
  maxDeadlineSeconds: 60 * 60,
}

const VALID = {
  maxPerTradeCNS: 25_000_000n,
  maxPerDayCNS: 100_000_000n,
  expiryS: NOW + 4 * 3600,
  deadlineS: NOW + 3600,
}

describe('validateAgentGrantLimits', () => {
  it('accepts the architecture defaults', () => {
    const errors = validateAgentGrantLimits(VALID, NOW, BOUNDS)
    expect(hasAgentGrantLimitsErrors(errors)).toBe(false)
  })

  it('rejects zero per-trade', () => {
    const errors = validateAgentGrantLimits(
      { ...VALID, maxPerTradeCNS: 0n },
      NOW,
      BOUNDS,
    )
    expect(errors.maxPerTrade).toBeDefined()
  })

  it('rejects per-trade above the 25 AUSD bound', () => {
    const errors = validateAgentGrantLimits(
      { ...VALID, maxPerTradeCNS: 25_000_001n },
      NOW,
      BOUNDS,
    )
    expect(errors.maxPerTrade).toBeDefined()
  })

  it('rejects per-day above the 100 AUSD bound', () => {
    const errors = validateAgentGrantLimits(
      { ...VALID, maxPerDayCNS: 100_000_001n },
      NOW,
      BOUNDS,
    )
    expect(errors.maxPerDay).toBeDefined()
  })

  it('rejects per-trade exceeding per-day', () => {
    const errors = validateAgentGrantLimits(
      { ...VALID, maxPerTradeCNS: 50_000_000n, maxPerDayCNS: 30_000_000n },
      NOW,
      { ...BOUNDS, maxPerTradeCNS: 60_000_000n },
    )
    expect(errors.maxPerTrade).toMatch(/per-day/)
  })

  it('rejects an expiry in the past', () => {
    const errors = validateAgentGrantLimits(
      { ...VALID, expiryS: NOW - 1 },
      NOW,
      BOUNDS,
    )
    expect(errors.expiry).toBeDefined()
  })

  it('rejects an expiry beyond 24h', () => {
    const errors = validateAgentGrantLimits(
      { ...VALID, expiryS: NOW + 25 * 3600 },
      NOW,
      BOUNDS,
    )
    expect(errors.expiry).toBeDefined()
  })

  it('rejects a deadline beyond 1h', () => {
    const errors = validateAgentGrantLimits(
      { ...VALID, deadlineS: NOW + 3601 },
      NOW,
      BOUNDS,
    )
    expect(errors.deadline).toBeDefined()
  })

  it('rejects a deadline in the past', () => {
    const errors = validateAgentGrantLimits(
      { ...VALID, deadlineS: NOW - 1 },
      NOW,
      BOUNDS,
    )
    expect(errors.deadline).toBeDefined()
  })
})
