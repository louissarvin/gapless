import { useQuery } from '@tanstack/react-query'
import type { Address } from 'viem'
import { ICoverManagerAbi } from '@/abi/ICoverManager'
import { ICoverVaultAbi } from '@/abi/ICoverVault'
import { IAUSDAbi } from '@/abi/IAUSD'
import { ADDRESSES, LISTED_PERP_ID } from '@/config/addresses.143'
import { publicClient } from '@/lib/chain'

/**
 * `/vault` public reads (ARCHITECTURE phase 2 ADR-W18): one multicall, no
 * session required. Every disclosure number on the page comes from here or
 * `/api/stats` (`lpCount`, premiums), never from a hardcoded constant.
 */
export interface VaultPublicState {
  blockNumber: bigint
  totalAssetsCNS: bigint
  totalSupply: bigint
  shareDecimals: number
  reservedTotalCNS: bigint
  reservedBtcCNS: bigint
  freeAssetsCNS: bigint
  utilizationBps: bigint
  owedTotalCNS: bigint
  paused: boolean
  treasury: Address
  maxUtilizationBps: number
  protocolFeeBps: number
  minDepositCNS: bigint
  cooldownBlocks: bigint
  depositLockBlocks: bigint
  blockPayoutCapCNS: bigint
  maxGapBpsCap: number
  perBlockPayoutCapBps: number
  maxCoverNotionalCNS: bigint
  liveCoverCount: bigint
  /** `convertToAssets(10^shareDecimals)`: the live price of one whole share. */
  sharePriceCNS: bigint
}

export function useVaultChainState() {
  return useQuery({
    queryKey: ['vaultChainState'],
    refetchInterval: 10_000,
    queryFn: async (): Promise<VaultPublicState> => {
      const [
        totalAssetsCNS,
        totalSupply,
        shareDecimals,
        reservedTotalCNS,
        reservedBtcCNS,
        freeAssetsCNS,
        utilizationBps,
        owedTotalCNS,
        paused,
        config,
        cooldownBlocks,
        depositLockBlocks,
        blockPayout,
        marketParams,
        liveCoverCount,
      ] = await publicClient.multicall({
        contracts: [
          {
            address: ADDRESSES.CoverVault,
            abi: ICoverVaultAbi,
            functionName: 'totalAssets',
          },
          {
            address: ADDRESSES.CoverVault,
            abi: ICoverVaultAbi,
            functionName: 'totalSupply',
          },
          {
            address: ADDRESSES.CoverVault,
            abi: ICoverVaultAbi,
            functionName: 'decimals',
          },
          {
            address: ADDRESSES.CoverVault,
            abi: ICoverVaultAbi,
            functionName: 'reservedTotal',
          },
          {
            address: ADDRESSES.CoverVault,
            abi: ICoverVaultAbi,
            functionName: 'reserved',
            args: [BigInt(LISTED_PERP_ID)],
          },
          {
            address: ADDRESSES.CoverVault,
            abi: ICoverVaultAbi,
            functionName: 'freeAssets',
          },
          {
            address: ADDRESSES.CoverVault,
            abi: ICoverVaultAbi,
            functionName: 'utilizationBps',
          },
          {
            address: ADDRESSES.CoverVault,
            abi: ICoverVaultAbi,
            functionName: 'owedTotal',
          },
          {
            address: ADDRESSES.CoverVault,
            abi: ICoverVaultAbi,
            functionName: 'paused',
          },
          {
            address: ADDRESSES.CoverVault,
            abi: ICoverVaultAbi,
            functionName: 'config',
          },
          {
            address: ADDRESSES.CoverVault,
            abi: ICoverVaultAbi,
            functionName: 'COOLDOWN_BLOCKS',
          },
          {
            address: ADDRESSES.CoverVault,
            abi: ICoverVaultAbi,
            functionName: 'DEPOSIT_LOCK_BLOCKS',
          },
          {
            address: ADDRESSES.CoverVault,
            abi: ICoverVaultAbi,
            functionName: 'blockPayout',
            args: [BigInt(LISTED_PERP_ID)],
          },
          {
            address: ADDRESSES.CoverManager,
            abi: ICoverManagerAbi,
            functionName: 'marketParams',
            args: [BigInt(LISTED_PERP_ID)],
          },
          {
            address: ADDRESSES.CoverManager,
            abi: ICoverManagerAbi,
            functionName: 'liveCount',
            args: [BigInt(LISTED_PERP_ID)],
          },
        ],
        allowFailure: false,
      })
      const [block, sharePriceCNS] = await Promise.all([
        publicClient.getBlock(),
        publicClient.readContract({
          address: ADDRESSES.CoverVault,
          abi: ICoverVaultAbi,
          functionName: 'convertToAssets',
          args: [10n ** BigInt(shareDecimals)],
        }),
      ])

      return {
        blockNumber: block.number,
        totalAssetsCNS,
        totalSupply,
        shareDecimals,
        reservedTotalCNS,
        reservedBtcCNS,
        freeAssetsCNS,
        utilizationBps,
        owedTotalCNS,
        paused,
        treasury: config.treasury,
        maxUtilizationBps: config.maxUtilizationBps,
        protocolFeeBps: config.protocolFeeBps,
        minDepositCNS: config.minDepositCNS,
        cooldownBlocks,
        depositLockBlocks,
        blockPayoutCapCNS: blockPayout.capCNS,
        maxGapBpsCap: marketParams.maxGapBpsCap,
        perBlockPayoutCapBps: marketParams.perBlockPayoutCapBps,
        maxCoverNotionalCNS: marketParams.maxCoverNotionalCNS,
        liveCoverCount,
        sharePriceCNS,
      }
    },
  })
}

export interface VaultRedeemRequest {
  requestId: bigint
  shares: bigint
  assetsAtRequestCNS: bigint
  claimableBlock: bigint
}

export interface VaultPosition {
  sharesBalance: bigint
  valueCNS: bigint
  lockUntilBlock: bigint
  ausdBalanceCNS: bigint
  ausdAllowanceCNS: bigint
  requests: ReadonlyArray<VaultRedeemRequest>
}

/**
 * LP position reads for the logged-in operator key (ARCHITECTURE phase 2:
 * "the same account that trades can also be an LP"). Deposits and redemptions
 * run from the operator's own address directly against CoverVault, so every
 * read here is keyed on the operator, not the GaplessAccount clone.
 */
export function useVaultPosition(operator: Address | null) {
  return useQuery({
    queryKey: ['vaultPosition', operator],
    enabled: operator !== null,
    refetchInterval: 5_000,
    queryFn: async (): Promise<VaultPosition> => {
      if (!operator) throw new Error('useVaultPosition: operator required')

      const [
        sharesBalance,
        lockUntilBlock,
        ausdBalanceCNS,
        ausdAllowanceCNS,
        requestIds,
      ] = await publicClient.multicall({
        contracts: [
          {
            address: ADDRESSES.CoverVault,
            abi: ICoverVaultAbi,
            functionName: 'balanceOf',
            args: [operator],
          },
          {
            address: ADDRESSES.CoverVault,
            abi: ICoverVaultAbi,
            functionName: 'lockUntil',
            args: [operator],
          },
          {
            address: ADDRESSES.AUSD,
            abi: IAUSDAbi,
            functionName: 'balanceOf',
            args: [operator],
          },
          {
            address: ADDRESSES.AUSD,
            abi: IAUSDAbi,
            functionName: 'allowance',
            args: [operator, ADDRESSES.CoverVault],
          },
          {
            address: ADDRESSES.CoverVault,
            abi: ICoverVaultAbi,
            functionName: 'requestIdsOf',
            args: [operator],
          },
        ],
        allowFailure: false,
      })

      const [valueCNS, requestResults] = await Promise.all([
        publicClient.readContract({
          address: ADDRESSES.CoverVault,
          abi: ICoverVaultAbi,
          functionName: 'convertToAssets',
          args: [sharesBalance],
        }),
        Promise.all(
          requestIds.map((requestId) =>
            publicClient.readContract({
              address: ADDRESSES.CoverVault,
              abi: ICoverVaultAbi,
              functionName: 'getRequest',
              args: [requestId],
            }),
          ),
        ),
      ])

      const requests: Array<VaultRedeemRequest> = requestIds.map(
        (requestId, i) => {
          const r = requestResults[i]
          return {
            requestId,
            shares: r.shares,
            assetsAtRequestCNS: r.assetsAtRequest,
            claimableBlock: BigInt(r.claimableBlock),
          }
        },
      )

      return {
        sharesBalance,
        valueCNS,
        lockUntilBlock,
        ausdBalanceCNS,
        ausdAllowanceCNS,
        requests,
      }
    },
  })
}
