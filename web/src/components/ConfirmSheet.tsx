import { useEffect, useState } from 'react'
import { CircleCheck, Loader2 } from 'lucide-react'
import { Drawer } from '@heroui/react'
import type { ReactNode } from 'react'
import type { Address } from 'viem'
import type { OperatorCallEstimate, TxLifecycle } from '@/lib/tx/send'
import GaplessButton from '@/components/GaplessButton'
import { errorCopyForRevert } from '@/lib/errors'
import { EXPLORER_URL } from '@/config'
import { formatMon, shortenHash } from '@/utils/units'
import { cnm } from '@/utils/style'

/** Shared network-cost formatting for every call site's `estimateOperatorCall` result. */
export function estimateToNetworkCost(
  estimate: OperatorCallEstimate | null,
): ConfirmNetworkCost | null {
  if (!estimate) return null
  const after =
    estimate.operatorBalanceWei > estimate.maxCostWei
      ? estimate.operatorBalanceWei - estimate.maxCostWei
      : 0n
  return {
    gasLimit: estimate.gas.toString(),
    maxCost: formatMon(estimate.maxCostWei),
    balanceAfter: formatMon(after),
  }
}

export interface ConfirmRow {
  key: string
  label: string
  value: ReactNode
  note?: ReactNode
  /** DESIGN 9.1: non-refundable amounts are a visible tag on their own row, never a tooltip. */
  tag?: string
}

export interface ConfirmDestination {
  label: string
  address: Address
  /** Only true once re-checked against the real destination (e.g. `accountOf(owner)`). */
  verified: boolean
}

export interface ConfirmDomainCheck {
  verified: boolean
  text: string
}

export interface ConfirmNetworkCost {
  gasLimit: string
  maxCost: string
  balanceAfter: string
}

export interface ConfirmFooterDetails {
  functionName: string
  chainId: number
}

export interface ConfirmSheetProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  totalLabel: string
  total: ReactNode
  totalNote?: ReactNode
  rows: ReadonlyArray<ConfirmRow>
  networkCost?: ConfirmNetworkCost | null
  destination?: ConfirmDestination
  domainCheck?: ConfirmDomainCheck
  footerDetails?: ConfirmFooterDetails
  /** An out-of-band error unrelated to the tx lifecycle (e.g. a failed signature). */
  error?: { title: string; body: string } | null
  lifecycle: TxLifecycle
  confirmLabel?: string
  destructive?: boolean
  disableConfirm?: boolean
  /** Pre-send busy state (e.g. a passkey signing ceremony) with no tx lifecycle yet. */
  pending?: boolean
  pendingLabel?: string
  onConfirm: () => void
}

/** DESIGN 5.7, 9.1: the one confirmation sheet, reused by every value-moving
 * action. Never shows form state directly: every row here is the caller's
 * decoded view of the exact call it is about to send. */
export default function ConfirmSheet({
  open,
  onOpenChange,
  title,
  totalLabel,
  total,
  totalNote,
  rows,
  networkCost,
  destination,
  domainCheck,
  footerDetails,
  error,
  lifecycle,
  confirmLabel = 'Confirm',
  destructive = false,
  disableConfirm = false,
  pending = false,
  pendingLabel = 'Working…',
  onConfirm,
}: ConfirmSheetProps) {
  const [guardReady, setGuardReady] = useState(false)
  const [detailsOpen, setDetailsOpen] = useState(false)

  // DESIGN 9.2: Confirm ignores input for the first 600ms after opening, so a
  // double-tap on the button that opened the sheet cannot also confirm it.
  useEffect(() => {
    if (!open) {
      setGuardReady(false)
      setDetailsOpen(false)
      return
    }
    const t = setTimeout(() => setGuardReady(true), 600)
    return () => clearTimeout(t)
  }, [open])

  // Confirm must ignore taps through the whole simulating phase (5
  // sequential RPC calls before anything is signed), not just while
  // actually sending.
  const confirmBusy =
    pending ||
    lifecycle.status === 'simulating' ||
    lifecycle.status === 'sending' ||
    lifecycle.status === 'confirming'
  // Cancel stays pressable through `simulating`: nothing has been signed
  // yet, so the caller's `AbortSignal` can still genuinely stop the send.
  // Once a transaction is broadcast (`sending`/`confirming`) there is
  // nothing left to cancel.
  const cancelDisabled =
    pending ||
    lifecycle.status === 'sending' ||
    lifecycle.status === 'confirming'
  const domainHardStop = domainCheck !== undefined && !domainCheck.verified

  return (
    <Drawer.Root
      isOpen={open}
      onOpenChange={cancelDisabled ? undefined : onOpenChange}
    >
      <Drawer.Backdrop isDismissable={!cancelDisabled}>
        <Drawer.Content
          placement="bottom"
          className="md:items-center md:justify-center"
        >
          <Drawer.Dialog className="max-h-[92dvh] w-full rounded-t-[32px] md:max-h-[85dvh] md:w-full md:max-w-[480px] md:rounded-[32px]">
            <Drawer.Handle className="md:hidden" />
            <Drawer.Body className="flex flex-col gap-6 overflow-y-auto px-6 pt-2 pb-6">
              <h2 className="type-title-2">{title}</h2>

              <div>
                <p className="type-label text-[#AEAEB2]">{totalLabel}</p>
                <p className="type-num-lg mt-1">{total}</p>
                {totalNote && (
                  <p className="type-footnote mt-1 text-[#AEAEB2]">
                    {totalNote}
                  </p>
                )}
              </div>

              <div className="rounded-[16px] bg-[#2C2C2E]">
                {rows.map((row, i) => (
                  <div
                    key={row.key}
                    className={cnm(
                      'flex items-center justify-between gap-4 px-4 py-3',
                      i > 0 && 'border-t border-[#3A3A3C]',
                    )}
                  >
                    <span className="type-body text-[#AEAEB2]">
                      {row.label}
                    </span>
                    <div className="flex flex-col items-end">
                      <span className="type-num text-white">{row.value}</span>
                      {row.note && (
                        <span className="type-footnote text-[#8E8E93]">
                          {row.note}
                        </span>
                      )}
                      {row.tag && (
                        <span className="type-caption mt-1 rounded-full bg-[#402F21] px-2 py-0.5 text-[#FF9230]">
                          {row.tag}
                        </span>
                      )}
                    </div>
                  </div>
                ))}
              </div>

              {networkCost && (
                <div className="rounded-[16px] bg-[#2C2C2E]">
                  <Row label="Gas limit" value={networkCost.gasLimit} />
                  <Row
                    label="Max network cost"
                    value={networkCost.maxCost}
                    border
                  />
                  <Row
                    label="Trading key MON after"
                    value={networkCost.balanceAfter}
                    border
                  />
                </div>
              )}

              {destination && (
                <div className="flex items-center justify-between gap-4 rounded-[16px] bg-[#2C2C2E] px-4 py-3">
                  <div>
                    <p className="type-footnote text-[#AEAEB2]">
                      {destination.label}
                    </p>
                    <p className="type-mono mt-1 break-all text-white">
                      {destination.address}
                    </p>
                  </div>
                  {destination.verified && (
                    <CircleCheck
                      className="size-5 shrink-0 text-[#30D158]"
                      strokeWidth={1.75}
                    />
                  )}
                </div>
              )}

              {domainCheck && (
                <div
                  className={cnm(
                    'flex items-center gap-3 rounded-[16px] px-4 py-3',
                    domainCheck.verified ? 'bg-[#2C2C2E]' : 'bg-[#2C2C2E]',
                  )}
                >
                  <CircleCheck
                    className={cnm(
                      'size-5 shrink-0',
                      domainCheck.verified
                        ? 'text-[#30D158]'
                        : 'text-[#FF6165]',
                    )}
                    strokeWidth={1.75}
                  />
                  <p className="type-footnote text-[#AEAEB2]">
                    {domainCheck.text}
                  </p>
                </div>
              )}

              {domainHardStop && (
                <div className="rounded-[16px] bg-[#2C2C2E] px-4 py-3">
                  <p className="type-headline text-[#FF6165]">
                    This account does not match what we expect
                  </p>
                  <p className="type-callout text-white">
                    The signing domain read from the contract does not match
                    Gapless's own. Signing here is blocked for your safety.
                  </p>
                </div>
              )}

              {error && (
                <div className="rounded-[16px] bg-[#2C2C2E] px-4 py-3">
                  <p className="type-headline text-[#FF6165]">{error.title}</p>
                  <p className="type-callout text-white">{error.body}</p>
                </div>
              )}

              {footerDetails && (
                <details
                  open={detailsOpen}
                  onToggle={(e) => setDetailsOpen(e.currentTarget.open)}
                  className="rounded-[16px] bg-[#2C2C2E] px-4 py-3"
                >
                  <summary className="type-footnote cursor-pointer text-[#AEAEB2]">
                    Details
                  </summary>
                  <p className="type-mono-sm mt-2 text-[#8E8E93]">
                    {footerDetails.functionName} · chain {footerDetails.chainId}
                  </p>
                </details>
              )}

              <LifecycleBlock lifecycle={lifecycle} />

              <div className="flex gap-3">
                <GaplessButton
                  variant="secondary"
                  size="lg"
                  fullWidth
                  isDisabled={cancelDisabled}
                  onPress={() => onOpenChange(false)}
                >
                  {lifecycle.status === 'done' ? 'Close' : 'Cancel'}
                </GaplessButton>
                {!domainHardStop && lifecycle.status !== 'done' && (
                  <GaplessButton
                    variant={destructive ? 'destructive' : 'primary'}
                    size="lg"
                    fullWidth
                    isDisabled={!guardReady || disableConfirm || confirmBusy}
                    isPending={confirmBusy}
                    onPress={onConfirm}
                  >
                    {confirmBusy
                      ? lifecycle.status === 'sending'
                        ? 'Sending…'
                        : lifecycle.status === 'confirming'
                          ? 'Confirming…'
                          : pendingLabel
                      : confirmLabel}
                  </GaplessButton>
                )}
              </div>
            </Drawer.Body>
          </Drawer.Dialog>
        </Drawer.Content>
      </Drawer.Backdrop>
    </Drawer.Root>
  )
}

function Row({
  label,
  value,
  border,
}: {
  label: string
  value: string
  border?: boolean
}) {
  return (
    <div
      className={cnm(
        'flex items-center justify-between gap-4 px-4 py-3',
        border && 'border-t border-[#3A3A3C]',
      )}
    >
      <span className="type-body text-[#AEAEB2]">{label}</span>
      <span className="type-num text-white">{value}</span>
    </div>
  )
}

/** DESIGN 9.2: Sending, then Confirming with hash, then Done or Reverted,
 * shown inside the sheet. Never a toast. */
function LifecycleBlock({ lifecycle }: { lifecycle: TxLifecycle }) {
  if (lifecycle.status === 'idle' || lifecycle.status === 'simulating')
    return null

  if (lifecycle.status === 'sending') {
    return (
      <div className="flex items-center gap-2 rounded-[16px] bg-[#2C2C2E] px-4 py-3">
        <Loader2 className="size-4 animate-spin text-[#AEAEB2]" />
        <p className="type-callout text-[#AEAEB2]">Sending…</p>
      </div>
    )
  }

  if (lifecycle.status === 'confirming' || lifecycle.status === 'unknown') {
    return (
      <div className="rounded-[16px] bg-[#2C2C2E] px-4 py-3">
        <p className="type-headline text-white">Confirming</p>
        <a
          href={`${EXPLORER_URL}/tx/${lifecycle.hash}`}
          target="_blank"
          rel="noopener noreferrer"
          className="type-mono-sm text-[#A48FFF]"
        >
          {shortenHash(lifecycle.hash)}
        </a>
      </div>
    )
  }

  if (lifecycle.status === 'done') {
    return (
      <div className="rounded-[16px] bg-[#2C2C2E] px-4 py-3">
        <p className="type-headline text-[#30D158]">Done</p>
        <a
          href={`${EXPLORER_URL}/tx/${lifecycle.receipt.transactionHash}`}
          target="_blank"
          rel="noopener noreferrer"
          className="type-mono-sm text-[#A48FFF]"
        >
          {shortenHash(lifecycle.receipt.transactionHash)}
        </a>
      </div>
    )
  }

  // reverted
  const copy = errorCopyForRevert(lifecycle.decoded)
  return (
    <div className="rounded-[16px] bg-[#2C2C2E] px-4 py-3">
      <p className="type-headline text-[#FF6165]">{copy.title}</p>
      <p className="type-callout text-white">{copy.body}</p>
    </div>
  )
}
