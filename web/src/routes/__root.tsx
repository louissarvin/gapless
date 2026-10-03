import { Suspense, lazy } from 'react'
import {
  HeadContent,
  Scripts,
  createRootRouteWithContext,
  useLocation,
} from '@tanstack/react-router'
import { QueryClientProvider } from '@tanstack/react-query'
import { ChartCandlestick, House, Settings, Vault } from 'lucide-react'

import type { QueryClient } from '@tanstack/react-query'
import type { TabBarItem } from '@/components/TabBar'
import ErrorPage from '@/components/ErrorPage'
import PauseBanner from '@/components/PauseBanner'
import TabBar from '@/components/TabBar'

import appCss from '@/styles.css?url'

/**
 * DESIGN 5.6: four app tabs. Home's active match is explicit because
 * `/covers/$coverId` is not under `/home` but still belongs to it (the
 * active cover card lives on `/home`).
 */
const ROUTE_ITEMS: ReadonlyArray<TabBarItem> = [
  {
    to: '/home',
    label: 'Home',
    icon: House,
    isActivePath: (pathname) =>
      pathname.startsWith('/home') || pathname.startsWith('/covers'),
  },
  { to: '/trade', label: 'Trade', icon: ChartCandlestick },
  {
    to: '/vault',
    label: 'Vault',
    icon: Vault,
    // ADR-W11: /stats and /gap-index are public analytics routes that live
    // under the Vault tab rather than getting their own nav slots.
    isActivePath: (pathname) =>
      pathname.startsWith('/vault') ||
      pathname.startsWith('/stats') ||
      pathname.startsWith('/gap-index'),
  },
  { to: '/settings', label: 'Settings', icon: Settings },
]

interface MyRouterContext {
  queryClient: QueryClient
}

// Dynamically imported, dev-only (ARCHITECTURE ADR-W3): never in the production bundle.
const DevtoolsPanel = import.meta.env.DEV
  ? lazy(() => import('@/components/DevtoolsPanel'))
  : null

export const Route = createRootRouteWithContext<MyRouterContext>()({
  errorComponent: ({ error, reset }) => (
    <ErrorPage error={error} reset={reset} />
  ),
  head: () => ({
    meta: [
      { charSet: 'utf-8' },
      {
        name: 'viewport',
        content: 'width=device-width, initial-scale=1, viewport-fit=cover',
      },
      { title: 'Gapless' },
      {
        name: 'description',
        content: 'Guaranteed stop-loss covers for perps on Monad.',
      },
      { name: 'theme-color', content: '#000000' },
      { name: 'mobile-web-app-capable', content: 'yes' },
      { name: 'apple-mobile-web-app-capable', content: 'yes' },
      {
        name: 'apple-mobile-web-app-status-bar-style',
        content: 'black-translucent',
      },
      { name: 'apple-mobile-web-app-title', content: 'Gapless' },
    ],
    links: [
      { rel: 'stylesheet', href: appCss },
      { rel: 'manifest', href: '/manifest.webmanifest' },
      { rel: 'apple-touch-icon', href: '/assets/icons/apple-touch-icon.png' },
      { rel: 'icon', type: 'image/png', href: '/favicon-32.png' },
    ],
  }),

  shellComponent: RootDocument,
})

function RootDocument({ children }: { children: React.ReactNode }) {
  const context = Route.useRouteContext()
  // Landing page floats a fixed glass nav pill over the top of the viewport
  // (DESIGN 5.6); clear it before the in-flow pause banner (5.8) so they
  // don't overlap.
  const isLanding = useLocation({ select: (loc) => loc.pathname === '/' })
  // DESIGN 5.6, ADR-W11: hidden on `/` and `/onboard` (own nav/progress pill
  // chrome) and on `/proof` (a presentation surface: the demo's first frame
  // is only the result card). Shown on every other app route, including a
  // session route with no session yet, so the user can leave the unlock card.
  const hideTabBar = useLocation({
    select: (loc) =>
      loc.pathname === '/' ||
      loc.pathname.startsWith('/onboard') ||
      loc.pathname.startsWith('/proof'),
  })

  return (
    <html lang="en" className="dark">
      <head>
        <HeadContent />
      </head>
      <body className="bg-background text-foreground antialiased">
        <QueryClientProvider client={context.queryClient}>
          <div
            className={
              isLanding
                ? 'pt-[calc(12px+env(safe-area-inset-top)+56px)]'
                : undefined
            }
          >
            <PauseBanner />
          </div>
          <div
            className={
              hideTabBar
                ? undefined
                : // DESIGN 5.6 + space-12 (362): clear the floating tab bar's
                  // own 12px offset and 64px height, then its 48px bottom
                  // clearance, so no page's content ever sits under or flush
                  // against it.
                  'pb-[calc(12px+env(safe-area-inset-bottom)+64px+48px)]'
            }
          >
            {children}
          </div>
          {!hideTabBar && <TabBar items={ROUTE_ITEMS} />}
          {DevtoolsPanel && (
            <Suspense fallback={null}>
              <DevtoolsPanel />
            </Suspense>
          )}
        </QueryClientProvider>
        <Scripts />
      </body>
    </html>
  )
}
