import { useEffect, useRef, useState } from 'react'
import { IPerplMinAbi } from '@/abi/IPerplMin'
import { ADDRESSES, LISTED_PERP_ID } from '@/config/addresses.143'
import { publicClient } from '@/lib/chain'

/** 10 minutes at 1 sample/s (ADR-W16). */
const RING_SIZE = 600
const POLL_MS = 1_000

export interface StalenessSample {
  tS: number
  block: bigint
  markAgeS: number
  oracleAgeS: number
  markVsBookBps: number | null
}

export interface LiveStaleness {
  latest: StalenessSample | null
  samples: ReadonlyArray<StalenessSample>
  symbol: string | null
  /** Null until the first successful read; stays at the last good value on a transient RPC error. */
  error: boolean
}

/**
 * ADR-W16: one multicall-batched read per second while the page is visible
 * (`getBlock('latest')` + `getPerpetualInfo(1)`), never the WS `mrk` (it may
 * be Perpl's offchain per-block mark, the wrong source for this claim).
 */
export function useLiveStaleness(): LiveStaleness {
  const [state, setState] = useState<LiveStaleness>({
    latest: null,
    samples: [],
    symbol: null,
    error: false,
  })
  const ring = useRef<Array<StalenessSample>>([])

  useEffect(() => {
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined

    async function tick() {
      if (document.hidden) {
        timer = setTimeout(tick, POLL_MS)
        return
      }
      try {
        const [block, info] = await Promise.all([
          publicClient.getBlock({ blockTag: 'latest' }),
          publicClient.readContract({
            address: ADDRESSES.PerplExchange,
            abi: IPerplMinAbi,
            functionName: 'getPerpetualInfo',
            args: [BigInt(LISTED_PERP_ID)],
          }),
        ])
        if (cancelled) return

        const mid =
          info.maxBidPriceONS > 0n && info.minAskPriceONS > 0n
            ? (info.maxBidPriceONS + info.minAskPriceONS) / 2n
            : null
        const markVsBookBps =
          mid !== null && mid > 0n
            ? Number(((info.markPNS - mid) * 10_000n) / mid)
            : null

        const sample: StalenessSample = {
          tS: Date.now() / 1000,
          block: block.number,
          markAgeS: Number(block.timestamp) - Number(info.markTimestamp),
          oracleAgeS: Number(block.timestamp) - Number(info.oracleTimestampSec),
          markVsBookBps,
        }
        ring.current = [...ring.current, sample].slice(-RING_SIZE)
        setState({
          latest: sample,
          samples: ring.current,
          symbol: info.symbol,
          error: false,
        })
      } catch {
        if (!cancelled) setState((s) => ({ ...s, error: true }))
      } finally {
        if (!cancelled) timer = setTimeout(tick, POLL_MS)
      }
    }

    void tick()
    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
    }
  }, [])

  return state
}
