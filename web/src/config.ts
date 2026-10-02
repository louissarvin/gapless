import { env } from '@/env'

/** App constants (ARCHITECTURE 9.3). Chain id and contract addresses are not
 * here: they come from `src/config/addresses.143.ts` (ADR-W9). */

export const EXPLORER_URL = env.VITE_EXPLORER_URL

/** Onboarding sponsor grant (ARCHITECTURE ADR-W4). */
export const SPONSOR_GRANT = {
  maxNotionalPerTradeCNS: 25_000_000n, // 25 AUSD
  maxNotionalPerDayCNS: 100_000_000n, // 100 AUSD
  /** 6h minus a 60s margin (relay max SPONSOR_GRANT_MAX_TTL_S 21,600). */
  expirySeconds: 21_540,
  /** 23h (relay window is now + 60s to now + 86,400s). */
  deadlineSeconds: 82_800,
  /** Discard a stored payload once less than this much grant life remains. */
  minUsableSeconds: 3_600,
} as const

/** Agent grant bounds (ARCHITECTURE 7.2) and defaults, for /settings/agent. */
export const AGENT_GRANT_BOUNDS = {
  maxPerTradeCNS: 25_000_000n,
  maxPerDayCNS: 100_000_000n,
  maxExpirySeconds: 24 * 60 * 60,
  maxDeadlineSeconds: 60 * 60,
} as const

export const AGENT_GRANT_DEFAULTS = {
  maxPerTradeCNS: 25_000_000n, // 25 AUSD
  maxPerDayCNS: 100_000_000n, // 100 AUSD
  expirySeconds: 4 * 60 * 60, // now + 4h
  deadlineSeconds: 60 * 60, // now + 1h
} as const

/** Re-grant this device (ARCHITECTURE 7.3): canary limits, longer expiry. */
export const AGENT_REGRANT_DEFAULTS = {
  maxPerTradeCNS: 25_000_000n, // 25 AUSD
  maxPerDayCNS: 100_000_000n, // 100 AUSD
  expirySeconds: 6 * 60 * 60, // now + 6h
  deadlineSeconds: 60 * 60, // now + 1h
} as const

/** Fee policy and gas rule (ARCHITECTURE 9.3, 5.2). Not used until /trade. */
export const FEE_POLICY = {
  priorityFeeWei: 2_000_000_000n, // 2 gwei
  gasLimitMultiplier: 1.2,
  gasLimitCap: 5_000_000n,
} as const

export const SESSION_TIMEOUTS = {
  operatorIdleMs: 15 * 60_000,
  operatorHiddenMs: 5 * 60_000,
} as const

/**
 * `/proof` (ADR-W15). A pinned pair of public ids for a real, recorded
 * Gapless trigger alongside its matching plain Perpl stop. `null` until a
 * real pair exists: the page falls back to measured mode, never a fake pair.
 */
export const PROOF_PAIR: {
  cover: `0x${string}`
  native: `0x${string}`
  exec: `0x${string}`
} | null = null
