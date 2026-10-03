import { getAddress, isAddress } from 'viem'
import type { Address } from 'viem'

/**
 * Agent-address validation for `/settings/agent` (ARCHITECTURE 7.2 step 2):
 * checksum valid, not the owner, not the clone itself, not the zero address.
 * "Not a known contract address" is explicitly out of scope.
 */

const ZERO_ADDRESS: Address = '0x0000000000000000000000000000000000000000'

export type AgentAddressResult =
  | { ok: true; address: Address }
  | { ok: false; reason: string }

export function validateAgentAddress(
  input: string,
  owner: Address,
  account: Address,
): AgentAddressResult {
  const trimmed = input.trim()
  if (!isAddress(trimmed, { strict: true })) {
    return {
      ok: false,
      reason:
        'Enter a valid address. If it has capital letters, they must match the checksum.',
    }
  }
  const address = getAddress(trimmed)
  if (address === ZERO_ADDRESS) {
    return { ok: false, reason: 'This cannot be the zero address.' }
  }
  if (address.toLowerCase() === owner.toLowerCase()) {
    return { ok: false, reason: 'This cannot be your owner address.' }
  }
  if (address.toLowerCase() === account.toLowerCase()) {
    return { ok: false, reason: 'This cannot be your Gapless account itself.' }
  }
  return { ok: true, address }
}
