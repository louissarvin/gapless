import { Link, useLocation } from '@tanstack/react-router'
import { motion } from 'motion/react'
import type { ComponentProps } from 'react'
import type { LucideIcon } from 'lucide-react'
import { SPRING_SMOOTH_TWO } from '@/config/animation'

export interface TabBarItem {
  to: ComponentProps<typeof Link>['to']
  label: string
  icon: LucideIcon
  /**
   * Fuzzy active match (DESIGN 5.6: "`/covers/$coverId` Home, set explicitly
   * because the path is not under `/home`"). Defaults to a prefix match on
   * `to` when omitted.
   */
  isActivePath?: (pathname: string) => boolean
}

/** The floating pill tab bar (DESIGN 5.6, r3). Mounted from `__root.tsx`. */
export default function TabBar({
  items,
}: {
  items: ReadonlyArray<TabBarItem>
}) {
  return (
    <nav
      aria-label="Primary"
      className="fixed inset-x-3 z-40 mx-auto flex h-16 w-[calc(100%-24px)] max-w-[392px] items-center rounded-full bg-[var(--color-glass-tab)] p-1 backdrop-blur-xl [box-shadow:inset_0_1px_0_rgba(255,255,255,0.08),0_8px_30px_rgba(0,0,0,0.5)]"
      style={{ bottom: 'calc(12px + env(safe-area-inset-bottom))' }}
    >
      <div className="grid w-full grid-cols-4">
        {items.map((item) => (
          <TabBarLink key={String(item.to)} {...item} />
        ))}
      </div>
    </nav>
  )
}

function TabBarLink({ to, label, icon: Icon, isActivePath }: TabBarItem) {
  // DESIGN 5.6: "Link sets aria-current="page" and data-status="active"
  // itself... style from data-status." Only Home overrides this, for the
  // documented `/covers/$coverId` fuzzy-match exception below.
  const fuzzyActive = useLocation({
    select: (loc) => (isActivePath ? isActivePath(loc.pathname) : false),
  })

  return (
    <Link
      to={to}
      aria-current={fuzzyActive ? 'page' : undefined}
      className="type-caption relative flex h-14 flex-col items-center justify-center gap-1 rounded-full text-[#8E8E93] transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-accent)] data-[status=active]:text-[var(--color-accent)] aria-[current=page]:text-[var(--color-accent)] active:[&_svg]:scale-[0.92] active:[&_span.label]:scale-[0.92] [@media(hover:hover)_and_(pointer:fine)]:hover:text-[#AEAEB2] [@media(hover:hover)_and_(pointer:fine)]:data-[status=active]:hover:text-[var(--color-accent)] [@media(hover:hover)_and_(pointer:fine)]:aria-[current=page]:hover:text-[var(--color-accent)]"
    >
      {({ isActive }) => (
        <>
          {(isActive || fuzzyActive) && (
            <motion.span
              layoutId="tab-bar-pill"
              className="absolute inset-0 rounded-full bg-[var(--color-accent-tint)]"
              transition={SPRING_SMOOTH_TWO}
            />
          )}
          <Icon
            className="relative z-10 size-6 transition-transform duration-120"
            strokeWidth={1.75}
          />
          <span className="label relative z-10 transition-transform duration-120">
            {label}
          </span>
        </>
      )}
    </Link>
  )
}
