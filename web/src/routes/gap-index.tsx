import { useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { ChevronDown } from 'lucide-react'
import type { CSSProperties } from 'react'
import type {
  NativeStopsData,
  StalenessData,
  SummaryData,
} from '@/lib/api/relay'
import GroupedList, { NumUnit } from '@/components/GroupedList'
import InlineBanner from '@/components/InlineBanner'
import Sawtooth from '@/components/Sawtooth'
import { useLiveStaleness } from '@/hooks/useLiveStaleness'
import {
  getNativeStops,
  getPremiumCurve,
  getStaleness,
  getSummary,
} from '@/lib/api/relay'
import { cnm } from '@/utils/style'

export const Route = createFileRoute('/gap-index')({ component: GapIndexPage })

/** ADR-W16: Gap Index documents are cached 60s at the relay; poll at most that often. */
const GAP_INDEX_POLL_MS = 60_000

function GapIndexPage() {
  const live = useLiveStaleness()

  const staleness = useQuery({
    queryKey: ['gapIndex', 'staleness'],
    queryFn: getStaleness,
    refetchInterval: GAP_INDEX_POLL_MS,
    staleTime: GAP_INDEX_POLL_MS,
  })
  const nativeStops = useQuery({
    queryKey: ['gapIndex', 'nativeStops'],
    queryFn: getNativeStops,
    refetchInterval: GAP_INDEX_POLL_MS,
    staleTime: GAP_INDEX_POLL_MS,
  })
  const summary = useQuery({
    queryKey: ['gapIndex', 'summary'],
    queryFn: getSummary,
    refetchInterval: GAP_INDEX_POLL_MS,
    staleTime: GAP_INDEX_POLL_MS,
  })

  const btcStaleness = staleness.data?.perps.find((p) => p.perpId === 1) ?? null
  const otherStaleness =
    staleness.data?.perps.filter((p) => p.perpId !== 1) ?? []
  const btcNative = nativeStops.data?.perps.find((p) => p.perpId === 1) ?? null
  const btcSummary = summary.data?.perps.find((p) => p.perpId === 1) ?? null

  return (
    <div className="mx-auto flex max-w-[480px] flex-col gap-6 px-5 pt-8">
      <h1 className="type-title-1">Gap Index</h1>
      <p className="type-callout text-[#AEAEB2]">
        Perpl&rsquo;s price oracle lags the order book. This page measures the
        lag live, on the same contract Gapless covers read.
      </p>

      <LiveStalenessCard
        symbol={live.symbol}
        latest={live.latest}
        samples={live.samples}
      />

      <ThisWeekCard
        headline={btcStaleness}
        others={otherStaleness}
        stale={staleness.data?.stale ?? false}
        isError={staleness.isError}
      />

      <NativeStopsCard
        data={btcNative}
        joinRate={nativeStops.data?.totals.joinRate ?? null}
        isLoading={nativeStops.isLoading}
        isError={nativeStops.isError}
        stale={nativeStops.data?.stale ?? false}
      />

      <SummaryCard
        headline={btcSummary?.headline ?? null}
        isLoading={summary.isLoading}
        isError={summary.isError}
      />

      <PremiumModelCard />

      <MethodCard
        docs={[
          { name: 'Staleness', data: staleness.data },
          { name: 'Native stops', data: nativeStops.data },
          { name: 'Summary', data: summary.data },
        ]}
      />
    </div>
  )
}

function fmtS(v: number | null): string {
  if (v === null) return '—'
  return v.toFixed(1)
}
function fmtBps(v: number | null): string {
  if (v === null) return '—'
  return v.toFixed(2)
}
function fmtPct(v: number | null): string {
  if (v === null) return '—'
  return `${(v * 100).toFixed(1)}%`
}

function LiveStalenessCard({
  symbol,
  latest,
  samples,
}: {
  symbol: string | null
  latest: ReturnType<typeof useLiveStaleness>['latest']
  samples: ReturnType<typeof useLiveStaleness>['samples']
}) {
  const label = symbol ? `${symbol} mark age` : 'Mark age'
  return (
    <section
      className="card-big flex flex-col p-6"
      style={{ '--card-min-h': '320px' } as CSSProperties}
    >
      <div className="flex items-center justify-between">
        <span className="type-label text-[#AEAEB2]">{label}</span>
        <span className="type-num-sm flex items-center gap-1.5 text-[#8E8E93]">
          <span className="size-1.5 rounded-full bg-[#8E8E93]" />
          {latest ? `Live · #${latest.block.toLocaleString()}` : 'Connecting'}
        </span>
      </div>
      <div className="type-num-hero mt-2 text-white">
        <NumUnit value={latest ? fmtS(latest.markAgeS) : '—'} unit="s" />
      </div>
      <div className="mt-2 flex gap-4">
        <span className="type-footnote text-[#AEAEB2]">
          Oracle age{' '}
          <span className="type-num-sm text-white">
            {latest ? `${fmtS(latest.oracleAgeS)} s` : '—'}
          </span>
        </span>
        <span className="type-footnote text-[#AEAEB2]">
          Mark vs book{' '}
          <span className="type-num-sm text-white">
            {latest?.markVsBookBps !== null &&
            latest?.markVsBookBps !== undefined
              ? `${fmtBps(latest.markVsBookBps)} bps`
              : '—'}
          </span>
        </span>
      </div>
      <div className="mt-6 min-h-[120px] flex-1">
        <Sawtooth samples={samples} />
      </div>
    </section>
  )
}

type StalenessPerp = StalenessData['perps'][number]
type NativeStopsPerp = NativeStopsData['perps'][number]
type SummaryHeadline = SummaryData['perps'][number]['headline']

function ThisWeekCard({
  headline,
  others,
  stale,
  isError,
}: {
  headline: StalenessPerp | null
  others: ReadonlyArray<StalenessPerp>
  stale: boolean
  isError: boolean
}) {
  const [showOthers, setShowOthers] = useState(false)
  if (isError) {
    return (
      <InlineBanner
        title="Data is unavailable"
        body="Staleness history is unavailable right now."
      />
    )
  }
  if (!headline) return <SkeletonCard title="This week" />
  return (
    <div className="flex flex-col gap-3">
      <GroupedList
        title="This week · BTC"
        lead={{
          label: 'Typical time between mark updates',
          value: fmtS(headline.mark.intervalSec.p50),
          unit: 's',
          note: `p90 ${fmtS(headline.mark.intervalSec.p90)} s · max ${fmtS(headline.mark.intervalSec.max)} s`,
        }}
        rows={[
          {
            key: 'oracleP50',
            label: 'Oracle publish interval, median',
            value: (
              <NumUnit value={fmtS(headline.oracle.intervalSec.p50)} unit="s" />
            ),
          },
          {
            key: 'reportLag',
            label: 'Oracle report lag, median',
            value: (
              <NumUnit
                value={fmtS(headline.oracle.reportLagSec.p50)}
                unit="s"
              />
            ),
          },
          {
            key: 'divP50',
            label: 'Mark vs oracle divergence, median',
            value: (
              <NumUnit
                value={fmtBps(headline.markOracleDivergenceBps.p50)}
                unit="bps"
              />
            ),
            note: `p99 ${fmtBps(headline.markOracleDivergenceBps.p99)} bps`,
          },
          {
            key: 'staleShare',
            label: 'Time the mark was older than 60 s',
            value: fmtPct(headline.mark.staleFraction),
          },
        ]}
      />
      {stale && (
        <InlineBanner
          title="Data is behind"
          body="Updated more than 15 min ago. The jobs process may be behind."
        />
      )}
      {others.length > 0 && (
        <button
          type="button"
          onClick={() => setShowOthers((v) => !v)}
          aria-expanded={showOthers}
          aria-controls="gap-index-other-markets"
          className="type-callout flex items-center gap-1 self-start text-[#A48FFF]"
        >
          Other markets
          <ChevronDown
            className={cnm(
              'size-5 transition-transform',
              showOthers && 'rotate-180',
            )}
          />
        </button>
      )}
      {showOthers && (
        <GroupedList
          id="gap-index-other-markets"
          rows={others.map((p) => ({
            key: String(p.perpId),
            label: p.symbol,
            value: <NumUnit value={fmtS(p.mark.intervalSec.p50)} unit="s" />,
            note: 'publish interval p50',
          }))}
        />
      )}
    </div>
  )
}

function NativeStopsCard({
  data,
  joinRate,
  isLoading,
  isError,
  stale,
}: {
  data: NativeStopsPerp | null
  joinRate: number | null
  isLoading: boolean
  isError: boolean
  stale: boolean
}) {
  if (isError)
    return (
      <InlineBanner
        title="Data is unavailable"
        body="Native stop data is unavailable right now."
      />
    )
  if (isLoading || !data) return <SkeletonCard title="What native stops did" />
  const delayP50 = data.delayBlocks.p50
  return (
    <div className="flex flex-col gap-3">
      <GroupedList
        title="What native stops did · BTC, this week"
        lead={{
          label: 'Worst fill past the trigger',
          value: fmtBps(data.slippageVsTriggerBps.max),
          unit: 'bps',
          note: `median ${fmtBps(data.slippageVsTriggerBps.p50)} · p95 ${fmtBps(data.slippageVsTriggerBps.p95)}`,
        }}
        rows={[
          { key: 'executions', label: 'Executions', value: data.executions },
          { key: 'full', label: 'Filled in full', value: data.full },
          { key: 'partial', label: 'Partially filled', value: data.partial },
          { key: 'unfilled', label: 'Filled nothing', value: data.unfilled },
          {
            key: 'delay50',
            label: 'Delay, median',
            value:
              delayP50 !== null ? (
                <NumUnit value={delayP50} unit="blocks" />
              ) : (
                '—'
              ),
            note:
              delayP50 !== null
                ? `about ${Math.round(delayP50 * 0.3)} s · p95 ${data.delayBlocks.p95 ?? '—'} blocks`
                : undefined,
          },
          { key: 'joinRate', label: 'Join rate', value: fmtPct(joinRate) },
        ]}
      />
      <p className="type-footnote px-5 text-[#8E8E93]">
        Outcomes are computed on joined rows only (a placement matched to its
        execution).
      </p>
      {stale && (
        <InlineBanner
          title="Data is behind"
          body="Updated more than 15 min ago. The jobs process may be behind."
        />
      )}
    </div>
  )
}

function SummaryCard({
  headline,
  isLoading,
  isError,
}: {
  headline: SummaryHeadline | null
  isLoading: boolean
  isError: boolean
}) {
  if (isError)
    return (
      <InlineBanner
        title="Data is unavailable"
        body="Summary data is unavailable right now."
      />
    )
  if (isLoading || !headline || headline.length === 0) {
    return <SkeletonCard title="How often stops get hit" />
  }
  const row = headline.find((h) => h.distanceBps === 100) ?? headline[0]
  return (
    <GroupedList
      title="How often stops get hit · BTC"
      lead={{
        label: `Chance a ${row.distanceBps} bps stop is hit within ${row.horizonBlocks.toLocaleString()} blocks (about 1 h)`,
        value: fmtPct(row.pHit),
      }}
      rows={[
        {
          key: 'gapP99',
          label: 'Mark gap through the stop, p99',
          value: <NumUnit value={fmtBps(row.markGapP99Bps)} unit="bps" />,
          note: `max ${fmtBps(row.markGapMaxBps)} bps`,
        },
      ]}
    />
  )
}

function PremiumModelCard() {
  const [open, setOpen] = useState(false)
  const premium = useQuery({
    queryKey: ['gapIndex', 'premiumCurve'],
    queryFn: getPremiumCurve,
    enabled: open,
    staleTime: GAP_INDEX_POLL_MS,
  })
  return (
    <div className="rounded-[24px] bg-[#1C1C1E] p-5">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls="gap-index-premium-model"
        className="type-headline flex w-full items-center justify-between"
      >
        Premium model
        <ChevronDown
          className={cnm('size-5 transition-transform', open && 'rotate-180')}
        />
      </button>
      {open && (
        <div id="gap-index-premium-model" className="mt-3">
          <p className="type-footnote mb-3 text-[#8E8E93]">
            Model at 20 AUSD notional, not a quote (ADR-W14). The binding price
            always comes from the contract at the moment of purchase.
          </p>
          {premium.isLoading && (
            <p className="type-callout text-[#AEAEB2]">Loading…</p>
          )}
          {premium.isError && (
            <InlineBanner
              title="Data is unavailable"
              body="Premium model is unavailable right now."
            />
          )}
          {premium.data && (
            <GroupedList
              rows={(
                premium.data.perps.find((p) => p.perpId === 1)?.curves
                  .specDefault ?? []
              )
                .slice(0, 6)
                .map((row) => ({
                  key: String(row.distanceBps),
                  label: `${row.distanceBps} bps distance`,
                  value:
                    row.allowed && row.feeBpsE2 !== null
                      ? `${(row.feeBpsE2 / 100).toFixed(2)} bps fee`
                      : 'Not allowed',
                }))}
            />
          )}
        </div>
      )}
    </div>
  )
}

function methodText(
  method: Record<string, unknown> | string | undefined,
): string | null {
  if (method === undefined) return null
  return typeof method === 'string' ? method : JSON.stringify(method)
}

function MethodCard({
  docs,
}: {
  docs: ReadonlyArray<{
    name: string
    data:
      | {
          generatedAt: string
          stale: boolean
          method?: Record<string, unknown> | string
        }
      | undefined
  }>
}) {
  const [open, setOpen] = useState(false)
  return (
    <div className="rounded-[24px] bg-[#1C1C1E] p-5">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls="gap-index-method"
        className="type-headline flex w-full items-center justify-between"
      >
        Method
        <ChevronDown
          className={cnm('size-5 transition-transform', open && 'rotate-180')}
        />
      </button>
      {open && (
        <div id="gap-index-method" className="mt-3 flex flex-col gap-3">
          {docs.map((d) => {
            const method = methodText(d.data?.method)
            return (
              <div key={d.name} className="flex flex-col gap-0.5">
                <div className="flex items-center justify-between">
                  <span className="type-footnote text-[#8E8E93]">{d.name}</span>
                  <span className="type-num-sm text-[#8E8E93]">
                    {d.data
                      ? new Date(d.data.generatedAt).toLocaleString()
                      : 'not available'}
                    {d.data?.stale ? ' · stale' : ''}
                  </span>
                </div>
                {method && (
                  <p className="type-footnote text-[#8E8E93]">{method}</p>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

function SkeletonCard({ title }: { title: string }) {
  return (
    <div className="rounded-[24px] bg-[#1C1C1E] p-5">
      <h3 className="type-label mb-3 text-[#AEAEB2]">{title}</h3>
      <div className="flex flex-col gap-2">
        {[0, 1, 2].map((i) => (
          <div
            key={i}
            className="h-5 w-full animate-pulse rounded-[8px] bg-[#2C2C2E]"
          />
        ))}
      </div>
    </div>
  )
}
