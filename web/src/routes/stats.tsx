import { Link, createFileRoute } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { ChevronRight, ExternalLink } from 'lucide-react'
import type { CSSProperties } from 'react'
import type { CoverStatusKind } from '@/components/StatusChip'
import type { StatsData } from '@/lib/api/relay'
import GroupedList, { NumUnit } from '@/components/GroupedList'
import InlineBanner from '@/components/InlineBanner'
import StatusChip from '@/components/StatusChip'
import { useKeeperConsole } from '@/hooks/useKeeperConsole'
import { RelayError, getStats } from '@/lib/api/relay'
import { EXPLORER_URL } from '@/config'
import { cnm } from '@/utils/style'
import { formatCNS, shortenHash } from '@/utils/units'

export const Route = createFileRoute('/stats')({ component: StatsPage })

function StatsPage() {
  const stats = useQuery({
    queryKey: ['stats'],
    queryFn: getStats,
    refetchInterval: 60_000,
    staleTime: 60_000,
    retry: (failureCount, error) =>
      !(error instanceof RelayError && error.code === 'STATS_NOT_READY') &&
      failureCount < 2,
  })

  const notReady =
    stats.isError &&
    stats.error instanceof RelayError &&
    stats.error.code === 'STATS_NOT_READY'

  return (
    <div className="mx-auto flex max-w-[480px] flex-col gap-6 px-5 pt-8">
      <h1 className="type-title-1">Protocol stats</h1>

      {notReady && <TotalCoversCard total={0} live={0} />}
      {stats.isError && !notReady && (
        <InlineBanner
          title="Stats are unavailable"
          body="Try again in a moment."
        />
      )}
      {stats.data && <StatsBody data={stats.data} />}

      <KeeperSection />
    </div>
  )
}

/** DESIGN 5.4.1 / R.3 item 1: hero anchored to the bottom, "0" reads as a number, not a word. */
function TotalCoversCard({ total, live }: { total: number; live: number }) {
  return (
    <div
      className="card-big flex flex-col justify-between p-6"
      style={{ '--card-min-h': '200px' } as CSSProperties}
    >
      <span className="type-label text-[#AEAEB2]">Total covers</span>
      <div>
        <span className="type-num-hero">{total.toLocaleString()}</span>
        <p className="type-callout mt-2 text-[#AEAEB2]">
          {total === 0
            ? 'No covers yet. The first one appears here within a minute of purchase.'
            : `${live.toLocaleString()} live now`}
        </p>
      </div>
    </div>
  )
}

function StatsBody({ data }: { data: StatsData }) {
  const { gapless, perplNativeStops } = data
  const total = gapless.covers.total

  const coverRows: ReadonlyArray<{
    key: string
    status: CoverStatusKind
    count: number
  }> = [
    { key: 'live', status: 'live', count: gapless.covers.live },
    { key: 'armed', status: 'armed', count: gapless.covers.armed },
    { key: 'triggered', status: 'triggered', count: gapless.covers.triggered },
    { key: 'finalized', status: 'finalized', count: gapless.covers.finalized },
    { key: 'expired', status: 'expired', count: gapless.covers.expired },
    { key: 'cancelled', status: 'cancelled', count: gapless.covers.cancelled },
    { key: 'voided', status: 'voided', count: gapless.covers.voided },
  ]

  return (
    <>
      <TotalCoversCard total={total} live={gapless.covers.live} />

      <div className="rounded-[24px] bg-[#1C1C1E] p-5">
        <h3 className="type-label mb-3 text-[#AEAEB2]">Covers</h3>
        <div className="flex flex-col">
          {coverRows.map((row, i) => (
            <div
              key={row.key}
              className={`flex items-center justify-between py-3 ${i > 0 ? 'border-t border-[#3A3A3C]' : ''}`}
            >
              <StatusChip status={row.status} />
              <span
                className={cnm(
                  'type-num',
                  row.count === 0 ? 'text-[#8E8E93]' : 'text-white',
                )}
              >
                {row.count.toLocaleString()}
              </span>
            </div>
          ))}
        </div>
      </div>

      <GroupedList
        title="Money"
        lead={{
          label: 'Notional covered',
          value: formatCNS(BigInt(gapless.notionalCoveredCNS), ''),
          unit: 'AUSD',
        }}
        rows={[
          {
            key: 'rent',
            label: 'Rent',
            value: formatCNS(BigInt(gapless.premiums.rentCNS)),
          },
          {
            key: 'toVault',
            label: 'Escrow to vault',
            value: formatCNS(BigInt(gapless.premiums.escrowToVaultCNS)),
          },
          {
            key: 'toLps',
            label: 'Premiums to LPs',
            value: formatCNS(BigInt(gapless.premiums.toLpsCNS)),
          },
          {
            key: 'toTreasury',
            label: 'To treasury',
            value: formatCNS(BigInt(gapless.premiums.toTreasuryCNS)),
          },
          {
            key: 'payoutCount',
            label: 'Payouts',
            value: gapless.payouts.count.toLocaleString(),
          },
          {
            key: 'payoutPaid',
            label: 'Paid',
            value: formatCNS(BigInt(gapless.payouts.paidCNS)),
          },
          {
            key: 'payoutOwed',
            label: 'Owed',
            value: formatCNS(BigInt(gapless.payouts.owedCNS)),
          },
        ]}
      />

      <GroupedList
        title="Trigger pipeline"
        lead={{
          label: 'Arm to trigger, median',
          value:
            gapless.armToTriggerBlocks.p50 !== null
              ? gapless.armToTriggerBlocks.p50
              : '—',
          unit: gapless.armToTriggerBlocks.p50 !== null ? 'blocks' : undefined,
          note:
            gapless.armToTriggerBlocks.p50 !== null
              ? `about ${Math.round(gapless.armToTriggerBlocks.p50 * 0.3)} s, n=${gapless.armToTriggerBlocks.n}`
              : undefined,
        }}
        rows={[
          {
            key: 'armToTriggerMax',
            label: 'Arm to trigger, max',
            value:
              gapless.armToTriggerBlocks.max !== null ? (
                <NumUnit value={gapless.armToTriggerBlocks.max} unit="blocks" />
              ) : (
                '—'
              ),
          },
          {
            key: 'reports',
            label: 'CRE reports',
            value: gapless.cre.reports.toLocaleString(),
          },
          {
            key: 'armed',
            label: 'Armed',
            value: gapless.cre.armed.toLocaleString(),
          },
          {
            key: 'triggered',
            label: 'Triggered',
            value: gapless.cre.triggered.toLocaleString(),
          },
        ]}
      />

      <GroupedList
        title="Vault"
        rows={[
          {
            key: 'tvl',
            label: 'TVL',
            value:
              gapless.vault.totalAssetsCNS !== null
                ? formatCNS(BigInt(gapless.vault.totalAssetsCNS))
                : '—',
          },
          {
            key: 'lps',
            label: 'LPs',
            value: gapless.vault.lpCount.toLocaleString(),
          },
          {
            key: 'util',
            label: 'Utilization',
            value:
              gapless.vault.utilizationBps !== null
                ? `${(gapless.vault.utilizationBps / 100).toFixed(2)}%`
                : '—',
          },
        ]}
      />
      <LinkRow to="/vault" label="Open Vault" />

      {perplNativeStops && (
        <>
          <GroupedList
            title="Native stops, this week"
            lead={{
              label: 'Worst fill past the trigger, p95',
              value:
                perplNativeStops.slippageVsTriggerBps.p95 !== null
                  ? perplNativeStops.slippageVsTriggerBps.p95.toFixed(2)
                  : '—',
              unit:
                perplNativeStops.slippageVsTriggerBps.p95 !== null
                  ? 'bps'
                  : undefined,
              note:
                perplNativeStops.slippageVsTriggerBps.p50 !== null
                  ? `median ${perplNativeStops.slippageVsTriggerBps.p50.toFixed(2)} bps`
                  : undefined,
            }}
            rows={[
              {
                key: 'executions',
                label: 'Executions',
                value: perplNativeStops.executions.toLocaleString(),
              },
              {
                key: 'joinRate',
                label: 'Join rate',
                value:
                  perplNativeStops.joinRate !== null
                    ? `${(perplNativeStops.joinRate * 100).toFixed(1)}%`
                    : '—',
              },
              {
                key: 'delay50',
                label: 'Delay, median',
                value:
                  perplNativeStops.delayBlocks.p50 !== null ? (
                    <NumUnit
                      value={perplNativeStops.delayBlocks.p50}
                      unit="blocks"
                    />
                  ) : (
                    '—'
                  ),
                note:
                  perplNativeStops.delayBlocks.p95 !== null
                    ? `p95 ${perplNativeStops.delayBlocks.p95} blocks`
                    : undefined,
              },
            ]}
          />
          <LinkRow to="/gap-index" label="Open Gap Index" />
        </>
      )}

      <FirstsList firsts={gapless.firsts} />

      {data.stale && (
        <InlineBanner
          title="Data is behind"
          body="Updated more than 15 min ago. The jobs process may be behind."
        />
      )}
      <p className="type-footnote px-1 text-[#8E8E93]">
        Updated {relativeTime(data.generatedAt)}
      </p>
    </>
  )
}

function relativeTime(iso: string): string {
  const minutes = Math.round((Date.now() - new Date(iso).getTime()) / 60_000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.round(minutes / 60)
  return `${hours} h ago`
}

function LinkRow({
  to,
  label,
}: {
  to: '/vault' | '/gap-index'
  label: string
}) {
  return (
    <Link
      to={to}
      className="flex min-h-[52px] items-center justify-between rounded-[24px] bg-[#1C1C1E] px-5 py-3 active:scale-[0.98]"
    >
      <span className="type-body text-white">{label}</span>
      <ChevronRight className="size-5 shrink-0 text-[#8E8E93]" />
    </Link>
  )
}

function FirstsList({
  firsts,
}: {
  firsts: {
    deployTx: string | null
    firstCoverTx: string | null
    firstTriggerTx: string | null
  }
}) {
  const row = (label: string, tx: string | null) => (
    <div className="flex items-center justify-between py-3 [&:not(:first-child)]:border-t [&:not(:first-child)]:border-[#3A3A3C]">
      <span className="type-body text-white">{label}</span>
      {tx ? (
        <a
          href={new URL(`/tx/${tx}`, EXPLORER_URL).toString()}
          target="_blank"
          rel="noopener noreferrer"
          className="type-mono-sm flex items-center gap-1 text-[#A48FFF]"
        >
          {shortenHash(tx)}
          <ExternalLink className="size-3.5 shrink-0" />
        </a>
      ) : (
        <span className="type-body text-[#8E8E93]">Not yet</span>
      )}
    </div>
  )
  return (
    <div className="rounded-[24px] bg-[#1C1C1E] p-5">
      <h3 className="type-label mb-3 text-[#AEAEB2]">Firsts</h3>
      <div className="flex flex-col">
        {row('Deploy', firsts.deployTx)}
        {row('First cover', firsts.firstCoverTx)}
        {row('First trigger', firsts.firstTriggerTx)}
      </div>
    </div>
  )
}

function KeeperSection() {
  const keeper = useKeeperConsole()

  if (keeper.isError) {
    const unavailable =
      keeper.error instanceof RelayError &&
      (keeper.error.code === 'KEEPER_UNAVAILABLE' ||
        keeper.error.code === 'KEEPER_CONSOLE_DISABLED')
    return (
      <div className="flex flex-col gap-3">
        <h3 className="type-label text-[#AEAEB2]">Keeper</h3>
        <InlineBanner
          title="Keeper status unavailable"
          body={
            unavailable
              ? 'No new covers can be armed or triggered right now; existing covers keep their lifecycle.'
              : 'Keeper status could not be read right now.'
          }
        />
      </div>
    )
  }

  if (!keeper.data) {
    return (
      <div className="rounded-[24px] bg-[#1C1C1E] p-5">
        <h3 className="type-label mb-3 text-[#AEAEB2]">Keeper</h3>
        <div className="h-5 w-full animate-pulse rounded-[8px] bg-[#2C2C2E]" />
      </div>
    )
  }

  const c = keeper.data
  return (
    <GroupedList
      title="Keeper"
      rows={[
        { key: 'status', label: 'Status', value: c.status },
        {
          key: 'head',
          label: 'Head lag',
          value: c.head.lagBlocks !== null ? `${c.head.lagBlocks} blocks` : '—',
        },
        {
          key: 'signer',
          label: 'Signer balance',
          value:
            c.signer.balanceWei !== null
              ? `${(Number(c.signer.balanceWei) / 1e18).toFixed(3)} MON`
              : '—',
        },
        {
          key: 'governor',
          label: 'Governor used / cap',
          value: `${(Number(c.governor.usedWei) / 1e18).toFixed(3)} / ${(Number(c.governor.capWei) / 1e18).toFixed(3)} MON`,
        },
        {
          key: 'walkGap',
          label: 'Walk gap, p50 / max',
          value: `${c.walks.chainGapP50 ?? '—'} / ${c.walks.chainGapMax ?? '—'} blocks`,
        },
        {
          key: 'recent',
          label: 'Recent actions',
          value: c.recent.length.toLocaleString(),
        },
      ]}
    />
  )
}
