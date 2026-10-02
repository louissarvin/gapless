import { createEnv } from '@t3-oss/env-core'
import { z } from 'zod'

/**
 * Client-only env schema (ARCHITECTURE 9.1). Every value here is compiled into
 * public JavaScript: never add a secret, a tokenized RPC URL, or an internal
 * bearer token. See env.test.ts for the enforced /KEY|TOKEN|SECRET|PRIVATE|PASSWORD/i check.
 */
export const clientEnvShape = {
  VITE_RP_ID: z.string().min(1),
  VITE_RELAY_URL: z.string().url(),
  VITE_RELAY_WS_URL: z.string().url(),
  VITE_RPC_URLS: z
    .string()
    .min(1)
    .transform((value) => value.split(',').map((url) => url.trim())),
  VITE_EXPLORER_URL: z.string().url().default('https://monadvision.com'),
  VITE_ENVIO_GRAPHQL_URL: z.string().url().optional(),
}

export const env = createEnv({
  clientPrefix: 'VITE_',
  client: clientEnvShape,
  runtimeEnv: import.meta.env,
  emptyStringAsUndefined: true,
})
