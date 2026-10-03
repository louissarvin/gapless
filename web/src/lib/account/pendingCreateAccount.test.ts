// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest'
import {
  clearPendingCreateAccount,
  isPendingCreateAccountUsable,
  loadPendingCreateAccount,
  savePendingCreateAccount,
} from './pendingCreateAccount'
import type { PendingCreateAccount } from './pendingCreateAccount'

const PAYLOAD: PendingCreateAccount = {
  owner: '0xe05fcC23807536bEe418f142D19fa0d21BB0cfF7',
  account: '0xab3CB7b3b28366eD7f6C59DbD2D708890919B289',
  grant: {
    key: '0x00000000000000000000000000000000000000A1',
    expiry: '1700021540',
    maxNotionalPerTradeCNS: '25000000',
    maxNotionalPerDayCNS: '100000000',
  },
  deadline: '1700082800',
  sig: `0x${'ab'.repeat(65)}`,
  expiry: 1_700_021_540,
}

describe('pendingCreateAccount storage', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('round-trips the payload', () => {
    savePendingCreateAccount(PAYLOAD)
    expect(loadPendingCreateAccount()).toEqual(PAYLOAD)
  })

  it('clears the payload', () => {
    savePendingCreateAccount(PAYLOAD)
    clearPendingCreateAccount()
    expect(loadPendingCreateAccount()).toBeUndefined()
  })

  it('rejects malformed stored data', () => {
    localStorage.setItem(
      'gapless.pendingCreateAccount.v1',
      JSON.stringify({ owner: 'x' }),
    )
    expect(loadPendingCreateAccount()).toBeUndefined()
  })
})

describe('isPendingCreateAccountUsable', () => {
  it('is usable with more than 1h of grant life left', () => {
    expect(isPendingCreateAccountUsable(PAYLOAD, PAYLOAD.expiry - 3_601)).toBe(
      true,
    )
  })

  it('is not usable with less than 1h left', () => {
    expect(isPendingCreateAccountUsable(PAYLOAD, PAYLOAD.expiry - 3_599)).toBe(
      false,
    )
  })
})
