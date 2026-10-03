/**
 * The owner-signed `CreateAccount` payload (ARCHITECTURE ADR-W4): public data
 * (it can only deploy the signer's own account with the signer's own
 * operator), kept in localStorage under one versioned key so onboarding can
 * resume after a reload without a second passkey ceremony.
 */
const STORAGE_KEY = 'gapless.pendingCreateAccount.v1'

export interface PendingCreateAccount {
  owner: `0x${string}`
  account: `0x${string}`
  grant: {
    key: `0x${string}`
    expiry: string
    maxNotionalPerTradeCNS: string
    maxNotionalPerDayCNS: string
  }
  deadline: string
  sig: `0x${string}`
  /** Unix seconds the grant expires at; discard the payload once unusable (ADR-W4). */
  expiry: number
}

export function savePendingCreateAccount(payload: PendingCreateAccount): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(payload))
  } catch {
    // Best effort; onboarding still works, it just re-signs on reload.
  }
}

export function loadPendingCreateAccount(): PendingCreateAccount | undefined {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return undefined
    const parsed: unknown = JSON.parse(raw)
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      typeof (parsed as { owner?: unknown }).owner !== 'string' ||
      typeof (parsed as { account?: unknown }).account !== 'string' ||
      typeof (parsed as { sig?: unknown }).sig !== 'string' ||
      typeof (parsed as { grant?: unknown }).grant !== 'object'
    ) {
      return undefined
    }
    return parsed as PendingCreateAccount
  } catch {
    return undefined
  }
}

export function clearPendingCreateAccount(): void {
  try {
    localStorage.removeItem(STORAGE_KEY)
  } catch {
    // ignore
  }
}

/** Usable while expiry >= submitTime + 1h (at least 1h of trading left, ADR-W4). */
export function isPendingCreateAccountUsable(
  payload: PendingCreateAccount,
  submitTimeS: number,
): boolean {
  return payload.expiry >= submitTimeS + 3_600
}
