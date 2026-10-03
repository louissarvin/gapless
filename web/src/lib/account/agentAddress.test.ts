import { describe, expect, it } from 'vitest'
import { validateAgentAddress } from './agentAddress'

const OWNER = '0xe05fcC23807536bEe418f142D19fa0d21BB0cfF7' as const
const ACCOUNT = '0xab3CB7b3b28366eD7f6C59DbD2D708890919B289' as const
const AGENT = '0xa5cc3c03994DB5b0d9A5eEdD10CabaB0813678AC' as const

describe('validateAgentAddress', () => {
  it('accepts a properly checksummed address that is none of the exclusions', () => {
    const result = validateAgentAddress(AGENT, OWNER, ACCOUNT)
    expect(result).toEqual({ ok: true, address: AGENT })
  })

  it('accepts an all-lowercase address (no checksum info to contradict)', () => {
    const result = validateAgentAddress(AGENT.toLowerCase(), OWNER, ACCOUNT)
    expect(result.ok).toBe(true)
  })

  it('rejects a mixed-case address with the wrong checksum', () => {
    const wrongChecksum = AGENT.toLowerCase().replace('a5cc', 'A5Cc')
    const result = validateAgentAddress(wrongChecksum, OWNER, ACCOUNT)
    expect(result.ok).toBe(false)
  })

  it('rejects garbage input', () => {
    const result = validateAgentAddress('not an address', OWNER, ACCOUNT)
    expect(result.ok).toBe(false)
  })

  it('rejects the zero address', () => {
    const result = validateAgentAddress(
      '0x0000000000000000000000000000000000000000',
      OWNER,
      ACCOUNT,
    )
    expect(result).toEqual({
      ok: false,
      reason: 'This cannot be the zero address.',
    })
  })

  it('rejects the owner address', () => {
    const result = validateAgentAddress(OWNER, OWNER, ACCOUNT)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toMatch(/owner/i)
  })

  it('rejects the clone account itself', () => {
    const result = validateAgentAddress(ACCOUNT, OWNER, ACCOUNT)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toMatch(/Gapless account/i)
  })

  it('is case-insensitive when matching the exclusions', () => {
    const result = validateAgentAddress(OWNER.toLowerCase(), OWNER, ACCOUNT)
    expect(result.ok).toBe(false)
  })
})
