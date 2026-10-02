import { describe, expect, it } from 'vitest'
import { clientEnvShape } from './env'

const SECRET_PATTERN = /KEY|TOKEN|SECRET|PRIVATE|PASSWORD/i

describe('client env schema', () => {
  it('never declares a key that looks like a secret (ARCHITECTURE 8.2)', () => {
    const keys = Object.keys(clientEnvShape)
    const offenders = keys.filter((key) => SECRET_PATTERN.test(key))
    expect(offenders).toEqual([])
  })

  it('every declared key is VITE_ prefixed', () => {
    for (const key of Object.keys(clientEnvShape)) {
      expect(key.startsWith('VITE_')).toBe(true)
    }
  })

  it('does not expose the starter leftovers VITE_API_KEY or SERVER_URL', () => {
    const keys = Object.keys(clientEnvShape)
    expect(keys).not.toContain('VITE_API_KEY')
    expect(keys).not.toContain('SERVER_URL')
  })
})
