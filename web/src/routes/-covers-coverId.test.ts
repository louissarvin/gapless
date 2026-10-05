import { describe, expect, it } from 'vitest'
import { buildSteps } from './covers/$coverId'
import type { CoverLogsResult } from '@/hooks/useCoverLogs'
import type { CoverChainState } from '@/hooks/useCoverChainState'
import { COVER_STATUS } from '@/hooks/useCoverChainState'

const TX_BOUGHT =
  '0x1111111111111111111111111111111111111111111111111111111111111111' as const
const TX_ARMED =
  '0x2222222222222222222222222222222222222222222222222222222222222222' as const
const TX_TRIGGERED =
  '0x3333333333333333333333333333333333333333333333333333333333333333' as const
const TX_FINALIZED =
  '0x4444444444444444444444444444444444444444444444444444444444444444' as const
const ACCOUNT = '0xab3CB7b3b28366eD7f6C59DbD2D708890919B289' as const

const BASE: CoverChainState = {
  account: ACCOUNT,
  perpId: 1,
  status: COVER_STATUS.Live,
  isLong: true,
  maxGapBps: 200,
  observed: false,
  lots: 2_200_000,
  filledLots: 0,
  stopPNS: 621_190,
  startBlock: 100,
  expiryBlock: 12_100,
  armedBlock: 0,
  capCNS: 1_000_000n,
  escrowCNS: 900_000n,
  rentCNS: 100_000n,
  triggerBlock: 0,
  refTrigPNS: 0,
  refPostPNS: 0,
  paidCNS: 0n,
  owedCNS: 0n,
  gRealCumCNS: 0n,
  refundOwedCNS: 0n,
  finalizedBlock: 50n,
}

describe('buildSteps: status derivation', () => {
  it('Live shows the first step as current, no Armed step yet, Triggered/Finalized pending', () => {
    const steps = buildSteps(BASE, undefined, undefined)
    expect(steps.map((s) => s.key)).toEqual(['live', 'triggered', 'finalized'])
    expect(steps[0]).toMatchObject({ key: 'live', state: 'current' })
    expect(steps[1]).toMatchObject({ key: 'triggered', state: 'pending' })
    expect(steps[2]).toMatchObject({ key: 'finalized', state: 'pending' })
  })

  it('Cancelled ends the stepper at two steps, no arm/trigger/finalize shown', () => {
    const steps = buildSteps(
      { ...BASE, status: COVER_STATUS.Cancelled },
      undefined,
      undefined,
    )
    expect(steps.map((s) => s.key)).toEqual(['live', 'end'])
    expect(steps[1]).toMatchObject({ title: 'Cancelled', state: 'done' })
  })

  it('Expired ends the stepper with the expiry block shown', () => {
    const steps = buildSteps(
      { ...BASE, status: COVER_STATUS.Expired },
      undefined,
      undefined,
    )
    expect(steps[1]).toMatchObject({
      title: 'Expired',
      block: BASE.expiryBlock,
    })
  })

  it('Voided ends the stepper with no block (never armed)', () => {
    const steps = buildSteps(
      { ...BASE, status: COVER_STATUS.Voided },
      undefined,
      undefined,
    )
    expect(steps[1]).toMatchObject({ title: 'Voided' })
    expect(steps[1].block).toBeUndefined()
  })

  it('Armed inserts an Armed step as current, with the arm-TTL note', () => {
    const cover = { ...BASE, status: COVER_STATUS.Armed, armedBlock: 500 }
    const steps = buildSteps(cover, undefined, 2_000)
    expect(steps.map((s) => s.key)).toEqual([
      'live',
      'armed',
      'triggered',
      'finalized',
    ])
    expect(steps[1]).toMatchObject({
      state: 'current',
      block: 500,
      note: 'Triggers within 2000 blocks of arming',
    })
    expect(steps[2]).toMatchObject({ key: 'triggered', state: 'pending' })
  })

  it('omits the Armed step entirely on the fast path (no arm, straight to Triggered)', () => {
    const cover = {
      ...BASE,
      status: COVER_STATUS.Triggered,
      armedBlock: 0,
      triggerBlock: 700,
    }
    const steps = buildSteps(cover, undefined, 2_000)
    expect(steps.map((s) => s.key)).toEqual(['live', 'triggered', 'finalized'])
    expect(steps[1].note).toBe(
      'Triggered on the fast path (mark through the stop), no arm needed',
    )
  })

  it('block-delta math: the Triggered note reports blocks elapsed since Armed', () => {
    const cover = {
      ...BASE,
      status: COVER_STATUS.Triggered,
      armedBlock: 500,
      triggerBlock: 503,
    }
    const steps = buildSteps(cover, undefined, 2_000)
    const triggered = steps.find((s) => s.key === 'triggered')
    expect(triggered?.note).toContain('Armed #500, triggered #503, 3 blocks')
  })

  it('singularizes "block" when the delta is exactly one', () => {
    const cover = {
      ...BASE,
      status: COVER_STATUS.Triggered,
      armedBlock: 500,
      triggerBlock: 501,
    }
    const steps = buildSteps(cover, undefined, 2_000)
    const triggered = steps.find((s) => s.key === 'triggered')
    expect(triggered?.note).toContain('1 block')
    expect(triggered?.note).not.toContain('1 blocks')
  })

  it('Finalized marks every prior step done and includes the paid-now amount from logs', () => {
    const cover = {
      ...BASE,
      status: COVER_STATUS.Finalized,
      armedBlock: 500,
      triggerBlock: 503,
      paidCNS: 900_000n,
      owedCNS: 100_000n,
    }
    const logs: CoverLogsResult = {
      bought: { txHash: TX_BOUGHT, blockNumber: 100n },
      armed: { txHash: TX_ARMED, blockNumber: 500n },
      triggered: {
        txHash: TX_TRIGGERED,
        blockNumber: 503n,
        filledLots: 2_200_000n,
        paidNowCNS: 900_000n,
        owedCNS: 100_000n,
      },
      finalized: { txHash: TX_FINALIZED, source: 'console' },
    }
    const steps = buildSteps(cover, logs, 2_000)
    expect(steps.every((s) => s.state === 'done')).toBe(true)
    const triggered = steps.find((s) => s.key === 'triggered')
    expect(triggered?.note).toContain('paid 0.90')
    expect(triggered?.txHash).toBe(TX_TRIGGERED)
    const finalized = steps.find((s) => s.key === 'finalized')
    expect(finalized?.txHash).toBe(TX_FINALIZED)
  })

  it('Finalized with no hash yet says so instead of showing a broken link', () => {
    const cover = { ...BASE, status: COVER_STATUS.Finalized, triggerBlock: 503 }
    const logs: CoverLogsResult = {
      bought: null,
      armed: null,
      triggered: null,
      finalized: { txHash: null, source: 'scan' },
    }
    const steps = buildSteps(cover, logs, 2_000)
    const finalized = steps.find((s) => s.key === 'finalized')
    expect(finalized?.note).toBe(
      'Final (block confirmed), hash not yet available from the keeper',
    )
    expect(finalized?.txHash).toBeUndefined()
  })
})
