import { TriangleAlert } from 'lucide-react'

/**
 * DESIGN 5.8, C3: `PauseBanner`'s anatomy, for inline use inside a page
 * column (stale data, keeper unavailable, a section's own data error).
 * Always standalone, never nested inside a card.
 */
export default function InlineBanner({
  title,
  body,
}: {
  title: string
  body: string
}) {
  return (
    <div className="flex items-start gap-3 rounded-[16px] bg-[#402F21] px-4 py-3">
      <TriangleAlert
        className="mt-0.5 size-5 shrink-0 text-[#FF9230]"
        strokeWidth={1.75}
      />
      <div>
        <p className="type-headline text-white">{title}</p>
        <p className="type-callout text-[#AEAEB2]">{body}</p>
      </div>
    </div>
  )
}
