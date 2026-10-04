import { useEffect, useRef, useState } from 'react'
import { EASE_OUT_CUBIC } from '@/config/animation'

const FLASH_MS = 400
const TRANSITION = `color ${FLASH_MS}ms cubic-bezier(${EASE_OUT_CUBIC.join(',')})`

/**
 * DESIGN 7.2, 8.1.4: "only the digits that changed take the up or down
 * color for 400 ms, then return." Diffs the previous rendered string
 * character by character (tabular figures keep positions stable) and
 * colors only the positions that changed. Color only, no movement, and
 * never a row flash.
 */
export default function TickText({
  text,
  numericValue,
  className,
}: {
  text: string
  /** Compared to the previous render to pick the up or down color. */
  numericValue: number
  className?: string
}) {
  const prevTextRef = useRef(text)
  const prevValueRef = useRef(numericValue)
  const [changed, setChanged] = useState<{
    indices: Set<number>
    direction: 'up' | 'down'
  } | null>(null)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    const prevText = prevTextRef.current
    const prevValue = prevValueRef.current
    if (prevText !== text && numericValue !== prevValue) {
      const indices = new Set<number>()
      const len = Math.max(prevText.length, text.length)
      for (let i = 0; i < len; i++) if (prevText[i] !== text[i]) indices.add(i)
      setChanged({
        indices,
        direction: numericValue > prevValue ? 'up' : 'down',
      })
      if (timerRef.current !== null) clearTimeout(timerRef.current)
      timerRef.current = setTimeout(() => setChanged(null), FLASH_MS)
    }
    prevTextRef.current = text
    prevValueRef.current = numericValue
  }, [text, numericValue])

  useEffect(
    () => () => {
      if (timerRef.current !== null) clearTimeout(timerRef.current)
    },
    [],
  )

  const colorVar =
    changed?.direction === 'up' ? 'var(--color-up)' : 'var(--color-down)'

  return (
    <span className={className}>
      {text.split('').map((char, i) => (
        <span
          key={i}
          style={{
            color: changed?.indices.has(i) ? colorVar : undefined,
            transition: TRANSITION,
          }}
        >
          {char}
        </span>
      ))}
    </span>
  )
}
