import { useMemo } from 'react'
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { toViemAccount } from '@category-labs/mera/viem'
import { LockKeyhole } from 'lucide-react'
import GaplessButton from '@/components/GaplessButton'
import GroupedList from '@/components/GroupedList'
import InlineBanner from '@/components/InlineBanner'
import StatusChip from '@/components/StatusChip'
import { useAccountSession } from '@/hooks/useAccountSession'
import { useAccountState } from '@/hooks/useAccountState'
import { useAgentGrantState } from '@/hooks/useAgentGrantState'
import { useAuthActions } from '@/hooks/useAuthActions'
import { errorCopyFor } from '@/lib/errors'
import { formatApproxDuration, formatCNS, shortenAddress } from '@/utils/units'

/**
 * `/settings` (ARCHITECTURE section 4, phase 2 5.7): Session group is real
 * (operator key, expiry, caps, `operatorUsage()`); renewing or granting a
 * different key is `/settings/agent` (section 7.3), not duplicated here.
 * Deferred, and why:
 * - Close position: the close flow needs live mark/book data that only
 *   `/trade`'s Position card already reads; this links there instead of
 *   duplicating that state.
 * - Withdraw (owner signs `Withdraw`, operator relays `withdrawWithSig`):
 *   blocked on pinning `WITHDRAW_TYPEHASH` (phase 2 5.7 memory note).
 * - Export phrase: P2 in the route table, not built this pass.
 */
export const Route = createFileRoute('/settings/')({ component: SettingsPage })

function SettingsPage() {
  const { ownerSession, operatorSession } = useAccountSession()

  const ownerAddress = useMemo(
    () => (ownerSession ? toViemAccount(ownerSession).address : null),
    [ownerSession],
  )
  const operatorAddress = useMemo(
    () => (operatorSession ? toViemAccount(operatorSession).address : null),
    [operatorSession],
  )

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
        account={chainState.account}
        thisDeviceOperator={operatorAddress}
      />
    </Shell>
  )
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="mx-auto min-h-screen max-w-[480px] px-5 py-10">
      <h1 className="type-title-1 mb-8">Settings</h1>
      {children}
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
        Use your passkey to see your account settings.
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
          Your account needs to be created and activated before settings are
          available.
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

function Ready({
  account,
  thisDeviceOperator,
}: {
  account: `0x${string}`
  thisDeviceOperator: `0x${string}`
}) {
  const navigate = useNavigate()
  const { data: grantState } = useAgentGrantState(account)

  const isThisDeviceOperator =
    grantState !== undefined &&
    grantState.operatorKey.toLowerCase() === thisDeviceOperator.toLowerCase()
  const expired =
    grantState !== undefined &&
    grantState.operatorExpiry <= BigInt(grantState.nowS)

  return (
    <div className="flex flex-col gap-6">
      <SessionSection
        grantState={grantState}
        isThisDeviceOperator={isThisDeviceOperator}
        expired={expired}
        onManage={() => navigate({ to: '/settings/agent' })}
      />

      <div className="flex flex-col gap-3 rounded-[24px] bg-[#1C1C1E] p-5">
        <h2 className="type-title-2">Position</h2>
        <p className="type-callout text-[#AEAEB2]">
          Open, cover and close trades from Trade.
        </p>
        <GaplessButton
          variant="secondary"
          size="lg"
          fullWidth
          onPress={() => navigate({ to: '/trade' })}
        >
          Go to Trade
        </GaplessButton>
      </div>

      <div className="flex flex-col gap-3 rounded-[24px] bg-[#1C1C1E] p-5">
        <h2 className="type-title-2">Withdraw</h2>
        <InlineBanner
          title="Not available yet"
          body="Withdrawing to your owner wallet needs one more piece of the signing setup. Your funds stay in your account and are not at risk."
        />
      </div>

      <div className="flex flex-col gap-3 rounded-[24px] bg-[#1C1C1E] p-5">
        <h2 className="type-title-2">Recovery phrase</h2>
        <InlineBanner
          title="Not built yet"
          body="Exporting your recovery phrase is planned for a later release."
        />
      </div>
    </div>
  )
}

function SessionSection({
  grantState,
  isThisDeviceOperator,
  expired,
  onManage,
}: {
  grantState: ReturnType<typeof useAgentGrantState>['data']
  isThisDeviceOperator: boolean
  expired: boolean
  onManage: () => void
}) {
  if (!grantState) {
    return (
      <div className="rounded-[24px] bg-[#1C1C1E] p-5">
        <p className="type-label text-[#AEAEB2]">Session</p>
        <span className="mt-2 inline-block h-7 w-40 animate-pulse rounded-xs bg-[#2C2C2E]" />
      </div>
    )
  }

  const secondsLeft = Math.max(
    0,
    Number(grantState.operatorExpiry) - grantState.nowS,
  )
  const statusChip = expired ? (
    <StatusChip status="expired" />
  ) : isThisDeviceOperator ? (
    <StatusChip status="live" />
  ) : (
    <StatusChip status="voided" />
  )

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between px-1">
        <h2 className="type-title-2">Session</h2>
        {statusChip}
      </div>
      <GroupedList
        rows={[
          {
            key: 'who',
            label: 'Trading key',
            value: isThisDeviceOperator ? 'This phone' : 'Agent',
            note: shortenAddress(grantState.operatorKey),
          },
          {
            key: 'expires',
            label: 'Expires',
            value: expired ? 'Expired' : formatApproxDuration(secondsLeft),
          },
          {
            key: 'per-trade',
            label: 'Per-trade cap',
            value: formatCNS(grantState.operatorMaxPerTradeCNS),
          },
          {
            key: 'per-day',
            label: 'Per-day cap',
            value: formatCNS(grantState.operatorMaxPerDayCNS),
          },
          {
            key: 'budget',
            label: 'Budget left today',
            value: formatCNS(grantState.operatorAvailableCNS),
          },
        ]}
      />
      <GaplessButton variant="primary" size="lg" fullWidth onPress={onManage}>
        {isThisDeviceOperator && !expired
          ? 'Manage trading agent'
          : 'Re-grant this device'}
      </GaplessButton>
    </div>
  )
}
