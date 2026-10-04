import { useSyncExternalStore } from 'react'
import { accountSession } from '@/lib/account/session'

const subscribe = accountSession.subscribe.bind(accountSession)
const getOwnerSession = accountSession.getOwnerSession.bind(accountSession)
const getOperatorSession =
  accountSession.getOperatorSession.bind(accountSession)

/**
 * Reactive read of the in-memory session store. Plain `accountSession.get*()`
 * calls only see the session at the render that calls them; this re-renders
 * the caller whenever a session is set or ended (ARCHITECTURE 8.3), which
 * `/onboard` needs so an inline sign-in can resolve in place.
 */
export function useAccountSession() {
  const ownerSession = useSyncExternalStore(subscribe, getOwnerSession)
  const operatorSession = useSyncExternalStore(subscribe, getOperatorSession)
  return { ownerSession, operatorSession }
}
