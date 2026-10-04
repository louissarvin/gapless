import { useQuery } from '@tanstack/react-query'
import type { Address, Hex } from 'viem'
import type { OperatorGrant } from '@/hooks/useHomeChainState'
import { ICoverManagerAbi } from '@/abi/ICoverManager'
import { IGaplessAccountAbi } from '@/abi/IGaplessAccount'
import { IPerplMinAbi } from '@/abi/IPerplMin'
import { ADDRESSES, LISTED_PERP_ID } from '@/config/addresses.143'
import { publicClient } from '@/lib/chain'

/** `marketConfig`/`marketParams` for BTC-PERP (ARCHITECTURE phase 2, 5.1 `marketStatic`). Rarely changes. */
export interface MarketStatic {
  priceDecimals: number
  lotDecimals: number
  scale: bigint
  maxGapBpsCap: number
  minStopDistanceBps: number
  warmupBlocks: number
  armTtlBlocks: number
  minDurationBlocks: number
  maxDurationBlocks: number
  sigmaMaxAgeBlocks: number
  minFeeCNS: bigint
  maxCoverNotionalCNS: bigint
}

export function useMarketStatic(perpId: number = LISTED_PERP_ID) {
  return useQuery({
    queryKey: ['marketStatic', perpId],
    staleTime: 5 * 60_000,
    queryFn: async (): Promise<MarketStatic> => {
      const [config, params] = await publicClient.multicall({
        contracts: [
          {
            address: ADDRESSES.CoverManager,
            abi: ICoverManagerAbi,
            functionName: 'marketConfig',
            args: [BigInt(perpId)],
          },
          {
            address: ADDRESSES.CoverManager,
            abi: ICoverManagerAbi,
            functionName: 'marketParams',
            args: [BigInt(perpId)],
          },
        ],
        allowFailure: false,
      })
      return {
        priceDecimals: config.priceDecimals,
        lotDecimals: config.lotDecimals,
        scale: config.scale,
        maxGapBpsCap: params.maxGapBpsCap,
        minStopDistanceBps: params.minStopDistanceBps,
        warmupBlocks: params.warmupBlocks,
        armTtlBlocks: params.armTtlBlocks,
        minDurationBlocks: params.minDurationBlocks,
        maxDurationBlocks: params.maxDurationBlocks,
        sigmaMaxAgeBlocks: params.sigmaMaxAgeBlocks,
        minFeeCNS: params.minFeeCNS,
        maxCoverNotionalCNS: params.maxCoverNotionalCNS,
      }
    },
  })
}

export interface TradePosition {
  lotLNS: bigint
  pricePNS: bigint
  /** 0 = long, 1 = short (`Constants.POSITION_LONG`/`POSITION_SHORT`). Meaningless when `lotLNS` is 0. */
  positionType: number
  depositCNS: bigint
  pnlCNS: bigint
}

export interface TradeChainState {
  blockNumber: bigint
  sigmaBlkBpsE2: number
  /** `uint48`; abitype decodes M <= 48 as `number`, not `bigint`. */
  sigmaPostedBlock: number
  buysPaused: boolean
  marketPaused: boolean
  exchangeHalted: boolean
  perpStatus: number
  markPNS: bigint
  lastPNS: bigint
  bestBidPNS: bigint
  bestAskPNS: bigint
  activeCoverId: Hex
  isLocked: boolean
  position: TradePosition
  operatorGrant: OperatorGrant
  operatorUsedCNS: bigint
  operatorAvailableCNS: bigint
  operatorMonBalanceWei: bigint
}

/**
 * ARCHITECTURE phase 2, 5.1 `tradeChain`: one multicall (plus `getBlock` and
 * `getBalance`) refreshed every second while the page is visible. Every
 * value the `/trade` form state machine and the Position card read.
 */
export function useTradeChainState(
  account: Address | null,
  operator: Address | null,
  perplAccountId: bigint | null,
) {
  return useQuery({
    queryKey: [
      'tradeChainState',
      account,
      operator,
      String(perplAccountId ?? ''),
    ],
    enabled: account !== null && operator !== null && perplAccountId !== null,
    refetchInterval: 1_000,
    queryFn: async (): Promise<TradeChainState> => {
      if (!account || !operator || perplAccountId === null) {
        throw new Error(
          'useTradeChainState: account, operator and perplAccountId required',
        )
      }

      try {
        const [
          sigma,
          buysPaused,
          marketPaused,
          activeCoverId,
          locked,
          perpInfo,
          halted,
          positionResult,
          operatorGrant,
          operatorUsage,
        ] = await publicClient.multicall({
          contracts: [
            {
              address: ADDRESSES.CoverManager,
              abi: ICoverManagerAbi,
              functionName: 'sigmaOf',
              args: [BigInt(LISTED_PERP_ID)],
            },
            {
              address: ADDRESSES.CoverManager,
              abi: ICoverManagerAbi,
              functionName: 'paused',
            },
            {
              address: ADDRESSES.CoverManager,
              abi: ICoverManagerAbi,
              functionName: 'marketPaused',
              args: [BigInt(LISTED_PERP_ID)],
            },
            {
              address: ADDRESSES.CoverManager,
              abi: ICoverManagerAbi,
              functionName: 'activeCoverOf',
              args: [account, BigInt(LISTED_PERP_ID)],
            },
            {
              address: ADDRESSES.CoverManager,
              abi: ICoverManagerAbi,
              functionName: 'isLocked',
              args: [account, BigInt(LISTED_PERP_ID)],
            },
            {
              address: ADDRESSES.PerplExchange,
              abi: IPerplMinAbi,
              functionName: 'getPerpetualInfo',
              args: [BigInt(LISTED_PERP_ID)],
            },
            {
              address: ADDRESSES.PerplExchange,
              abi: IPerplMinAbi,
              functionName: 'isHalted',
            },
            {
              address: ADDRESSES.PerplExchange,
              abi: IPerplMinAbi,
              functionName: 'getPosition',
              args: [BigInt(LISTED_PERP_ID), perplAccountId],
            },
            {
              address: account,
              abi: IGaplessAccountAbi,
              functionName: 'operator',
            },
            {
              address: account,
              abi: IGaplessAccountAbi,
              functionName: 'operatorUsage',
            },
          ],
          allowFailure: false,
        })

        const [blockInfo, operatorMonBalanceWei] = await Promise.all([
          publicClient.getBlock(),
          publicClient.getBalance({ address: operator }),
        ])

        return {
          blockNumber: blockInfo.number,
          sigmaBlkBpsE2: sigma[0],
          sigmaPostedBlock: sigma[1],
          buysPaused,
          marketPaused,
          exchangeHalted: halted,
          perpStatus: perpInfo.status,
          markPNS: perpInfo.markPNS,
          lastPNS: perpInfo.lastPNS,
          bestBidPNS: perpInfo.maxBidPriceONS,
          bestAskPNS: perpInfo.minAskPriceONS,
          activeCoverId,
          isLocked: locked,
          position: {
            lotLNS: positionResult[0].lotLNS,
            pricePNS: positionResult[0].pricePNS,
            positionType: positionResult[0].positionType,
            depositCNS: positionResult[0].depositCNS,
            pnlCNS: positionResult[0].pnlCNS,
          },
          operatorGrant,
          operatorUsedCNS: operatorUsage[0],
          operatorAvailableCNS: operatorUsage[1],
          operatorMonBalanceWei,
        }
      } catch (err) {
        if (import.meta.env.DEV)
          console.error('[useTradeChainState] read failed', {
            account,
            operator,
            err,
          })
        throw err
      }
    },
  })
}
