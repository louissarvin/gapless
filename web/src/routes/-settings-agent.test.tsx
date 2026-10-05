// @vitest-environment jsdom
import { createSecp256k1SigningSession } from '@category-labs/mera'
import { toViemAccount } from '@category-labs/mera/viem'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import type * as ReactRouter from '@tanstack/react-router'
import type { AccountChainState } from '@/hooks/useAccountState'
import type * as UseAccountStateModule from '@/hooks/useAccountState'
import type * as UseAgentGrantStateModule from '@/hooks/useAgentGrantState'
import { accountSession } from '@/lib/account/session'

const OWNER_KEY =
  '0x00000000000000000000000000000000000000000000000000000000000a11ce' as const
const OPERATOR_KEY =
  '0x7efce7832709767241439ade3913e4ff50c77e498c2ad111817fd56ed14cad5a' as const

const OWNER = '0xe05fcC23807536bEe418f142D19fa0d21BB0cfF7' as const
const ACCOUNT = '0xab3CB7b3b28366eD7f6C59DbD2D708890919B289' as const
const AGENT = '0xa5cc3c03994DB5b0d9A5eEdD10CabaB0813678AC' as const

function sessionFromKey(key: `0x${string}`) {
  const bytes = Uint8Array.from(Buffer.from(key.slice(2), 'hex'))
  return createSecp256k1SigningSession({ privateKey: bytes })
}

// This device's real operator address, derived the same way the app does
// (`toViemAccount(session).address`), so the "This phone" vs "Agent" label
// in `CurrentOperatorCard` is exercised against a real address match.
const THIS_DEVICE_OPERATOR = toViemAccount(sessionFromKey(OPERATOR_KEY)).address

const READY_STATE: AccountChainState = {
  owner: OWNER,
  operator: THIS_DEVICE_OPERATOR,
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
  operatorKey: THIS_DEVICE_OPERATOR,
  operatorExpiry: 9_999_999_999n,
  operatorMonBalanceWei: 1n,
  nowS: 1_700_000_000,
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

const useAgentGrantStateMock = vi.fn()
const readSetOperatorSigningContextMock = vi.fn()
vi.mock('@/hooks/useAgentGrantState', async (importOriginal) => {
  const actual = await importOriginal<typeof UseAgentGrantStateModule>()
  return {
    ...actual,
    useAgentGrantState: () => useAgentGrantStateMock(),
    readSetOperatorSigningContext: (...args: Array<unknown>) =>
      readSetOperatorSigningContextMock(...args),
  }
})

const unlockAccountKeysMock = vi.fn()
vi.mock('@/lib/account/keys', () => ({
  unlockAccountKeys: (...args: Array<unknown>) =>
    unlockAccountKeysMock(...args),
}))

vi.mock('@/lib/account/credentialHint', () => ({
  loadCredentialHint: () => undefined,
}))

const sendOperatorCallMock = vi.fn()
vi.mock('@/lib/tx/send', () => ({
  sendOperatorCall: (...args: Array<unknown>) => sendOperatorCallMock(...args),
}))

const { Route } = await import('./settings/agent')
const AgentPage = Route.options.component as () => React.ReactElement

function freshCeremonyResult() {
  return {
    ownerSession: sessionFromKey(OWNER_KEY),
    operatorSession: sessionFromKey(OPERATOR_KEY),
  }
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  accountSession.endOwnerSession()
  accountSession.endOperatorSession()
})

describe('/settings/agent', () => {
  it('shows the unlock card when there is no session', () => {
    useAccountStateMock.mockReturnValue({ data: undefined })
    useAgentGrantStateMock.mockReturnValue({ data: undefined })

    render(<AgentPage />)

    expect(screen.getByText('Unlock Gapless')).toBeInTheDocument()
  })

  it('shows the not-ready card when the account is not deployed/activated', () => {
    accountSession.setOwnerSession(sessionFromKey(OWNER_KEY))
    accountSession.setOperatorSession(sessionFromKey(OPERATOR_KEY))
    useAccountStateMock.mockReturnValue({
      data: { ...READY_STATE, isDeployed: false, perplAccountId: 0n },
    })
    useAgentGrantStateMock.mockReturnValue({ data: undefined })

    render(<AgentPage />)

    expect(screen.getByText('Finish setting up first')).toBeInTheDocument()
  })

  it('shows the current operator as "This phone" when the operator key matches this device', () => {
    const operatorSession = sessionFromKey(OPERATOR_KEY)
    accountSession.setOwnerSession(sessionFromKey(OWNER_KEY))
    accountSession.setOperatorSession(operatorSession)
    useAccountStateMock.mockReturnValue({ data: READY_STATE })
    useAgentGrantStateMock.mockReturnValue({
      data: {
        operatorKey: READY_STATE.operator,
        operatorExpiry: 9_999_999_999n,
        operatorMaxPerTradeCNS: 25_000_000n,
        operatorMaxPerDayCNS: 100_000_000n,
        operatorUsedCNS: 0n,
        operatorAvailableCNS: 100_000_000n,
        nowS: READY_STATE.nowS,
      },
      refetch: vi.fn(),
    })

    render(<AgentPage />)

    expect(screen.getByText('This phone')).toBeInTheDocument()
    expect(screen.getByText('Grant a trading agent')).toBeInTheDocument()
    expect(screen.getByText('Re-grant this device')).toBeInTheDocument()
  })

  it('shows the current operator as "Agent" once it differs from this device', () => {
    accountSession.setOwnerSession(sessionFromKey(OWNER_KEY))
    accountSession.setOperatorSession(sessionFromKey(OPERATOR_KEY))
    useAccountStateMock.mockReturnValue({ data: READY_STATE })
    useAgentGrantStateMock.mockReturnValue({
      data: {
        operatorKey: AGENT,
        operatorExpiry: 9_999_999_999n,
        operatorMaxPerTradeCNS: 25_000_000n,
        operatorMaxPerDayCNS: 100_000_000n,
        operatorUsedCNS: 0n,
        operatorAvailableCNS: 100_000_000n,
        nowS: READY_STATE.nowS,
      },
      refetch: vi.fn(),
    })

    render(<AgentPage />)

    expect(screen.getByText('Agent')).toBeInTheDocument()
  })

  it('validates the pasted agent address inline before letting the user continue', () => {
    accountSession.setOwnerSession(sessionFromKey(OWNER_KEY))
    accountSession.setOperatorSession(sessionFromKey(OPERATOR_KEY))
    useAccountStateMock.mockReturnValue({ data: READY_STATE })
    useAgentGrantStateMock.mockReturnValue({
      data: {
        operatorKey: READY_STATE.operator,
        operatorExpiry: 9_999_999_999n,
        operatorMaxPerTradeCNS: 25_000_000n,
        operatorMaxPerDayCNS: 100_000_000n,
        operatorUsedCNS: 0n,
        operatorAvailableCNS: 100_000_000n,
        nowS: READY_STATE.nowS,
      },
      refetch: vi.fn(),
    })

    render(<AgentPage />)
    fireEvent.click(screen.getByText('Grant a trading agent'))

    const input = screen.getByPlaceholderText('0x…')
    fireEvent.change(input, { target: { value: OWNER } })
    expect(
      screen.getByText('This cannot be your owner address.'),
    ).toBeInTheDocument()
    expect(screen.getByText('Continue')).toBeDisabled()

    fireEvent.change(input, { target: { value: AGENT } })
    expect(
      screen.queryByText('This cannot be your owner address.'),
    ).not.toBeInTheDocument()
    expect(screen.getByText('Continue')).not.toBeDisabled()
  })

  it('signs a grant and shows the mm gapless link command with real values', async () => {
    accountSession.setOwnerSession(sessionFromKey(OWNER_KEY))
    accountSession.setOperatorSession(sessionFromKey(OPERATOR_KEY))
    useAccountStateMock.mockReturnValue({ data: READY_STATE })
    useAgentGrantStateMock.mockReturnValue({
      data: {
        operatorKey: READY_STATE.operator,
        operatorExpiry: 9_999_999_999n,
        operatorMaxPerTradeCNS: 25_000_000n,
        operatorMaxPerDayCNS: 100_000_000n,
        operatorUsedCNS: 0n,
        operatorAvailableCNS: 100_000_000n,
        nowS: 1_700_000_000,
      },
      refetch: vi.fn(),
    })
    readSetOperatorSigningContextMock.mockResolvedValue({
      domain: {
        name: 'GaplessAccount',
        version: '1',
        chainId: 143,
        verifyingContract: ACCOUNT,
      },
      nonce: 3n,
    })
    unlockAccountKeysMock.mockImplementation(() =>
      Promise.resolve(freshCeremonyResult()),
    )

    render(<AgentPage />)
    fireEvent.click(screen.getByText('Grant a trading agent'))
    fireEvent.change(screen.getByPlaceholderText('0x…'), {
      target: { value: AGENT },
    })
    fireEvent.click(screen.getByText('Continue'))

    expect(
      screen.getByText((_, el) => el?.textContent === 'It can never withdraw.'),
    ).toBeInTheDocument()

    // Waits for the sheet's domain-check preview read to resolve (DESIGN
    // 9.2: the Confirm button stays in a "Checking…" busy state until then)
    // and for the 600ms accidental-tap guard before the real click.
    await screen.findByText('Sign with passkey')
    await new Promise((resolve) => setTimeout(resolve, 650))
    fireEvent.click(screen.getByText('Sign with passkey'))

    const commands = await screen.findAllByText(/mm gapless link/)
    const command = commands.find((el) => el.tagName === 'PRE')
    expect(command).toBeDefined()
    expect(command?.textContent).toContain(`--account ${ACCOUNT}`)
    expect(command?.textContent).toContain('--max-per-trade 25')
    expect(command?.textContent).toContain('--max-per-day 100')
    expect(command?.textContent).toMatch(/--sig 0x[0-9a-fA-F]{130}/)
  })

  it('re-grants this device by submitting setOperatorWithSig through sendOperatorCall', async () => {
    accountSession.setOwnerSession(sessionFromKey(OWNER_KEY))
    accountSession.setOperatorSession(sessionFromKey(OPERATOR_KEY))
    useAccountStateMock.mockReturnValue({ data: READY_STATE })
    useAgentGrantStateMock.mockReturnValue({
      data: {
        operatorKey: AGENT,
        operatorExpiry: 0n,
        operatorMaxPerTradeCNS: 25_000_000n,
        operatorMaxPerDayCNS: 100_000_000n,
        operatorUsedCNS: 0n,
        operatorAvailableCNS: 100_000_000n,
        nowS: 1_700_000_000,
      },
      refetch: vi.fn(),
    })
    readSetOperatorSigningContextMock.mockResolvedValue({
      domain: {
        name: 'GaplessAccount',
        version: '1',
        chainId: 143,
        verifyingContract: ACCOUNT,
      },
      nonce: 5n,
    })
    unlockAccountKeysMock.mockImplementation(() =>
      Promise.resolve(freshCeremonyResult()),
    )
    sendOperatorCallMock.mockResolvedValue({
      status: 'done',
      receipt: { status: 'success' },
    })

    render(<AgentPage />)
    fireEvent.click(screen.getByText('Re-grant this device'))
    await screen.findByText('Sign and submit')
    await new Promise((resolve) => setTimeout(resolve, 650))
    fireEvent.click(screen.getByText('Sign and submit'))

    await screen.findByText('This device is trading again')
    expect(sendOperatorCallMock).toHaveBeenCalledTimes(1)
    const [call] = sendOperatorCallMock.mock.calls[0] as [
      { functionName: string; args: ReadonlyArray<unknown> },
    ]
    expect(call.functionName).toBe('setOperatorWithSig')
  })
})
