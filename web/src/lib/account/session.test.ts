// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  AccountSessionStore,
  OPERATOR_HIDDEN_TIMEOUT_MS,
  OPERATOR_IDLE_TIMEOUT_MS,
} from './session'

function fakeSession() {
  return { end: vi.fn(), publicKey: new Uint8Array(65), signDigest: vi.fn() }
}

describe('AccountSessionStore', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('owner session ends immediately when endOwnerSession is called', () => {
    const store = new AccountSessionStore()
    const owner = fakeSession()
    store.setOwnerSession(owner as never)
    store.endOwnerSession()
    expect(owner.end).toHaveBeenCalledOnce()
    expect(store.getOwnerSession()).toBeNull()
  })

  it('operator session ends after 15 minutes idle', () => {
    const store = new AccountSessionStore()
    const detach = store.attach()
    const operator = fakeSession()
    store.setOperatorSession(operator as never)

    vi.advanceTimersByTime(OPERATOR_IDLE_TIMEOUT_MS - 1)
    expect(operator.end).not.toHaveBeenCalled()

    vi.advanceTimersByTime(1)
    expect(operator.end).toHaveBeenCalledOnce()
    expect(store.getOperatorSession()).toBeNull()
    detach()
  })

  it('activity resets the idle timer', () => {
    const store = new AccountSessionStore()
    const detach = store.attach()
    const operator = fakeSession()
    store.setOperatorSession(operator as never)

    vi.advanceTimersByTime(OPERATOR_IDLE_TIMEOUT_MS - 1)
    window.dispatchEvent(new Event('pointerdown'))
    vi.advanceTimersByTime(OPERATOR_IDLE_TIMEOUT_MS - 1)
    expect(operator.end).not.toHaveBeenCalled()
    detach()
  })

  it('operator session ends after 5 minutes hidden', () => {
    const store = new AccountSessionStore()
    const detach = store.attach()
    const operator = fakeSession()
    store.setOperatorSession(operator as never)

    Object.defineProperty(document, 'hidden', {
      value: true,
      configurable: true,
    })
    document.dispatchEvent(new Event('visibilitychange'))

    vi.advanceTimersByTime(OPERATOR_HIDDEN_TIMEOUT_MS)
    expect(operator.end).toHaveBeenCalledOnce()
    detach()
  })

  it('ending the operator session clears its timers', () => {
    const store = new AccountSessionStore()
    const detach = store.attach()
    const operator = fakeSession()
    store.setOperatorSession(operator as never)
    store.endOperatorSession()

    vi.advanceTimersByTime(OPERATOR_IDLE_TIMEOUT_MS)
    expect(operator.end).toHaveBeenCalledOnce()
    detach()
  })
})
