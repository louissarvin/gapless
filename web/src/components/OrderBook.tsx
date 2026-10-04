import { useState } from 'react'
import type { MarketStatic } from '@/hooks/useTradeChainState'
import type { BookLevel, MarketBook, MarketSyncStatus } from '@/lib/market/ws'
import TickText from '@/components/TickText'
import { cnm } from '@/utils/style'

const COLLAPSED_LEVELS = 5
const EXPANDED_LEVELS = 20

/**
 * DESIGN 5.14, 8.1, 8.2: live order book, display only. Rows are keyed by
 * price so React reuses the DOM; no row ever transitions or flashes, only
 * the digits that changed (TickText). `o: 0` removals already fell out of
 * the book in `lib/market/ws.ts` before this renders.
 */
export default function OrderBook({
  market,
  book,
  status,
}: {
  market: MarketStatic
  book: MarketBook | null
  status: MarketSyncStatus
}) {
  const [expanded, setExpanded] = useState(false)
  const depth = expanded ? EXPANDED_LEVELS : COLLAPSED_LEVELS
  const unsynced = status === 'unsynced'

  const bids = book?.bids.slice(0, depth) ?? []
  const asks = book?.asks.slice(0, depth) ?? []
  const maxSize = Math.max(
    1,
    ...bids.map((l) => l.sizeScaled),
    ...asks.map((l) => l.sizeScaled),
  )

  return (
    <div
      className={cnm(
        'rounded-lg bg-[#1C1C1E] p-5 transition-opacity duration-300',
        unsynced && 'opacity-40',
      )}
    >
      <div className="mb-3 flex items-center justify-between">
        <p className="type-label text-[#AEAEB2]">Order book</p>
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="type-footnote text-[#A48FFF]"
        >
          {expanded ? 'Show 5 levels' : 'Show 20 levels'}
        </button>
      </div>

      {!book && (
        <p className="type-callout py-6 text-center text-[#8E8E93]">
          {unsynced ? 'Reconnecting…' : 'Loading book…'}
        </p>
      )}

      {book && (
        // overscroll-behavior: contain (DESIGN 8.1.9) so this scroller never drags the page.
        <div className="[overscroll-behavior:contain] max-h-[480px] overflow-y-auto">
          {[...asks].reverse().map((level) => (
            <BookRow
              key={`ask-${level.priceScaled}`}
              level={level}
              side="ask"
              market={market}
              maxSize={maxSize}
            />
          ))}
          {bids.map((level) => (
            <BookRow
              key={`bid-${level.priceScaled}`}
              level={level}
              side="bid"
              market={market}
              maxSize={maxSize}
            />
          ))}
        </div>
      )}
    </div>
  )
}

function BookRow({
  level,
  side,
  market,
  maxSize,
}: {
  level: BookLevel
  side: 'bid' | 'ask'
  market: MarketStatic
  maxSize: number
}) {
  const price = (level.priceScaled / 10 ** market.priceDecimals).toFixed(
    market.priceDecimals,
  )
  const size = (level.sizeScaled / 10 ** market.lotDecimals).toFixed(
    market.lotDecimals,
  )
  const ratio = Math.min(1, level.sizeScaled / maxSize)
  const barColor = side === 'bid' ? 'var(--color-up)' : 'var(--color-down)'

  return (
    <div className="relative flex h-7 items-center justify-end gap-4 px-1">
      <div
        className="absolute inset-y-0 right-0 origin-right"
        style={{
          width: '100%',
          backgroundColor: barColor,
          opacity: 0.12,
          transform: `scaleX(${ratio})`,
        }}
      />
      <TickText
        text={price}
        numericValue={level.priceScaled}
        className={cnm(
          'type-num-sm relative z-10 w-[88px] text-right tabular-nums',
          side === 'bid' ? 'text-[#30D158]' : 'text-[#FF6165]',
        )}
      />
      <TickText
        text={size}
        numericValue={level.sizeScaled}
        className="type-num-sm relative z-10 w-[72px] text-right tabular-nums text-[#AEAEB2]"
      />
    </div>
  )
}
