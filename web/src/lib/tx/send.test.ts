import { encodeEventTopics } from 'viem'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type * as Viem from 'viem'
import type { Log, TransactionReceipt } from 'viem'
import type * as ChainModule from '@/lib/chain'
import type * as ScopedModule from '@/lib/account/scoped'
import { ICoverManagerAbi } from '@/abi/ICoverManager'
import { ADDRESSES } from '@/config/addresses.143'

const COVER_ID = `0x${'11'.repeat(32)}` as const
const OWNER = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as const
const OPERATOR = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' as const
const ACCOUNT = '0xcccccccccccccccccccccccccccccccccccccccc' as const

function coverBoughtLog(): Log {
  const topics = encodeEventTopics({
    abi: ICoverManagerAbi,
    eventName: 'CoverBought',
    args: { coverId: COVER_ID, account: OWNER, perpId: 1n },
  })
  return {
    address: ADDRESSES.CoverManager,
    topics,
    data: `0x${'00'.repeat(32 * 8)}`,
    blockNumber: 1n,
    blockHash: `0x${'22'.repeat(32)}`,
    transactionHash: `0x${'33'.repeat(32)}`,
    transactionIndex: 0,
    logIndex: 0,
    removed: false,
  } as Log
}

function receiptWithLogs(logs: ReadonlyArray<Log>): TransactionReceipt {
  return {
    status: 'success',
    transactionHash: `0x${'33'.repeat(32)}`,
    logs,
  } as unknown as TransactionReceipt
}

// Fakes the one sync-send client (`sendClient` in send.ts): estimateGas and
// sendRawTransactionSync are the only two calls it makes.
const estimateGasMock = vi.fn()
const sendRawTransactionSyncMock = vi.fn()

vi.mock('viem', async (importOriginal) => {
  const actual = await importOriginal<typeof Viem>()
  return {
    ...actual,
    createPublicClient: () => ({
      estimateGas: estimateGasMock,
      sendRawTransactionSync: sendRawTransactionSyncMock,
    }),
  }
})

// Fakes the shared read-only client (`publicClient` from `@/lib/chain`):
// `accountOf`, the latest block, the operator's MON balance, its nonce, and
// (for the unresolved-send dedup path) the eventual receipt.
const readContractMock = vi.fn()
const getBlockMock = vi.fn()
const getBalanceMock = vi.fn()
const getTransactionCountMock = vi.fn()
const getTransactionReceiptMock = vi.fn()

vi.mock('@/lib/chain', async (importOriginal) => {
  const actual = await importOriginal<typeof ChainModule>()
  return {
    ...actual,
    publicClient: {
      readContract: readContractMock,
      getBlock: getBlockMock,
      getBalance: getBalanceMock,
      getTransactionCount: getTransactionCountMock,
      getTransactionReceipt: getTransactionReceiptMock,
    },
  }
})

vi.mock('@category-labs/mera/viem', () => ({
  toViemAccount: () => ({ address: OPERATOR }),
}))

const signTransactionMock = vi.fn()
vi.mock('@/lib/account/scoped', async (importOriginal) => {
  const actual = await importOriginal<typeof ScopedModule>()
  return {
    ...actual,
    OperatorScope: class {
      signTransaction = signTransactionMock
    },
  }
})

const { sendOperatorCall, coverIdFromReceipt, SendRefusedError } =
  await import('./send')

describe('coverIdFromReceipt', () => {
  it('decodes the coverId topic from a CoverBought log', () => {
    const receipt = receiptWithLogs([coverBoughtLog()])
    expect(coverIdFromReceipt(receipt)).toBe(COVER_ID)
  })

  it('returns null when the receipt bought no cover', () => {
    const receipt = receiptWithLogs([])
    expect(coverIdFromReceipt(receipt)).toBeNull()
  })
})

describe('SendRefusedError', () => {
  it('carries a message and the right name', () => {
    const err = new SendRefusedError('nope')
    expect(err.name).toBe('SendRefusedError')
    expect(err.message).toBe('nope')
  })
})

const SIGNED_TX =
  '0x02f8500182031180808252088080808080c080a04012522854168b27e5dc3d5839bab5e6b39e1a0ffd343901ce1622e3d64b48f1a04e00902ae0502c4728cbf12156290df99c3ed7de85b1dbfe20b5c36931733a33' as const

function wireHappyPathMocks() {
  readContractMock.mockResolvedValue(ACCOUNT)
  estimateGasMock.mockResolvedValue(21_000n)
  getBlockMock.mockResolvedValue({ baseFeePerGas: 1_000_000n })
  getBalanceMock.mockResolvedValue(10n ** 18n)
  getTransactionCountMock.mockResolvedValue(0)
  getTransactionReceiptMock.mockResolvedValue(null)
  signTransactionMock.mockResolvedValue(SIGNED_TX)
}

describe('sendOperatorCall', () => {
  afterEach(() => {
    vi.clearAllMocks()
  })

  it('happy path: estimates, signs, broadcasts, and reports done', async () => {
    wireHappyPathMocks()
    sendRawTransactionSyncMock.mockResolvedValue(receiptWithLogs([]))

    const statuses: Array<string> = []
    const result = await sendOperatorCall(
      { functionName: 'cancelCover', args: [`0x${'11'.repeat(32)}` as const] },
      {
        session: {} as never,
        owner: OWNER,
        account: ACCOUNT,
      },
      (s) => statuses.push(s.status),
    )

    expect(result.status).toBe('done')
    expect(statuses).toEqual(['simulating', 'sending', 'done'])
    expect(signTransactionMock).toHaveBeenCalledTimes(1)
    expect(sendRawTransactionSyncMock).toHaveBeenCalledTimes(1)
  })

  it('a slow/erroring RPC after broadcast never triggers a second signed send for the same operator', async () => {
    wireHappyPathMocks()
    // First send: broadcast "succeeds" (reaches the mempool) but the sync
    // reply times out before a receipt comes back (ADR-W12 scenario).
    sendRawTransactionSyncMock.mockRejectedValueOnce(new Error('timeout'))

    const first = await sendOperatorCall(
      { functionName: 'cancelCover', args: [`0x${'11'.repeat(32)}` as const] },
      { session: {} as never, owner: OWNER, account: ACCOUNT },
    )
    expect(first.status).toBe('unknown')
    expect(signTransactionMock).toHaveBeenCalledTimes(1)

    // Second send attempt for the same operator, before the receipt lands:
    // must not re-estimate, re-sign, or re-broadcast.
    getTransactionReceiptMock.mockResolvedValueOnce(null)
    const second = await sendOperatorCall(
      { functionName: 'cancelCover', args: [`0x${'11'.repeat(32)}` as const] },
      { session: {} as never, owner: OWNER, account: ACCOUNT },
    )
    expect(second.status).toBe('confirming')
    expect(signTransactionMock).toHaveBeenCalledTimes(1)
    expect(sendRawTransactionSyncMock).toHaveBeenCalledTimes(1)

    // Once the outstanding hash resolves, the dedup guard clears and a
    // genuinely new send is free to go out (a fresh signed transaction, not
    // a re-send of the one that just resolved).
    getTransactionReceiptMock.mockResolvedValueOnce(receiptWithLogs([]))
    sendRawTransactionSyncMock.mockResolvedValueOnce(receiptWithLogs([]))
    const third = await sendOperatorCall(
      { functionName: 'cancelCover', args: [`0x${'11'.repeat(32)}` as const] },
      { session: {} as never, owner: OWNER, account: ACCOUNT },
    )
    expect(third.status).toBe('done')
    expect(signTransactionMock).toHaveBeenCalledTimes(2)
    expect(sendRawTransactionSyncMock).toHaveBeenCalledTimes(2)
  })

  it('throws SendAbortedError when the signal is already aborted before signing', async () => {
    wireHappyPathMocks()
    const controller = new AbortController()
    controller.abort()

    await expect(
      sendOperatorCall(
        { functionName: 'cancelCover', args: [`0x${'11'.repeat(32)}` as const] },
        { session: {} as never, owner: OWNER, account: ACCOUNT },
        undefined,
        controller.signal,
      ),
    ).rejects.toThrow('aborted before signing')
    expect(signTransactionMock).not.toHaveBeenCalled()
  })
})
