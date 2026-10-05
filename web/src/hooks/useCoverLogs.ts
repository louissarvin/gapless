import { useQuery } from '@tanstack/react-query'
import type { Hex } from 'viem'
import type { KeeperConsoleData } from '@/lib/api/relay'
import type { CoverTxRef, TriggeredLog } from '@/lib/covers/logs'
import {
  findFinalizedLogByScan,
  getArmedLog,
  getCoverBoughtLog,
  getTriggeredLog,
} from '@/lib/covers/logs'
import { publicClient } from '@/lib/chain'

export interface CoverLogsResult {
  bought: CoverTxRef | null
  armed: CoverTxRef | null
  triggered: TriggeredLog | null
  /** `null` txHash with `source: 'console'` still tells the page the keeper
   * saw this cover finalize, even if its row has no hash recorded. */
  finalized: { txHash: Hex | null; source: 'console' | 'scan' } | null
}

function findFinalizedInConsole(
  console: KeeperConsoleData | undefined,
  coverId: Hex,
): Hex | null {
  if (!console) return null
  const row = console.recent.find(
    (r) =>
      r.coverId?.toLowerCase() === coverId.toLowerCase() &&
      r.action.toLowerCase().includes('finaliz'),
  )
  return (row?.txHash as Hex | null | undefined) ?? null
}

/**
 * ADR-W7: `CoverBought`/`Armed`/`Triggered` from single-block `eth_getLogs`
 * at the cover's own recorded blocks; `Finalized` from the keeper console's
 * `recent[]` first (ADR-W17), falling back to a bounded forward scan from
 * `triggerBlock` only once the cover is actually `Finalized` on chain.
 */
export function useCoverLogs(
  coverId: Hex,
  status: number | undefined,
  startBlock: number | undefined,
  armedBlock: number | undefined,
  triggerBlock: number | undefined,
  keeperConsole: KeeperConsoleData | undefined,
) {
  const FINALIZED = 4
  return useQuery({
    queryKey: [
      'coverLogs',
      coverId,
      status,
      startBlock,
      armedBlock,
      triggerBlock,
      status === FINALIZED
        ? findFinalizedInConsole(keeperConsole, coverId)
        : null,
    ],
    enabled: status !== undefined && startBlock !== undefined,
    queryFn: async (): Promise<CoverLogsResult> => {
      const [bought, armed, triggered] = await Promise.all([
        getCoverBoughtLog(coverId, startBlock ?? 0),
        getArmedLog(coverId, armedBlock ?? 0),
        getTriggeredLog(coverId, triggerBlock ?? 0),
      ])

      let finalized: CoverLogsResult['finalized'] = null
      if (status === FINALIZED) {
        const consoleHash = findFinalizedInConsole(keeperConsole, coverId)
        if (consoleHash) {
          finalized = { txHash: consoleHash, source: 'console' }
        } else {
          const latest = await publicClient.getBlockNumber()
          const scanned = await findFinalizedLogByScan(
            coverId,
            triggerBlock ?? 0,
            latest,
          )
          finalized = { txHash: scanned?.txHash ?? null, source: 'scan' }
        }
      }

      return { bought, armed, triggered, finalized }
    },
  })
}
