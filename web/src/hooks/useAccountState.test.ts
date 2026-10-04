// @vitest-environment jsdom
import { createElement } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { deriveOnboardStep, useAccountState } from './useAccountState'
import type { ReactNode } from 'react'
import type { AccountChainState } from './useAccountState'

const chain = vi.hoisted(() => ({
  isAccount: false,
  readContract: vi.fn(),
  multicall: vi.fn(),
}))

vi.mock('@/lib/chain', () => ({
  publicClient: {
    readContract: chain.readContract,
    multicall: chain.multicall,
    getBlock: () => Promise.resolve({ timestamp: 1_700_000_000n }),
    getBalance: () => Promise.resolve(0n),
  },
}))

const OWNER = '0xe05fcC23807536bEe418f142D19fa0d21BB0cfF7' as const
const OPERATOR = '0x00000000000000000000000000000000000000A1' as const
const ACCOUNT = '0xab3CB7b3b28366eD7f6C59DbD2D708890919B289' as const
const ZERO = '0x0000000000000000000000000000000000000000' as const

const BASE: AccountChainState = {
  owner: OWNER,
  operator: OPERATOR,
  account: ZERO,
  isDeployed: false,
  factoryDomain: {
    name: 'GaplessFactory',
    version: '1',
    chainId: 143,
    verifyingContract: ACCOUNT,
  },
  ausdBalanceCNS: 0n,
  minOpenCNS: 10_000_000n,
  perplAccountId: 0n,
  operatorKey: ZERO,
  operatorExpiry: 0n,
  operatorMonBalanceWei: 0n,
  nowS: 1_700_000_000,
}

describe('deriveOnboardStep', () => {
  it('shows keys before the owner has signed CreateAccount once', () => {
    expect(deriveOnboardStep(BASE, false)).toBe('keys')
  })

  it('shows fund once signed but under the minimum balance', () => {
    expect(deriveOnboardStep(BASE, true)).toBe('fund')
  })

  it('shows create once funded but not deployed', () => {
    expect(
      deriveOnboardStep({ ...BASE, ausdBalanceCNS: 10_000_000n }, true),
    ).toBe('create')
  })

  it('shows activate once deployed with no Perpl account', () => {
    expect(
      deriveOnboardStep({ ...BASE, isDeployed: true, account: ACCOUNT }, true),
    ).toBe('activate')
  })

  it('shows activate when deployed but the operator has no MON', () => {
    expect(
      deriveOnboardStep(
        {
          ...BASE,
          isDeployed: true,
          account: ACCOUNT,
          perplAccountId: 7n,
          operatorMonBalanceWei: 0n,
        },
        true,
      ),
    ).toBe('activate')
  })

  it('shows operator-replaced when the onchain operator key differs', () => {
    expect(
      deriveOnboardStep(
        {
          ...BASE,
          isDeployed: true,
          account: ACCOUNT,
          perplAccountId: 7n,
          operatorMonBalanceWei: 1n,
          operatorKey: '0x0000000000000000000000000000000000dEaD',
          operatorExpiry: 9_999_999_999n,
        },
        true,
      ),
    ).toBe('operator-replaced')
  })

  it('shows session-expired when the operator grant has lapsed', () => {
    expect(
      deriveOnboardStep(
        {
          ...BASE,
          isDeployed: true,
          account: ACCOUNT,
          perplAccountId: 7n,
          operatorMonBalanceWei: 1n,
          operatorKey: OPERATOR,
          operatorExpiry: 1n,
        },
        true,
      ),
    ).toBe('session-expired')
  })

  it('shows ready once everything checks out', () => {
    expect(
      deriveOnboardStep(
        {
          ...BASE,
          isDeployed: true,
          account: ACCOUNT,
          perplAccountId: 7n,
          operatorMonBalanceWei: 1n,
          operatorKey: OPERATOR,
          operatorExpiry: 9_999_999_999n,
        },
        true,
      ),
    ).toBe('ready')
  })
})

describe('useAccountState', () => {
  beforeEach(() => {
    chain.multicall.mockReset()
    chain.readContract.mockReset()
    chain.readContract.mockImplementation(
      ({ functionName }: { functionName: string }) => {
        const results: Record<string, unknown> = {
          // accountOf is a CREATE2 prediction: non-zero even before deployment.
          accountOf: ACCOUNT,
          eip712Domain: [
            '0x0f',
            'GaplessFactory',
            '1',
            143n,
            ACCOUNT,
            ZERO,
            [],
          ],
          getMinAccountOpenCNS: 10_000_000n,
          isAccount: chain.isAccount,
          balanceOf: 0n,
        }
        return Promise.resolve(results[functionName])
      },
    )
  })

  function renderAccountState() {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })
    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(QueryClientProvider, { client }, children)
    return renderHook(() => useAccountState(OWNER, OPERATOR), { wrapper })
  }

  it('treats a predicted but undeployed account as not deployed and skips clone reads', async () => {
    chain.isAccount = false
    const { result } = renderAccountState()
    await waitFor(() => expect(result.current.isSuccess).toBe(true))

    expect(result.current.data?.account).toBe(ACCOUNT)
    expect(result.current.data?.isDeployed).toBe(false)
    expect(chain.multicall).not.toHaveBeenCalled()
  })

  it('reads the clone once the factory reports it as an account', async () => {
    chain.isAccount = true
    chain.multicall.mockResolvedValue([
      7n,
      { key: OPERATOR, expiry: 9_999_999_999n },
    ])
    const { result } = renderAccountState()
    await waitFor(() => expect(result.current.isSuccess).toBe(true))

    expect(result.current.data?.isDeployed).toBe(true)
    expect(result.current.data?.perplAccountId).toBe(7n)
    expect(result.current.data?.operatorKey).toBe(OPERATOR)
  })
})
