import { createFileRoute } from '@tanstack/react-router'
import { z } from 'zod'
import type { Hex } from 'viem'
import type { StepperStep } from '@/components/CoverStepper'
import type { CoverStatusKind } from '@/components/StatusChip'
import CoverStepper from '@/components/CoverStepper'
import GroupedList from '@/components/GroupedList'
import InlineBanner from '@/components/InlineBanner'
import StatusChip, { COVER_STATUS_COLOR } from '@/components/StatusChip'
import {
  COVER_STATUS,
  useCoverChainState,
  useCoverMarketParams,
} from '@/hooks/useCoverChainState'
import { useCoverLogs } from '@/hooks/useCoverLogs'
import { useKeeperConsole } from '@/hooks/useKeeperConsole'
import { RelayError } from '@/lib/api/relay'
import { formatCNS, pnsToPrice, shortenHash } from '@/utils/units'

const coverIdSchema = z.object({
  coverId: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
})

/**
 * ARCHITECTURE section 5.3, phase 2 section 5.6 (build gate None, no keeper
 * needed: every chain read here is public). Deferred from this pass:
 * - Cancel (explicitly P1 in the route table): needs an owner/operator
 *   session and a new confirm-sheet flow; this page states the M-03 escrow
 *   rule nowhere yet because there is no cancel button to attach it to.
 * - `EndReason` text for Cancelled/Expired/Voided: the struct does not
 *   record the ending block, so showing the reason needs another log fetch
 *   beyond the three blocks ADR-W7 already gives us (`startBlock`,
 *   `armedBlock`, `triggerBlock`). The status chip and stepper still show
 *   the correct terminal state without it.
 */
export const Route = createFileRoute('/covers/$coverId')({
  params: { parse: (raw) => coverIdSchema.parse(raw) },
  component: CoverPage,
})

const STATUS_KIND: Record<number, CoverStatusKind> = {
  [COVER_STATUS.Live]: 'live',
  [COVER_STATUS.Armed]: 'armed',
  [COVER_STATUS.Triggered]: 'triggered',
  [COVER_STATUS.Finalized]: 'finalized',
  [COVER_STATUS.Cancelled]: 'cancelled',
  [COVER_STATUS.Expired]: 'expired',
  [COVER_STATUS.Voided]: 'voided',
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="mx-auto min-h-screen max-w-[480px] px-5 py-10">
      <h1 className="type-title-1 mb-8">Cover</h1>
      {children}
    </div>
  )
}

function CoverPage() {
  // Branded for the chain reads below; `params.parse` already validated the
  // `^0x[0-9a-fA-F]{64}$` shape (ARCHITECTURE section 4 route params).
  const coverId = Route.useParams().coverId as Hex
  const { data: cover, isLoading, error } = useCoverChainState(coverId)
  const { data: marketParams } = useCoverMarketParams(cover?.perpId ?? 0)
  const { data: keeperConsole, error: keeperError } = useKeeperConsole()
  const { data: logs } = useCoverLogs(
    coverId,
    cover?.status,
    cover?.startBlock,
    cover?.armedBlock,
    cover?.triggerBlock,
    keeperConsole,
  )

  if (isLoading || !cover) {
    return (
      <Shell>
        <p className="type-callout text-[#AEAEB2]">Loading cover…</p>
      </Shell>
    )
  }

  if (error || cover.status === COVER_STATUS.None) {
    return (
      <Shell>
        <InlineBanner
          title="Cover not found"
          body="This cover id does not exist on chain."
        />
      </Shell>
    )
  }

  const kind = STATUS_KIND[cover.status]
  const priceDecimals = 1 // BTC-PERP (perpId 1): priceDecimals 1 (ARCHITECTURE phase 2 units header).
  const stopPrice = pnsToPrice(BigInt(cover.stopPNS), priceDecimals)
  const totalPaidCNS = cover.paidCNS + cover.owedCNS
  const isTerminal =
    cover.status === COVER_STATUS.Finalized ||
    cover.status === COVER_STATUS.Cancelled ||
    cover.status === COVER_STATUS.Expired ||
    cover.status === COVER_STATUS.Voided

  const keeperRows = keeperConsole?.recent.filter(
    (r) => r.coverId?.toLowerCase() === coverId.toLowerCase(),
  )

  return (
    <Shell>
      <div className="flex flex-col gap-6">
        <StatusHero
          kind={kind}
          cover={cover}
          totalPaidCNS={totalPaidCNS}
          stopPrice={stopPrice}
        />

        <CoverStepper
          steps={buildSteps(cover, logs, marketParams?.armTtlBlocks)}
        />

        {cover.refundOwedCNS > 0n && (
          <InlineBanner
            title={`${formatCNS(cover.refundOwedCNS)} owed to you`}
            body="This account has a recorded refund balance on the cover manager."
          />
        )}

        {isTerminal && cover.status !== COVER_STATUS.Finalized && (
          <p className="type-footnote px-1 text-[#8E8E93]">
            This cover ended without triggering. The exact reason isn't shown
            here yet; the chip above reflects the real on-chain status.
          </p>
        )}

        {keeperError instanceof RelayError ? (
          <InlineBanner
            title="Keeper status unavailable"
            body="The stepper above still reflects real chain state."
          />
        ) : (
          keeperRows &&
          keeperRows.length > 0 && (
            <GroupedList
              title="Keeper"
              rows={keeperRows.map((r, i) => ({
                key: `${r.block ?? 'pending'}-${i}`,
                label: r.action,
                value: r.block ?? '—',
                note: r.txHash ? shortenHash(r.txHash) : r.outcome,
              }))}
            />
          )
        )}
      </div>
    </Shell>
  )
}

function StatusHero({
  kind,
  cover,
  totalPaidCNS,
  stopPrice,
}: {
  kind: CoverStatusKind
  cover: ReturnType<typeof useCoverChainState>['data']
  totalPaidCNS: bigint
  stopPrice: number
}) {
  if (!cover) return null
  const heroValue =
    cover.status >= COVER_STATUS.Triggered
      ? formatCNS(totalPaidCNS)
      : formatCNS(cover.capCNS)
  const heroLabel =
    cover.status >= COVER_STATUS.Triggered ? 'Paid' : 'Covered up to'
  return (
    <div
      className="card-big flex flex-col justify-between p-6"
      style={{ '--card-min-h': '280px' } as React.CSSProperties}
    >
      <StatusChip status={kind} />
      <div>
        <p className="type-label mb-1 text-[#AEAEB2]">{heroLabel}</p>
        <p className="type-num-hero text-white">{heroValue}</p>
        <p className="type-callout mt-2 text-[#AEAEB2]">
          {cover.isLong ? 'Long' : 'Short'} · stop at ${stopPrice.toFixed(1)}
        </p>
      </div>
    </div>
  )
}

export function buildSteps(
  cover: NonNullable<ReturnType<typeof useCoverChainState>['data']>,
  logs: ReturnType<typeof useCoverLogs>['data'],
  armTtlBlocks: number | undefined,
): ReadonlyArray<StepperStep> {
  const status = cover.status

  const liveState = status === COVER_STATUS.Live ? 'current' : 'done'
  const steps: Array<StepperStep> = [
    {
      key: 'live',
      title: 'Live',
      block: cover.startBlock,
      txHash: logs?.bought?.txHash,
      state: liveState,
      color: COVER_STATUS_COLOR.live,
    },
  ]

  if (status === COVER_STATUS.Cancelled) {
    steps.push({
      key: 'end',
      title: 'Cancelled',
      state: 'done',
      color: COVER_STATUS_COLOR.cancelled,
    })
    return steps
  }
  if (status === COVER_STATUS.Expired) {
    steps.push({
      key: 'end',
      title: 'Expired',
      block: cover.expiryBlock,
      state: 'done',
      color: COVER_STATUS_COLOR.expired,
    })
    return steps
  }
  if (status === COVER_STATUS.Voided) {
    steps.push({
      key: 'end',
      title: 'Voided',
      state: 'done',
      color: COVER_STATUS_COLOR.voided,
    })
    return steps
  }

  if (cover.armedBlock > 0) {
    steps.push({
      key: 'armed',
      title: 'Armed',
      block: cover.armedBlock,
      txHash: logs?.armed?.txHash,
      note:
        armTtlBlocks !== undefined
          ? `Triggers within ${armTtlBlocks} blocks of arming`
          : undefined,
      state:
        status === COVER_STATUS.Armed
          ? 'current'
          : status >= COVER_STATUS.Triggered
            ? 'done'
            : 'pending',
      color: COVER_STATUS_COLOR.armed,
    })
  }

  const triggerNote =
    status >= COVER_STATUS.Triggered
      ? cover.armedBlock > 0
        ? `Armed #${cover.armedBlock}, triggered #${cover.triggerBlock}, ${cover.triggerBlock - cover.armedBlock} block${cover.triggerBlock - cover.armedBlock === 1 ? '' : 's'}`
        : 'Triggered on the fast path (mark through the stop), no arm needed'
      : undefined

  steps.push({
    key: 'triggered',
    title: 'Triggered',
    block: status >= COVER_STATUS.Triggered ? cover.triggerBlock : undefined,
    txHash: logs?.triggered?.txHash,
    note:
      status >= COVER_STATUS.Triggered && logs?.triggered
        ? `${triggerNote} · paid ${formatCNS(logs.triggered.paidNowCNS)} now`
        : triggerNote,
    state:
      status === COVER_STATUS.Triggered
        ? 'current'
        : status === COVER_STATUS.Finalized
          ? 'done'
          : 'pending',
    color: COVER_STATUS_COLOR.triggered,
  })

  steps.push({
    key: 'finalized',
    title: 'Finalized',
    txHash: logs?.finalized?.txHash ?? undefined,
    note:
      status === COVER_STATUS.Finalized
        ? logs?.finalized?.txHash
          ? undefined
          : 'Final (block confirmed), hash not yet available from the keeper'
        : status === COVER_STATUS.Triggered
          ? 'Finalizing…'
          : undefined,
    state: status === COVER_STATUS.Finalized ? 'done' : 'pending',
    color: COVER_STATUS_COLOR.finalized,
  })

  return steps
}
