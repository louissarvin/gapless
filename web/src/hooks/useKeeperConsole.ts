import { useQuery } from '@tanstack/react-query'
import type { KeeperConsoleData } from '@/lib/api/relay'
import { RelayRateLimitError, getKeeperConsole } from '@/lib/api/relay'

/**
 * ADR-W17: one shared poll for the whole app (`['keeperConsole']`), so
 * `/stats` and `/covers/$coverId` never multiply the keeper's 30/min per-IP
 * budget. 10s cadence; a 429 backs off for the server's own `Retry-After`
 * instead of hammering it, and the last good value stays on screen.
 */
const DEFAULT_INTERVAL_MS = 10_000

export function useKeeperConsole(intervalMs: number = DEFAULT_INTERVAL_MS) {
  return useQuery<KeeperConsoleData>({
    queryKey: ['keeperConsole'],
    queryFn: getKeeperConsole,
    refetchInterval: intervalMs,
    refetchIntervalInBackground: false,
    staleTime: intervalMs,
    retry: (failureCount, error) => {
      if (error instanceof RelayRateLimitError) return failureCount < 3
      // KEEPER_UNAVAILABLE / KEEPER_CONSOLE_DISABLED are expected states, not transient faults.
      return false
    },
    retryDelay: (_attempt, error) =>
      error instanceof RelayRateLimitError && error.retryAfterS
        ? error.retryAfterS * 1_000
        : 2_000,
  })
}
