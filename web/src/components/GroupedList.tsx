import type { ReactNode } from 'react'
import { cnm } from '@/utils/style'

export interface GroupedListRow {
  key: string
  label: ReactNode
  value?: ReactNode
  note?: ReactNode
}

export interface GroupedListLead {
  label: string
  value: ReactNode
  unit?: string
  note?: ReactNode
}

/** DESIGN 3.4: number in white, thin space, unit in `type-label` secondary gray. */
export function NumUnit({ value, unit }: { value: ReactNode; unit?: string }) {
  if (!unit) return <>{value}</>
  return (
    <>
      {value}
      <span className="type-label text-[#AEAEB2]">
        {' '}
        {unit}
      </span>
    </>
  )
}

/**
 * DESIGN 5.4, C4: rows inside one regular card. C4 data variant: an optional
 * lead value gives the card one focal point, percentiles collapse into a
 * row's `note` instead of their own rows, and the value column never wraps.
 */
export default function GroupedList({
  id,
  title,
  lead,
  rows,
  className,
}: {
  id?: string
  title?: string
  lead?: GroupedListLead
  rows: ReadonlyArray<GroupedListRow>
  className?: string
}) {
  return (
    <div id={id} className={cnm('rounded-[24px] bg-[#1C1C1E] p-5', className)}>
      {title && <h3 className="type-label mb-3 text-[#AEAEB2]">{title}</h3>}
      {lead && (
        <div className="mb-4">
          <p className="type-label text-[#AEAEB2]">{lead.label}</p>
          <p className="type-num-lg mt-2 text-white">
            <NumUnit value={lead.value} unit={lead.unit} />
          </p>
          {lead.note && (
            <p className="type-footnote mt-1 text-[#8E8E93]">{lead.note}</p>
          )}
        </div>
      )}
      <div className="flex flex-col">
        {rows.map((row, i) => (
          <div
            key={row.key}
            className={cnm(
              'flex min-h-[44px] items-center justify-between gap-4 py-3',
              i > 0 && 'border-t border-[#3A3A3C]',
            )}
          >
            <span className="type-body min-w-0 text-white">{row.label}</span>
            <div className="flex shrink-0 flex-col items-end whitespace-nowrap">
              {row.value !== undefined && (
                <span className="type-num text-white">{row.value}</span>
              )}
              {row.note && (
                <span className="type-footnote text-[#8E8E93]">{row.note}</span>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
