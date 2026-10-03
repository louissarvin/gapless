import {
  createPublicClient,
  decodeErrorResult,
  fallback,
  http,
  isHex,
} from 'viem'
import { monad } from 'viem/chains'
import type { Hex } from 'viem'
import { ICoverManagerAbi } from '@/abi/ICoverManager'
import { ICoverVaultAbi } from '@/abi/ICoverVault'
import { IGaplessAccountAbi } from '@/abi/IGaplessAccount'
import { IGaplessInheritedAbi } from '@/abi/IGaplessInherited'
import { IPerplErrorsAbi } from '@/abi/IPerplErrors'
import { env } from '@/env'

/**
 * Real block time is about 300ms (viem's `blockTime` is 400). Explicit so we
 * never fall back to viem's default guess (ARCHITECTURE 5.5).
 */
export const POLLING_INTERVAL_MS = 300

/**
 * Factory kept separate from the singleton below so it can be unit tested
 * without requiring the env module to be configured (ARCHITECTURE 5.5).
 * Public RPC endpoints only: never pass a tokenized or private URL, this
 * client lives in the browser bundle.
 */
export function createMonadPublicClient(httpUrls: ReadonlyArray<string>) {
  if (httpUrls.length === 0) {
    throw new Error('createMonadPublicClient: at least one RPC URL is required')
  }
  return createPublicClient({
    chain: monad,
    transport: fallback(httpUrls.map((url) => http(url))),
    batch: { multicall: true },
    pollingInterval: POLLING_INTERVAL_MS,
  })
}

export const publicClient = createMonadPublicClient(env.VITE_RPC_URLS)

export type PublicClient = typeof publicClient

/**
 * Combined ABI for decoding reverts bubbled up from a cover trade or quote
 * (ARCHITECTURE F-2 producer notes, section 6): `ICoverManager` for the
 * manager's own errors, `IGaplessAccount` for the account's, `IGaplessInherited`
 * for OZ's `EnforcedPause`, `IPerplErrors` for Perpl rejections, `ICoverVault`
 * for vault errors bubbled through quotes.
 */
const REVERT_DECODING_ABI = [
  ...ICoverManagerAbi,
  ...IGaplessAccountAbi,
  ...IGaplessInheritedAbi,
  ...IPerplErrorsAbi,
  ...ICoverVaultAbi,
] as const

export interface DecodedRevert {
  errorName: string
  args: ReadonlyArray<unknown>
}

/**
 * Decodes a revert's raw `data` to its custom error name and args, or `null`
 * when it does not match any known error (an undecoded revert, ARCHITECTURE
 * 8.7: surfaced as "something went wrong", never guessed at).
 */
export function decodeRevertError(data: Hex): DecodedRevert | null {
  try {
    const decoded = decodeErrorResult({ abi: REVERT_DECODING_ABI, data })
    // viem's type for this combined ABI claims `args` is always present, but a
    // zero-arg error (e.g. EnforcedPause) really does decode to `undefined` at
    // runtime; proven by the EnforcedPause test in chain.test.ts.
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    return { errorName: decoded.errorName, args: decoded.args ?? [] }
  } catch {
    return null
  }
}

/**
 * Walks a viem error's `cause` chain for revert bytes (copied from the
 * plugin's `revertData`, ARCHITECTURE phase 2 ADR-W19: vectors are copied,
 * not imported, across packages). Custom transports and multicall batching
 * nest the real RPC error several `cause` levels deep.
 */
export function revertDataFromError(err: unknown): Hex | null {
  let cur: unknown = err
  for (let depth = 0; cur && depth < 12; depth++) {
    const c = cur as { data?: unknown; raw?: unknown; cause?: unknown }
    if (typeof c.raw === 'string' && isHex(c.raw) && c.raw.length >= 10)
      return c.raw
    if (typeof c.data === 'string' && isHex(c.data) && c.data.length >= 10)
      return c.data
    if (c.data && typeof c.data === 'object') {
      const inner = (c.data as { data?: unknown }).data
      if (typeof inner === 'string' && isHex(inner) && inner.length >= 10)
        return inner
    }
    cur = c.cause
  }
  return null
}

/** Decodes a thrown viem error straight to a revert, or `null` when it carries no known revert data. */
export function decodeRevertFromError(err: unknown): DecodedRevert | null {
  const data = revertDataFromError(err)
  return data ? decodeRevertError(data) : null
}
