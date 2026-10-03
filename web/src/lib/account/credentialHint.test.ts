// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest'
import { loadCredentialHint, saveCredentialHint } from './credentialHint'

describe('credential hint storage', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('round-trips a credential hint', () => {
    saveCredentialHint({ credentialId: 'abc123', transports: ['internal'] })
    expect(loadCredentialHint()).toEqual({
      credentialId: 'abc123',
      transports: ['internal'],
    })
  })

  it('returns undefined when nothing is stored', () => {
    expect(loadCredentialHint()).toBeUndefined()
  })

  it('rejects malformed stored data rather than throwing', () => {
    localStorage.setItem(
      'gapless.credential.v1',
      JSON.stringify({ transports: ['internal'] }),
    )
    expect(loadCredentialHint()).toBeUndefined()
  })

  it('never stores a key, seed or PRF output, only credentialId and transports', () => {
    saveCredentialHint({ credentialId: 'abc123', transports: ['internal'] })
    const raw = localStorage.getItem('gapless.credential.v1')
    expect(raw).not.toBeNull()
    const parsed = JSON.parse(raw as string)
    expect(Object.keys(parsed).sort()).toEqual(['credentialId', 'transports'])
  })
})
