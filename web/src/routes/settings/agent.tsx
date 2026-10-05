import { useEffect, useRef, useState } from 'react'
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { isMeraError } from '@category-labs/mera'
import { toViemAccount } from '@category-labs/mera/viem'
import { formatUnits } from 'viem'
import { LockKeyhole } from 'lucide-react'
import type { Address, Hex } from 'viem'
import type { Eip712Domain } from '@/lib/account/typedData'
import type { TxLifecycle } from '@/lib/tx/send'
import ConfirmSheet from '@/components/ConfirmSheet'
import Field from '@/components/Field'
import GaplessButton from '@/components/GaplessButton'
import GroupedList from '@/components/GroupedList'
import QrCode from '@/components/QrCode'
import { AGENT_GRANT_BOUNDS, AGENT_REGRANT_DEFAULTS } from '@/config'
import { accountSession } from '@/lib/account/session'
import { unlockAccountKeys } from '@/lib/account/keys'
import { loadCredentialHint } from '@/lib/account/credentialHint'
import { OwnerScope } from '@/lib/account/scoped'
import { validateAgentAddress } from '@/lib/account/agentAddress'
import {
  hasAgentGrantLimitsErrors,
  validateAgentGrantLimits,
} from '@/lib/account/agentGrantLimits'
import {
  readSetOperatorSigningContext,
  useAgentGrantState,
} from '@/hooks/useAgentGrantState'
import { useAccountState } from '@/hooks/useAccountState'
import { useAccountSession } from '@/hooks/useAccountSession'
import { useAuthActions } from '@/hooks/useAuthActions'
import { sendOperatorCall } from '@/lib/tx/send'
import { errorCopyFor } from '@/lib/errors'
import { formatApproxDuration, formatCNS, shortenAddress } from '@/utils/units'

export const Route = createFileRoute('/settings/agent')({
  component: AgentPage,
})

type View =
  | { kind: 'home' }
  | { kind: 'grantForm' }
  | {
      kind: 'grantConfirm'
      address: Address
      expiryS: number
      deadlineS: number
      maxPerTradeCNS: bigint
      maxPerDayCNS: bigint
    }
  | {
      kind: 'grantResult'
      address: Address
      expiryS: number
      deadlineS: number
      maxPerTradeCNS: bigint
      maxPerDayCNS: bigint
      sig: Hex
    }
  | { kind: 'regrantConfirm' }
  | { kind: 'regrantDone' }

function AgentPage() {
  const { ownerSession, operatorSession } = useAccountSession()

  // Every signature and every send on this page re-derives its own fresh
  // session (a step-up ceremony, ARCHITECTURE phase 2 7.2 step 5) and ends
  // the owner session right after signing (8.3: "owner: end() right after
  // each signature"). Gating the whole page on the *live* session would
  // unmount straight back to the unlock card the instant that happens, so
  // once an owner/operator pair has been observed this page remembers their
  // addresses instead of re-deriving them from the (possibly now-ended)
  // live session on every render.
  const ownerAddressRef = useRef<Address | null>(null)
  const operatorAddressRef = useRef<Address | null>(null)
  if (ownerSession)
    ownerAddressRef.current = toViemAccount(ownerSession).address
  if (operatorSession)
    operatorAddressRef.current = toViemAccount(operatorSession).address
  const ownerAddress = ownerAddressRef.current
  const operatorAddress = operatorAddressRef.current

  const { data: chainState } = useAccountState(ownerAddress, operatorAddress)

  if (!ownerAddress || !operatorAddress) {
    return (
      <Shell>
        <UnlockCard />
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

  // Precondition (ARCHITECTURE 7.2 step 1): deployed and activated.
  // Deliberately not `deriveOnboardStep === 'ready'`: once an agent already
  // holds the operator grant, that derivation returns 'operator-replaced',
  // and this is exactly the page that must stay reachable then (7.3 re-grant).
  const activated = chainState.isDeployed && chainState.perplAccountId > 0n
  if (!activated) {
    return (
      <Shell>
        <NotReadyCard />
      </Shell>
    )
  }

  return (
    <Shell>
      <Ready
        owner={ownerAddress}
        account={chainState.account}
        thisDeviceOperator={operatorAddress}
      />
    </Shell>
  )
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="mx-auto min-h-screen max-w-[480px] px-5 py-10">
      <h1 className="type-title-1 mb-8">Trading agent</h1>
      {children}
    </div>
  )
}

function NotReadyCard() {
  const navigate = useNavigate()
  return (
    <div
      className="card-big flex flex-col justify-between p-6"
      style={{ '--card-min-h': '240px' } as React.CSSProperties}
    >
      <div>
        <p className="type-label mb-2 text-[#AEAEB2]">Account</p>
        <h2 className="type-title-1 mb-4">Finish setting up first</h2>
        <p className="type-callout text-[#AEAEB2]">
          Your account needs to be created and activated before you can grant a
          trading agent.
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
        Use your passkey to manage your trading agent.
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

/**
 * Fresh passkey ceremony for a step-up signature (ARCHITECTURE phase 2 7.2
 * step 5 amendment): always re-derives both owner and operator from a new
 * ceremony, regardless of any session already live. The owner session is
 * only ever held for the duration of one signature. The freshly derived
 * operator session replaces the live one only if none is live; otherwise
 * it is a duplicate of the same device key, so it is ended immediately and
 * the already-live session keeps running untouched.
 */
async function withFreshOwnerSignature<T>(
  sign: (owner: OwnerScope) => Promise<T>,
): Promise<T> {
  const credential = loadCredentialHint()
  const fresh = await unlockAccountKeys(credential ?? undefined)
  accountSession.setOwnerSession(fresh.ownerSession)
  try {
    return await sign(new OwnerScope(fresh.ownerSession))
  } finally {
    accountSession.endOwnerSession()
    if (accountSession.getOperatorSession()) {
      fresh.operatorSession.end()
    } else {
      accountSession.setOperatorSession(fresh.operatorSession)
    }
  }
}

const SET_OPERATOR_DOMAIN_NAME = 'GaplessAccount'
const SET_OPERATOR_DOMAIN_VERSION = '1'

/**
 * Display-only domain preview for a `SetOperator` confirm sheet (DESIGN 9.2:
 * "a domain check row... 'Verified: GaplessAccount v1, Monad 143, 0x…'").
 * The actual signing path re-reads the domain and hard-stops on a mismatch
 * via `assertDomainMatches` inside `OwnerScope.signSetOperator` regardless of
 * what this preview shows; this only lets the sheet render the row before
 * the owner ceremony starts.
 */
function useDomainPreview(account: Address) {
  const [domain, setDomain] = useState<Eip712Domain | null>(null)
  const [error, setError] = useState(false)

  useEffect(() => {
    let cancelled = false
    setDomain(null)
    setError(false)
    readSetOperatorSigningContext(account)
      .then((ctx) => {
        if (!cancelled) setDomain(ctx.domain)
      })
      .catch(() => {
        if (!cancelled) setError(true)
      })
    return () => {
      cancelled = true
    }
  }, [account])

  const verified =
    domain !== null &&
    domain.name === SET_OPERATOR_DOMAIN_NAME &&
    domain.version === SET_OPERATOR_DOMAIN_VERSION &&
    domain.chainId === 143 &&
    domain.verifyingContract.toLowerCase() === account.toLowerCase()

  return {
    loading: domain === null && !error,
    domainCheck: domain
      ? {
          verified,
          text: `Verified: ${domain.name} v${domain.version}, Monad ${domain.chainId}, ${domain.verifyingContract}`,
        }
      : error
        ? {
            verified: false,
            text: 'Could not read the signing domain from the contract.',
          }
        : undefined,
  }
}

function Ready({
  owner,
  account,
  thisDeviceOperator,
}: {
  owner: Address
  account: Address
  thisDeviceOperator: Address
}) {
  const { data: grantState, refetch } = useAgentGrantState(account)
  const [view, setView] = useState<View>({ kind: 'home' })
  const [actionError, setActionError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const [lifecycle, setLifecycle] = useState<TxLifecycle>({ status: 'idle' })

  const isThisDeviceOperator =
    grantState !== undefined &&
    grantState.operatorKey.toLowerCase() === thisDeviceOperator.toLowerCase()
  const errorCopy = actionError ? errorCopyFor(actionError) : null
  const nowS = grantState?.nowS ?? Math.floor(Date.now() / 1000)

  async function submitGrant(
    address: Address,
    expiryS: number,
    deadlineS: number,
    maxPerTradeCNS: bigint,
    maxPerDayCNS: bigint,
  ) {
    setActionError(null)
    setPending(true)
    try {
      const { domain, nonce } = await readSetOperatorSigningContext(account)
      const expectedDomain = {
        name: SET_OPERATOR_DOMAIN_NAME,
        version: SET_OPERATOR_DOMAIN_VERSION,
        chainId: 143,
        verifyingContract: account,
      }
      const sig = await withFreshOwnerSignature((ownerScope) =>
        ownerScope.signSetOperator(domain, expectedDomain, {
          account,
          key: address,
          expiry: BigInt(expiryS),
          maxNotional: maxPerTradeCNS,
          maxNotionalPerDay: maxPerDayCNS,
          nonce,
          deadline: BigInt(deadlineS),
        }),
      )
      setView({
        kind: 'grantResult',
        address,
        expiryS,
        deadlineS,
        maxPerTradeCNS,
        maxPerDayCNS,
        sig,
      })
    } catch (err) {
      setActionError(isMeraError(err) ? err.code : 'UNKNOWN')
    } finally {
      setPending(false)
    }
  }

  async function submitRegrant() {
    setActionError(null)
    setPending(true)
    try {
      const { domain, nonce } = await readSetOperatorSigningContext(account)
      const expectedDomain = {
        name: SET_OPERATOR_DOMAIN_NAME,
        version: SET_OPERATOR_DOMAIN_VERSION,
        chainId: 143,
        verifyingContract: account,
      }
      const expiryS = nowS + AGENT_REGRANT_DEFAULTS.expirySeconds
      const deadlineS = nowS + AGENT_REGRANT_DEFAULTS.deadlineSeconds
      const grant = {
        key: thisDeviceOperator,
        expiry: BigInt(expiryS),
        maxNotionalPerTradeCNS: AGENT_REGRANT_DEFAULTS.maxPerTradeCNS,
        maxNotionalPerDayCNS: AGENT_REGRANT_DEFAULTS.maxPerDayCNS,
      }
      const sig = await withFreshOwnerSignature((ownerScope) =>
        ownerScope.signSetOperator(domain, expectedDomain, {
          account,
          key: thisDeviceOperator,
          expiry: grant.expiry,
          maxNotional: grant.maxNotionalPerTradeCNS,
          maxNotionalPerDay: grant.maxNotionalPerDayCNS,
          nonce,
          deadline: BigInt(deadlineS),
        }),
      )
      // ARCHITECTURE 7.3 / phase 2 amendment: the OPERATOR submits this
      // itself (it holds the drip MON; the owner has none), through the
      // single ADR-W12 send pipeline (`sendOperatorCall`), never
      // `writeContractSync` directly.
      const operatorSession = accountSession.getOperatorSession()
      if (!operatorSession) throw new Error('no live operator session')
      const result = await sendOperatorCall(
        {
          functionName: 'setOperatorWithSig',
          args: [grant, BigInt(deadlineS), sig],
        },
        { session: operatorSession, owner, account },
        setLifecycle,
      )
      if (result.status !== 'done') {
        throw new Error(`setOperatorWithSig did not complete: ${result.status}`)
      }
      setView({ kind: 'regrantDone' })
      void refetch()
    } catch (err) {
      setActionError(isMeraError(err) ? err.code : 'UNKNOWN')
    } finally {
      setPending(false)
    }
  }

  if (view.kind === 'home') {
    return (
      <div className="flex flex-col gap-6">
        {errorCopy && (
          <div className="rounded-md bg-[#2C2C2E] px-4 py-3">
            <p className="type-headline text-[#FF6165]">{errorCopy.title}</p>
            <p className="type-callout text-white">{errorCopy.body}</p>
          </div>
        )}
        <CurrentOperatorCard
          grantState={grantState}
          isThisDeviceOperator={isThisDeviceOperator}
        />
        <GaplessButton
          variant="primary"
          size="lg"
          fullWidth
          onPress={() => setView({ kind: 'grantForm' })}
        >
          Grant a trading agent
        </GaplessButton>
        <GaplessButton
          variant="secondary"
          size="lg"
          fullWidth
          onPress={() => setView({ kind: 'regrantConfirm' })}
        >
          Re-grant this device
        </GaplessButton>
      </div>
    )
  }

  if (view.kind === 'grantForm') {
    return (
      <GrantForm
        owner={owner}
        account={account}
        nowS={nowS}
        onCancel={() => setView({ kind: 'home' })}
        onContinue={(
          address,
          expiryS,
          deadlineS,
          maxPerTradeCNS,
          maxPerDayCNS,
        ) =>
          setView({
            kind: 'grantConfirm',
            address,
            expiryS,
            deadlineS,
            maxPerTradeCNS,
            maxPerDayCNS,
          })
        }
      />
    )
  }

  if (view.kind === 'grantConfirm') {
    return (
      <GrantConfirm
        account={account}
        address={view.address}
        expiryS={view.expiryS}
        deadlineS={view.deadlineS}
        maxPerTradeCNS={view.maxPerTradeCNS}
        maxPerDayCNS={view.maxPerDayCNS}
        pending={pending}
        errorCopy={errorCopy}
        onBack={() => setView({ kind: 'grantForm' })}
        onConfirm={() =>
          submitGrant(
            view.address,
            view.expiryS,
            view.deadlineS,
            view.maxPerTradeCNS,
            view.maxPerDayCNS,
          )
        }
      />
    )
  }

  if (view.kind === 'grantResult') {
    return (
      <GrantResult
        account={account}
        expiryS={view.expiryS}
        deadlineS={view.deadlineS}
        maxPerTradeCNS={view.maxPerTradeCNS}
        maxPerDayCNS={view.maxPerDayCNS}
        sig={view.sig}
        onDone={() => {
          setView({ kind: 'home' })
          void refetch()
        }}
      />
    )
  }

  if (view.kind === 'regrantConfirm') {
    return (
      <RegrantConfirm
        account={account}
        thisDeviceOperator={thisDeviceOperator}
        nowS={nowS}
        pending={pending}
        lifecycle={lifecycle}
        errorCopy={errorCopy}
        onBack={() => {
          setLifecycle({ status: 'idle' })
          setView({ kind: 'home' })
        }}
        onConfirm={submitRegrant}
      />
    )
  }

  // view.kind === 'regrantDone'
  return <RegrantDone onDone={() => setView({ kind: 'home' })} />
}

function CurrentOperatorCard({
  grantState,
  isThisDeviceOperator,
}: {
  grantState: ReturnType<typeof useAgentGrantState>['data']
  isThisDeviceOperator: boolean
}) {
  if (!grantState) {
    return (
      <div className="rounded-[24px] bg-[#1C1C1E] p-5">
        <p className="type-label text-[#AEAEB2]">Current operator</p>
        <span className="mt-2 inline-block h-7 w-40 animate-pulse rounded-xs bg-[#2C2C2E]" />
      </div>
    )
  }

  const secondsLeft = Math.max(
    0,
    Number(grantState.operatorExpiry) - grantState.nowS,
  )

  return (
    <GroupedList
      title="Current operator"
      rows={[
        {
          key: 'who',
          label: isThisDeviceOperator ? 'This phone' : 'Agent',
          value: shortenAddress(grantState.operatorKey),
        },
        {
          key: 'expires',
          label: 'Expires',
          value: formatApproxDuration(secondsLeft),
        },
        {
          key: 'per-trade',
          label: 'Per-trade cap',
          value: formatCNS(grantState.operatorMaxPerTradeCNS),
        },
        {
          key: 'budget',
          label: 'Budget left today',
          value: formatCNS(grantState.operatorAvailableCNS),
        },
      ]}
    />
  )
}

/** Exact decimal AUSD input to CNS (6-decimal integer). `null` on anything
 * that is not a clean nonnegative decimal (ARCHITECTURE phase 2 ADR-W19:
 * calldata values are bigint end to end, parsed from the string directly). */
function parseAusdToCns(input: string): bigint | null {
  const trimmed = input.trim()
  if (!/^\d{1,12}(\.\d{1,6})?$/.test(trimmed)) return null
  const [intPart, fracPart = ''] = trimmed.split('.')
  return BigInt(intPart) * 1_000_000n + BigInt(fracPart.padEnd(6, '0'))
}

function formatAbsoluteTime(unixS: number): string {
  return new Date(unixS * 1000).toLocaleString(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  })
}

function GrantForm({
  owner,
  account,
  nowS,
  onCancel,
  onContinue,
}: {
  owner: Address
  account: Address
  nowS: number
  onCancel: () => void
  onContinue: (
    address: Address,
    expiryS: number,
    deadlineS: number,
    maxPerTradeCNS: bigint,
    maxPerDayCNS: bigint,
  ) => void
}) {
  const [addressInput, setAddressInput] = useState('')
  const [maxPerTrade, setMaxPerTrade] = useState('25')
  const [maxPerDay, setMaxPerDay] = useState('100')
  const [expiryHours, setExpiryHours] = useState('4')
  const [deadlineMinutes, setDeadlineMinutes] = useState('60')

  const addressResult = addressInput.trim()
    ? validateAgentAddress(addressInput, owner, account)
    : null

  const maxPerTradeCNS = parseAusdToCns(maxPerTrade)
  const maxPerDayCNS = parseAusdToCns(maxPerDay)
  const expiryHoursNum = Number(expiryHours)
  const deadlineMinutesNum = Number(deadlineMinutes)
  const expiryS =
    nowS +
    Math.round((Number.isFinite(expiryHoursNum) ? expiryHoursNum : 0) * 3600)
  const deadlineS =
    nowS +
    Math.round(
      (Number.isFinite(deadlineMinutesNum) ? deadlineMinutesNum : 0) * 60,
    )

  const limitErrors =
    maxPerTradeCNS !== null && maxPerDayCNS !== null
      ? validateAgentGrantLimits(
          { maxPerTradeCNS, maxPerDayCNS, expiryS, deadlineS },
          nowS,
          AGENT_GRANT_BOUNDS,
        )
      : { maxPerTrade: 'Enter an amount.' }

  const canContinue =
    addressResult?.ok === true &&
    maxPerTradeCNS !== null &&
    maxPerDayCNS !== null &&
    !hasAgentGrantLimitsErrors(limitErrors)

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-4 rounded-[24px] bg-[#1C1C1E] p-5">
        <h2 className="type-title-2">Grant a trading agent</h2>

        <Field
          label="Agent address"
          error={
            addressInput.trim() && addressResult?.ok === false
              ? addressResult.reason
              : undefined
          }
        >
          <input
            type="text"
            value={addressInput}
            onChange={(e) => setAddressInput(e.target.value)}
            placeholder="0x…"
            className="type-mono w-full bg-transparent text-white outline-none"
          />
        </Field>

        <Field
          label="Per trade"
          bound={`Up to ${formatCNS(AGENT_GRANT_BOUNDS.maxPerTradeCNS)}`}
          error={limitErrors.maxPerTrade}
        >
          <AmountInput value={maxPerTrade} onChange={setMaxPerTrade} />
        </Field>

        <Field
          label="Per day"
          bound={`Up to ${formatCNS(AGENT_GRANT_BOUNDS.maxPerDayCNS)}`}
          error={limitErrors.maxPerDay}
        >
          <AmountInput value={maxPerDay} onChange={setMaxPerDay} />
        </Field>

        <Field
          label="Expires in"
          bound={`Up to ${AGENT_GRANT_BOUNDS.maxExpirySeconds / 3600}h`}
          error={limitErrors.expiry}
        >
          <AmountInput
            value={expiryHours}
            onChange={setExpiryHours}
            unit="hours"
          />
        </Field>

        <Field
          label="Signature valid for"
          bound={`Up to ${AGENT_GRANT_BOUNDS.maxDeadlineSeconds / 60} min`}
          error={limitErrors.deadline}
        >
          <AmountInput
            value={deadlineMinutes}
            onChange={setDeadlineMinutes}
            unit="minutes"
          />
        </Field>
      </div>

      <div className="flex gap-3">
        <GaplessButton
          variant="secondary"
          size="lg"
          fullWidth
          onPress={onCancel}
        >
          Cancel
        </GaplessButton>
        <GaplessButton
          variant="primary"
          size="lg"
          fullWidth
          isDisabled={!canContinue}
          onPress={() => {
            if (
              !addressResult?.ok ||
              maxPerTradeCNS === null ||
              maxPerDayCNS === null
            )
              return
            onContinue(
              addressResult.address,
              expiryS,
              deadlineS,
              maxPerTradeCNS,
              maxPerDayCNS,
            )
          }}
        >
          Continue
        </GaplessButton>
      </div>
    </div>
  )
}

function AmountInput({
  value,
  onChange,
  unit = 'AUSD',
}: {
  value: string
  onChange: (v: string) => void
  unit?: string
}) {
  return (
    <>
      <input
        type="text"
        inputMode="decimal"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="type-num w-full bg-transparent text-white outline-none"
      />
      <span className="type-label text-[#AEAEB2]">{unit}</span>
    </>
  )
}

function GrantConfirm({
  account,
  address,
  expiryS,
  deadlineS,
  maxPerTradeCNS,
  maxPerDayCNS,
  pending,
  errorCopy,
  onBack,
  onConfirm,
}: {
  account: Address
  address: Address
  expiryS: number
  deadlineS: number
  maxPerTradeCNS: bigint
  maxPerDayCNS: bigint
  pending: boolean
  errorCopy: ReturnType<typeof errorCopyFor> | null
  onBack: () => void
  onConfirm: () => void
}) {
  const { loading, domainCheck } = useDomainPreview(account)
  return (
    <ConfirmSheet
      open
      onOpenChange={(v) => !v && onBack()}
      title="Grant a trading agent"
      totalLabel="Can trade up to"
      total={formatCNS(maxPerTradeCNS)}
      rows={[
        { key: 'per-day', label: 'Per day', value: formatCNS(maxPerDayCNS) },
        {
          key: 'expires',
          label: 'Expires',
          value: formatAbsoluteTime(expiryS),
        },
        {
          key: 'deadline',
          label: 'Signature valid until',
          value: formatAbsoluteTime(deadlineS),
        },
      ]}
      totalNote={
        <>
          This replaces this phone's trading key.{' '}
          <span className="type-headline text-white">
            It can never withdraw.
          </span>{' '}
          This phone stops trading until you re-grant it.
        </>
      }
      destination={{ label: 'Agent address', address, verified: false }}
      domainCheck={domainCheck}
      error={errorCopy}
      lifecycle={{ status: 'idle' }}
      pending={pending || loading}
      pendingLabel={loading ? 'Checking…' : 'Signing…'}
      disableConfirm={errorCopy !== null}
      confirmLabel="Sign with passkey"
      onConfirm={onConfirm}
    />
  )
}

/** Mirrors `plugin/src/ops/link.ts`'s unsigned `next` string exactly, with
 * the owner's real signature filled in (ARCHITECTURE 7.1 plugin command). */
function buildLinkCommand(args: {
  account: Address
  expiryS: number
  deadlineS: number
  maxPerTradeCNS: bigint
  maxPerDayCNS: bigint
  sig: Hex
}): string {
  const maxPerTradeAusd = formatUnits(args.maxPerTradeCNS, 6)
  const maxPerDayAusd = formatUnits(args.maxPerDayCNS, 6)
  return [
    'mm gapless link',
    `--account ${args.account}`,
    `--expiry ${args.expiryS}`,
    `--deadline ${args.deadlineS}`,
    `--max-per-trade ${maxPerTradeAusd}`,
    `--max-per-day ${maxPerDayAusd}`,
    `--sig ${args.sig}`,
  ].join(' ')
}

function GrantResult({
  account,
  expiryS,
  deadlineS,
  maxPerTradeCNS,
  maxPerDayCNS,
  sig,
  onDone,
}: {
  account: Address
  expiryS: number
  deadlineS: number
  maxPerTradeCNS: bigint
  maxPerDayCNS: bigint
  sig: Hex
  onDone: () => void
}) {
  const [copied, setCopied] = useState(false)
  const cliCommand = buildLinkCommand({
    account,
    expiryS,
    deadlineS,
    maxPerTradeCNS,
    maxPerDayCNS,
    sig,
  })

  async function copyCommand() {
    await navigator.clipboard.writeText(cliCommand)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-4 rounded-[24px] bg-[#1C1C1E] p-5">
        <h2 className="type-title-2">Signed</h2>
        <p className="type-callout text-[#AEAEB2]">
          Nothing was sent anywhere. Copy this command and run it where your
          agent's MetaMask wallet lives.
        </p>
        <pre className="type-mono whitespace-pre-wrap break-all rounded-md bg-[#2C2C2E] p-3 text-white">
          {cliCommand}
        </pre>
        <GaplessButton
          variant="secondary"
          size="lg"
          fullWidth
          onPress={copyCommand}
        >
          {copied ? 'Copied' : 'Copy command'}
        </GaplessButton>
        <div className="flex justify-center">
          <QrCode data={cliCommand} />
        </div>
      </div>
      <GaplessButton variant="primary" size="lg" fullWidth onPress={onDone}>
        Done
      </GaplessButton>
    </div>
  )
}

function RegrantConfirm({
  account,
  thisDeviceOperator,
  nowS,
  pending,
  lifecycle,
  errorCopy,
  onBack,
  onConfirm,
}: {
  account: Address
  thisDeviceOperator: Address
  nowS: number
  pending: boolean
  lifecycle: TxLifecycle
  errorCopy: ReturnType<typeof errorCopyFor> | null
  onBack: () => void
  onConfirm: () => void
}) {
  const expiryS = nowS + AGENT_REGRANT_DEFAULTS.expirySeconds
  const { loading, domainCheck } = useDomainPreview(account)
  const signing = pending && lifecycle.status === 'idle'
  return (
    <ConfirmSheet
      open
      onOpenChange={(v) => !v && onBack()}
      title="Re-grant this device"
      totalLabel="Per trade"
      total={formatCNS(AGENT_REGRANT_DEFAULTS.maxPerTradeCNS)}
      rows={[
        {
          key: 'per-day',
          label: 'Per day',
          value: formatCNS(AGENT_REGRANT_DEFAULTS.maxPerDayCNS),
        },
        {
          key: 'expires',
          label: 'Expires',
          value: formatAbsoluteTime(expiryS),
        },
      ]}
      totalNote={
        <>
          This makes this phone's trading key the operator again.{' '}
          <span className="type-headline text-white">
            It can never withdraw.
          </span>{' '}
          Today's trading budget does not reset: a re-grant keeps what was
          already used today.
        </>
      }
      destination={{
        label: 'This device',
        address: thisDeviceOperator,
        verified: true,
      }}
      domainCheck={domainCheck}
      error={errorCopy}
      lifecycle={lifecycle}
      pending={signing || loading}
      pendingLabel={loading ? 'Checking…' : 'Signing…'}
      confirmLabel="Sign and submit"
      onConfirm={onConfirm}
    />
  )
}

function RegrantDone({ onDone }: { onDone: () => void }) {
  const navigate = useNavigate()
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-4 rounded-[24px] bg-[#1C1C1E] p-5 text-center">
        <h2 className="type-title-2">This device is trading again</h2>
        <p className="type-callout text-[#AEAEB2]">
          Your trading key is the operator again.
        </p>
      </div>
      <GaplessButton
        variant="primary"
        size="lg"
        fullWidth
        onPress={() => navigate({ to: '/trade' })}
      >
        Go to Trade
      </GaplessButton>
      <GaplessButton variant="text" size="lg" fullWidth onPress={onDone}>
        Back to agent settings
      </GaplessButton>
    </div>
  )
}
