// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import type { AccountChainState } from '@/hooks/useAccountState'
import type { HomeChainState } from '@/hooks/useHomeChainState'
import type * as ReactRouter from '@tanstack/react-router'
import type * as UseAccountStateModule from '@/hooks/useAccountState'
import type * as UseHomeChainStateModule from '@/hooks/useHomeChainState'
import { ZERO_COVER_ID } from '@/hooks/useHomeChainState'

const OWNER = '0xe05fcC23807536bEe418f142D19fa0d21BB0cfF7' as const
const OPERATOR = '0x1111111111111111111111111111111111111A' as const
const ACCOUNT = '0xab3CB7b3b28366eD7f6C59DbD2D708890919B289' as const
const COVER_ID =
  '0xaaaa000000000000000000000000000000000000000000000000000000000001' as const

const READY_STATE: AccountChainState = {
  owner: OWNER,
  operator: OPERATOR,
  account: ACCOUNT,
  isDeployed: true,
  factoryDomain: {
    name: 'GaplessFactory',
    version: '1',
    chainId: 143,
    verifyingContract: ACCOUNT,
  },
  ausdBalanceCNS: 10_000_000n,
  minOpenCNS: 10_000_000n,
  perplAccountId: 7n,
  operatorKey: OPERATOR,
  operatorExpiry: 9_999_999_999n,
  operatorMonBalanceWei: 1n,
  nowS: 1_700_000_000,
}

const HOME_STATE: HomeChainState = {
  walletAusdCNS: 10_000_000n,
  perplFreeCNS: 5_000_000n,
  perplLockedCNS: 0n,
  positionDepositCNS: 2_000_000n,
  positionLotLNS: 0n,
  positionPricePNS: 0n,
  positionPnlCNS: 0n,
  activeCoverId: COVER_ID,
  operatorGrant: {
    key: OPERATOR,
    expiry: BigInt(1_700_000_000 + 3 * 3600),
    maxNotionalPerTradeCNS: 25_000_000n,
    maxNotionalPerDayCNS: 100_000_000n,
  },
  operatorUsedCNS: 10_000_000n,
  operatorAvailableCNS: 90_000_000n,
  operatorMonBalanceWei: 1n,
}

vi.mock('@category-labs/mera/viem', () => ({
  toViemAccount: (session: { address: string }) => ({
    address: session.address,
  }),
}))

vi.mock('@tanstack/react-router', async (importOriginal) => {
  const actual = await importOriginal<typeof ReactRouter>()
  return {
    ...actual,
    useNavigate: () => vi.fn(),
    Link: ({
      children,
      to,
      params,
      ...rest
    }: {
      children: ReactNode
      to: string
      params?: Record<string, string>
    }) => (
      <a href={`${to}${params ? `:${JSON.stringify(params)}` : ''}`} {...rest}>
        {children}
      </a>
    ),
  }
})

const useAccountSessionMock = vi.fn()
vi.mock('@/hooks/useAccountSession', () => ({
  useAccountSession: () => useAccountSessionMock(),
}))

const useAccountStateMock = vi.fn()
vi.mock('@/hooks/useAccountState', async (importOriginal) => {
  const actual = await importOriginal<typeof UseAccountStateModule>()
  return {
    ...actual,
    useAccountState: () => useAccountStateMock(),
  }
})

const useHomeChainStateMock = vi.fn()
vi.mock('@/hooks/useHomeChainState', async (importOriginal) => {
  const actual = await importOriginal<typeof UseHomeChainStateModule>()
  return {
    ...actual,
    useHomeChainState: () => useHomeChainStateMock(),
  }
})

const { HomePage } = await import('./home')

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('/home', () => {
  it('shows the unlock card when there is no session', () => {
    useAccountSessionMock.mockReturnValue({
      ownerSession: null,
      operatorSession: null,
    })
    useAccountStateMock.mockReturnValue({ data: undefined })
    useHomeChainStateMock.mockReturnValue({ data: undefined })

    render(<HomePage />)

    expect(screen.getByText('Unlock Gapless')).toBeInTheDocument()
    expect(screen.queryByText('Finish setting up')).not.toBeInTheDocument()
  })

  it('shows the continue-setup card when the account is not ready', () => {
    useAccountSessionMock.mockReturnValue({
      ownerSession: { address: OWNER },
      operatorSession: { address: OPERATOR },
    })
    useAccountStateMock.mockReturnValue({
      data: { ...READY_STATE, isDeployed: false },
    })
    useHomeChainStateMock.mockReturnValue({ data: undefined })

    render(<HomePage />)

    expect(screen.getByText('Finish setting up')).toBeInTheDocument()
  })

  it('names the agent once it holds the operator grant (ARCHITECTURE 7.2 step 7)', () => {
    const AGENT = '0xa5cc3c03994DB5b0d9A5eEdD10CabaB0813678AC'
    useAccountSessionMock.mockReturnValue({
      ownerSession: { address: OWNER },
      operatorSession: { address: OPERATOR },
    })
    useAccountStateMock.mockReturnValue({
      data: { ...READY_STATE, operatorKey: AGENT },
    })
    useHomeChainStateMock.mockReturnValue({ data: undefined })

    render(<HomePage />)

    expect(screen.getByText('Trading key: agent')).toBeInTheDocument()
    expect(screen.getByText('0xa5cc3c…78AC')).toBeInTheDocument()
    expect(screen.queryByText('Finish setting up')).not.toBeInTheDocument()
  })

  it('renders the balance, active cover and session cards once ready', () => {
    useAccountSessionMock.mockReturnValue({
      ownerSession: { address: OWNER },
      operatorSession: { address: OPERATOR },
    })
    useAccountStateMock.mockReturnValue({ data: READY_STATE })
    useHomeChainStateMock.mockReturnValue({ data: HOME_STATE })

    render(<HomePage />)

    // Balance card: 10 + 5 + 2 = 17 AUSD total (ARCHITECTURE 5.4 formula).
    expect(screen.getByText('17.00 AUSD')).toBeInTheDocument()
    // Active cover card links out since activeCoverId is non-zero.
    expect(screen.getByText('Active cover')).toBeInTheDocument()
    // Session card.
    expect(screen.getByText('about 3 h')).toBeInTheDocument()
    expect(screen.getByText('25.00 AUSD')).toBeInTheDocument()
    expect(screen.getByText('90.00 AUSD')).toBeInTheDocument()
    // Operator has MON, so no fund banner.
    expect(screen.queryByText('Fund your trading key')).not.toBeInTheDocument()
  })

  it('shows the fund-MON banner when the operator has no gas', () => {
    useAccountSessionMock.mockReturnValue({
      ownerSession: { address: OWNER },
      operatorSession: { address: OPERATOR },
    })
    useAccountStateMock.mockReturnValue({ data: READY_STATE })
    useHomeChainStateMock.mockReturnValue({
      data: { ...HOME_STATE, operatorMonBalanceWei: 0n },
    })

    render(<HomePage />)

    expect(screen.getByText('Fund your trading key')).toBeInTheDocument()
  })

  it('shows an error card instead of hanging on loading when the account read fails', () => {
    useAccountSessionMock.mockReturnValue({
      ownerSession: { address: OWNER },
      operatorSession: { address: OPERATOR },
    })
    useAccountStateMock.mockReturnValue({
      data: undefined,
      error: null,
      failureReason: new Error('ContractFunctionExecutionError: boom'),
      errorUpdateCount: 1,
    })
    useHomeChainStateMock.mockReturnValue({ data: undefined })

    render(<HomePage />)

    expect(screen.getByText('Something went wrong')).toBeInTheDocument()
    expect(screen.queryByText('Loading your account…')).not.toBeInTheDocument()
  })

  it('shows an error card instead of hanging when the home chain read fails', () => {
    useAccountSessionMock.mockReturnValue({
      ownerSession: { address: OWNER },
      operatorSession: { address: OPERATOR },
    })
    useAccountStateMock.mockReturnValue({
      data: READY_STATE,
      error: null,
      failureReason: null,
      errorUpdateCount: 0,
    })
    useHomeChainStateMock.mockReturnValue({
      data: undefined,
      error: null,
      failureReason: new Error('ContractFunctionExecutionError: boom'),
      errorUpdateCount: 1,
    })

    render(<HomePage />)

    expect(screen.getByText('Something went wrong')).toBeInTheDocument()
    expect(screen.queryByText('Active cover')).not.toBeInTheDocument()
  })

  it('shows the empty cover state when there is no active cover', () => {
    useAccountSessionMock.mockReturnValue({
      ownerSession: { address: OWNER },
      operatorSession: { address: OPERATOR },
    })
    useAccountStateMock.mockReturnValue({ data: READY_STATE })
    useHomeChainStateMock.mockReturnValue({
      data: { ...HOME_STATE, activeCoverId: ZERO_COVER_ID },
    })

    render(<HomePage />)

    expect(screen.getByText('No active cover')).toBeInTheDocument()
  })
})
