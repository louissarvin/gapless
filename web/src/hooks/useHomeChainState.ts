import { useQuery } from '@tanstack/react-query'
import type { Address, Hex } from 'viem'
import { ICoverManagerAbi } from '@/abi/ICoverManager'
import { IGaplessAccountAbi } from '@/abi/IGaplessAccount'
import { IPerplMinAbi } from '@/abi/IPerplMin'
import { IAUSDAbi } from '@/abi/IAUSD'
import { ADDRESSES, LISTED_PERP_ID } from '@/config/addresses.143'
import { publicClient } from '@/lib/chain'

export const ZERO_COVER_ID =
  '0x0000000000000000000000000000000000000000000000000000000000000000' as const

export interface OperatorGrant {
  key: Address
  expiry: bigint
  maxNotionalPerTradeCNS: bigint
  maxNotionalPerDayCNS: bigint
}

export interface HomeChainState {
  walletAusdCNS: bigint
  perplFreeCNS: bigint
  perplLockedCNS: bigint
  positionDepositCNS: bigint
  positionLotLNS: bigint
  positionPricePNS: bigint
  positionPnlCNS: bigint
  activeCoverId: Hex
  operatorGrant: OperatorGrant
  operatorUsedCNS: bigint
  operatorAvailableCNS: bigint
  operatorMonBalanceWei: bigint
}

/**
 * ARCHITECTURE 5.4: one multicall for everything `/home` shows, plus a
 * separate `eth_getBalance` (not part of the multicall). Enabled only once
 * the account is deployed and activated (`perplAccountId` is known).
 */
export function useHomeChainState(
  account: Address | null,
  operator: Address | null,
  perplAccountId: bigint | null,
) {
  return useQuery({
    queryKey: ['homeChainState', account, operator, String(perplAccountId)],
    enabled: account !== null && operator !== null && perplAccountId !== null,
    refetchInterval: 4_000,
    queryFn: async (): Promise<HomeChainState> => {
      if (!account || !operator || perplAccountId === null) {
        throw new Error(
          'useHomeChainState: account, operator and perplAccountId required',
        )
      }

      try {
        const [
          walletAusdCNS,
          accountInfo,
          positionResult,
          activeCoverId,
          operatorGrant,
          operatorUsage,
        ] = await publicClient.multicall({
          contracts: [
            {
              address: ADDRESSES.AUSD,
              abi: IAUSDAbi,
              functionName: 'balanceOf',
              args: [account],
            },
            {
              address: ADDRESSES.PerplExchange,
              abi: IPerplMinAbi,
              functionName: 'getAccountById',
              args: [perplAccountId],
            },
            {
              address: ADDRESSES.PerplExchange,
              abi: IPerplMinAbi,
              functionName: 'getPosition',
              args: [BigInt(LISTED_PERP_ID), perplAccountId],
            },
            {
              address: ADDRESSES.CoverManager,
              abi: ICoverManagerAbi,
              functionName: 'activeCoverOf',
              args: [account, BigInt(LISTED_PERP_ID)],
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

        const operatorMonBalanceWei = await publicClient.getBalance({
          address: operator,
        })

        return {
          walletAusdCNS,
          perplFreeCNS: accountInfo.balanceCNS,
          perplLockedCNS: accountInfo.lockedBalanceCNS,
          positionDepositCNS: positionResult[0].depositCNS,
          positionLotLNS: positionResult[0].lotLNS,
          positionPricePNS: positionResult[0].pricePNS,
          positionPnlCNS: positionResult[0].pnlCNS,
          activeCoverId,
          operatorGrant,
          operatorUsedCNS: operatorUsage[0],
          operatorAvailableCNS: operatorUsage[1],
          operatorMonBalanceWei,
        }
      } catch (err) {
        // TanStack Query does not log failed queries, so a broken read is otherwise silent.
        if (import.meta.env.DEV)
          console.error('[useHomeChainState] read failed', {
            account,
            operator,
            err,
          })
        throw err
      }
    },
  })
}

/** Total balance shown on `/home` (ARCHITECTURE 5.4 formula): wallet AUSD
 * plus Perpl free balance plus the open position's deposit. */
export function totalBalanceCNS(state: HomeChainState): bigint {
  return state.walletAusdCNS + state.perplFreeCNS + state.positionDepositCNS
}

export function hasActiveCover(state: HomeChainState): boolean {
  return state.activeCoverId !== ZERO_COVER_ID
}
