import { CHAIN_ID } from '@/config/addresses.143'

/**
 * EIP-712 typed-data builders (ARCHITECTURE ADR-W9, 7.1, 8.3). Every builder
 * pairs with an onchain domain read: never sign before `assertDomainMatches`
 * passes. Primary types and field order are frozen by the contracts; do not
 * reorder them even though EIP-712 field names are otherwise arbitrary.
 */

export interface Eip712Domain {
  name: string
  version: string
  chainId: number
  verifyingContract: `0x${string}`
}

export class DomainMismatchError extends Error {
  constructor(expected: Eip712Domain, actual: Eip712Domain) {
    super(
      `EIP-712 domain mismatch: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    )
    this.name = 'DomainMismatchError'
  }
}

/**
 * The only gate between a read domain and a signature (ARCHITECTURE ADR-W9,
 * 8.3): "If the domain check fails, the sheet becomes a hard stop... no
 * continue button" (DESIGN 9.2).
 */
export function assertDomainMatches(
  onchain: Eip712Domain,
  expected: Eip712Domain,
): void {
  if (
    onchain.name !== expected.name ||
    onchain.version !== expected.version ||
    onchain.chainId !== expected.chainId ||
    onchain.verifyingContract.toLowerCase() !==
      expected.verifyingContract.toLowerCase()
  ) {
    throw new DomainMismatchError(expected, onchain)
  }
  if (onchain.chainId !== CHAIN_ID) {
    throw new DomainMismatchError(expected, onchain)
  }
}

const CREATE_ACCOUNT_TYPES = {
  CreateAccount: [
    { name: 'owner', type: 'address' },
    { name: 'key', type: 'address' },
    { name: 'expiry', type: 'uint64' },
    { name: 'maxNotional', type: 'uint128' },
    { name: 'maxNotionalPerDay', type: 'uint128' },
    { name: 'deadline', type: 'uint256' },
  ],
} as const

export interface CreateAccountMessage {
  owner: `0x${string}`
  key: `0x${string}`
  expiry: bigint
  maxNotional: bigint
  maxNotionalPerDay: bigint
  deadline: bigint
}

/** Owner-signed `CreateAccount` (ARCHITECTURE ADR-W4, ADR-W1). Domain = the GaplessFactory. */
export function buildCreateAccountTypedData(
  domain: Eip712Domain,
  message: CreateAccountMessage,
) {
  return {
    domain,
    types: CREATE_ACCOUNT_TYPES,
    primaryType: 'CreateAccount' as const,
    message,
  }
}

const SET_OPERATOR_TYPES = {
  SetOperator: [
    { name: 'account', type: 'address' },
    { name: 'key', type: 'address' },
    { name: 'expiry', type: 'uint64' },
    { name: 'maxNotional', type: 'uint128' },
    { name: 'maxNotionalPerDay', type: 'uint128' },
    { name: 'nonce', type: 'uint256' },
    { name: 'deadline', type: 'uint256' },
  ],
} as const

export interface SetOperatorMessage {
  account: `0x${string}`
  key: `0x${string}`
  expiry: bigint
  maxNotional: bigint
  maxNotionalPerDay: bigint
  nonce: bigint
  deadline: bigint
}

/** Owner-signed `SetOperator` (ARCHITECTURE 7.1). Domain = the user's GaplessAccount clone. */
export function buildSetOperatorTypedData(
  domain: Eip712Domain,
  message: SetOperatorMessage,
) {
  return {
    domain,
    types: SET_OPERATOR_TYPES,
    primaryType: 'SetOperator' as const,
    message,
  }
}

// Withdraw is intentionally not implemented: WITHDRAW_TYPEHASH's exact field
// order is not yet pinned anywhere this plan could verify against, and
// /settings (its only caller) is out of scope for this pass. Verify against
// the contract before building it.
