import { TriangleAlert } from 'lucide-react'
import { usePauseState } from '@/hooks/usePauseState'

/**
 * Global pause banner (DESIGN 5.8, ARCHITECTURE __root.tsx row). Not
 * dismissible while the condition holds; one card per active condition.
 */
export default function PauseBanner() {
  const { data } = usePauseState()
  if (!data) return null

  const conditions: Array<{ title: string; body: string }> = []
  if (data.exchangeHalted) {
    conditions.push({
      title: 'Exchange is halted',
      body: 'Perpl has halted trading. Covers keep their lifecycle; no new trades can be sent.',
    })
  }
  if (data.marketPaused) {
    conditions.push({
      title: 'Market is paused',
      body: 'This market is paused by the protocol. Open covers keep their lifecycle.',
    })
  } else if (data.buysPaused) {
    conditions.push({
      title: 'Buys are paused',
      body: 'The protocol has paused new covers. Plain trades (no Guarantee) and existing covers are unaffected.',
    })
  }

  if (conditions.length === 0) return null

  return (
    <div className="mx-auto max-w-[480px] px-5 pt-4">
      {conditions.map((condition) => (
        <div
          key={condition.title}
          className="mb-2 flex items-start gap-3 rounded-md bg-[#402F21] px-4 py-3"
        >
          <TriangleAlert
            className="mt-0.5 size-5 shrink-0 text-[#FF9230]"
            strokeWidth={1.75}
          />
          <div>
            <p className="font-sans text-[17px] font-semibold text-white">
              {condition.title}
            </p>
            <p className="font-sans text-[15px] text-[#AEAEB2]">
              {condition.body}
            </p>
          </div>
        </div>
      ))}
    </div>
  )
}
