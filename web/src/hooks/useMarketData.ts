import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { MarketSnapshot } from '@/lib/market/ws'
import { marketWs } from '@/lib/market/ws'

const EMPTY_SNAPSHOT: MarketSnapshot = {
  status: 'connecting',
  quote: null,
  book: null,
  updatedAtMs: null,
}

/**
 * Live display data for one perp from `/ws/market` (ARCHITECTURE 5.2).
 * Never the source of a trade's limit or mark; those stay chain reads.
 */
export function useMarketData(perpId: number): MarketSnapshot {
  useEffect(() => {
    marketWs.acquire(perpId)
    return () => marketWs.release(perpId)
  }, [perpId])

  return useSyncExternalStore(
    (listener) => marketWs.subscribe(listener),
    () => marketWs.getSnapshot(perpId),
    () => EMPTY_SNAPSHOT,
  )
}

/**
 * Trailing-edge throttle so a value changes on screen at most once per
 * `intervalMs` (DESIGN 8.1.2: the price header coalesces to one paint per
 * 500 ms). The book itself is left unthrottled; one emit per animation
 * frame from the client is already its cap.
 */
export function useThrottledValue<T>(value: T, intervalMs: number): T {
  const [display, setDisplay] = useState(value)
  const lastPaintRef = useRef(0)
  const pendingRef = useRef(value)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  pendingRef.current = value

  useEffect(() => {
    const elapsed = Date.now() - lastPaintRef.current
    if (elapsed >= intervalMs) {
      lastPaintRef.current = Date.now()
      setDisplay(value)
      return
    }
    if (timerRef.current !== null) return
    timerRef.current = setTimeout(() => {
      timerRef.current = null
      lastPaintRef.current = Date.now()
      setDisplay(pendingRef.current)
    }, intervalMs - elapsed)
  }, [value, intervalMs])

  useEffect(
    () => () => {
      if (timerRef.current !== null) clearTimeout(timerRef.current)
    },
    [],
  )

  return display
}

/** Re-renders every `intervalMs` so an "Updated Ns ago" label stays correct. Text only, no motion. */
export function useNowTick(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs)
    return () => clearInterval(timer)
  }, [intervalMs])
  return now
}
