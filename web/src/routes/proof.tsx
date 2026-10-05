import { Link, createFileRoute } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { ChevronLeft, ShieldCheck } from 'lucide-react'
import { z } from 'zod'
import type { CSSProperties, ReactNode } from 'react'
import type { AccountNativeStop } from '@/lib/api/relay'
import { ICoverManagerAbi } from '@/abi/ICoverManager'
import InlineBanner from '@/components/InlineBanner'
import { NumUnit } from '@/components/GroupedList'
import { ADDRESSES, LISTED_PERP_ID } from '@/config/addresses.143'
import { PROOF_PAIR } from '@/config'
import { publicClient } from '@/lib/chain'
import { getNativeStops, getWalletHistory } from '@/lib/api/relay'
import { PROOF_PAIRING_WINDOW_BLOCKS, isValidPair } from '@/lib/proofPairing'
import { formatCNS } from '@/utils/units'

const hex32 = z.string().regex(/^0x[0-9a-fA-F]{64}$/)
const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/)

const proofSearchSchema = z.object({
  cover: hex32.optional(),
  native: address.optional(),
  exec: hex32.optional(),
})

export const Route = createFileRoute('/proof')({
  validateSearch: (search) => proofSearchSchema.parse(search),
  component: ProofPage,
})

function resolvePair(search: z.infer<typeof proofSearchSchema>) {
  if (search.cover && search.native && search.exec) {
    return { cover: search.cover, native: search.native, exec: search.exec }
  }
  return PROOF_PAIR
}

async function readGaplessSide(coverId: `0x${string}`) {
  const [cover, marketParams] = await Promise.all([
    publicClient.readContract({
      address: ADDRESSES.CoverManager,
      abi: ICoverManagerAbi,
      functionName: 'getCover',
      args: [coverId],
    }),
    publicClient.readContract({
      address: ADDRESSES.CoverManager,
      abi: ICoverManagerAbi,
      functionName: 'marketParams',
      args: [BigInt(LISTED_PERP_ID)],
    }),
  ])
  return { cover, marketParams }
}

type GaplessSide = Awaited<ReturnType<typeof readGaplessSide>>

function fmtBps(v: number | null): string {
  if (v === null) return '—'
  return v.toFixed(2)
}

/** `/proof` (ADR-W15): a pinned real trigger vs. a real plain Perpl stop, or measured mode when no pair exists yet. */
function ProofPage() {
  const search = Route.useSearch()
  const pair = resolvePair(search)

  const paired = useQuery({
    queryKey: ['proof', 'pair', pair?.cover, pair?.native, pair?.exec],
    queryFn: async () => {
      if (!pair) throw new Error('no pair')
      const [gapless, wallet] = await Promise.all([
        readGaplessSide(pair.cover as `0x${string}`),
        getWalletHistory(pair.native),
      ])
      const native =
        wallet.nativeStops.find(
          (s) => s.execTx?.toLowerCase() === pair.exec.toLowerCase(),
        ) ?? null
      return { gapless, native }
    },
    enabled: pair !== null,
  })

  const aggregates = useQuery({
    queryKey: ['proof', 'measured'],
    queryFn: getNativeStops,
    enabled: pair === null,
    staleTime: 60_000,
  })

  const marketParamsOnly = useQuery({
    queryKey: ['proof', 'marketParams'],
    queryFn: () =>
      publicClient.readContract({
        address: ADDRESSES.CoverManager,
        abi: ICoverManagerAbi,
        functionName: 'marketParams',
        args: [BigInt(LISTED_PERP_ID)],
      }),
    enabled: pair === null,
    staleTime: 60_000,
  })

  const isLoading = pair
    ? paired.isLoading
    : aggregates.isLoading || marketParamsOnly.isLoading
  const isError = pair
    ? paired.isError
    : aggregates.isError || marketParamsOnly.isError

  return (
    <div className="mx-auto flex max-w-[480px] flex-col gap-6 px-5 pt-10 lg:max-w-[960px] lg:px-10">
      <Link
        to="/gap-index"
        aria-label="Back to Gap Index"
        className="flex size-11 items-center justify-center rounded-full bg-[#2C2C2E] active:scale-95"
      >
        <ChevronLeft className="size-5 text-white" strokeWidth={2} />
      </Link>

      {isError && (
        <InlineBanner
          title="Proof data is unavailable"
          body="Try again in a moment."
        />
      )}

      {isLoading && <ProofSkeleton />}

      {!isLoading && !isError && pair && paired.data && (
        <PairedResult
          gapless={paired.data.gapless}
          native={paired.data.native}
        />
      )}

      {!isLoading && !isError && !pair && (
        <MeasuredMode
          totals={aggregates.data?.perps.find((p) => p.perpId === 1) ?? null}
          slipAllowanceBps={marketParamsOnly.data?.slipAllowanceBps ?? null}
        />
      )}
    </div>
  )
}

/** Shared anatomy (DESIGN C5): label (plus optional icon) at top, hero content anchored to the bottom. */
function ProofCard({
  label,
  children,
}: {
  label: ReactNode
  children: ReactNode
}) {
  return (
    <div
      className="card-big flex flex-1 flex-col justify-between gap-2 p-6 lg:p-10"
      style={{ '--card-min-h': '280px' } as CSSProperties}
    >
      <div className="flex items-center gap-2">{label}</div>
      <div>{children}</div>
    </div>
  )
}

function CardsGrid({ children }: { children: ReactNode }) {
  return (
    <div className="grid gap-6 lg:grid-cols-2 lg:items-stretch">{children}</div>
  )
}

function ProofSkeleton() {
  return (
    <CardsGrid>
      {[0, 1].map((i) => (
        <div
          key={i}
          className="card-big animate-pulse p-6 lg:p-10"
          style={{ '--card-min-h': '280px' } as CSSProperties}
        >
          <div className="h-4 w-32 rounded-[8px] bg-[#2C2C2E]" />
          <div className="mt-20 h-10 w-40 rounded-[8px] bg-[#2C2C2E]" />
        </div>
      ))}
    </CardsGrid>
  )
}

function CardLabel({ children }: { children: ReactNode }) {
  return <span className="type-label text-[#AEAEB2]">{children}</span>
}

function GaplessLabel() {
  return (
    <>
      <ShieldCheck className="size-4 shrink-0 text-[#00DAC3]" strokeWidth={2} />
      <CardLabel>Gapless cover</CardLabel>
    </>
  )
}

function PairedResult({
  gapless,
  native,
}: {
  gapless: GaplessSide
  native: AccountNativeStop | null
}) {
  const { cover } = gapless
  const scale = 1n // BTC-PERP (perpId 1) marketConfig scale is 1 (phase 2 section 1 facts)
  const notionalCNS = BigInt(cover.filledLots) * BigInt(cover.stopPNS) * scale
  const paidCNS = BigInt(cover.paidCNS) + BigInt(cover.owedCNS)
  const residualCNS =
    BigInt(cover.gRealCumCNS) > paidCNS
      ? BigInt(cover.gRealCumCNS) - paidCNS
      : 0n
  const exitBps =
    notionalCNS > 0n ? Number((residualCNS * 10_000n) / notionalCNS) : null
  const exitedAtStop = residualCNS === 0n && cover.status === 4

  const valid =
    native?.triggerPNS !== null &&
    native?.triggerPNS !== undefined &&
    native.executedBlock !== null &&
    isValidPair({
      gaplessPerpId: cover.perpId,
      gaplessIsLong: cover.isLong,
      gaplessStopPNS: BigInt(cover.stopPNS),
      gaplessTriggerBlock: BigInt(cover.triggerBlock),
      nativePerpId: native.perpId,
      nativeSide: native.side,
      nativeTriggerPNS: BigInt(Math.round(native.triggerPNS)),
      nativeExecutedBlock: BigInt(native.executedBlock),
    })

  return (
    <div className="flex flex-col gap-6">
      <h1 className="type-title-1 lg:type-display">
        {valid ? 'Same stop, same market' : 'Two separate events'}
      </h1>
      {!valid && (
        <p className="type-callout max-w-[60ch] text-[#AEAEB2]">
          These two events did not line up closely enough (same market, same
          side, same stop, within {PROOF_PAIRING_WINDOW_BLOCKS.toString()}{' '}
          blocks) to call them a matched pair, so they are shown separately.
        </p>
      )}

      <CardsGrid>
        <ProofCard label={<CardLabel>Plain Perpl stop</CardLabel>}>
          {native ? (
            <>
              <div className="type-num-hero text-white">
                <NumUnit
                  value={fmtBps(native.slippageVsTriggerBps)}
                  unit="bps"
                />
              </div>
              <p className="type-callout mt-2 text-[#AEAEB2]">
                Executed block #{native.executedBlock} · delay{' '}
                {native.delayBlocks ?? '—'} blocks
              </p>
            </>
          ) : (
            <p className="type-callout text-[#AEAEB2]">
              No matching native stop execution found for this wallet.
            </p>
          )}
        </ProofCard>

        <ProofCard label={<GaplessLabel />}>
          <div className="type-num-hero text-white">
            {exitBps !== null ? (
              <NumUnit value={fmtBps(exitBps)} unit="bps" />
            ) : (
              '—'
            )}
          </div>
          <p className="type-callout mt-2 text-[#AEAEB2]">
            {exitedAtStop
              ? 'Exited at the stop'
              : `Paid ${formatCNS(paidCNS)} now, top-up pending`}
            {' · '}
            {formatCNS(notionalCNS)} notional
          </p>
        </ProofCard>
      </CardsGrid>
    </div>
  )
}

function MeasuredMode({
  totals,
  slipAllowanceBps,
}: {
  totals: {
    executions: number
    unfilled: number
    slippageVsTriggerBps: {
      p50: number | null
      p95: number | null
      max: number | null
    }
  } | null
  slipAllowanceBps: number | undefined | null
}) {
  return (
    <div className="flex flex-col gap-6">
      <h1 className="type-title-1 lg:type-display">No Gapless trigger yet</h1>
      <p className="type-callout max-w-[60ch] text-[#AEAEB2]">
        This deployment has not had a real Gapless trigger to compare against a
        plain Perpl stop. Nothing below is a claimed outcome: it is this
        week&rsquo;s measured plain-stop data, and the rule a Gapless cover uses
        to pay if one does trigger.
      </p>

      <CardsGrid>
        <ProofCard label={<CardLabel>Plain Perpl stop, this week</CardLabel>}>
          {totals ? (
            <>
              <div className="type-num-hero text-white">
                <NumUnit
                  value={fmtBps(totals.slippageVsTriggerBps.max)}
                  unit="bps"
                />
              </div>
              <p className="type-callout mt-2 text-[#AEAEB2]">
                Across {totals.executions.toLocaleString()} stop executions.
                Median {fmtBps(totals.slippageVsTriggerBps.p50)} bps, p95{' '}
                {fmtBps(totals.slippageVsTriggerBps.p95)} bps.{' '}
                {totals.unfilled.toLocaleString()} filled nothing.
              </p>
            </>
          ) : (
            <p className="type-callout text-[#AEAEB2]">No data yet.</p>
          )}
        </ProofCard>

        <ProofCard label={<GaplessLabel />}>
          <p className="type-title-1">Pays the gap back</p>
          <div className="mt-4 rounded-[16px] bg-[#2C2C2E] px-4 py-3">
            <p className="type-footnote text-[#AEAEB2]">Pays the smallest of</p>
            <p className="type-body mt-1 text-white">The real gap</p>
            <p className="type-body text-white">
              The reference gap plus a{' '}
              {slipAllowanceBps !== null && slipAllowanceBps !== undefined
                ? `${slipAllowanceBps} bps`
                : '—'}{' '}
              allowance
            </p>
            <p className="type-body text-white">
              The cap: notional times max gap
            </p>
          </div>
          <p className="type-footnote mt-3 text-[#8E8E93]">
            This is the rule, not a result. No cover has triggered on this
            deployment yet.
          </p>
        </ProofCard>
      </CardsGrid>
    </div>
  )
}
