import {
  concat,
  encodeAbiParameters,
  hashTypedData,
  keccak256,
  recoverTypedDataAddress,
  toBytes,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { describe, expect, it } from 'vitest'
import {
  DomainMismatchError,
  assertDomainMatches,
  buildCreateAccountTypedData,
  buildSetOperatorTypedData,
} from './typedData'

/** secp256k1 n / 2: OZ ECDSA (and the contracts) reject s above it, and v other than 27 or 28. */
const SECP256K1_HALF_N =
  0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0n

function assertCanonicalSignature(sig: `0x${string}`) {
  expect(sig).toMatch(/^0x[0-9a-fA-F]{130}$/)
  const s = BigInt(`0x${sig.slice(66, 130)}`)
  const v = Number.parseInt(sig.slice(130, 132), 16)
  expect(s <= SECP256K1_HALF_N).toBe(true)
  expect(v === 27 || v === 28).toBe(true)
}

/**
 * Pinned from backend/test/sponsor.test.ts FORGE_PARITY (real GaplessFactory,
 * C5, chainId 143, vm.sign with key 0xa11ce). Any drift in the type string,
 * field order or domain fails here, same as the backend's own test.
 */
const FORGE_PARITY = {
  factory: '0x5615dEB798BB3E4dFa0139dFa1b3D433Cc23b72f' as const,
  ownerKey:
    '0x00000000000000000000000000000000000000000000000000000000000a11ce' as const,
  owner: '0xe05fcC23807536bEe418f142D19fa0d21BB0cfF7' as const,
  grant: {
    key: '0x00000000000000000000000000000000000000A1' as const,
    expiry: 1_791_223_200n,
    maxNotionalPerTradeCNS: 25_000_000n,
    maxNotionalPerDayCNS: 100_000_000n,
  },
  deadline: 1_791_202_200n,
  sig: '0x199b32e85003eae4ffce21360e0d44e143b556c39916c646dc884dbf17659bd9735cf796965257c4a3f1f318ece570f7c02b5f929cf3665b1569c1086e96e4fd1b' as const,
}

describe('buildCreateAccountTypedData', () => {
  it('signs to the same bytes the contract and the relay agree on', async () => {
    const f = FORGE_PARITY
    const signer = privateKeyToAccount(f.ownerKey)
    expect(signer.address).toBe(f.owner)

    const typedData = buildCreateAccountTypedData(
      {
        name: 'GaplessFactory',
        version: '1',
        chainId: 143,
        verifyingContract: f.factory,
      },
      {
        owner: f.owner,
        key: f.grant.key,
        expiry: f.grant.expiry,
        maxNotional: f.grant.maxNotionalPerTradeCNS,
        maxNotionalPerDay: f.grant.maxNotionalPerDayCNS,
        deadline: f.deadline,
      },
    )

    const sig = await signer.signTypedData(typedData)
    expect(sig).toBe(f.sig)
    assertCanonicalSignature(sig)
  })
})

describe('buildSetOperatorTypedData', () => {
  it("matches the contract digest (ARCHITECTURE 7.1), cross-checked against the plugin's own vector (plugin/test/read.test.ts)", async () => {
    const account = '0xab3CB7b3b28366eD7f6C59DbD2D708890919B289' as const
    const key = '0x00000000000000000000000000000000000000A1' as const
    const message = {
      account,
      key,
      expiry: 1_760_014_400n,
      maxNotional: 25_000_000n,
      maxNotionalPerDay: 100_000_000n,
      nonce: 7n,
      deadline: 1_760_003_600n,
    }
    const domain = {
      name: 'GaplessAccount',
      version: '1',
      chainId: 143,
      verifyingContract: account,
    }

    const typedData = buildSetOperatorTypedData(domain, message)

    // Recompute GaplessAccount.setOperatorWithSig's digest by hand (OZ EIP712 +
    // Constants.SET_OPERATOR_TYPEHASH), independent of our own builder.
    const typehash = keccak256(
      toBytes(
        'SetOperator(address account,address key,uint64 expiry,uint128 maxNotional,uint128 maxNotionalPerDay,uint256 nonce,uint256 deadline)',
      ),
    )
    const structHash = keccak256(
      encodeAbiParameters(
        [
          { type: 'bytes32' },
          { type: 'address' },
          { type: 'address' },
          { type: 'uint64' },
          { type: 'uint128' },
          { type: 'uint128' },
          { type: 'uint256' },
          { type: 'uint256' },
        ],
        [
          typehash,
          message.account,
          message.key,
          message.expiry,
          message.maxNotional,
          message.maxNotionalPerDay,
          message.nonce,
          message.deadline,
        ],
      ),
    )
    const domainSeparator = keccak256(
      encodeAbiParameters(
        [
          { type: 'bytes32' },
          { type: 'bytes32' },
          { type: 'bytes32' },
          { type: 'uint256' },
          { type: 'address' },
        ],
        [
          keccak256(
            toBytes(
              'EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)',
            ),
          ),
          keccak256(toBytes('GaplessAccount')),
          keccak256(toBytes('1')),
          143n,
          account,
        ],
      ),
    )
    const expectedDigest = keccak256(
      concat(['0x1901', domainSeparator, structHash]),
    )

    expect(hashTypedData(typedData)).toBe(expectedDigest)

    const owner = privateKeyToAccount(
      '0x00000000000000000000000000000000000000000000000000000000000a11ce',
    )
    const sig = await owner.signTypedData(typedData)
    assertCanonicalSignature(sig)
    expect(
      await recoverTypedDataAddress({ ...typedData, signature: sig }),
    ).toBe(owner.address)
  })
})

describe('assertDomainMatches', () => {
  const expected = {
    name: 'GaplessFactory',
    version: '1',
    chainId: 143,
    verifyingContract: '0x5615dEB798BB3E4dFa0139dFa1b3D433Cc23b72f' as const,
  }

  it('passes when every field matches', () => {
    expect(() => assertDomainMatches(expected, expected)).not.toThrow()
  })

  it('throws on a name mismatch (never sign, DESIGN 9.2 hard stop)', () => {
    expect(() =>
      assertDomainMatches({ ...expected, name: 'NotGapless' }, expected),
    ).toThrow(DomainMismatchError)
  })

  it('throws on a chain id other than 143', () => {
    expect(() =>
      assertDomainMatches(
        { ...expected, chainId: 1 },
        { ...expected, chainId: 1 },
      ),
    ).toThrow(DomainMismatchError)
  })

  it('throws on a verifyingContract mismatch', () => {
    expect(() =>
      assertDomainMatches(
        {
          ...expected,
          verifyingContract: '0x0000000000000000000000000000000000000001',
        },
        expected,
      ),
    ).toThrow(DomainMismatchError)
  })
})
