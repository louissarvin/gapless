import { useRef, useState } from 'react'
import { Link, createFileRoute } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { toViemAccount } from '@category-labs/mera/viem'
import { formatUnits } from 'viem'
import { ChevronRight, LockKeyhole } from 'lucide-react'
import type { OperatorCallEstimate, TxLifecycle } from '@/lib/tx/send'
import type {
  VaultPublicState,
  VaultRedeemRequest,
} from '@/hooks/useVaultChainState'
import ConfirmSheet, { estimateToNetworkCost } from '@/components/ConfirmSheet'
import Field from '@/components/Field'
import GaplessButton from '@/components/GaplessButton'
import GroupedList from '@/components/GroupedList'
import InlineBanner from '@/components/InlineBanner'
import UtilizationRing from '@/components/UtilizationRing'
import { useAccountSession } from '@/hooks/useAccountSession'
import { useAuthActions } from '@/hooks/useAuthActions'
import { useAccountState } from '@/hooks/useAccountState'
import {
  useVaultChainState,
  useVaultPosition,
} from '@/hooks/useVaultChainState'
import {
  assetsFromClaimReceipt,
  estimateOperatorCall,
  requestIdFromReceipt,
  sendOperatorCall,
  sharesFromDepositReceipt,
} from '@/lib/tx/send'
import { OrderInputError, parseDecimalToUnits } from '@/lib/trade/order'
import { getStats } from '@/lib/api/relay'
import { publicClient } from '@/lib/chain'
import { ICoverVaultAbi } from '@/abi/ICoverVault'
import { errorCopyFor, errorCopyForRevert } from '@/lib/errors'
import { ADDRESSES } from '@/config/addresses.143'
import { formatApproxDuration, formatCNS } from '@/utils/units'

export const Route = createFileRoute('/vault')({ component: VaultPage })

/** Real block time is about 300ms (lib/chain.ts `POLLING_INTERVAL_MS` note). Display only. */
const BLOCK_TIME_S = 0.3

function VaultPage() {
  return (
    <div className="mx-auto flex max-w-[480px] flex-col gap-6 px-5 pt-8 pb-16">
      <h1 className="type-title-1">Vault</h1>
      <PublicSection />
      <LpSection />
    </div>
  )
}

function blocksToApprox(blocks: bigint): string {
  return formatApproxDuration(Number(blocks) * BLOCK_TIME_S)
}

/** ADR-W18: every number here is read live, never hardcoded. */
function PublicSection() {
  const { data, isError } = useVaultChainState()
  const stats = useQuery({
    queryKey: ['stats'],
    queryFn: getStats,
    refetchInterval: 60_000,
    staleTime: 60_000,
  })

  if (isError) {
    return (
      <InlineBanner
        title="Vault data is unavailable"
        body="Try again in a moment."
      />
    )
  }
  if (!data) {
    return <p className="type-callout text-[#AEAEB2]">Loading vault…</p>
  }

  const lpCount = stats.data?.gapless.vault.lpCount ?? null
  const toLpsCNS = stats.data?.gapless.premiums.toLpsCNS
  const toTreasuryCNS = stats.data?.gapless.premiums.toTreasuryCNS

  return (
    <>
      <TvlCard data={data} />

      <GroupedList
        title="Capacity"
        rows={[
          {
            key: 'reserved',
            label: 'Reserved total',
            value: formatCNS(data.reservedTotalCNS),
          },
          {
            key: 'reserved-btc',
            label: 'Reserved for BTC',
            value: formatCNS(data.reservedBtcCNS),
          },
          {
            key: 'free',
            label: 'Free assets',
            value: formatCNS(data.freeAssetsCNS),
          },
          {
            key: 'owed',
            label: 'Owed (deferred)',
            value: formatCNS(data.owedTotalCNS),
          },
          {
            key: 'live',
            label: 'Live covers',
            value: data.liveCoverCount.toString(),
          },
        ]}
      />

      <GroupedList
        title="Returns"
        rows={[
          {
            key: 'to-lps',
            label: 'Premiums to LPs',
            value: toLpsCNS ? formatCNS(BigInt(toLpsCNS)) : '—',
          },
          {
            key: 'to-treasury',
            label: 'Premiums to treasury',
            value: toTreasuryCNS ? formatCNS(BigInt(toTreasuryCNS)) : '—',
          },
          {
            key: 'fee',
            label: 'Protocol fee',
            value: `${(data.protocolFeeBps / 100).toFixed(2)}%`,
          },
          {
            key: 'lp-count',
            label: 'LPs',
            value: lpCount !== null ? lpCount.toString() : '—',
          },
          {
            key: 'share-price',
            label: 'Share price',
            value: formatCNS(data.sharePriceCNS),
          },
        ]}
      />

      <MaxLossCard data={data} />

      <div className="rounded-[24px] bg-[#1C1C1E]">
        <Link
          to="/stats"
          className="flex min-h-[44px] items-center justify-between gap-4 border-b border-[#3A3A3C] px-5 py-3 active:scale-[0.98]"
        >
          <span className="type-body text-white">Protocol stats</span>
          <ChevronRight className="size-5 text-[#8E8E93]" strokeWidth={1.75} />
        </Link>
        <Link
          to="/gap-index"
          className="flex min-h-[44px] items-center justify-between gap-4 px-5 py-3 active:scale-[0.98]"
        >
          <span className="type-body text-white">Gap Index</span>
          <ChevronRight className="size-5 text-[#8E8E93]" strokeWidth={1.75} />
        </Link>
      </div>
    </>
  )
}

function TvlCard({ data }: { data: VaultPublicState }) {
  return (
    <div
      className="card-big flex flex-col justify-between p-6"
      style={{ '--card-min-h': '280px' } as React.CSSProperties}
    >
      <div className="flex items-start justify-between">
        <p className="type-label text-[#AEAEB2]">Total value locked</p>
        <UtilizationRing bps={Number(data.utilizationBps)} />
      </div>
      <div className="mt-6">
        <p className="type-num-hero mb-1">{formatCNS(data.totalAssetsCNS)}</p>
        <p className="type-footnote text-[#AEAEB2]">
          {formatCNS(data.reservedTotalCNS)} reserved
        </p>
      </div>
    </div>
  )
}

function MaxLossCard({ data }: { data: VaultPublicState }) {
  return (
    <div className="rounded-[24px] bg-[#1C1C1E] p-5">
      <h3 className="type-headline mb-3 text-white">What LPs can lose</h3>
      <p className="type-body mb-3 text-[#AEAEB2]">
        Worst case, LPs lose the reserved liability. The vault caps that at{' '}
        {(data.maxUtilizationBps / 100).toFixed(0)}% of assets. Payouts to any
        one market stop at {(data.perBlockPayoutCapBps / 100).toFixed(0)}% of
        assets per block; the rest is owed and paid later. Each cover's payout
        is at most its cap, notional times at most{' '}
        {(data.maxGapBpsCap / 100).toFixed(2)}%, on at most{' '}
        {formatCNS(data.maxCoverNotionalCNS)} notional.
      </p>
      <p className="type-body text-[#AEAEB2]">
        Deposits lock for {blocksToApprox(data.depositLockBlocks)} after you
        deposit. Redemptions cool down {blocksToApprox(data.cooldownBlocks)}{' '}
        after you request. A claim pays the lower of the vault's value when you
        requested and when you claim: if the vault lost value while you waited,
        you absorb it; if it gained, the gain stays with the remaining LPs.
      </p>
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
        Use your passkey to deposit or manage your position.
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

function ErrorBlock({ title, body }: { title: string; body: string }) {
  return (
    <div className="rounded-md bg-[#2C2C2E] px-4 py-3">
      <p className="type-headline text-[#FF6165]">{title}</p>
      <p className="type-callout text-white">{body}</p>
    </div>
  )
}

function LpSection() {
  const { ownerSession, operatorSession } = useAccountSession()
  const ownerAddress = ownerSession ? toViemAccount(ownerSession).address : null
  const operatorAddress = operatorSession
    ? toViemAccount(operatorSession).address
    : null
  const { data: accountState } = useAccountState(ownerAddress, operatorAddress)
  const vaultChain = useVaultChainState()
  const position = useVaultPosition(operatorAddress)

  if (!ownerSession || !operatorSession || !ownerAddress || !operatorAddress) {
    return <UnlockCard />
  }
  if (!accountState || !vaultChain.data || !position.data) {
    return <p className="type-callout text-[#AEAEB2]">Loading your position…</p>
  }

  return (
    <LpPosition
      owner={ownerAddress}
      account={accountState.account}
      operator={operatorAddress}
      operatorSession={operatorSession}
      vault={vaultChain.data}
      position={position.data}
      onChanged={() => {
        void position.refetch()
        void vaultChain.refetch()
      }}
    />
  )
}

function LpPosition({
  owner,
  account,
  operator,
  operatorSession,
  vault,
  position,
  onChanged,
}: {
  owner: `0x${string}`
  account: `0x${string}`
  operator: `0x${string}`
  operatorSession: Parameters<typeof sendOperatorCall>[1]['session']
  vault: VaultPublicState
  position: ReturnType<typeof useVaultPosition>['data'] & object
  onChanged: () => void
}) {
  const hasShares = position.sharesBalance > 0n
  const locked = position.lockUntilBlock > vault.blockNumber

  return (
    <div className="flex flex-col gap-6">
      <GroupedList
        title="Your position"
        rows={[
          {
            key: 'value',
            label: 'Value',
            value: formatCNS(position.valueCNS),
          },
          {
            key: 'shares',
            label: 'Shares',
            value: formatUnits(position.sharesBalance, vault.shareDecimals),
          },
          {
            key: 'lock',
            label: 'Lock status',
            value: hasShares
              ? locked
                ? `Locked until #${position.lockUntilBlock.toString()}`
                : 'Unlocked'
              : '—',
          },
          {
            key: 'wallet',
            label: 'Wallet AUSD',
            value: formatCNS(position.ausdBalanceCNS),
          },
        ]}
      />

      <DepositForm
        owner={owner}
        account={account}
        operator={operator}
        operatorSession={operatorSession}
        vault={vault}
        position={position}
        onChanged={onChanged}
      />

      {hasShares && (
        <RequestRedeemForm
          owner={owner}
          account={account}
          operator={operator}
          operatorSession={operatorSession}
          vault={vault}
          position={position}
          locked={locked}
          onChanged={onChanged}
        />
      )}

      {position.requests.length > 0 && (
        <RequestsList
          owner={owner}
          account={account}
          operatorSession={operatorSession}
          vault={vault}
          requests={position.requests}
          onChanged={onChanged}
        />
      )}
    </div>
  )
}

function DepositForm({
  owner,
  account,
  operator,
  operatorSession,
  vault,
  position,
  onChanged,
}: {
  owner: `0x${string}`
  account: `0x${string}`
  operator: `0x${string}`
  operatorSession: Parameters<typeof sendOperatorCall>[1]['session']
  vault: VaultPublicState
  position: NonNullable<ReturnType<typeof useVaultPosition>['data']>
  onChanged: () => void
}) {
  const [amountInput, setAmountInput] = useState('')
  const [preview, setPreview] = useState<{
    amountCNS: bigint
    sharesOut: bigint
  } | null>(null)
  const [previewing, setPreviewing] = useState(false)
  const [sending, setSending] = useState(false)
  const [step, setStep] = useState<'approve' | 'deposit' | null>(null)
  const [lifecycle, setLifecycle] = useState<TxLifecycle>({ status: 'idle' })
  const [actionError, setActionError] = useState<string | null>(null)
  const [done, setDone] = useState<{ sharesOut: bigint } | null>(null)
  const [sheetOpen, setSheetOpen] = useState(false)
  const [estimate, setEstimate] = useState<OperatorCallEstimate | null>(null)
  const [estimateError, setEstimateError] = useState<string | null>(null)
  const sendInFlightRef = useRef(false)
  const sendAbortRef = useRef<AbortController | null>(null)

  let amountCNS = 0n
  let amountErr: string | null = null
  if (amountInput.trim()) {
    try {
      amountCNS = parseDecimalToUnits(amountInput, 6, 'amount')
      if (amountCNS < vault.minDepositCNS) {
        amountErr = `Minimum deposit is ${formatCNS(vault.minDepositCNS)}`
      } else if (amountCNS > position.ausdBalanceCNS) {
        amountErr = 'More than your wallet balance'
      }
    } catch (err) {
      amountErr =
        err instanceof OrderInputError ? err.message : 'Invalid amount'
    }
  }

  function reset() {
    setPreview(null)
    setDone(null)
    setActionError(null)
    setLifecycle({ status: 'idle' })
  }

  const needsApprove = position.ausdAllowanceCNS < (preview?.amountCNS ?? 0n)

  async function runPreview() {
    setActionError(null)
    setPreviewing(true)
    try {
      const sharesOut = await publicClient.readContract({
        address: ADDRESSES.CoverVault,
        abi: ICoverVaultAbi,
        functionName: 'previewDeposit',
        args: [amountCNS],
      })
      setPreview({ amountCNS, sharesOut })
    } catch {
      setActionError('Could not price this deposit')
    } finally {
      setPreviewing(false)
    }
  }

  function openSheet() {
    setSheetOpen(true)
    setEstimate(null)
    setEstimateError(null)
    void runEstimate()
  }

  function closeSheet() {
    sendAbortRef.current?.abort()
    setSheetOpen(false)
    setLifecycle({ status: 'idle' })
    setActionError(null)
  }

  async function runEstimate() {
    if (!preview) return
    try {
      const call = needsApprove
        ? ({ target: 'approveVault', amountCNS: preview.amountCNS } as const)
        : ({
            target: 'vault',
            functionName: 'deposit',
            args: [preview.amountCNS, operator],
          } as const)
      const est = await estimateOperatorCall(call, {
        session: operatorSession,
        owner,
        account,
      })
      setEstimate(est)
    } catch (err) {
      setEstimateError(
        err instanceof Error ? err.message : 'Could not estimate network cost',
      )
    }
  }

  async function runDeposit() {
    if (!preview || sendInFlightRef.current) return
    sendInFlightRef.current = true
    setActionError(null)
    setSending(true)
    const controller = new AbortController()
    sendAbortRef.current = controller
    try {
      if (position.ausdAllowanceCNS < preview.amountCNS) {
        setStep('approve')
        const approveResult = await sendOperatorCall(
          { target: 'approveVault', amountCNS: preview.amountCNS },
          { session: operatorSession, owner, account },
          setLifecycle,
          controller.signal,
        )
        if (approveResult.status !== 'done') {
          if (approveResult.status === 'reverted') {
            setActionError(revertErrorCode(approveResult.decoded))
          }
          return
        }
      }
      setStep('deposit')
      setLifecycle({ status: 'idle' })
      const depositResult = await sendOperatorCall(
        {
          target: 'vault',
          functionName: 'deposit',
          args: [preview.amountCNS, operator],
        },
        { session: operatorSession, owner, account },
        setLifecycle,
        controller.signal,
      )
      if (depositResult.status === 'reverted') {
        setActionError(revertErrorCode(depositResult.decoded))
      } else if (depositResult.status === 'done') {
        const sharesOut =
          sharesFromDepositReceipt(depositResult.receipt) ?? preview.sharesOut
        setDone({ sharesOut })
        setAmountInput('')
        setPreview(null)
        onChanged()
      }
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Deposit failed')
      setLifecycle({ status: 'idle' })
    } finally {
      setSending(false)
      setStep(null)
      sendInFlightRef.current = false
      sendAbortRef.current = null
    }
  }

  return (
    <div className="rounded-[24px] bg-[#1C1C1E] p-5">
      <h2 className="type-title-2 mb-4">Deposit</h2>

      <Field
        label="Amount"
        error={amountErr ?? undefined}
        bound={`Minimum ${formatCNS(vault.minDepositCNS)}. Locks for ${blocksToApprox(vault.depositLockBlocks)} after it lands.`}
        className="mb-4"
      >
        <input
          inputMode="decimal"
          value={amountInput}
          onChange={(e) => {
            setAmountInput(e.target.value)
            reset()
          }}
          placeholder="0"
          className="type-num w-full bg-transparent outline-none"
        />
        <span className="type-label text-[#AEAEB2]">AUSD</span>
      </Field>

      {done && (
        <div className="mb-4 rounded-md bg-[#2C2C2E] px-4 py-3">
          <p className="type-headline text-[#30D158]">Deposited</p>
          <p className="type-callout text-white">
            {formatUnits(done.sharesOut, vault.shareDecimals)} shares received
          </p>
        </div>
      )}

      {actionError && !sheetOpen && (
        <div className="mb-4">
          <ErrorBlock
            title={errorCopyFor(actionError).title}
            body={errorCopyFor(actionError).body}
          />
        </div>
      )}

      <GaplessButton
        variant="primary"
        size="lg"
        fullWidth
        isDisabled={
          amountCNS === 0n || Boolean(amountErr) || previewing || sending
        }
        isPending={previewing}
        onPress={() => {
          if (!preview) void runPreview()
          else openSheet()
        }}
      >
        {!preview
          ? previewing
            ? 'Pricing…'
            : 'Preview deposit'
          : 'Review deposit'}
      </GaplessButton>

      {preview && sheetOpen && (
        <ConfirmSheet
          open
          onOpenChange={(v) => !v && closeSheet()}
          title="Deposit"
          totalLabel="Depositing"
          total={formatCNS(preview.amountCNS)}
          totalNote={
            needsApprove
              ? 'Two transactions: approve, then deposit.'
              : undefined
          }
          rows={[
            {
              key: 'shares',
              label: 'Shares you receive',
              value: `${formatUnits(preview.sharesOut, vault.shareDecimals)} shares`,
            },
            {
              key: 'lock',
              label: 'Locked until',
              value: `#${(vault.blockNumber + vault.depositLockBlocks).toString()}`,
              note: `about ${blocksToApprox(vault.depositLockBlocks)} from now`,
            },
          ]}
          networkCost={estimateToNetworkCost(estimate)}
          destination={{
            label: 'Gapless vault',
            address: ADDRESSES.CoverVault,
            verified: true,
          }}
          footerDetails={{
            functionName: step === 'approve' ? 'approve' : 'deposit',
            chainId: 143,
          }}
          lifecycle={lifecycle}
          disableConfirm={Boolean(estimateError)}
          confirmLabel="Deposit"
          onConfirm={() => void runDeposit()}
        />
      )}
    </div>
  )
}

function RequestRedeemForm({
  owner,
  account,
  operator: _operator,
  operatorSession,
  vault,
  position,
  locked,
  onChanged,
}: {
  owner: `0x${string}`
  account: `0x${string}`
  operator: `0x${string}`
  operatorSession: Parameters<typeof sendOperatorCall>[1]['session']
  vault: VaultPublicState
  position: NonNullable<ReturnType<typeof useVaultPosition>['data']>
  locked: boolean
  onChanged: () => void
}) {
  const [sharesInput, setSharesInput] = useState('')
  const [preview, setPreview] = useState<{
    shares: bigint
    assetsOut: bigint
  } | null>(null)
  const [previewing, setPreviewing] = useState(false)
  const [sending, setSending] = useState(false)
  const [lifecycle, setLifecycle] = useState<TxLifecycle>({ status: 'idle' })
  const [actionError, setActionError] = useState<string | null>(null)
  const [done, setDone] = useState<{ requestId: bigint } | null>(null)
  const [sheetOpen, setSheetOpen] = useState(false)
  const [estimate, setEstimate] = useState<OperatorCallEstimate | null>(null)
  const [estimateError, setEstimateError] = useState<string | null>(null)
  const sendInFlightRef = useRef(false)
  const sendAbortRef = useRef<AbortController | null>(null)

  let shares = 0n
  let sharesErr: string | null = null
  if (sharesInput.trim()) {
    try {
      shares = parseDecimalToUnits(sharesInput, vault.shareDecimals, 'shares')
      if (shares > position.sharesBalance) {
        sharesErr = 'More than your share balance'
      }
    } catch (err) {
      sharesErr =
        err instanceof OrderInputError ? err.message : 'Invalid amount'
    }
  }

  function reset() {
    setPreview(null)
    setDone(null)
    setActionError(null)
    setLifecycle({ status: 'idle' })
  }

  async function runPreview() {
    setActionError(null)
    setPreviewing(true)
    try {
      const assetsOut = await publicClient.readContract({
        address: ADDRESSES.CoverVault,
        abi: ICoverVaultAbi,
        functionName: 'previewRedeem',
        args: [shares],
      })
      setPreview({ shares, assetsOut })
    } catch {
      setActionError('Could not price this redemption')
    } finally {
      setPreviewing(false)
    }
  }

  function openSheet() {
    setSheetOpen(true)
    setEstimate(null)
    setEstimateError(null)
    void runEstimate()
  }

  function closeSheet() {
    sendAbortRef.current?.abort()
    setSheetOpen(false)
    setLifecycle({ status: 'idle' })
    setActionError(null)
  }

  async function runEstimate() {
    if (!preview) return
    try {
      const est = await estimateOperatorCall(
        {
          target: 'vault',
          functionName: 'requestRedeem',
          args: [preview.shares],
        },
        { session: operatorSession, owner, account },
      )
      setEstimate(est)
    } catch (err) {
      setEstimateError(
        err instanceof Error ? err.message : 'Could not estimate network cost',
      )
    }
  }

  async function runRequest() {
    if (!preview || sendInFlightRef.current) return
    sendInFlightRef.current = true
    setActionError(null)
    setSending(true)
    const controller = new AbortController()
    sendAbortRef.current = controller
    try {
      const result = await sendOperatorCall(
        {
          target: 'vault',
          functionName: 'requestRedeem',
          args: [preview.shares],
        },
        { session: operatorSession, owner, account },
        setLifecycle,
        controller.signal,
      )
      if (result.status === 'reverted') {
        setActionError(revertErrorCode(result.decoded))
      } else if (result.status === 'done') {
        const requestId = requestIdFromReceipt(result.receipt)
        if (requestId !== null) setDone({ requestId })
        setSharesInput('')
        setPreview(null)
        onChanged()
      }
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Request failed')
      setLifecycle({ status: 'idle' })
    } finally {
      setSending(false)
      sendInFlightRef.current = false
      sendAbortRef.current = null
    }
  }

  return (
    <div className="rounded-[24px] bg-[#1C1C1E] p-5">
      <h2 className="type-title-2 mb-2">Request redeem</h2>
      <p className="type-callout mb-4 text-[#AEAEB2]">
        Starts a {blocksToApprox(vault.cooldownBlocks)} cooldown. The claim pays
        the lower of the vault's value now and its value when you claim.
      </p>

      {locked && (
        <p className="type-footnote mb-3 text-[#FF9230]">
          Your deposit is still locked until #
          {position.lockUntilBlock.toString()}.
        </p>
      )}

      <Field label="Shares" error={sharesErr ?? undefined} className="mb-4">
        <input
          inputMode="decimal"
          value={sharesInput}
          onChange={(e) => {
            setSharesInput(e.target.value)
            reset()
          }}
          placeholder="0"
          className="type-num w-full bg-transparent outline-none"
        />
      </Field>

      {done && (
        <div className="mb-4 rounded-md bg-[#2C2C2E] px-4 py-3">
          <p className="type-headline text-[#30D158]">Requested</p>
          <p className="type-callout text-white">
            Request #{done.requestId.toString()} created
          </p>
        </div>
      )}

      {actionError && !sheetOpen && (
        <div className="mb-4">
          <ErrorBlock
            title={errorCopyFor(actionError).title}
            body={errorCopyFor(actionError).body}
          />
        </div>
      )}

      <GaplessButton
        variant="secondary"
        size="lg"
        fullWidth
        isDisabled={
          shares === 0n || Boolean(sharesErr) || locked || previewing || sending
        }
        isPending={previewing}
        onPress={() => {
          if (!preview) void runPreview()
          else openSheet()
        }}
      >
        {!preview
          ? previewing
            ? 'Pricing…'
            : 'Preview redeem'
          : 'Review redeem'}
      </GaplessButton>

      {preview && sheetOpen && (
        <ConfirmSheet
          open
          onOpenChange={(v) => !v && closeSheet()}
          title="Request redeem"
          totalLabel="Estimated payout at claim"
          total={formatCNS(preview.assetsOut)}
          totalNote="A claim pays the lower of the vault's value at request and at claim (whichever is less)."
          rows={[
            {
              key: 'shares',
              label: 'Shares',
              value: formatUnits(preview.shares, vault.shareDecimals),
            },
            {
              key: 'cooldown',
              label: 'Cooldown',
              value: blocksToApprox(vault.cooldownBlocks),
            },
          ]}
          networkCost={estimateToNetworkCost(estimate)}
          destination={{
            label: 'Gapless vault',
            address: ADDRESSES.CoverVault,
            verified: true,
          }}
          footerDetails={{ functionName: 'requestRedeem', chainId: 143 }}
          lifecycle={lifecycle}
          disableConfirm={Boolean(estimateError)}
          confirmLabel="Request redeem"
          onConfirm={() => void runRequest()}
        />
      )}
    </div>
  )
}

function RequestsList({
  owner,
  account,
  operatorSession,
  vault,
  requests,
  onChanged,
}: {
  owner: `0x${string}`
  account: `0x${string}`
  operatorSession: Parameters<typeof sendOperatorCall>[1]['session']
  vault: VaultPublicState
  requests: ReadonlyArray<VaultRedeemRequest>
  onChanged: () => void
}) {
  return (
    <div className="rounded-[24px] bg-[#1C1C1E] p-5">
      <h2 className="type-title-2 mb-4">Pending redemptions</h2>
      <div className="flex flex-col gap-4">
        {requests.map((r) => (
          <ClaimRow
            key={r.requestId.toString()}
            owner={owner}
            account={account}
            operatorSession={operatorSession}
            vault={vault}
            request={r}
            onChanged={onChanged}
          />
        ))}
      </div>
    </div>
  )
}

function ClaimRow({
  owner,
  account,
  operatorSession,
  vault,
  request,
  onChanged,
}: {
  owner: `0x${string}`
  account: `0x${string}`
  operatorSession: Parameters<typeof sendOperatorCall>[1]['session']
  vault: VaultPublicState
  request: VaultRedeemRequest
  onChanged: () => void
}) {
  const [sending, setSending] = useState(false)
  const [lifecycle, setLifecycle] = useState<TxLifecycle>({ status: 'idle' })
  const [actionError, setActionError] = useState<string | null>(null)
  const [paidCNS, setPaidCNS] = useState<bigint | null>(null)
  const [sheetOpen, setSheetOpen] = useState(false)
  const [estimate, setEstimate] = useState<OperatorCallEstimate | null>(null)
  const [estimateError, setEstimateError] = useState<string | null>(null)
  const sendInFlightRef = useRef(false)
  const sendAbortRef = useRef<AbortController | null>(null)

  const claimable = vault.blockNumber >= request.claimableBlock

  function openSheet() {
    setSheetOpen(true)
    setEstimate(null)
    setEstimateError(null)
    estimateOperatorCall(
      {
        target: 'vault',
        functionName: 'claimRedeem',
        args: [request.requestId, owner],
      },
      { session: operatorSession, owner, account },
    )
      .then(setEstimate)
      .catch((err: unknown) =>
        setEstimateError(
          err instanceof Error
            ? err.message
            : 'Could not estimate network cost',
        ),
      )
  }

  function closeSheet() {
    sendAbortRef.current?.abort()
    setSheetOpen(false)
    setLifecycle({ status: 'idle' })
    setActionError(null)
  }

  async function runClaim() {
    if (sendInFlightRef.current) return
    sendInFlightRef.current = true
    setActionError(null)
    setSending(true)
    const controller = new AbortController()
    sendAbortRef.current = controller
    try {
      const result = await sendOperatorCall(
        {
          target: 'vault',
          functionName: 'claimRedeem',
          args: [request.requestId, owner],
        },
        { session: operatorSession, owner, account },
        setLifecycle,
        controller.signal,
      )
      if (result.status === 'reverted') {
        setActionError(revertErrorCode(result.decoded))
      } else if (result.status === 'done') {
        setPaidCNS(assetsFromClaimReceipt(result.receipt))
        onChanged()
      }
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Claim failed')
      setLifecycle({ status: 'idle' })
    } finally {
      setSending(false)
      sendInFlightRef.current = false
      sendAbortRef.current = null
    }
  }

  return (
    <div className="rounded-md bg-[#2C2C2E] px-4 py-3">
      <div className="mb-2 flex items-center justify-between">
        <p className="type-headline text-white">
          Request #{request.requestId.toString()}
        </p>
        <p className="type-footnote text-[#AEAEB2]">
          {claimable
            ? 'Ready to claim'
            : `Claimable at #${request.claimableBlock.toString()}`}
        </p>
      </div>
      <p className="type-footnote mb-3 text-[#AEAEB2]">
        Locked in at {formatCNS(request.assetsAtRequestCNS)}. You will be paid
        whichever is lower: that value, or the vault's value right now.
      </p>

      {paidCNS !== null && (
        <div className="mb-3 rounded-md bg-[#1C1C1E] px-3 py-2">
          <p className="type-headline text-[#30D158]">Claimed</p>
          <p className="type-callout text-white">{formatCNS(paidCNS)} paid</p>
        </div>
      )}

      {actionError && !sheetOpen && (
        <div className="mb-3">
          <ErrorBlock
            title={errorCopyFor(actionError).title}
            body={errorCopyFor(actionError).body}
          />
        </div>
      )}

      <GaplessButton
        variant="secondary"
        size="md"
        fullWidth
        isDisabled={!claimable || sending}
        onPress={openSheet}
      >
        Claim
      </GaplessButton>

      {sheetOpen && (
        <ConfirmSheet
          open
          onOpenChange={(v) => !v && closeSheet()}
          title="Claim redeem"
          totalLabel="You receive at most"
          total={formatCNS(request.assetsAtRequestCNS)}
          totalNote="Paid the lower of this value and the vault's value right now."
          rows={[
            {
              key: 'request',
              label: 'Request',
              value: `#${request.requestId.toString()}`,
            },
          ]}
          networkCost={estimateToNetworkCost(estimate)}
          destination={{
            label: 'Gapless vault',
            address: ADDRESSES.CoverVault,
            verified: true,
          }}
          footerDetails={{ functionName: 'claimRedeem', chainId: 143 }}
          lifecycle={lifecycle}
          disableConfirm={Boolean(estimateError)}
          confirmLabel="Claim"
          onConfirm={() => void runClaim()}
        />
      )}
    </div>
  )
}

function revertErrorCode(
  decoded: Parameters<typeof errorCopyForRevert>[0],
): string {
  return errorCopyForRevert(decoded).title
}
