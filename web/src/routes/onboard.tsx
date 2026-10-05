import { Suspense, lazy, useEffect, useMemo, useRef, useState } from 'react'
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { toViemAccount } from '@category-labs/mera/viem'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import { Copy } from 'lucide-react'
import type { OnboardStep } from '@/hooks/useAccountState'
import type { DevBypassStage } from '@/dev/devBypass'
import {
  applyDevBypassStage,
  readDevBypassStage,
  writeDevBypassStage,
} from '@/dev/devBypass'
import GaplessButton from '@/components/GaplessButton'
import QrCode from '@/components/QrCode'
import {
  EASE_OUT_CUBIC,
  EASE_OUT_EXPO,
  SPRING_CONTENT_ENTRY,
  SPRING_SMOOTH_ONE,
  SPRING_SMOOTH_TWO,
  TRANSITION_EXIT,
} from '@/config/animation'
import { ADDRESSES } from '@/config/addresses.143'
import { SPONSOR_GRANT } from '@/config'
import { accountSession } from '@/lib/account/session'
import { OwnerScope } from '@/lib/account/scoped'
import {
  clearPendingCreateAccount,
  isPendingCreateAccountUsable,
  loadPendingCreateAccount,
  savePendingCreateAccount,
} from '@/lib/account/pendingCreateAccount'
import { RelayError, activate, sponsorCreate } from '@/lib/api/relay'
import { deriveOnboardStep, useAccountState } from '@/hooks/useAccountState'
import { useAccountSession } from '@/hooks/useAccountSession'
import { useAuthActions } from '@/hooks/useAuthActions'
import { errorCopyFor } from '@/lib/errors'
import { formatCNS, shortenAddress } from '@/utils/units'
import { cnm } from '@/utils/style'

export const Route = createFileRoute('/onboard')({ component: OnboardPage })

// Dev-only bypass panel (same tree-shaking pattern as DevtoolsPanel in
// __root.tsx, ARCHITECTURE ADR-W3): never in the production bundle.
const DevBypassPanelLazy = import.meta.env.DEV
  ? lazy(() =>
      import('@/dev/DevBypassPanel').then((m) => ({
        default: m.DevBypassPanel,
      })),
    )
  : null

const STEP_ORDER: ReadonlyArray<{ key: OnboardStep | 'done'; label: string }> =
  [
    { key: 'keys', label: 'Keys' },
    { key: 'fund', label: 'Fund' },
    { key: 'create', label: 'Create' },
    { key: 'activate', label: 'Activate' },
    { key: 'ready', label: 'Ready' },
  ]

function stepIndex(step: OnboardStep): number {
  const order: Array<OnboardStep> = [
    'keys',
    'fund',
    'create',
    'activate',
    'ready',
  ]
  // operator-replaced and session-expired are end states reached only from "ready"
  if (step === 'operator-replaced' || step === 'session-expired')
    return order.length - 1
  return order.indexOf(step)
}

function OnboardPage() {
  const navigate = useNavigate()
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
    refetch,
  } = useAccountState(ownerAddress, operatorAddress)
  const [actionError, setActionError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const [activateResult, setActivateResult] = useState<string | null>(null)
  // Direction for the step transition (DESIGN 7.2): tracked above the early
  // returns below, since hooks must run in the same order every render.
  const prevIndexRef = useRef<number | null>(null)

  // Dev-only bypass state (requirement: additive, never alters real logic).
  // The ternaries collapse to `'off'` / a no-op in production, where
  // `import.meta.env.DEV` is a statically-replaced `false`.
  const [devBypassStage, setDevBypassStage] = useState<DevBypassStage>(() =>
    import.meta.env.DEV ? readDevBypassStage() : 'off',
  )
  useEffect(() => {
    if (import.meta.env.DEV) writeDevBypassStage(devBypassStage)
  }, [devBypassStage])

  if (!ownerSession || !operatorSession || !ownerAddress || !operatorAddress) {
    // ARCHITECTURE 5.1: "No session" is the first row of the state table,
    // checked before any chain read. There is nothing to read yet.
    return <UnlockCard />
  }
  // Rebind as non-null consts: TS does not narrow outer closures captured by
  // the nested handlers below (they run later, as event callbacks).
  const ownerSessionSafe = ownerSession
  const ownerAddr = ownerAddress
  const operatorAddr = operatorAddress

  // With no data, each poll resets `error` to null (query-core fetchState); errorUpdateCount persists.
  if (!chainState && errorUpdateCount > 0) {
    const copy = errorCopyFor(null)
    const detail = (chainError ?? failureReason)?.message
    return (
      <Shell>
        <div className="rounded-md bg-[#2C2C2E] px-4 py-3">
          <p className="type-headline text-[#FF6165]">{copy.title}</p>
          <p className="type-callout text-white">{copy.body}</p>
          {import.meta.env.DEV && detail && (
            <pre className="type-mono-sm mt-3 whitespace-pre-wrap break-all text-[#AEAEB2]">
              {detail}
            </pre>
          )}
        </div>
      </Shell>
    )
  }

  if (!chainState) {
    return (
      <Shell>
        <p className="type-callout text-[#AEAEB2]">Loading your account…</p>
      </Shell>
    )
  }

  // Dev bypass only overrides the derived fields (balance/deployed/perpl
  // account/operator funding); `account` and `factoryDomain` stay real, so
  // the Keys step still signs a genuine CreateAccount grant for this address.
  const state = import.meta.env.DEV
    ? applyDevBypassStage(chainState, devBypassStage)
    : chainState
  const pendingPayload = loadPendingCreateAccount()
  const hasUsablePayload =
    pendingPayload?.owner.toLowerCase() === ownerAddr.toLowerCase() &&
    isPendingCreateAccountUsable(pendingPayload, state.nowS)

  const step = deriveOnboardStep(state, Boolean(hasUsablePayload))
  const errorCopy = actionError ? errorCopyFor(actionError) : null

  const activeIndex = stepIndex(step)
  const direction =
    activeIndex >= (prevIndexRef.current ?? activeIndex) ? 1 : -1
  prevIndexRef.current = activeIndex

  async function handleSignCreateAccount() {
    setActionError(null)
    setPending(true)
    try {
      const expectedDomain = {
        name: 'GaplessFactory',
        version: '1',
        chainId: 143,
        verifyingContract: ADDRESSES.GaplessFactory,
      }
      const expiry = state.nowS + SPONSOR_GRANT.expirySeconds
      const deadline = state.nowS + SPONSOR_GRANT.deadlineSeconds
      const owner = new OwnerScope(ownerSessionSafe)
      const sig = await owner.signCreateAccount(
        state.factoryDomain,
        expectedDomain,
        {
          owner: ownerAddr,
          key: operatorAddr,
          expiry: BigInt(expiry),
          maxNotional: SPONSOR_GRANT.maxNotionalPerTradeCNS,
          maxNotionalPerDay: SPONSOR_GRANT.maxNotionalPerDayCNS,
          deadline: BigInt(deadline),
        },
      )
      accountSession.endOwnerSession()
      savePendingCreateAccount({
        owner: ownerAddr,
        account: state.account,
        grant: {
          key: operatorAddr,
          expiry: String(expiry),
          maxNotionalPerTradeCNS: String(SPONSOR_GRANT.maxNotionalPerTradeCNS),
          maxNotionalPerDayCNS: String(SPONSOR_GRANT.maxNotionalPerDayCNS),
        },
        deadline: String(deadline),
        sig,
        expiry,
      })
      await refetch()
    } catch (err) {
      setActionError(err instanceof RelayError ? err.code : 'UNKNOWN')
    } finally {
      setPending(false)
    }
  }

  async function handleSubmitCreate() {
    // Dev bypass: never calls the real relay. Just advances the simulated
    // stage so `deriveOnboardStep` naturally moves on to "activate".
    if (import.meta.env.DEV && devBypassStage !== 'off') {
      setDevBypassStage('deployed')
      return
    }
    if (!pendingPayload) return
    setActionError(null)
    setPending(true)
    try {
      const data = await sponsorCreate({
        owner: pendingPayload.owner,
        grant: pendingPayload.grant,
        deadline: pendingPayload.deadline,
        sig: pendingPayload.sig,
      })
      // ADR-W9: the relay's account must equal the chain's own prediction.
      if (data.account.toLowerCase() !== state.account.toLowerCase()) {
        throw new Error(
          'Relay returned an account that does not match accountOf(owner)',
        )
      }
      clearPendingCreateAccount()
      await refetch()
    } catch (err) {
      setActionError(err instanceof RelayError ? err.code : 'UNKNOWN')
    } finally {
      setPending(false)
    }
  }

  async function handleActivate() {
    // Dev bypass: never calls the real relay (no sponsored tx, no real MON
    // drip). Just advances the simulated stage to "ready".
    if (import.meta.env.DEV && devBypassStage !== 'off') {
      setActivateResult(
        'Simulated (dev bypass): would call /activate here. No real transaction was sent.',
      )
      setDevBypassStage('activated')
      return
    }
    setActionError(null)
    setPending(true)
    try {
      const data = await activate({ account: state.account })
      setActivateResult(
        data.dripSkipped
          ? `Activated. Trading key funding: ${data.dripSkipped.replaceAll('_', ' ')}.`
          : 'Activated. Your trading key was funded with MON for gas.',
      )
      await refetch()
    } catch (err) {
      setActionError(err instanceof RelayError ? err.code : 'UNKNOWN')
    } finally {
      setPending(false)
    }
  }

  return (
    <Shell>
      <ProgressPill activeIndex={activeIndex} />

      {errorCopy && (
        <div className="mb-6 rounded-md bg-[#2C2C2E] px-4 py-3">
          <p className="type-headline text-[#FF6165]">{errorCopy.title}</p>
          <p className="type-callout text-white">{errorCopy.body}</p>
        </div>
      )}

      <AnimatePresence mode="popLayout" custom={direction}>
        <motion.div
          key={step}
          custom={direction}
          variants={{
            enter: (dir: number) => ({ opacity: 0, x: dir >= 0 ? 64 : -64 }),
            center: { opacity: 1, x: 0, transition: SPRING_CONTENT_ENTRY },
            exit: (dir: number) => ({
              opacity: 0,
              x: dir >= 0 ? -64 : 64,
              transition: TRANSITION_EXIT,
            }),
          }}
          initial="enter"
          animate="center"
          exit="exit"
        >
          {step === 'keys' && (
            <KeysStep
              ownerAddress={ownerAddress}
              operatorAddress={operatorAddress}
              pending={pending}
              onContinue={handleSignCreateAccount}
            />
          )}
          {step === 'fund' && (
            <FundStep
              depositAddress={state.account}
              balanceCNS={state.ausdBalanceCNS}
              minCNS={state.minOpenCNS}
            />
          )}
          {step === 'create' && (
            <CreateStep pending={pending} onSubmit={handleSubmitCreate} />
          )}
          {step === 'activate' && (
            <ActivateStep
              pending={pending}
              result={activateResult}
              onActivate={handleActivate}
            />
          )}
          {step === 'operator-replaced' && (
            <EndStateCard
              title="This phone is no longer your trading key"
              body="Another device or agent holds the trading key for this account now."
              actionLabel="Re-grant this device"
              onAction={() => navigate({ to: '/settings/agent' })}
            />
          )}
          {step === 'session-expired' && (
            <EndStateCard
              title="Trading session expired"
              body="This device's trading key has expired."
              actionLabel="Renew this device"
              onAction={() => navigate({ to: '/settings/agent' })}
            />
          )}
          {step === 'ready' && (
            <ReadyStep onContinue={() => navigate({ to: '/trade' })} />
          )}
        </motion.div>
      </AnimatePresence>

      {DevBypassPanelLazy && (
        <Suspense fallback={null}>
          <DevBypassPanelLazy
            stage={devBypassStage}
            onChange={setDevBypassStage}
          />
        </Suspense>
      )}
    </Shell>
  )
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="mx-auto min-h-screen max-w-[480px] px-5 py-10">
      <h1 className="type-title-1 mb-8">Set up your account</h1>
      {children}
    </div>
  )
}

/**
 * Onboarding progress (DESIGN 5.6.1, r2/r3): 40px pill, 4px inset, one
 * continuous `#6E54FF` fill spanning slots via a shared grid plus Motion's
 * `layout` animation (no discrete segments). Reports chain state: an
 * `<ol aria-current="step">`, never focusable, never hoverable.
 */
function ProgressPill({ activeIndex }: { activeIndex: number }) {
  return (
    <div className="relative mb-8 h-10 rounded-full bg-surface">
      <div className="absolute inset-1 grid grid-cols-5">
        <motion.div
          layout
          transition={SPRING_SMOOTH_TWO}
          className="rounded-full bg-[var(--color-accent-fill)]"
          style={{ gridColumn: `1 / span ${activeIndex + 1}` }}
        />
      </div>
      <ol
        aria-label="Account setup"
        className="absolute inset-1 grid grid-cols-5"
      >
        {STEP_ORDER.map((item, index) => (
          <li
            key={item.key}
            aria-current={index === activeIndex ? 'step' : undefined}
            className="flex items-center justify-center"
          >
            <span
              className={cnm(
                'type-caption',
                index <= activeIndex ? 'text-white' : 'text-[#8E8E93]',
              )}
            >
              {item.label}
            </span>
          </li>
        ))}
      </ol>
    </div>
  )
}

function CopyRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between border-b border-separator py-3 last:border-0">
      <div>
        <p className="type-label text-[#AEAEB2]">{label}</p>
        <p className="type-mono-sm">{shortenAddress(value)}</p>
      </div>
      <button
        type="button"
        aria-label={`Copy ${label}`}
        className="flex size-11 items-center justify-center rounded-full bg-[#2C2C2E]"
        onClick={() => navigator.clipboard.writeText(value)}
      >
        <Copy className="size-5" strokeWidth={1.75} />
      </button>
    </div>
  )
}

function KeysStep({
  ownerAddress,
  operatorAddress,
  pending,
  onContinue,
}: {
  ownerAddress: string
  operatorAddress: string
  pending: boolean
  onContinue: () => void
}) {
  return (
    <div
      className="card-big flex min-h-[400px] flex-col justify-between p-6"
      style={{ '--card-min-h': '400px' } as React.CSSProperties}
    >
      <div>
        <h2 className="type-title-1 mb-4">Your keys</h2>
        <CopyRow label="Owner" value={ownerAddress} />
        <CopyRow label="Trading key" value={operatorAddress} />
        <p className="type-footnote mt-4 text-[#AEAEB2]">
          The owner never signs a transaction and never needs MON. The trading
          key signs trades inside the limits you set.
        </p>
      </div>
      <GaplessButton
        variant="primary"
        size="lg"
        fullWidth
        isPending={pending}
        onPress={onContinue}
      >
        Continue
      </GaplessButton>
    </div>
  )
}

function FundStep({
  depositAddress,
  balanceCNS,
  minCNS,
}: {
  depositAddress: string
  balanceCNS: bigint
  minCNS: bigint
}) {
  const remainingCNS = minCNS > balanceCNS ? minCNS - balanceCNS : 0n
  return (
    <div
      className="card-big flex min-h-[400px] flex-col justify-between p-6 text-center"
      style={{ '--card-min-h': '400px' } as React.CSSProperties}
    >
      <div>
        <h2 className="type-title-1 mb-4">Fund your account</h2>
        <div className="mb-4 flex justify-center">
          <QrCode data={depositAddress} />
        </div>
        <p className="type-mono break-all text-[#AEAEB2]">{depositAddress}</p>
      </div>
      <div>
        <p className="type-num-lg">{formatCNS(balanceCNS)}</p>
        {remainingCNS > 0n && (
          <p className="type-footnote text-[#AEAEB2]">
            {formatCNS(remainingCNS)} more needed
          </p>
        )}
      </div>
    </div>
  )
}

function CreateStep({
  pending,
  onSubmit,
}: {
  pending: boolean
  onSubmit: () => void
}) {
  return (
    <div
      className="card-big flex min-h-[400px] flex-col justify-between p-6"
      style={{ '--card-min-h': '400px' } as React.CSSProperties}
    >
      <div>
        <h2 className="type-title-1 mb-4">Create your account</h2>
        <p className="type-callout text-[#AEAEB2]">
          You are funded. Submit your signed grant to deploy your account.
        </p>
      </div>
      <GaplessButton
        variant="primary"
        size="lg"
        fullWidth
        isPending={pending}
        onPress={onSubmit}
      >
        Create account
      </GaplessButton>
    </div>
  )
}

function ActivateStep({
  pending,
  result,
  onActivate,
}: {
  pending: boolean
  result: string | null
  onActivate: () => void
}) {
  return (
    <div
      className="card-big flex min-h-[400px] flex-col justify-between p-6"
      style={{ '--card-min-h': '400px' } as React.CSSProperties}
    >
      <div>
        <h2 className="type-title-1 mb-4">Activate trading</h2>
        <p className="type-callout text-[#AEAEB2]">
          Last step: open your Perpl account and fund your trading key for gas.
        </p>
        {result && <p className="type-callout mt-4 text-[#30D158]">{result}</p>}
      </div>
      <GaplessButton
        variant="primary"
        size="lg"
        fullWidth
        isPending={pending}
        onPress={onActivate}
      >
        Activate
      </GaplessButton>
    </div>
  )
}

function ReadyStep({ onContinue }: { onContinue: () => void }) {
  const reducedMotion = useReducedMotion()
  return (
    <div
      className="card-big relative flex min-h-[400px] flex-col items-center justify-center p-6 text-center"
      style={
        {
          '--card-min-h': '400px',
          backgroundImage:
            'radial-gradient(60% 50% at 50% 30%, rgba(110, 84, 255, 0.24), transparent 70%)',
        } as React.CSSProperties
      }
    >
      {/* Ready mark (DESIGN 7.8): mark scales in once, check draws once, one ring expands and fades once. */}
      <div className="relative mb-6 flex size-[88px] items-center justify-center">
        {!reducedMotion && (
          <motion.span
            aria-hidden
            className="absolute inset-0 rounded-full border-2 border-[var(--color-accent)]"
            initial={{ scale: 1, opacity: 0.6 }}
            animate={{ scale: 1.8, opacity: 0 }}
            transition={{ duration: 0.9, ease: EASE_OUT_EXPO }}
          />
        )}
        <motion.div
          className="absolute inset-0 rounded-full bg-[var(--color-accent-fill)]"
          initial={reducedMotion ? undefined : { scale: 0.6 }}
          animate={{ scale: 1 }}
          transition={SPRING_SMOOTH_ONE}
        />
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="#ffffff"
          strokeWidth={2.5}
          strokeLinecap="round"
          strokeLinejoin="round"
          className="relative size-10"
        >
          <motion.path
            d="M20 6 9 17l-5-5"
            initial={reducedMotion ? undefined : { pathLength: 0 }}
            animate={{ pathLength: 1 }}
            transition={{ duration: 0.4, ease: EASE_OUT_CUBIC }}
          />
        </svg>
      </div>
      <h2 className="type-title-1 mb-6">You're ready</h2>
      <GaplessButton variant="primary" size="lg" fullWidth onPress={onContinue}>
        Start trading
      </GaplessButton>
    </div>
  )
}

function EndStateCard({
  title,
  body,
  actionLabel,
  onAction,
}: {
  title: string
  body: string
  actionLabel: string
  onAction: () => void
}) {
  return (
    <div className="rounded-3xl bg-surface p-5">
      <h2 className="type-title-2 mb-4 text-[#FF9230]">{title}</h2>
      <p className="type-callout mb-4 text-[#AEAEB2]">{body}</p>
      <GaplessButton variant="secondary" size="lg" fullWidth onPress={onAction}>
        {actionLabel}
      </GaplessButton>
    </div>
  )
}

function UnlockCard() {
  // Inline, not a redirect (ARCHITECTURE 4: "routes that need a session
  // render an unlock card in place"). `onDone` is a no-op: useAccountSession
  // re-renders this page itself once the ceremony sets a session.
  const { pending, error, createAccount, signIn } = useAuthActions(() => {})
  const errorCopy = error ? errorCopyFor(error) : null

  return (
    <div className="mx-auto flex min-h-screen max-w-[480px] flex-col justify-center px-5">
      {/* DESIGN 10: the unlock card is a big card, 320px min, centered content. This
          one serves the no-account-yet case too, so it keeps both auth actions
          rather than the single "Unlock with passkey" button of an already-created account. */}
      <div
        className="card-big flex min-h-[320px] flex-col items-center justify-center p-6 text-center"
        style={{ '--card-min-h': '320px' } as React.CSSProperties}
      >
        <h2 className="type-title-1 mb-4">Set up your account</h2>
        <p className="type-callout mb-6 text-[#AEAEB2]">
          Create an account or sign in with your passkey to continue.
        </p>

        {errorCopy && (
          <div className="mb-4 rounded-md bg-[#2C2C2E] px-4 py-3 text-left">
            <p className="type-headline text-[#FF6165]">{errorCopy.title}</p>
            <p className="type-callout text-white">{errorCopy.body}</p>
          </div>
        )}

        <div className="flex flex-col gap-3">
          <GaplessButton
            variant="primary"
            size="lg"
            fullWidth
            isDisabled={pending !== null}
            isPending={pending === 'create'}
            onPress={createAccount}
          >
            Create account
          </GaplessButton>
          <GaplessButton
            variant="secondary"
            size="lg"
            fullWidth
            isDisabled={pending !== null}
            isPending={pending === 'signin'}
            onPress={signIn}
          >
            Sign in
          </GaplessButton>
        </div>
        <p className="type-footnote mt-4 text-[#AEAEB2]">
          Creating an account makes a new passkey. Already have one? Sign in
          instead.
        </p>
      </div>
    </div>
  )
}
