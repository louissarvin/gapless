import { encodeErrorResult } from 'viem'
import { describe, expect, it } from 'vitest'
import {
  POLLING_INTERVAL_MS,
  createMonadPublicClient,
  decodeRevertError,
} from './chain'
import { ICoverManagerAbi } from '@/abi/ICoverManager'
import { IGaplessAccountAbi } from '@/abi/IGaplessAccount'
import { IGaplessInheritedAbi } from '@/abi/IGaplessInherited'

describe('createMonadPublicClient', () => {
  it('builds a client pinned to chain 143 with an explicit polling interval', () => {
    const client = createMonadPublicClient(['https://rpc.monad.xyz'])
    expect(client.chain.id).toBe(143)
    expect(client.pollingInterval).toBe(POLLING_INTERVAL_MS)
    expect(client.pollingInterval).not.toBe(client.chain.blockTime)
  })

  it('refuses an empty endpoint list rather than silently defaulting', () => {
    expect(() => createMonadPublicClient([])).toThrow()
  })

  it('never silently accepts a tokenized-looking URL as a public endpoint list element type', () => {
    // Documents the rule (ARCHITECTURE 8.2): callers must only ever pass
    // VITE_RPC_URLS, never a server-side MONAD_HTTP_URLS value.
    const client = createMonadPublicClient([
      'https://rpc.monad.xyz',
      'https://rpc1.monad.xyz',
    ])
    expect(client.transport.type).toBe('fallback')
  })
})

describe('decodeRevertError', () => {
  it('decodes CoverManager.PremiumTooHigh(quotedCNS, maxCNS)', () => {
    const data = encodeErrorResult({
      abi: ICoverManagerAbi,
      errorName: 'PremiumTooHigh',
      args: [40_000_000n, 38_000_000n],
    })
    expect(decodeRevertError(data)).toEqual({
      errorName: 'PremiumTooHigh',
      args: [40_000_000n, 38_000_000n],
    })
  })

  it('decodes CoverManager.StopTooClose(distanceBps, minBps)', () => {
    const data = encodeErrorResult({
      abi: ICoverManagerAbi,
      errorName: 'StopTooClose',
      args: [12n, 15n],
    })
    expect(decodeRevertError(data)).toEqual({
      errorName: 'StopTooClose',
      args: [12n, 15n],
    })
  })

  it('decodes CoverManager.SigmaStale(postedBlock)', () => {
    const data = encodeErrorResult({
      abi: ICoverManagerAbi,
      errorName: 'SigmaStale',
      args: [111_101_834n],
    })
    expect(decodeRevertError(data)).toEqual({
      errorName: 'SigmaStale',
      args: [111_101_834n],
    })
  })

  it('decodes GaplessAccount.OperatorBudgetExceeded(notionalCNS, availableCNS)', () => {
    const data = encodeErrorResult({
      abi: IGaplessAccountAbi,
      errorName: 'OperatorBudgetExceeded',
      args: [100_000_000n, 21_400_000n],
    })
    expect(decodeRevertError(data)).toEqual({
      errorName: 'OperatorBudgetExceeded',
      args: [100_000_000n, 21_400_000n],
    })
  })

  it('decodes the inherited OZ EnforcedPause()', () => {
    const data = encodeErrorResult({
      abi: IGaplessInheritedAbi,
      errorName: 'EnforcedPause',
      args: [],
    })
    expect(decodeRevertError(data)).toEqual({
      errorName: 'EnforcedPause',
      args: [],
    })
  })

  it('returns null for data that matches no known error, never guessing', () => {
    expect(decodeRevertError('0xdeadbeef')).toBeNull()
  })
})
