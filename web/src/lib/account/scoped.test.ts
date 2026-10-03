import { createSecp256k1SigningSession } from '@category-labs/mera'
import { privateKeyToAccount } from 'viem/accounts'
import { decodeFunctionData, parseTransaction } from 'viem'
import { describe, expect, it } from 'vitest'
import {
  OperatorScope,
  OwnerScope,
  encodeOperatorCall,
  operatorCallDestination,
} from './scoped'
import { DomainMismatchError } from './typedData'
import { IGaplessAccountAbi } from '@/abi/IGaplessAccount'
import { ICoverVaultAbi } from '@/abi/ICoverVault'
import { IAUSDAbi } from '@/abi/IAUSD'
import { ADDRESSES } from '@/config/addresses.143'

const TEST_OWNER_KEY =
  '0x00000000000000000000000000000000000000000000000000000000000a11ce' as const
const CLONE = '0xab3CB7b3b28366eD7f6C59DbD2D708890919B289' as const
const FACTORY = '0x5615dEB798BB3E4dFa0139dFa1b3D433Cc23b72f' as const
const ATTACKER = '0x000000000000000000000000000000000000Ad' as const

function sessionFromKey(key: `0x${string}`) {
  const bytes = Uint8Array.from(Buffer.from(key.slice(2), 'hex'))
  return createSecp256k1SigningSession({ privateKey: bytes })
}

const COVER_ID = `0x${'11'.repeat(32)}` as const

describe('encodeOperatorCall', () => {
  it('encodes one of the six allowed selectors', () => {
    const data = encodeOperatorCall({
      functionName: 'cancelCover',
      args: [COVER_ID],
    })
    const decoded = decodeFunctionData({ abi: IGaplessAccountAbi, data })
    expect(decoded.functionName).toBe('cancelCover')
  })

  it('refuses anything not in the allowed list', () => {
    expect(() =>
      encodeOperatorCall({ functionName: 'sweep' as never, args: [] }),
    ).toThrow()
  })
})

describe('vault calls (P2, ARCHITECTURE 8.3)', () => {
  it('encodes deposit/requestRedeem/claimRedeem against ICoverVault', () => {
    const data = encodeOperatorCall({
      target: 'vault',
      functionName: 'deposit',
      args: [1_000_000n, '0x1111111111111111111111111111111111111111'],
    })
    const decoded = decodeFunctionData({ abi: ICoverVaultAbi, data })
    expect(decoded.functionName).toBe('deposit')
  })

  it('refuses a vault function that is not deposit/requestRedeem/claimRedeem', () => {
    expect(() =>
      encodeOperatorCall({
        target: 'vault',
        functionName: 'setManager' as never,
        args: [ATTACKER],
      }),
    ).toThrow()
  })

  it('approveVault always encodes the vault as spender, with no spender field to override', () => {
    const data = encodeOperatorCall({
      target: 'approveVault',
      amountCNS: 5_000_000n,
    })
    const decoded = decodeFunctionData({ abi: IAUSDAbi, data })
    expect(decoded.functionName).toBe('approve')
    const [spender, value] = decoded.args as [string, bigint]
    expect(spender.toLowerCase()).toBe(ADDRESSES.CoverVault.toLowerCase())
    expect(value).toBe(5_000_000n)
  })

  it('resolves vault/approveVault destinations to the vault and AUSD regardless of the clone', () => {
    expect(
      operatorCallDestination(
        { target: 'vault', functionName: 'deposit', args: [] },
        CLONE,
      ).toLowerCase(),
    ).toBe(ADDRESSES.CoverVault.toLowerCase())
    expect(
      operatorCallDestination(
        { target: 'approveVault', amountCNS: 1n },
        CLONE,
      ).toLowerCase(),
    ).toBe(ADDRESSES.AUSD.toLowerCase())
  })

  it('a clone call (default target) still resolves to the clone, never the vault or an attacker address', () => {
    expect(
      operatorCallDestination(
        { functionName: 'cancelCover', args: [COVER_ID] },
        CLONE,
      ),
    ).toBe(CLONE)
  })
})

describe('OperatorScope', () => {
  it('always targets the clone it was constructed with, value 0, chain 143', async () => {
    const session = sessionFromKey(TEST_OWNER_KEY)
    const scope = new OperatorScope(session, CLONE)
    const signed = await scope.signTransaction(
      { functionName: 'cancelCover', args: [COVER_ID] },
      {
        gas: 300_000n,
        maxFeePerGas: 200_000_000_000n,
        maxPriorityFeePerGas: 2_000_000_000n,
        nonce: 0,
      },
    )
    const parsed = parseTransaction(signed)
    expect(parsed.to?.toLowerCase()).toBe(CLONE.toLowerCase())
    expect(parsed.value ?? 0n).toBe(0n)
    expect(parsed.chainId).toBe(143)
    session.end()
  })

  it('sends a vault call to CoverVault, not the clone, and an AUSD approve to AUSD', async () => {
    const session = sessionFromKey(TEST_OWNER_KEY)
    // A clone distinct from CoverVault's real address, so "not the clone" is
    // a meaningful assertion (CLONE above happens to equal ADDRESSES.CoverVault
    // on this deployment).
    const distinctClone = '0x1111111111111111111111111111111111111111' as const
    const scope = new OperatorScope(session, distinctClone)
    const overrides = {
      gas: 300_000n,
      maxFeePerGas: 200_000_000_000n,
      maxPriorityFeePerGas: 2_000_000_000n,
      nonce: 0,
    }

    const depositTx = await scope.signTransaction(
      {
        target: 'vault',
        functionName: 'deposit',
        args: [1_000_000n, distinctClone],
      },
      overrides,
    )
    const parsedDeposit = parseTransaction(depositTx)
    expect(parsedDeposit.to?.toLowerCase()).toBe(
      ADDRESSES.CoverVault.toLowerCase(),
    )
    expect(parsedDeposit.to?.toLowerCase()).not.toBe(
      distinctClone.toLowerCase(),
    )

    const approveTx = await scope.signTransaction(
      { target: 'approveVault', amountCNS: 1_000_000n },
      { ...overrides, nonce: 1 },
    )
    const parsedApprove = parseTransaction(approveTx)
    expect(parsedApprove.to?.toLowerCase()).toBe(ADDRESSES.AUSD.toLowerCase())
    session.end()
  })
})

describe('OwnerScope', () => {
  const expectedDomain = {
    name: 'GaplessFactory',
    version: '1',
    chainId: 143,
    verifyingContract: FACTORY,
  }

  it('signs CreateAccount when the onchain domain matches (forge parity vector)', async () => {
    const session = sessionFromKey(TEST_OWNER_KEY)
    const scope = new OwnerScope(session)
    expect(scope.address).toBe(privateKeyToAccount(TEST_OWNER_KEY).address)

    const sig = await scope.signCreateAccount(expectedDomain, expectedDomain, {
      owner: privateKeyToAccount(TEST_OWNER_KEY).address,
      key: '0x00000000000000000000000000000000000000A1',
      expiry: 1_791_223_200n,
      maxNotional: 25_000_000n,
      maxNotionalPerDay: 100_000_000n,
      deadline: 1_791_202_200n,
    })

    expect(sig).toBe(
      '0x199b32e85003eae4ffce21360e0d44e143b556c39916c646dc884dbf17659bd9735cf796965257c4a3f1f318ece570f7c02b5f929cf3665b1569c1086e96e4fd1b',
    )
    session.end()
  })

  it('refuses to sign when the onchain domain does not match (hard stop, no continue button)', async () => {
    const session = sessionFromKey(TEST_OWNER_KEY)
    const scope = new OwnerScope(session)
    await expect(
      scope.signCreateAccount(
        { ...expectedDomain, verifyingContract: CLONE },
        expectedDomain,
        {
          owner: privateKeyToAccount(TEST_OWNER_KEY).address,
          key: '0x00000000000000000000000000000000000000A1',
          expiry: 1_791_223_200n,
          maxNotional: 25_000_000n,
          maxNotionalPerDay: 100_000_000n,
          deadline: 1_791_202_200n,
        },
      ),
    ).rejects.toThrow(DomainMismatchError)
    session.end()
  })
})
