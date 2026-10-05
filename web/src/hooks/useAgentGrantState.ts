import { useQuery } from '@tanstack/react-query'
import type { Address } from 'viem'
import type { Eip712Domain } from '@/lib/account/typedData'
import { IGaplessAccountAbi } from '@/abi/IGaplessAccount'
import { publicClient } from '@/lib/chain'

export interface AgentGrantDisplayState {
  operatorKey: Address
  operatorExpiry: bigint
  operatorMaxPerTradeCNS: bigint
  operatorMaxPerDayCNS: bigint
  operatorUsedCNS: bigint
  operatorAvailableCNS: bigint
  nowS: number
}

/**
 * Polled display state for `/settings/agent` (ARCHITECTURE 7.2 step 1): the
 * current operator, its expiry, and `operatorUsage()`. This is for display
 * only; the nonce and domain used to actually sign are read fresh, right
 * before signing, by `readSetOperatorSigningContext` below.
 */
export function useAgentGrantState(account: Address | null) {
  return useQuery({
    queryKey: ['agentGrantState', account],
    enabled: account !== null,
    refetchInterval: 5_000,
    queryFn: async (): Promise<AgentGrantDisplayState> => {
      if (!account) {
        throw new Error('useAgentGrantState: account required')
      }
      const [grant, usage] = await publicClient.multicall({
        contracts: [
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
      const block = await publicClient.getBlock()
      return {
        operatorKey: grant.key,
        operatorExpiry: grant.expiry,
        operatorMaxPerTradeCNS: grant.maxNotionalPerTradeCNS,
        operatorMaxPerDayCNS: grant.maxNotionalPerDayCNS,
        operatorUsedCNS: usage[0],
        operatorAvailableCNS: usage[1],
        nowS: Number(block.timestamp),
      }
    },
  })
}

export interface SetOperatorSigningContext {
  domain: Eip712Domain
  nonce: bigint
}

/**
 * Fresh domain and nonce read, done immediately before signing (ARCHITECTURE
 * 7.1: "nonce = account.opNonce() read just before signing"). Never cached,
 * never read from a polled query: a stale nonce here would sign a grant the
 * contract then rejects as `BadSig`, or worse, double-spend an intended nonce.
 */
export async function readSetOperatorSigningContext(
  account: Address,
): Promise<SetOperatorSigningContext> {
  const [domainRaw, nonce] = await publicClient.multicall({
    contracts: [
      {
        address: account,
        abi: IGaplessAccountAbi,
        functionName: 'eip712Domain',
      },
      {
        address: account,
        abi: IGaplessAccountAbi,
        functionName: 'opNonce',
      },
    ],
    allowFailure: false,
  })
  return {
    domain: {
      name: domainRaw[1],
      version: domainRaw[2],
      chainId: Number(domainRaw[3]),
      verifyingContract: domainRaw[4],
    },
    nonce,
  }
}
