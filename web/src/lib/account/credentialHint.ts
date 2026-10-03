import type { PasskeyCredentialMetadata } from '@category-labs/mera'

/**
 * localStorage holds only the credential hint, never a key or PRF output
 * (ARCHITECTURE 8.3). Validated on every read.
 */
const STORAGE_KEY = 'gapless.credential.v1'

export function saveCredentialHint(
  credential: PasskeyCredentialMetadata,
): void {
  try {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        credentialId: credential.credentialId,
        transports: credential.transports,
      }),
    )
  } catch {
    // localStorage unavailable (private mode, quota): sign-in falls back to an unscoped assertion.
  }
}

export function loadCredentialHint(): PasskeyCredentialMetadata | undefined {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return undefined
    const parsed: unknown = JSON.parse(raw)
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      typeof (parsed as { credentialId?: unknown }).credentialId !== 'string'
    ) {
      return undefined
    }
    const { credentialId, transports } = parsed as {
      credentialId: string
      transports?: unknown
    }
    return {
      credentialId,
      transports: Array.isArray(transports)
        ? (transports as Array<string>)
        : undefined,
    }
  } catch {
    return undefined
  }
}
