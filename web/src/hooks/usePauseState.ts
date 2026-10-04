import { useQuery } from '@tanstack/react-query'
import { ICoverManagerAbi } from '@/abi/ICoverManager'
import { IPerplMinAbi } from '@/abi/IPerplMin'
import { ADDRESSES, LISTED_PERP_ID } from '@/config/addresses.143'
import { publicClient } from '@/lib/chain'

export interface PauseState {
  buysPaused: boolean
  marketPaused: boolean
  exchangeHalted: boolean
}

/**
 * Global pause banner data (ARCHITECTURE route map, __root.tsx row): `paused()`
 * and `marketPaused(1)` on CoverManager, `isHalted()` on the Perpl exchange.
 * One multicall, polled at the chain's own cadence.
 */
export function usePauseState() {
  return useQuery({
    queryKey: ['pauseState'],
    queryFn: async (): Promise<PauseState> => {
      const [buysPaused, marketPaused, exchangeHalted] =
        await publicClient.multicall({
          contracts: [
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
              address: ADDRESSES.PerplExchange,
              abi: IPerplMinAbi,
              functionName: 'isHalted',
            },
          ],
          allowFailure: false,
        })
      return { buysPaused, marketPaused, exchangeHalted }
    },
    refetchInterval: 5_000,
    staleTime: 2_000,
  })
}
