import type { Address } from 'viem'
import type { AccountChainState } from '@/hooks/useAccountState'
import type { HomeChainState } from '@/hooks/useHomeChainState'

/**
 * Dev-only onboarding bypass (requested for local testing against live mainnet
 * contracts without spending real AUSD). Only ever imported from call sites
 * guarded by `import.meta.env.DEV` (see onboard.tsx, home.tsx, DevBypassPanel.tsx)
 * so this module tree-shakes out of production builds entirely.
 *
 * It never calls the real relay, never signs or submits a transaction. It only
 * overrides the *displayed* derived state so the real step components, real
 * animations, and real `deriveOnboardStep` logic can be exercised locally.
 */

export type DevBypassStage = 'off' | 'funded' | 'deployed' | 'activated'

const STAGE_STORAGE_KEY = 'gapless:dev-bypass-stage'
const QUERY_PARAM = 'devBypass'

function isStage(value: string | null): value is DevBypassStage {
  return (
    value === 'off' ||
    value === 'funded' ||
    value === 'deployed' ||
    value === 'activated'
  )
}

/** Opt-in gate for the panel itself: visiting `?devBypass=1` reveals it.
 * Without the param, a dev running the real funding flow sees nothing extra. */
export function isDevBypassPanelRequested(): boolean {
  if (typeof window === 'undefined') return false
  return new URLSearchParams(window.location.search).get(QUERY_PARAM) === '1'
}

export function readDevBypassStage(): DevBypassStage {
  if (typeof window === 'undefined') return 'off'
  const raw = window.localStorage.getItem(STAGE_STORAGE_KEY)
  return isStage(raw) ? raw : 'off'
}

export function writeDevBypassStage(stage: DevBypassStage): void {
  if (typeof window === 'undefined') return
  if (stage === 'off') window.localStorage.removeItem(STAGE_STORAGE_KEY)
  else window.localStorage.setItem(STAGE_STORAGE_KEY, stage)
}

/**
 * Pure, additive override: returns a new object, never mutates `real`. Each
 * stage layers on top of the previous one so the real `deriveOnboardStep`
 * walks forward exactly as it would for a genuinely funded/deployed/activated
 * account — only the chain-read inputs are faked.
 */
export function applyDevBypassStage(
  real: AccountChainState,
  stage: DevBypassStage,
): AccountChainState {
  if (stage === 'off') return real

  const fundedAusdBalanceCNS =
    real.minOpenCNS > 0n ? real.minOpenCNS : 10_000_000n

  if (stage === 'funded')
    return { ...real, ausdBalanceCNS: fundedAusdBalanceCNS }

  if (stage === 'deployed')
    return {
      ...real,
      ausdBalanceCNS: fundedAusdBalanceCNS,
      isDeployed: true,
    }

  return {
    ...real,
    ausdBalanceCNS: fundedAusdBalanceCNS,
    isDeployed: true,
    perplAccountId: 1n,
    operatorKey: real.operator,
    operatorExpiry: BigInt(real.nowS + 3600),
    operatorMonBalanceWei:
      real.operatorMonBalanceWei > 0n
        ? real.operatorMonBalanceWei
        : 1_000_000_000_000_000n,
  }
}

/**
 * `/home`'s real `useHomeChainState` reads the account's own contract storage
 * (operator(), operatorUsage(), ...). A dev-bypassed account was never really
 * deployed, so those reads would throw. This is a fully synthetic stand-in,
 * only ever substituted when the bypass stage is 'activated' and the real
 * query is disabled (never fired) for the same render.
 */
export function fakeHomeChainState(
  operator: Address,
  nowS: number,
): HomeChainState {
  return {
    walletAusdCNS: 4_000_000n,
    perplFreeCNS: 3_500_000n,
    perplLockedCNS: 1_000_000n,
    positionDepositCNS: 2_500_000n,
    positionLotLNS: 1_000_000n,
    positionPricePNS: 2_000_000n,
    positionPnlCNS: 150_000n,
    activeCoverId:
      '0xaaaa000000000000000000000000000000000000000000000000000000000001',
    operatorGrant: {
      key: operator,
      expiry: BigInt(nowS + 3 * 3600),
      maxNotionalPerTradeCNS: 25_000_000n,
      maxNotionalPerDayCNS: 100_000_000n,
    },
    operatorUsedCNS: 15_000_000n,
    operatorAvailableCNS: 85_000_000n,
    operatorMonBalanceWei: 1_000_000_000_000_000n,
  }
}
