import { useQuery } from '@tanstack/react-query'
import type { Address, Hex } from 'viem'
import { ICoverManagerAbi } from '@/abi/ICoverManager'
import { ADDRESSES } from '@/config/addresses.143'
import { publicClient } from '@/lib/chain'

/** `CoverStatus` enum (`contract/src/types/GaplessTypes.sol`). */
export const COVER_STATUS = {
  None: 0,
  Live: 1,
  Armed: 2,
  Triggered: 3,
  Finalized: 4,
  Cancelled: 5,
  Expired: 6,
  Voided: 7,
} as const

const NON_TERMINAL = new Set<number>([
  COVER_STATUS.Live,
  COVER_STATUS.Armed,
  COVER_STATUS.Triggered,
])

export interface CoverChainState {
  account: Address
  perpId: number
  status: number
  isLong: boolean
  maxGapBps: number
  observed: boolean
  lots: number
  filledLots: number
  stopPNS: number
  startBlock: number
  expiryBlock: number
  armedBlock: number
  capCNS: bigint
  escrowCNS: bigint
  rentCNS: bigint
  triggerBlock: number
  refTrigPNS: number
  refPostPNS: number
  paidCNS: bigint
  owedCNS: bigint
  gRealCumCNS: bigint
  refundOwedCNS: bigint
  finalizedBlock: bigint
}

/**
 * ARCHITECTURE 5.3: `getCover` every 1s while non-terminal (Live, Armed,
 * Triggered), every 10s once terminal. `refundOwed` and the finalized block
 * tag ride along in the same poll so the "finalizing" to "final" switch and
 * the claim banner never need a second query.
 */
export function useCoverChainState(coverId: Hex) {
  return useQuery({
    queryKey: ['coverChainState', coverId],
    refetchInterval: (query) => {
      const status = query.state.data?.status
      return status !== undefined && !NON_TERMINAL.has(status) ? 10_000 : 1_000
    },
    queryFn: async (): Promise<CoverChainState> => {
      const cover = await publicClient.readContract({
        address: ADDRESSES.CoverManager,
        abi: ICoverManagerAbi,
        functionName: 'getCover',
        args: [coverId],
      })

      const [refundOwedCNS, finalizedBlock] = await Promise.all([
        publicClient.readContract({
          address: ADDRESSES.CoverManager,
          abi: ICoverManagerAbi,
          functionName: 'refundOwed',
          args: [cover.account],
        }),
        publicClient.getBlock({ blockTag: 'finalized' }).then((b) => b.number),
      ])

      return {
        account: cover.account,
        perpId: cover.perpId,
        status: cover.status,
        isLong: cover.isLong,
        maxGapBps: cover.maxGapBps,
        observed: cover.observed,
        lots: cover.lots,
        filledLots: cover.filledLots,
        stopPNS: cover.stopPNS,
        startBlock: cover.startBlock,
        expiryBlock: cover.expiryBlock,
        armedBlock: cover.armedBlock,
        capCNS: cover.capCNS,
        escrowCNS: cover.escrowCNS,
        rentCNS: cover.rentCNS,
        triggerBlock: cover.triggerBlock,
        refTrigPNS: cover.refTrigPNS,
        refPostPNS: cover.refPostPNS,
        paidCNS: cover.paidCNS,
        owedCNS: cover.owedCNS,
        gRealCumCNS: cover.gRealCumCNS,
        refundOwedCNS,
        finalizedBlock,
      }
    },
  })
}

export interface MarketCountdownParams {
  armTtlBlocks: number
  windowBlocks: number
}

/** `marketParams(perpId)`'s `armTtlBlocks` and `windowBlocks` (ARCHITECTURE 5.3 countdowns). Rarely changes. */
export function useCoverMarketParams(perpId: number) {
  return useQuery({
    queryKey: ['coverMarketParams', perpId],
    staleTime: 5 * 60_000,
    queryFn: async (): Promise<MarketCountdownParams> => {
      const params = await publicClient.readContract({
        address: ADDRESSES.CoverManager,
        abi: ICoverManagerAbi,
        functionName: 'marketParams',
        args: [BigInt(perpId)],
      })
      return {
        armTtlBlocks: params.armTtlBlocks,
        windowBlocks: params.windowBlocks,
      }
    },
  })
}
