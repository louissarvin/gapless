import { useState } from 'react'
import { isMeraError } from '@category-labs/mera'
import { createAccountPasskey, unlockAccountKeys } from '@/lib/account/keys'
import {
  loadCredentialHint,
  saveCredentialHint,
} from '@/lib/account/credentialHint'
import { accountSession } from '@/lib/account/session'

export type AuthPending = 'create' | 'signin' | null

/**
 * The two passkey ceremonies shared by `/` and `/onboard`'s unlock card
 * (ARCHITECTURE 5.1): create a new passkey, or re-derive the same owner and
 * operator from an existing one. `onDone` runs only after a session is live.
 */
export function useAuthActions(onDone: () => void | Promise<void>) {
  const [pending, setPending] = useState<AuthPending>(null)
  const [error, setError] = useState<string | null>(null)

  async function createAccount() {
    setError(null)
    setPending('create')
    try {
      const { credential, sessions } = await createAccountPasskey()
      saveCredentialHint(credential)
      accountSession.setOwnerSession(sessions.ownerSession)
      accountSession.setOperatorSession(sessions.operatorSession)
      await onDone()
    } catch (err) {
      setError(isMeraError(err) ? err.code : 'UNKNOWN')
    } finally {
      setPending(null)
    }
  }

  async function signIn() {
    setError(null)
    setPending('signin')
    try {
      const hint = loadCredentialHint()
      const sessions = await unlockAccountKeys(hint)
      accountSession.setOwnerSession(sessions.ownerSession)
      accountSession.setOperatorSession(sessions.operatorSession)
      await onDone()
    } catch (err) {
      setError(isMeraError(err) ? err.code : 'UNKNOWN')
    } finally {
      setPending(null)
    }
  }

  return { pending, error, createAccount, signIn }
}
