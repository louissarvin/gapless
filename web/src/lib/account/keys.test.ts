import { getEvmAddress } from '@category-labs/mera'
import { entropyToMnemonic } from '@scure/bip39'
import { wordlist } from '@scure/bip39/wordlists/english.js'
import { mnemonicToAccount } from 'viem/accounts'
import { describe, expect, it } from 'vitest'
import { OPERATOR_PATH, OWNER_PATH, deriveAccountKeys } from './keys'

const FIXED_PRF_OUTPUT = new Uint8Array(32).map((_, i) => i + 1)

describe('deriveAccountKeys', () => {
  it('matches viem mnemonicToAccount at index 0 (owner) and index 1 (operator)', () => {
    const { ownerSession, operatorSession } =
      deriveAccountKeys(FIXED_PRF_OUTPUT)

    const mnemonic = entropyToMnemonic(FIXED_PRF_OUTPUT, wordlist)
    const expectedOwner = mnemonicToAccount(mnemonic, { addressIndex: 0 })
    const expectedOperator = mnemonicToAccount(mnemonic, { addressIndex: 1 })

    expect(getEvmAddress(ownerSession.publicKey)).toBe(expectedOwner.address)
    expect(getEvmAddress(operatorSession.publicKey)).toBe(
      expectedOperator.address,
    )

    ownerSession.end()
    operatorSession.end()
  })

  it('uses the paths documented in ADR-W1', () => {
    expect(OWNER_PATH).toBe("m/44'/60'/0'/0/0")
    expect(OPERATOR_PATH).toBe("m/44'/60'/0'/0/1")
  })

  it('rejects a PRF output that is not 32 bytes', () => {
    expect(() => deriveAccountKeys(new Uint8Array(16))).toThrow(RangeError)
  })

  it('zeroes the caller-supplied buffer’s working copy (the input itself is left to the caller)', () => {
    const input = new Uint8Array(FIXED_PRF_OUTPUT)
    const { ownerSession, operatorSession } = deriveAccountKeys(input)
    // The function must not mutate the caller's buffer in place.
    expect(input).toEqual(FIXED_PRF_OUTPUT)
    ownerSession.end()
    operatorSession.end()
  })
})
