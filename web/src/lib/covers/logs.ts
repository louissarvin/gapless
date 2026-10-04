import type { Hex } from 'viem'
import { ICoverManagerAbi } from '@/abi/ICoverManager'
import { ADDRESSES } from '@/config/addresses.143'
import { publicClient } from '@/lib/chain'

/**
 * ADR-W7: tx hashes for a cover's own lifecycle events come from single-block
 * `eth_getLogs`, at the block the cover's own struct already recorded
 * (`startBlock`, `armedBlock`, `triggerBlock`), filtered by the manager
 * address and `topic1 = coverId`. `rpc.monad.xyz` caps `eth_getLogs` at 100
 * blocks, so every call here is exactly one block.
 */

export interface CoverTxRef {
  txHash: Hex
  blockNumber: bigint
}

export async function getCoverBoughtLog(
  coverId: Hex,
  startBlock: number,
): Promise<CoverTxRef | null> {
  if (startBlock === 0) return null
  const logs = await publicClient.getContractEvents({
    address: ADDRESSES.CoverManager,
    abi: ICoverManagerAbi,
    eventName: 'CoverBought',
    args: { coverId },
    fromBlock: BigInt(startBlock),
    toBlock: BigInt(startBlock),
    strict: true,
  })
  const log = logs.at(0)
  return log
    ? { txHash: log.transactionHash, blockNumber: log.blockNumber }
    : null
}

export async function getArmedLog(
  coverId: Hex,
  armedBlock: number,
): Promise<CoverTxRef | null> {
  if (armedBlock === 0) return null
  const logs = await publicClient.getContractEvents({
    address: ADDRESSES.CoverManager,
    abi: ICoverManagerAbi,
    eventName: 'Armed',
    args: { coverId },
    fromBlock: BigInt(armedBlock),
    toBlock: BigInt(armedBlock),
    strict: true,
  })
  const log = logs.at(0)
  return log
    ? { txHash: log.transactionHash, blockNumber: log.blockNumber }
    : null
}

export interface TriggeredLog extends CoverTxRef {
  filledLots: bigint
  paidNowCNS: bigint
  owedCNS: bigint
}

export async function getTriggeredLog(
  coverId: Hex,
  triggerBlock: number,
): Promise<TriggeredLog | null> {
  if (triggerBlock === 0) return null
  const logs = await publicClient.getContractEvents({
    address: ADDRESSES.CoverManager,
    abi: ICoverManagerAbi,
    eventName: 'Triggered',
    args: { coverId },
    fromBlock: BigInt(triggerBlock),
    toBlock: BigInt(triggerBlock),
    strict: true,
  })
  const log = logs.at(0)
  if (!log) return null
  return {
    txHash: log.transactionHash,
    blockNumber: log.blockNumber,
    filledLots: log.args.filledLots,
    paidNowCNS: log.args.paidNowCNS,
    owedCNS: log.args.owedCNS,
  }
}

const FALLBACK_WINDOW_BLOCKS = 100
const FALLBACK_MAX_WINDOWS = 10

/**
 * ADR-W7 fallback: `Finalized` has no block recorded on the `Cover` struct.
 * Bounded forward scan from `triggerBlock` in 100-block windows (the public
 * RPC's `eth_getLogs` cap), at most 10 windows (1,000 blocks, about 5 min of
 * Monad's ~300ms block time) before giving up and relying on the keeper
 * console cross-reference instead.
 */
export async function findFinalizedLogByScan(
  coverId: Hex,
  triggerBlock: number,
  latestBlock: bigint,
): Promise<CoverTxRef | null> {
  if (triggerBlock === 0) return null
  let from = BigInt(triggerBlock)
  for (let i = 0; i < FALLBACK_MAX_WINDOWS && from <= latestBlock; i++) {
    const to = from + BigInt(FALLBACK_WINDOW_BLOCKS - 1)
    const logs = await publicClient.getContractEvents({
      address: ADDRESSES.CoverManager,
      abi: ICoverManagerAbi,
      eventName: 'Finalized',
      args: { coverId },
      fromBlock: from,
      toBlock: to > latestBlock ? latestBlock : to,
      strict: true,
    })
    const log = logs.at(0)
    if (log)
      return { txHash: log.transactionHash, blockNumber: log.blockNumber }
    from = to + 1n
  }
  return null
}
