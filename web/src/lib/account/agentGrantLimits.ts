import { formatCNS } from '@/utils/units'

/**
 * Limits-form validation for `/settings/agent` (ARCHITECTURE 7.2 step 3):
 * per-trade <= 25 AUSD, per-day <= 100 AUSD, per-trade <= per-day, both
 * nonzero, expiry <= now + 24h, deadline <= now + 1h. "now" is the latest
 * block timestamp the caller read, never the device clock.
 */

export interface AgentGrantLimitsInput {
  maxPerTradeCNS: bigint
  maxPerDayCNS: bigint
  expiryS: number
  deadlineS: number
}

export interface AgentGrantLimitsBounds {
  maxPerTradeCNS: bigint
  maxPerDayCNS: bigint
  maxExpirySeconds: number
  maxDeadlineSeconds: number
}

export interface AgentGrantLimitsErrors {
  maxPerTrade?: string
  maxPerDay?: string
  expiry?: string
  deadline?: string
}

export function validateAgentGrantLimits(
  input: AgentGrantLimitsInput,
  nowS: number,
  bounds: AgentGrantLimitsBounds,
): AgentGrantLimitsErrors {
  const errors: AgentGrantLimitsErrors = {}

  if (input.maxPerTradeCNS <= 0n) {
    errors.maxPerTrade = 'Must be greater than zero.'
  } else if (input.maxPerTradeCNS > bounds.maxPerTradeCNS) {
    errors.maxPerTrade = `Cannot exceed ${formatCNS(bounds.maxPerTradeCNS)}.`
  }

  if (input.maxPerDayCNS <= 0n) {
    errors.maxPerDay = 'Must be greater than zero.'
  } else if (input.maxPerDayCNS > bounds.maxPerDayCNS) {
    errors.maxPerDay = `Cannot exceed ${formatCNS(bounds.maxPerDayCNS)}.`
  }

  if (
    !errors.maxPerTrade &&
    !errors.maxPerDay &&
    input.maxPerTradeCNS > input.maxPerDayCNS
  ) {
    errors.maxPerTrade = 'Per-trade limit cannot exceed the per-day limit.'
  }

  if (input.expiryS <= nowS) {
    errors.expiry = 'Expiry must be in the future.'
  } else if (input.expiryS > nowS + bounds.maxExpirySeconds) {
    errors.expiry = `Cannot be more than ${Math.round(bounds.maxExpirySeconds / 3600)}h from now.`
  }

  if (input.deadlineS <= nowS) {
    errors.deadline = 'Deadline must be in the future.'
  } else if (input.deadlineS > nowS + bounds.maxDeadlineSeconds) {
    errors.deadline = `Cannot be more than ${Math.round(bounds.maxDeadlineSeconds / 60)} min from now.`
  }

  return errors
}

export function hasAgentGrantLimitsErrors(
  errors: AgentGrantLimitsErrors,
): boolean {
  return Object.values(errors).some((value) => value !== undefined)
}
