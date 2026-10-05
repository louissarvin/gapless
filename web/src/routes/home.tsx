import { Suspense, lazy, useEffect, useMemo, useState } from 'react'
import { Link, createFileRoute, useNavigate } from '@tanstack/react-router'
import { toViemAccount } from '@category-labs/mera/viem'
import { ChevronRight, Copy, LockKeyhole, TriangleAlert } from 'lucide-react'
import type { HomeChainState } from '@/hooks/useHomeChainState'
import type { OnboardStep } from '@/hooks/useAccountState'
import type { DevBypassStage } from '@/dev/devBypass'
import {
  applyDevBypassStage,
  fakeHomeChainState,
  readDevBypassStage,
  writeDevBypassStage,
} from '@/dev/devBypass'
import GaplessButton from '@/components/GaplessButton'
import { deriveOnboardStep, useAccountState } from '@/hooks/useAccountState'
import { useAccountSession } from '@/hooks/useAccountSession'
import { useAuthActions } from '@/hooks/useAuthActions'
import {
  hasActiveCover,
  totalBalanceCNS,
  useHomeChainState,
} from '@/hooks/useHomeChainState'
import { errorCopyFor } from '@/lib/errors'
import { formatApproxDuration, formatCNS, shortenAddress } from '@/utils/units'

export const Route = createFileRoute('/home')({ component: HomePage })

// Dev-only bypass panel (same tree-shaking pattern as DevtoolsPanel in
// __root.tsx, ARCHITECTURE ADR-W3): never in the production bundle.
const DevBypassPanelLazy = import.meta.env.DEV
  ? lazy(() =>
      import('@/dev/DevBypassPanel').then((m) => ({
        default: m.DevBypassPanel,
      })),
    )
  : null

/** Exported for `home.test.tsx`: TanStack Router's file-route convention
 * otherwise only exposes the component through `Route.options.component`. */
export function HomePage() {
  const { ownerSession, operatorSession } = useAccountSession()

  const ownerAddress = useMemo(
    () => (ownerSession ? toViemAccount(ownerSession).address : null),
    [ownerSession],
  )
  const operatorAddress = useMemo(
    () => (operatorSession ? toViemAccount(operatorSession).address : null),
    [operatorSession],
  )

  const {
    data: chainState,
    error: chainError,
    failureReason,
    errorUpdateCount,
  } = useAccountState(ownerAddress, operatorAddress)

  // Dev-only bypass state (requirement: additive, never alters real logic).
  // The ternaries collapse to `'off'` / a no-op in production, where
  // `import.meta.env.DEV` is a statically-replaced `false`. `devPanel` is a
  // plain child (not a named prop) so `Shell` itself stays untouched.
  const [devBypassStage, setDevBypassStage] = useState<DevBypassStage>(() =>
    import.meta.env.DEV ? readDevBypassStage() : 'off',
  )
  useEffect(() => {
    if (import.meta.env.DEV) writeDevBypassStage(devBypassStage)
  }, [devBypassStage])
  const devPanel = DevBypassPanelLazy ? (
    <Suspense fallback={null}>
      <DevBypassPanelLazy stage={devBypassStage} onChange={setDevBypassStage} />
    </Suspense>
  ) : null

  // DESIGN 10: any route that needs a session shows an unlock card in place,
  // never a redirect (ARCHITECTURE section 4). The tab bar stays mounted
  // from __root.tsx regardless.
  if (!ownerSession || !operatorSession || !ownerAddress || !operatorAddress) {
    return (
      <Shell>
        <UnlockCard />
        {devPanel}
      </Shell>
    )
  }

  // With no data, each poll resets `error` to null (query-core fetchState); errorUpdateCount persists.
  if (!chainState && errorUpdateCount > 0) {
    const copy = errorCopyFor(null)
    const detail = (chainError ?? failureReason)?.message
    return (
      <Shell>
        <ErrorCard title={copy.title} body={copy.body} detail={detail} />
        {devPanel}
      </Shell>
    )
  }

  if (!chainState) {
    return (
      <Shell>
        <p className="type-callout text-[#AEAEB2]">Loading your account…</p>
        {devPanel}
      </Shell>
    )
  }

  // Dev bypass only overrides the derived fields; never touches `account` or
  // `factoryDomain`, so a real session is still required to get here.
  const state = import.meta.env.DEV
    ? applyDevBypassStage(chainState, devBypassStage)
    : chainState

  // hasPendingPayload only disambiguates the pre-deployment steps (keys vs
  // fund); once deployed (always true by the time a user reaches /home) it
  // has no effect on the result, so `false` is safe here.
  const step = deriveOnboardStep(state, false)

  if (step !== 'ready') {
    return (
      <Shell>
        <ContinueSetupCard
          step={step}
          agentAddress={step === 'operator-replaced' ? state.operatorKey : null}
        />
        {devPanel}
      </Shell>
    )
  }

  // Dev bypass: pass a null `perplAccountId` so this never fires the real
  // multicall against an account that was never really deployed
  // (`useHomeChainState`'s own, unmodified, `enabled` check does the rest).
  // A real user's `state.perplAccountId` is never null by the time
  // `step === 'ready'` (`deriveOnboardStep` requires it to be nonzero).
  const bypassActive = import.meta.env.DEV && devBypassStage === 'activated'

  return (
    <Shell>
      <HomeContent
        account={state.account}
        operator={operatorAddress}
        perplAccountId={bypassActive ? null : state.perplAccountId}
        nowS={state.nowS}
      />
      {devPanel}
    </Shell>
  )
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="mx-auto min-h-screen max-w-[480px] px-5 py-10">
      <h1 className="type-title-1 mb-8">Home</h1>
      {children}
    </div>
  )
}

function ErrorCard({
  title,
  body,
  detail,
}: {
  title: string
  body: string
  detail: string | undefined
}) {
  return (
    <div className="rounded-md bg-[#2C2C2E] px-4 py-3">
      <p className="type-headline text-[#FF6165]">{title}</p>
      <p className="type-callout text-white">{body}</p>
      {import.meta.env.DEV && detail && (
        <pre className="type-mono-sm mt-3 whitespace-pre-wrap break-all text-[#AEAEB2]">
          {detail}
        </pre>
      )}
    </div>
  )
}

function HomeContent({
  account,
  operator,
  perplAccountId,
  nowS,
}: {
  // `perplAccountId` is nullable only because the dev bypass asks for it to
  // stay null (see home.tsx's HomePage). A real user never reaches this
  // component with it null: HomePage only renders it once `step === 'ready'`,
  // which requires a real, nonzero perpl account id.
  account: `0x${string}`
  operator: `0x${string}`
  perplAccountId: bigint | null
  nowS: number
}) {
  // A dev-bypassed account was never really deployed: its contract storage
  // doesn't exist on chain, so the real multicall would just throw.
  // `useHomeChainState`'s own (unmodified) `enabled` check keeps it from ever
  // firing when `perplAccountId` is null.
  const {
    data: realHomeState,
    error: homeError,
    failureReason: homeFailureReason,
    errorUpdateCount: homeErrorUpdateCount,
  } = useHomeChainState(account, operator, perplAccountId)
  const homeState =
    import.meta.env.DEV && perplAccountId === null
      ? fakeHomeChainState(operator, nowS)
      : realHomeState

  // Same reasoning as the top-level useAccountState check above: `error`
  // resets to null on each refetch attempt, so errorUpdateCount is what
  // keeps the error card showing instead of flickering back to skeletons.
  if (perplAccountId !== null && !homeState && homeErrorUpdateCount > 0) {
    const copy = errorCopyFor(null)
    const detail = (homeError ?? homeFailureReason)?.message
    return <ErrorCard title={copy.title} body={copy.body} detail={detail} />
  }

  return (
    <div className="flex flex-col gap-6">
      <BalanceCard account={account} state={homeState} />
      <ActiveCoverCard state={homeState} />
      {homeState && <SessionCard state={homeState} nowS={nowS} />}
      {homeState && homeState.operatorMonBalanceWei === 0n && <FundMonBanner />}
    </div>
  )
}

function BalanceCard({
  account,
  state,
}: {
  account: `0x${string}`
  state: HomeChainState | undefined
}) {
  const [copied, setCopied] = useState(false)

  async function copyAddress() {
    await navigator.clipboard.writeText(account)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  return (
    <div
      className="card-big flex flex-col justify-between p-6"
      style={{ '--card-min-h': '240px' } as React.CSSProperties}
    >
      <div className="flex items-center justify-between">
        <p className="type-label text-[#AEAEB2]">Balance</p>
        <button
          type="button"
          aria-label="Copy deposit address"
          onClick={copyAddress}
          className="flex items-center gap-1.5 rounded-full bg-[#2C2C2E] px-3 py-1.5 text-[#AEAEB2]"
        >
          <Copy className="size-3.5" strokeWidth={1.75} />
          <span className="type-mono-sm">
            {copied ? 'Copied' : shortenAddress(account)}
          </span>
        </button>
      </div>

      <div>
        <p className="type-num-hero mb-6">
          {state ? (
            formatCNS(totalBalanceCNS(state))
          ) : (
            <span className="inline-block h-10 w-40 animate-pulse rounded-xs bg-[#2C2C2E] align-middle" />
          )}
        </p>
        <div className="grid grid-cols-3 gap-3 rounded-md bg-[#2C2C2E] px-4 py-3">
          <BalanceBreakdownItem label="Wallet" cns={state?.walletAusdCNS} />
          <BalanceBreakdownItem label="Perpl free" cns={state?.perplFreeCNS} />
          <BalanceBreakdownItem
            label="In position"
            cns={state?.positionDepositCNS}
          />
        </div>
      </div>
    </div>
  )
}

function BalanceBreakdownItem({
  label,
  cns,
}: {
  label: string
  cns: bigint | undefined
}) {
  return (
    <div>
      <p className="type-footnote text-[#AEAEB2]">{label}</p>
      <p className="type-num">
        {cns !== undefined ? (
          formatCNS(cns, '')
        ) : (
          <span className="inline-block h-4 w-12 animate-pulse rounded-xs bg-[#3A3A3C] align-middle" />
        )}
      </p>
    </div>
  )
}

function ActiveCoverCard({ state }: { state: HomeChainState | undefined }) {
  if (!state) {
    return (
      <div
        className="card-big flex flex-col justify-between p-6"
        style={{ '--card-min-h': '200px' } as React.CSSProperties}
      >
        <p className="type-label text-[#AEAEB2]">Cover</p>
        <span className="inline-block h-7 w-32 animate-pulse rounded-xs bg-[#2C2C2E]" />
      </div>
    )
  }

  const active = hasActiveCover(state)

  const body = (
    <>
      <div className="flex items-center justify-between">
        <p className="type-label text-[#AEAEB2]">Cover</p>
        {active && (
          <ChevronRight className="size-5 text-[#8E8E93]" strokeWidth={1.75} />
        )}
      </div>
      <div>
        <h2 className="type-title-1 mb-2">
          {active ? 'Active cover' : 'No active cover'}
        </h2>
        <p className="type-callout text-[#AEAEB2]">
          {active
            ? 'Tap to view status and payout.'
            : 'Open a covered trade to protect your position.'}
        </p>
      </div>
    </>
  )

  if (!active) {
    return (
      <div
        className="card-big flex flex-col justify-between p-6"
        style={{ '--card-min-h': '200px' } as React.CSSProperties}
      >
        {body}
      </div>
    )
  }

  return (
    <Link
      to="/covers/$coverId"
      params={{ coverId: state.activeCoverId }}
      className="card-big card-big-tappable flex flex-col justify-between p-6"
      style={{ '--card-min-h': '200px' } as React.CSSProperties}
    >
      {body}
    </Link>
  )
}

function SessionCard({ state, nowS }: { state: HomeChainState; nowS: number }) {
  const secondsLeft = Number(state.operatorGrant.expiry) - nowS
  const budgetFraction =
    state.operatorGrant.maxNotionalPerDayCNS > 0n
      ? Number(state.operatorAvailableCNS) /
        Number(state.operatorGrant.maxNotionalPerDayCNS)
      : 0
  const budgetPercent = Math.max(0, Math.min(1, budgetFraction)) * 100

  return (
    <div className="rounded-lg bg-[#1C1C1E] p-5">
      <h2 className="type-title-2 mb-3">Session</h2>
      <Row label="Expires" value={formatApproxDuration(secondsLeft)} />
      <Row
        label="Per-trade cap"
        value={formatCNS(state.operatorGrant.maxNotionalPerTradeCNS)}
      />
      <div className="py-3">
        <div className="mb-2 flex items-center justify-between">
          <p className="type-body text-white">Budget left</p>
          <p className="type-num">{formatCNS(state.operatorAvailableCNS)}</p>
        </div>
        <div className="h-1.5 w-full overflow-hidden rounded-full bg-[#3A3A3C]">
          <div
            className="h-full rounded-full bg-[#A48FFF]"
            style={{ width: `${budgetPercent}%` }}
          />
        </div>
      </div>
    </div>
  )
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between border-b border-separator py-3 last:border-0">
      <p className="type-body text-white">{label}</p>
      <p className="type-num">{value}</p>
    </div>
  )
}

function FundMonBanner() {
  return (
    <div className="flex items-start gap-3 rounded-md bg-[#402F21] px-4 py-3">
      <TriangleAlert
        className="mt-0.5 size-5 shrink-0 text-[#FF9230]"
        strokeWidth={1.75}
      />
      <div>
        <p className="type-headline text-white">Fund your trading key</p>
        <p className="type-callout text-[#AEAEB2]">
          Your trading key has no MON for gas. Trades and covers can't be sent
          until it's funded.
        </p>
      </div>
    </div>
  )
}

function ContinueSetupCard({
  step,
  agentAddress,
}: {
  step: OnboardStep
  agentAddress: `0x${string}` | null
}) {
  const navigate = useNavigate()

  // ARCHITECTURE 7.2 step 7: once an agent holds the operator grant, /home
  // names it instead of showing the generic "finish setting up" copy.
  if (step === 'operator-replaced' && agentAddress) {
    return (
      <div
        className="card-big flex flex-col justify-between p-6"
        style={{ '--card-min-h': '240px' } as React.CSSProperties}
      >
        <div>
          <p className="type-label mb-2 text-[#AEAEB2]">Account</p>
          <h2 className="type-title-1 mb-4">Trading key: agent</h2>
          <p className="type-mono-sm mb-2 text-white">
            {shortenAddress(agentAddress)}
          </p>
          <p className="type-callout text-[#AEAEB2]">
            This agent trades for you now. This phone stops trading until you
            re-grant it.
          </p>
        </div>
        <GaplessButton
          variant="primary"
          size="lg"
          fullWidth
          onPress={() => navigate({ to: '/settings/agent' })}
        >
          Re-grant this device
        </GaplessButton>
      </div>
    )
  }

  return (
    <div
      className="card-big flex flex-col justify-between p-6"
      style={{ '--card-min-h': '240px' } as React.CSSProperties}
    >
      <div>
        <p className="type-label mb-2 text-[#AEAEB2]">Account</p>
        <h2 className="type-title-1 mb-4">Finish setting up</h2>
        <p className="type-callout text-[#AEAEB2]">
          Your account isn't ready yet. Pick up where you left off.
        </p>
      </div>
      <GaplessButton
        variant="primary"
        size="lg"
        fullWidth
        onPress={() => navigate({ to: '/onboard' })}
      >
        Continue setup
      </GaplessButton>
    </div>
  )
}

function UnlockCard() {
  // Inline, not a redirect (ARCHITECTURE 4, DESIGN 10): the tab bar stays
  // visible beneath it so the user can leave. `onDone` is a no-op:
  // useAccountSession re-renders this page itself once a session is live.
  const { pending, error, signIn } = useAuthActions(() => {})
  const errorCopy = error ? errorCopyFor(error) : null

  return (
    <div
      className="card-big flex flex-col items-center justify-center p-6 text-center"
      style={{ '--card-min-h': '320px' } as React.CSSProperties}
    >
      <LockKeyhole className="mb-4 size-8 text-[#AEAEB2]" strokeWidth={1.75} />
      <h2 className="type-title-1 mb-4">Unlock Gapless</h2>
      <p className="type-callout mb-6 text-[#AEAEB2]">
        Use your passkey to see your balance and covers.
      </p>

      {errorCopy && (
        <div className="mb-4 w-full rounded-md bg-[#2C2C2E] px-4 py-3 text-left">
          <p className="type-headline text-[#FF6165]">{errorCopy.title}</p>
          <p className="type-callout text-white">{errorCopy.body}</p>
        </div>
      )}

      <GaplessButton
        variant="primary"
        size="lg"
        fullWidth
        isDisabled={pending !== null}
        isPending={pending === 'signin'}
        onPress={signIn}
      >
        Unlock with passkey
      </GaplessButton>
    </div>
  )
}
