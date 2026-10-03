import type { Secp256k1SigningSession } from '@category-labs/mera'

/**
 * In-memory session holder (ARCHITECTURE 8.3). Keys live only in this module's
 * closure; React only ever sees addresses and signing functions. Owner ends
 * right after each signature; operator ends after idle or hidden timeouts,
 * on sign-out, and on `pagehide`.
 */

export const OPERATOR_IDLE_TIMEOUT_MS = 15 * 60_000
export const OPERATOR_HIDDEN_TIMEOUT_MS = 5 * 60_000

type Listener = () => void

const ACTIVITY_EVENTS = ['pointerdown', 'keydown', 'wheel'] as const

export class AccountSessionStore {
  private ownerSession: Secp256k1SigningSession | null = null
  private operatorSession: Secp256k1SigningSession | null = null
  private idleTimer: ReturnType<typeof setTimeout> | null = null
  private hiddenTimer: ReturnType<typeof setTimeout> | null = null
  private listeners = new Set<Listener>()
  private attached = false

  /** Attaches the idle, hidden and pagehide listeners. Call once, on the client. */
  attach(): () => void {
    if (this.attached || typeof window === 'undefined') return () => {}
    this.attached = true
    document.addEventListener('visibilitychange', this.handleVisibilityChange)
    window.addEventListener('pagehide', this.endOperatorSession)
    for (const event of ACTIVITY_EVENTS) {
      window.addEventListener(event, this.resetIdleTimer, { passive: true })
    }
    return () => {
      document.removeEventListener(
        'visibilitychange',
        this.handleVisibilityChange,
      )
      window.removeEventListener('pagehide', this.endOperatorSession)
      for (const event of ACTIVITY_EVENTS) {
        window.removeEventListener(event, this.resetIdleTimer)
      }
      this.attached = false
    }
  }

  setOwnerSession(session: Secp256k1SigningSession): void {
    this.ownerSession?.end()
    this.ownerSession = session
    this.notify()
  }

  getOwnerSession(): Secp256k1SigningSession | null {
    return this.ownerSession
  }

  /** Owner: end() right after each signature (ARCHITECTURE 8.3). The owner never holds a live session idly. */
  endOwnerSession = (): void => {
    this.ownerSession?.end()
    this.ownerSession = null
    this.notify()
  }

  setOperatorSession(session: Secp256k1SigningSession): void {
    this.operatorSession?.end()
    this.operatorSession = session
    this.resetIdleTimer()
    this.notify()
  }

  getOperatorSession(): Secp256k1SigningSession | null {
    return this.operatorSession
  }

  endOperatorSession = (): void => {
    this.operatorSession?.end()
    this.operatorSession = null
    this.clearTimers()
    this.notify()
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private notify(): void {
    for (const listener of this.listeners) listener()
  }

  private resetIdleTimer = (): void => {
    if (!this.operatorSession) return
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = setTimeout(
      this.endOperatorSession,
      OPERATOR_IDLE_TIMEOUT_MS,
    )
  }

  private handleVisibilityChange = (): void => {
    if (typeof document === 'undefined') return
    if (document.hidden) {
      if (this.hiddenTimer) clearTimeout(this.hiddenTimer)
      this.hiddenTimer = setTimeout(
        this.endOperatorSession,
        OPERATOR_HIDDEN_TIMEOUT_MS,
      )
    } else {
      if (this.hiddenTimer) clearTimeout(this.hiddenTimer)
      this.hiddenTimer = null
      this.resetIdleTimer()
    }
  }

  private clearTimers(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer)
    if (this.hiddenTimer) clearTimeout(this.hiddenTimer)
    this.idleTimer = null
    this.hiddenTimer = null
  }
}

/** One store for the whole app. */
export const accountSession = new AccountSessionStore()
