import { CircleAlert } from 'lucide-react'
import type { ReactNode } from 'react'
import { cnm } from '@/utils/style'

/**
 * DESIGN 5.2, C2: one field shape, shared by `/trade`, `/vault` and
 * `/settings/agent`. Label above, 52px min height, 1px border at rest, a
 * 2px accent border on focus (drawn inset so height never shifts), and one
 * reserved line below for a bound or an error, never both.
 */
export default function Field({
  label,
  children,
  bound,
  error,
  className,
}: {
  label: string
  children: ReactNode
  bound?: string
  error?: string
  className?: string
}) {
  return (
    <div className={className}>
      <p className="type-label mb-2 text-[#AEAEB2]">{label}</p>
      <div
        className={cnm(
          'flex min-h-[52px] items-center gap-2 rounded-[16px] border bg-[#2C2C2E] px-4',
          'focus-within:border-2 focus-within:border-[#A48FFF]',
          error ? 'border-2 border-[#FF6165]' : 'border-[#48484A]',
        )}
      >
        {children}
      </div>
      <p className="type-footnote mt-1.5 flex min-h-[18px] items-center gap-1">
        {error ? (
          <>
            <CircleAlert
              className="size-3.5 shrink-0 text-[#FF6165]"
              strokeWidth={2}
            />
            <span className="text-[#FF6165]">{error}</span>
          </>
        ) : bound ? (
          <span className="text-[#AEAEB2]">{bound}</span>
        ) : null}
      </p>
    </div>
  )
}
