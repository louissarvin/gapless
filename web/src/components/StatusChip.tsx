import {
  CircleAlert,
  CircleCheck,
  CircleSlash,
  Clock,
  HandCoins,
  ShieldAlert,
  ShieldCheck,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'

/** DESIGN 2.5: cover status chip colors, text and icon (`contract/src/types/GaplessTypes.sol` `CoverStatus`). */
export type CoverStatusKind =
  | 'live'
  | 'armed'
  | 'triggered'
  | 'finalized'
  | 'cancelled'
  | 'expired'
  | 'voided'

const CHIP: Record<
  CoverStatusKind,
  { label: string; text: string; bg: string; icon: LucideIcon }
> = {
  live: { label: 'Live', text: '#00DAC3', bg: '#183A38', icon: ShieldCheck },
  armed: { label: 'Armed', text: '#FFD600', bg: '#403A19', icon: ShieldAlert },
  triggered: {
    label: 'Triggered',
    text: '#5CB8FF',
    bg: '#263542',
    icon: HandCoins,
  },
  finalized: {
    label: 'Finalized',
    text: '#30D158',
    bg: '#1F3927',
    icon: CircleCheck,
  },
  cancelled: {
    label: 'Cancelled',
    text: '#AEAEB2',
    bg: '#333336',
    icon: CircleSlash,
  },
  expired: { label: 'Expired', text: '#AEAEB2', bg: '#333336', icon: Clock },
  voided: {
    label: 'Voided',
    text: '#FF9230',
    bg: '#402F21',
    icon: CircleAlert,
  },
}

/** Same colors as the chip above, for the stepper's node fills (5.13). */
export const COVER_STATUS_COLOR: Record<CoverStatusKind, string> =
  Object.fromEntries(
    Object.entries(CHIP).map(([key, v]) => [key, v.text]),
  ) as Record<CoverStatusKind, string>

export default function StatusChip({ status }: { status: CoverStatusKind }) {
  const { label, text, bg, icon: Icon } = CHIP[status]
  return (
    <span
      className="type-caption inline-flex h-7 items-center gap-1.5 rounded-full px-3"
      style={{ color: text, backgroundColor: bg }}
    >
      <Icon className="size-3.5" strokeWidth={1.75} />
      {label}
    </span>
  )
}
