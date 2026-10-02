import { TanStackDevtools } from '@tanstack/react-devtools'
import { TanStackRouterDevtoolsPanel } from '@tanstack/react-router-devtools'
import TanStackQueryDevtools from '@/integrations/tanstack-query/devtools'

/**
 * Dev-only. Dynamically imported from __root.tsx behind `import.meta.env.DEV`
 * (ARCHITECTURE ADR-W3) so the production bundle never pulls in devtools.
 */
export default function DevtoolsPanel() {
  return (
    <TanStackDevtools
      config={{ position: 'bottom-right' }}
      plugins={[
        { name: 'Tanstack Router', render: <TanStackRouterDevtoolsPanel /> },
        TanStackQueryDevtools,
      ]}
    />
  )
}
