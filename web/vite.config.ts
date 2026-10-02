import { defineConfig } from 'vite'
import { devtools } from '@tanstack/devtools-vite'
import { tanstackStart } from '@tanstack/react-start/plugin/vite'
import viteReact from '@vitejs/plugin-react'
import viteTsConfigPaths from 'vite-tsconfig-paths'
import tailwindcss from '@tailwindcss/vite'

// Vitest sets this; the Start plugin applies SSR-oriented resolve conditions
// that duplicate the React module graph under jsdom (causes "Invalid hook
// call" in any component-rendering test), so it never runs under test.
const isTest = Boolean(process.env.VITEST)

const config = defineConfig({
  plugins: [
    devtools(),
    // this is the plugin that enables path aliases
    viteTsConfigPaths({
      projects: ['./tsconfig.json'],
    }),
    tailwindcss(),
    // Static SPA (ARCHITECTURE ADR-W2): no Nitro, no server functions. The
    // build emits a prerendered /_shell.html; the host rewrites 404s to it.
    ...(isTest ? [] : [tanstackStart({ spa: { enabled: true } })]),
    viteReact(),
  ],
  test: {
    setupFiles: ['./src/test-setup.ts'],
    // Safe, public, non-secret defaults so unit tests can import `src/env.ts`
    // without a local .env file. Never put a real value here (ARCHITECTURE 8.2).
    env: {
      VITE_RP_ID: 'localhost',
      VITE_RELAY_URL: 'http://localhost:3701',
      VITE_RELAY_WS_URL: 'ws://localhost:3701/ws/market',
      VITE_RPC_URLS: 'https://rpc.monad.xyz,https://rpc1.monad.xyz',
    },
  },
})

export default config
