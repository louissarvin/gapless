import { useQuery } from '@tanstack/react-query'
import type { Address } from 'viem'
import type { Eip712Domain } from '@/lib/account/typedData'
import { IAUSDAbi } from '@/abi/IAUSD'
import { IGaplessAccountAbi } from '@/abi/IGaplessAccount'
import { IGaplessFactoryAbi } from '@/abi/IGaplessFactory'
import { IPerplMinAbi } from '@/abi/IPerplMin'
import { ADDRESSES } from '@/config/addresses.143'
import { publicClient } from '@/lib/chain'

export type OnboardStep =
  | 'keys'
  | 'fund'
  | 'create'
  | 'activate'
  | 'operator-replaced'
  | 'session-expired'
  | 'ready'

export interface AccountChainState {
  owner: Address
  operator: Address
  account: Address
  isDeployed: boolean
  factoryDomain: Eip712Domain
  ausdBalanceCNS: bigint
  minOpenCNS: bigint
  perplAccountId: bigint
  operatorKey: Address
  operatorExpiry: bigint
  operatorMonBalanceWei: bigint
  nowS: number
}

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000' as const

/**
 * One multicall per poll (ARCHITECTURE 5.1): everything the onboarding state
 * machine derives from chain state. `hasPendingPayload` folds in the local
 * ADR-W4 payload so "keys" only shows before the owner has signed once.
 */
export function useAccountState(
  owner: Address | null,
  operator: Address | null,
) {
  return useQuery({
    queryKey: ['accountState', owner, operator],
    enabled: owner !== null && operator !== null,
    refetchInterval: 4_000,
    queryFn: async (): Promise<AccountChainState> => {
      if (!owner || !operator)
        throw new Error('useAccountState: owner and operator required')

      try {
        const [account, factoryDomainRaw, minOpenCNS, latestBlock] =
          await Promise.all([
            publicClient.readContract({
              address: ADDRESSES.GaplessFactory,
              abi: IGaplessFactoryAbi,
              functionName: 'accountOf',
              args: [owner],
            }),
            publicClient.readContract({
              address: ADDRESSES.GaplessFactory,
              abi: IGaplessFactoryAbi,
              functionName: 'eip712Domain',
            }),
            publicClient.readContract({
              address: ADDRESSES.PerplExchange,
              abi: IPerplMinAbi,
              functionName: 'getMinAccountOpenCNS',
            }),
            publicClient.getBlock(),
          ])

        // accountOf is a CREATE2 prediction, never zero: deployment is isAccount (ARCHITECTURE 5.1).
        const [isDeployed, ausdBalanceCNS, operatorMonBalanceWei] =
          await Promise.all([
            publicClient.readContract({
              address: ADDRESSES.GaplessFactory,
              abi: IGaplessFactoryAbi,
              functionName: 'isAccount',
              args: [account],
            }),
            publicClient.readContract({
              address: ADDRESSES.AUSD,
              abi: IAUSDAbi,
              functionName: 'balanceOf',
              args: [account],
            }),
            publicClient.getBalance({ address: operator }),
          ])

        // Clone reads only once it has code; on an empty address they return 0x and throw.
        const [perplAccountId, operatorGrant] = isDeployed
          ? await publicClient.multicall({
              contracts: [
                {
                  address: account,
                  abi: IGaplessAccountAbi,
                  functionName: 'perplAccountId',
                },
                {
                  address: account,
                  abi: IGaplessAccountAbi,
                  functionName: 'operator',
                },
              ],
              allowFailure: false,
            })
          : ([0n, { key: ZERO_ADDRESS, expiry: 0n }] as const)

        return {
          owner,
          operator,
          account,
          isDeployed,
          factoryDomain: {
            name: factoryDomainRaw[1],
            version: factoryDomainRaw[2],
            chainId: Number(factoryDomainRaw[3]),
            verifyingContract: factoryDomainRaw[4],
          },
          ausdBalanceCNS,
          minOpenCNS,
          perplAccountId,
          operatorKey: operatorGrant.key,
          operatorExpiry: operatorGrant.expiry,
          operatorMonBalanceWei,
          nowS: Number(latestBlock.timestamp),
        }
      } catch (err) {
        // TanStack Query does not log failed queries, so a broken read is otherwise silent.
        if (import.meta.env.DEV)
          console.error('[useAccountState] read failed', {
            owner,
            operator,
            err,
          })
        throw err
      }
    },
  })
}

/** ARCHITECTURE 5.1 state table, evaluated top to bottom. */
export function deriveOnboardStep(
  state: AccountChainState,
  hasPendingPayload: boolean,
): OnboardStep {
  if (!state.isDeployed) {
    if (!hasPendingPayload) return 'keys'
    if (state.ausdBalanceCNS < state.minOpenCNS) return 'fund'
    return 'create'
  }

  if (state.perplAccountId === 0n) return 'activate'
  if (state.operatorMonBalanceWei === 0n) return 'activate'
  if (state.operatorKey.toLowerCase() !== state.operator.toLowerCase())
    return 'operator-replaced'
  if (state.operatorExpiry <= BigInt(state.nowS)) return 'session-expired'
  return 'ready'
}
