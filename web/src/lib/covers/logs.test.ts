import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  findFinalizedLogByScan,
  getArmedLog,
  getCoverBoughtLog,
  getTriggeredLog,
} from './logs'

const chain = vi.hoisted(() => ({
  getContractEvents: vi.fn(),
}))

vi.mock('@/lib/chain', () => ({
  publicClient: { getContractEvents: chain.getContractEvents },
}))

const COVER_ID =
  '0xaaaa000000000000000000000000000000000000000000000000000000000001' as const
const TX =
  '0x1111111111111111111111111111111111111111111111111111111111111111' as const

beforeEach(() => {
  chain.getContractEvents.mockReset()
})

describe('getCoverBoughtLog / getArmedLog / getTriggeredLog', () => {
  it('returns null without calling the RPC when the block is 0 (event never happened)', async () => {
    expect(await getCoverBoughtLog(COVER_ID, 0)).toBeNull()
    expect(await getArmedLog(COVER_ID, 0)).toBeNull()
    expect(await getTriggeredLog(COVER_ID, 0)).toBeNull()
    expect(chain.getContractEvents).not.toHaveBeenCalled()
  })

  it('queries exactly one block, from and to the recorded block (ADR-W7)', async () => {
    chain.getContractEvents.mockResolvedValueOnce([])
    await getCoverBoughtLog(COVER_ID, 12_345)
    expect(chain.getContractEvents).toHaveBeenCalledWith(
      expect.objectContaining({ fromBlock: 12_345n, toBlock: 12_345n }),
    )
  })

  it('maps the first matching log to a tx ref', async () => {
    chain.getContractEvents.mockResolvedValueOnce([
      { transactionHash: TX, blockNumber: 500n },
    ])
    expect(await getArmedLog(COVER_ID, 500)).toEqual({
      txHash: TX,
      blockNumber: 500n,
    })
  })

  it('pulls filledLots/paidNowCNS/owedCNS off the Triggered log', async () => {
    chain.getContractEvents.mockResolvedValueOnce([
      {
        transactionHash: TX,
        blockNumber: 503n,
        args: {
          filledLots: 2_200_000n,
          paidNowCNS: 900_000n,
          owedCNS: 100_000n,
        },
      },
    ])
    expect(await getTriggeredLog(COVER_ID, 503)).toEqual({
      txHash: TX,
      blockNumber: 503n,
      filledLots: 2_200_000n,
      paidNowCNS: 900_000n,
      owedCNS: 100_000n,
    })
  })
})

describe('findFinalizedLogByScan: bounded forward scan', () => {
  it('returns null immediately when triggerBlock is 0', async () => {
    expect(await findFinalizedLogByScan(COVER_ID, 0, 1_000n)).toBeNull()
    expect(chain.getContractEvents).not.toHaveBeenCalled()
  })

  it('scans in 100-block windows starting at triggerBlock', async () => {
    chain.getContractEvents.mockResolvedValueOnce([])
    chain.getContractEvents.mockResolvedValueOnce([
      { transactionHash: TX, blockNumber: 250n },
    ])
    const result = await findFinalizedLogByScan(COVER_ID, 100, 10_000n)
    expect(result).toEqual({ txHash: TX, blockNumber: 250n })
    expect(chain.getContractEvents).toHaveBeenCalledTimes(2)
    expect(chain.getContractEvents).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ fromBlock: 100n, toBlock: 199n }),
    )
    expect(chain.getContractEvents).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ fromBlock: 200n, toBlock: 299n }),
    )
  })

  it('gives up after 10 windows (1,000 blocks) and returns null', async () => {
    chain.getContractEvents.mockResolvedValue([])
    const result = await findFinalizedLogByScan(COVER_ID, 100, 100_000n)
    expect(result).toBeNull()
    expect(chain.getContractEvents).toHaveBeenCalledTimes(10)
  })

  it('clamps the final window to latestBlock instead of scanning past the chain head', async () => {
    chain.getContractEvents.mockResolvedValueOnce([])
    const result = await findFinalizedLogByScan(COVER_ID, 100, 150n)
    expect(result).toBeNull()
    expect(chain.getContractEvents).toHaveBeenCalledWith(
      expect.objectContaining({ fromBlock: 100n, toBlock: 150n }),
    )
  })
})
