// @vitest-environment jsdom
import { createSecp256k1SigningSession } from '@category-labs/mera'
import { toViemAccount } from '@category-labs/mera/viem'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import type * as ReactRouter from '@tanstack/react-router'
import type * as UseAccountStateModule from '@/hooks/useAccountState'
import type * as UseVaultChainStateModule from '@/hooks/useVaultChainState'
import type * as ChainModule from '@/lib/chain'
import type * as SendModule from '@/lib/tx/send'
import { accountSession } from '@/lib/account/session'

const OWNER_KEY =
  '0x00000000000000000000000000000000000000000000000000000000000a11ce' as const
const OPERATOR_KEY =
  '0x7efce7832709767241439ade3913e4ff50c77e498c2ad111817fd56ed14cad5a' as const

const OWNER = '0xe05fcC23807536bEe418f142D19fa0d21BB0cfF7' as const
const ACCOUNT = '0xab3CB7b3b28366eD7f6C59DbD2D708890919B289' as const

function sessionFromKey(key: `0x${string}`) {
  const bytes = Uint8Array.from(Buffer.from(key.slice(2), 'hex'))
  return createSecp256k1SigningSession({ privateKey: bytes })
}

const OPERATOR = toViemAccount(sessionFromKey(OPERATOR_KEY)).address

const VAULT_STATE = {
  blockNumber: 1_000n,
  totalAssetsCNS: 1_000_000_000n,
  totalSupply: 1_000_000_000n,
  shareDecimals: 6,
  reservedTotalCNS: 0n,
  reservedBtcCNS: 0n,
  freeAssetsCNS: 1_000_000_000n,
  utilizationBps: 0n,
  owedTotalCNS: 0n,
  paused: false,
  treasury: ACCOUNT,
  maxUtilizationBps: 8_000,
  protocolFeeBps: 0,
  minDepositCNS: 10_000_000n,
  cooldownBlocks: 100n,
  depositLockBlocks: 100n,
  blockPayoutCapCNS: 0n,
  maxGapBpsCap: 500,
  perBlockPayoutCapBps: 100,
  maxCoverNotionalCNS: 0n,
  liveCoverCount: 0n,
  sharePriceCNS: 1_000_000n,
}

const POSITION_STATE = {
  sharesBalance: 0n,
  lockUntilBlock: 0n,
  ausdBalanceCNS: 1_000_000_000n,
  ausdAllowanceCNS: 0n,
  valueCNS: 0n,
  requests: [],
}

vi.mock('@tanstack/react-router', async (importOriginal) => {
  const actual = await importOriginal<typeof ReactRouter>()
  return {
    ...actual,
    useNavigate: () => vi.fn(),
    Link: ({ children, to, ...rest }: { children: ReactNode; to: string }) => (
      <a href={to} {...rest}>
        {children}
      </a>
    ),
  }
})

const useAccountStateMock = vi.fn()
vi.mock('@/hooks/useAccountState', async (importOriginal) => {
  const actual = await importOriginal<typeof UseAccountStateModule>()
  return { ...actual, useAccountState: () => useAccountStateMock() }
})

const useVaultChainStateMock = vi.fn()
const useVaultPositionMock = vi.fn()
vi.mock('@/hooks/useVaultChainState', async (importOriginal) => {
  const actual = await importOriginal<typeof UseVaultChainStateModule>()
  return {
    ...actual,
    useVaultChainState: () => useVaultChainStateMock(),
    useVaultPosition: () => useVaultPositionMock(),
  }
})

vi.mock('@/lib/api/relay', () => ({
  getStats: () => Promise.resolve({ gapless: { vault: {}, premiums: {} } }),
}))

const readContractMock = vi.fn()
vi.mock('@/lib/chain', async (importOriginal) => {
  const actual = await importOriginal<typeof ChainModule>()
  return {
    ...actual,
    publicClient: { readContract: readContractMock },
  }
})

const sendOperatorCallMock = vi.fn()
const estimateOperatorCallMock = vi.fn()
vi.mock('@/lib/tx/send', async (importOriginal) => {
  const actual = await importOriginal<typeof SendModule>()
  return {
    ...actual,
    sendOperatorCall: (...args: Array<unknown>) =>
      sendOperatorCallMock(...args),
    estimateOperatorCall: (...args: Array<unknown>) =>
      estimateOperatorCallMock(...args),
  }
})

const { Route } = await import('./vault')
const VaultPage = Route.options.component as () => React.ReactElement

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  accountSession.endOwnerSession()
  accountSession.endOperatorSession()
})

describe('/vault deposit double-tap guard (M-2)', () => {
  it('a second Confirm press while the first deposit is still simulating sends only once', async () => {
    accountSession.setOwnerSession(sessionFromKey(OWNER_KEY))
    accountSession.setOperatorSession(sessionFromKey(OPERATOR_KEY))
    useAccountStateMock.mockReturnValue({
      data: { account: ACCOUNT, operator: OPERATOR, owner: OWNER },
    })
    useVaultChainStateMock.mockReturnValue({
      data: VAULT_STATE,
      refetch: vi.fn(),
    })
    useVaultPositionMock.mockReturnValue({
      data: POSITION_STATE,
      refetch: vi.fn(),
    })
    readContractMock.mockResolvedValue(50_000_000n) // previewDeposit sharesOut
    estimateOperatorCallMock.mockResolvedValue({
      gas: 21_000n,
      maxFeePerGas: 1n,
      maxPriorityFeePerGas: 1n,
      operatorBalanceWei: 10n ** 18n,
      maxCostWei: 21_000n,
    })
    // Never resolves within this test: holds the sheet in "simulating" so a
    // second tap on Confirm races the first send still in flight.
    const deferred: { resolve: (() => void) | null } = { resolve: null }
    sendOperatorCallMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          deferred.resolve = () =>
            resolve({ status: 'done', receipt: { status: 'success', logs: [] } })
        }),
    )

    const queryClient = new QueryClient()
    render(
      <QueryClientProvider client={queryClient}>
        <VaultPage />
      </QueryClientProvider>,
    )

    fireEvent.change(screen.getByPlaceholderText('0'), {
      target: { value: '100' },
    })
    fireEvent.click(await screen.findByText('Preview deposit'))
    fireEvent.click(await screen.findByText('Review deposit'))

    const confirmButton = await screen.findByRole('button', {
      name: 'Deposit',
    })
    // 600ms accidental-tap guard in ConfirmSheet.
    await new Promise((resolve) => setTimeout(resolve, 650))
    fireEvent.click(confirmButton)
    fireEvent.click(confirmButton)
    fireEvent.click(confirmButton)

    expect(sendOperatorCallMock).toHaveBeenCalledTimes(1)
    deferred.resolve?.()
  })
})
