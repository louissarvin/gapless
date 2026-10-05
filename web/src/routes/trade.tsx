import { useMemo, useRef, useState } from 'react'
import { Link, createFileRoute, useNavigate } from '@tanstack/react-router'
import { toViemAccount } from '@category-labs/mera/viem'
import { encodeFunctionData } from 'viem'
import {
  ArrowDownRight,
  ArrowUpRight,
  ChevronRight,
  LockKeyhole,
  ShieldCheck,
} from 'lucide-react'
import type { Address } from 'viem'
import type { MarketStatic, TradeChainState } from '@/hooks/useTradeChainState'
import type { DecodedRevert } from '@/lib/chain'
import type { OperatorCallEstimate, TxLifecycle } from '@/lib/tx/send'
import type { CoverParams } from '@/lib/trade/order'
import type { MarketQuoteScaled, MarketSyncStatus } from '@/lib/market/ws'
import type { Secp256k1SigningSession } from '@category-labs/mera'
import ConfirmSheet, { estimateToNetworkCost } from '@/components/ConfirmSheet'
import Field from '@/components/Field'
import GaplessButton from '@/components/GaplessButton'
import OrderBook from '@/components/OrderBook'
import TickText from '@/components/TickText'
import { useAccountSession } from '@/hooks/useAccountSession'
import { useAuthActions } from '@/hooks/useAuthActions'
import { deriveOnboardStep, useAccountState } from '@/hooks/useAccountState'
import {
  useMarketData,
  useNowTick,
  useThrottledValue,
} from '@/hooks/useMarketData'
import { useMarketStatic, useTradeChainState } from '@/hooks/useTradeChainState'
import { decodeRevertFromError, publicClient } from '@/lib/chain'
import {
  coverIdFromReceipt,
  estimateOperatorCall,
  sendOperatorCall,
} from '@/lib/tx/send'
import {
  OrderInputError,
  buildCloseDesc,
  buildOpenDesc,
  closeLimit,
  maxPremiumFromQuote,
  openLimit,
  parseDecimalToUnits,
  stopDistanceBps,
  tradeNotionalCNS,
} from '@/lib/trade/order'
import { ICoverManagerAbi } from '@/abi/ICoverManager'
import { IGaplessAccountAbi } from '@/abi/IGaplessAccount'
import { ADDRESSES, LISTED_PERP_ID } from '@/config/addresses.143'
import { errorCopyFor, errorCopyForRevert } from '@/lib/errors'
import { formatCNS, formatSigned, lnsToSize, pnsToPrice } from '@/utils/units'
import { cnm } from '@/utils/style'

export const Route = createFileRoute('/trade')({ component: TradePage })

/** DESIGN 8, ADR-W19: fixed recipe defaults this pass does not expose as fields. */
const DEFAULT_MAX_GAP_BPS = 200
const DEFAULT_DURATION_BLOCKS = 12_000

function TradePage() {
  const { ownerSession, operatorSession } = useAccountSession()

  const ownerAddress = useMemo(
    () => (ownerSession ? toViemAccount(ownerSession).address : null),
    [ownerSession],
  )
  const operatorAddress = useMemo(
    () => (operatorSession ? toViemAccount(operatorSession).address : null),
    [operatorSession],
  )

  const { data: chainState, errorUpdateCount } = useAccountState(
    ownerAddress,
    operatorAddress,
  )

  if (!ownerSession || !operatorSession || !ownerAddress || !operatorAddress) {
    return (
      <Shell>
        <UnlockCard />
      </Shell>
    )
  }

  if (!chainState) {
    if (errorUpdateCount > 0) {
      const copy = errorCopyFor(null)
      return (
        <Shell>
          <ErrorBlock title={copy.title} body={copy.body} />
        </Shell>
      )
    }
    return (
      <Shell>
        <p className="type-callout text-[#AEAEB2]">Loading your account…</p>
      </Shell>
    )
  }

  const step = deriveOnboardStep(chainState, false)
  if (step !== 'ready') {
    return (
      <Shell>
        <FinishSetupCard step={step} />
      </Shell>
    )
  }

  return (
    <Shell>
      <TradeContent
        account={chainState.account}
        owner={ownerAddress}
        operatorAddress={operatorAddress}
        operatorSession={operatorSession}
        perplAccountId={chainState.perplAccountId}
      />
    </Shell>
  )
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="mx-auto min-h-screen max-w-[480px] px-5 py-10">
      <h1 className="type-title-1 mb-8">Trade</h1>
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
        Use your passkey to trade.
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

function FinishSetupCard({ step }: { step: string }) {
  const navigate = useNavigate()
  const linkTo =
    step === 'operator-replaced' || step === 'session-expired'
      ? '/settings/agent'
      : '/onboard'
  return (
    <div
      className="card-big flex flex-col justify-between p-6"
      style={{ '--card-min-h': '240px' } as React.CSSProperties}
    >
      <div>
        <p className="type-label mb-2 text-[#AEAEB2]">Account</p>
        <h2 className="type-title-1 mb-4">Finish setting up</h2>
        <p className="type-callout text-[#AEAEB2]">
          Your account isn't ready to trade yet.
        </p>
      </div>
      <GaplessButton
        variant="primary"
        size="lg"
        fullWidth
        onPress={() => navigate({ to: linkTo })}
      >
        {linkTo === '/settings/agent'
          ? 'Go to agent settings'
          : 'Continue setup'}
      </GaplessButton>
    </div>
  )
}

function ErrorBlock({
  title,
  body,
  code,
}: {
  title: string
  body: string
  code?: string
}) {
  return (
    <div className="rounded-md bg-[#2C2C2E] px-4 py-3">
      <p className="type-headline text-[#FF6165]">{title}</p>
      <p className="type-callout text-white">{body}</p>
      {code && <p className="type-mono-sm mt-2 text-[#8E8E93]">{code}</p>}
    </div>
  )
}

function TradeContent({
  account,
  owner,
  operatorAddress,
  operatorSession,
  perplAccountId,
}: {
  account: Address
  owner: Address
  operatorAddress: Address
  operatorSession: Secp256k1SigningSession
  perplAccountId: bigint
}) {
  const { data: marketData } = useMarketStatic(LISTED_PERP_ID)
  const {
    data: chainData,
    error: chainError,
    errorUpdateCount,
  } = useTradeChainState(account, operatorAddress, perplAccountId)
  const marketWs = useMarketData(LISTED_PERP_ID)

  const navigate = useNavigate()
  const [side, setSide] = useState<'long' | 'short'>('long')
  const [sizeInput, setSizeInput] = useState('')
  const [stopInput, setStopInput] = useState('')
  const [guaranteeOn, setGuaranteeOn] = useState(false)
  const [lifecycle, setLifecycle] = useState<TxLifecycle>({ status: 'idle' })
  const [actionError, setActionError] = useState<string | null>(null)
  const [coverQuote, setCoverQuote] = useState<{
    quotedCNS: bigint
    rentCNS?: bigint
    source: 'probe' | 'quote'
  } | null>(null)
  const [quoting, setQuoting] = useState(false)
  const [confirming, setConfirming] = useState(false)
  // Re-entrancy guard for the send handlers below: a double-call (double
  // tap, or a re-render racing a click) is a no-op while one is in flight.
  const sendInFlightRef = useRef(false)
  // Lets Cancel actually abort an in-flight send while it is still
  // simulating (ADR-W12 M-2): nothing is signed until this is checked.
  const sendAbortRef = useRef<AbortController | null>(null)

  // DESIGN 5.7, 9.1: one confirmation sheet for every value-moving action.
  const [sheet, setSheet] = useState<'open' | 'guarantee' | 'close' | null>(
    null,
  )
  const [estimate, setEstimate] = useState<OperatorCallEstimate | null>(null)
  const [estimateError, setEstimateError] = useState<string | null>(null)

  if (!marketData) {
    return <p className="type-callout text-[#AEAEB2]">Loading market…</p>
  }

  if (!chainData) {
    if (errorUpdateCount > 0) {
      const copy = errorCopyFor(null)
      return (
        <ErrorBlock
          title={copy.title}
          body={copy.body}
          code={chainError?.message}
        />
      )
    }
    return <p className="type-callout text-[#AEAEB2]">Loading market…</p>
  }

  // Rebind as non-null consts: TS does not narrow outer closures captured by
  // the nested handlers below (same reasoning as onboard.tsx), since they
  // run later, as event callbacks or async continuations.
  const chain = chainData
  const market = marketData

  const hasPosition = chain.position.lotLNS > 0n
  const positionIsLong = chain.position.positionType === 0
  const hasActiveCover =
    chain.activeCoverId !==
    '0x0000000000000000000000000000000000000000000000000000000000000000'
  const perpActive = chain.perpStatus === 4 && !chain.exchangeHalted
  const buysBlocked = chain.buysPaused || chain.marketPaused

  function resetOrderState() {
    setCoverQuote(null)
    setActionError(null)
    setLifecycle({ status: 'idle' })
  }

  async function runProbeOrQuote() {
    setActionError(null)
    setQuoting(true)
    try {
      if (hasPosition) {
        const p = buildCoverParams(positionIsLong, chain.position.lotLNS)
        const quote = await publicClient.readContract({
          address: ADDRESSES.CoverManager,
          abi: ICoverManagerAbi,
          functionName: 'quote',
          args: [account, p],
        })
        setCoverQuote({
          quotedCNS: quote.escrowCNS + quote.rentCNS,
          rentCNS: quote.rentCNS,
          source: 'quote',
        })
      } else {
        const { desc, p } = buildOpenOrderAndCover()
        const data = encodeFunctionData({
          abi: IGaplessAccountAbi,
          functionName: 'tradeAndCover',
          args: [desc, p, 0n],
        })
        try {
          await publicClient.call({
            account: operatorAddress,
            to: account,
            data,
            value: 0n,
          })
          throw new Error(
            'Probe did not revert: could not price the cover (report this)',
          )
        } catch (err) {
          const decoded = decodeRevertFromError(err)
          if (decoded?.errorName === 'PremiumTooHigh') {
            const quotedCNS = decoded.args[0] as bigint
            setCoverQuote({ quotedCNS, source: 'probe' })
            return
          }
          setActionError(revertErrorCode(decoded))
        }
      }
    } catch (err) {
      setActionError(
        err instanceof Error ? err.message : 'Could not price the cover',
      )
    } finally {
      setQuoting(false)
    }
  }

  function buildCoverParams(isLong: boolean, lots: bigint): CoverParams {
    const stopPNS = parseDecimalToUnits(
      stopInput || '0',
      market.priceDecimals,
      'stop',
    )
    return {
      perpId: BigInt(LISTED_PERP_ID),
      isLong,
      lots,
      stopPNS,
      maxGapBps: DEFAULT_MAX_GAP_BPS,
      durationBlocks: DEFAULT_DURATION_BLOCKS,
    }
  }

  function openSheetFor(kind: 'open' | 'guarantee' | 'close') {
    setSheet(kind)
    setEstimate(null)
    setEstimateError(null)
    void runEstimateFor(kind)
  }

  function closeSheet() {
    sendAbortRef.current?.abort()
    setSheet(null)
    setEstimate(null)
    setEstimateError(null)
    setLifecycle({ status: 'idle' })
    setActionError(null)
  }

  async function runEstimateFor(kind: 'open' | 'guarantee' | 'close') {
    try {
      let call: Parameters<typeof estimateOperatorCall>[0]
      if (kind === 'open') {
        if (guaranteeOn && coverQuote) {
          const { desc, p } = buildOpenOrderAndCover()
          call = {
            functionName: 'tradeAndCover',
            args: [desc, p, maxPremiumFromQuote(coverQuote.quotedCNS)],
          }
        } else {
          const isLong = side === 'long'
          const lots = parseDecimalToUnits(
            sizeInput,
            market.lotDecimals,
            'size',
          )
          const limitPNS = openLimit(isLong, {
            markPNS: chain.markPNS,
            bestBidPNS: chain.bestBidPNS,
            bestAskPNS: chain.bestAskPNS,
          })
          const desc = buildOpenDesc({
            perpId: BigInt(LISTED_PERP_ID),
            isLong,
            lots,
            limitPNS,
          })
          call = { functionName: 'trade', args: [desc] }
        }
      } else if (kind === 'guarantee') {
        if (!coverQuote) return
        const p = buildCoverParams(positionIsLong, chain.position.lotLNS)
        call = {
          functionName: 'buyCover',
          args: [p, maxPremiumFromQuote(coverQuote.quotedCNS)],
        }
      } else {
        const isLong = positionIsLong
        const limitPNS = closeLimit(isLong, {
          markPNS: chain.markPNS,
          bestBidPNS: chain.bestBidPNS,
          bestAskPNS: chain.bestAskPNS,
        })
        const desc = buildCloseDesc({
          perpId: BigInt(LISTED_PERP_ID),
          isLong,
          lots: chain.position.lotLNS,
          limitPNS,
        })
        call = { functionName: 'trade', args: [desc] }
      }
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

  function buildOpenOrderAndCover() {
    const isLong = side === 'long'
    const lots = parseDecimalToUnits(sizeInput, market.lotDecimals, 'size')
    const limitPNS = openLimit(isLong, {
      markPNS: chain.markPNS,
      bestBidPNS: chain.bestBidPNS,
      bestAskPNS: chain.bestAskPNS,
    })
    const desc = buildOpenDesc({
      perpId: BigInt(LISTED_PERP_ID),
      isLong,
      lots,
      limitPNS,
    })
    const p = buildCoverParams(isLong, lots)
    return { desc, p }
  }

  async function handleOpenPlain() {
    if (sendInFlightRef.current) return
    sendInFlightRef.current = true
    setActionError(null)
    setConfirming(true)
    const controller = new AbortController()
    sendAbortRef.current = controller
    try {
      const isLong = side === 'long'
      const lots = parseDecimalToUnits(sizeInput, market.lotDecimals, 'size')
      const limitPNS = openLimit(isLong, {
        markPNS: chain.markPNS,
        bestBidPNS: chain.bestBidPNS,
        bestAskPNS: chain.bestAskPNS,
      })
      const desc = buildOpenDesc({
        perpId: BigInt(LISTED_PERP_ID),
        isLong,
        lots,
        limitPNS,
      })
      const result = await sendOperatorCall(
        { functionName: 'trade', args: [desc] },
        { session: operatorSession, owner, account },
        setLifecycle,
        controller.signal,
      )
      if (result.status === 'reverted') {
        setActionError(revertErrorCode(result.decoded))
      }
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Send failed')
      setLifecycle({ status: 'idle' })
    } finally {
      setConfirming(false)
      sendInFlightRef.current = false
      sendAbortRef.current = null
    }
  }

  async function handleOpenWithGuarantee() {
    if (!coverQuote || sendInFlightRef.current) return
    sendInFlightRef.current = true
    setActionError(null)
    setConfirming(true)
    const controller = new AbortController()
    sendAbortRef.current = controller
    try {
      const { desc, p } = buildOpenOrderAndCover()
      const maxPremiumCNS = maxPremiumFromQuote(coverQuote.quotedCNS)
      const result = await sendOperatorCall(
        { functionName: 'tradeAndCover', args: [desc, p, maxPremiumCNS] },
        { session: operatorSession, owner, account },
        setLifecycle,
        controller.signal,
      )
      if (result.status === 'reverted') {
        setActionError(revertErrorCode(result.decoded))
      } else if (result.status === 'done') {
        const coverId = coverIdFromReceipt(result.receipt)
        if (coverId)
          void navigate({ to: '/covers/$coverId', params: { coverId } })
      }
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Send failed')
      setLifecycle({ status: 'idle' })
    } finally {
      setConfirming(false)
      sendInFlightRef.current = false
      sendAbortRef.current = null
    }
  }

  async function handleAddGuarantee() {
    if (!coverQuote || sendInFlightRef.current) return
    sendInFlightRef.current = true
    setActionError(null)
    setConfirming(true)
    const controller = new AbortController()
    sendAbortRef.current = controller
    try {
      const p = buildCoverParams(positionIsLong, chain.position.lotLNS)
      const maxPremiumCNS = maxPremiumFromQuote(coverQuote.quotedCNS)
      const result = await sendOperatorCall(
        { functionName: 'buyCover', args: [p, maxPremiumCNS] },
        { session: operatorSession, owner, account },
        setLifecycle,
        controller.signal,
      )
      if (result.status === 'reverted') {
        setActionError(revertErrorCode(result.decoded))
      } else if (result.status === 'done') {
        const coverId = coverIdFromReceipt(result.receipt)
        if (coverId)
          void navigate({ to: '/covers/$coverId', params: { coverId } })
      }
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Send failed')
      setLifecycle({ status: 'idle' })
    } finally {
      setConfirming(false)
      sendInFlightRef.current = false
      sendAbortRef.current = null
    }
  }

  async function handleClose() {
    if (sendInFlightRef.current) return
    sendInFlightRef.current = true
    setActionError(null)
    setConfirming(true)
    const controller = new AbortController()
    sendAbortRef.current = controller
    try {
      const isLong = positionIsLong
      const limitPNS = closeLimit(isLong, {
        markPNS: chain.markPNS,
        bestBidPNS: chain.bestBidPNS,
        bestAskPNS: chain.bestAskPNS,
      })
      const desc = buildCloseDesc({
        perpId: BigInt(LISTED_PERP_ID),
        isLong,
        lots: chain.position.lotLNS,
        limitPNS,
      })
      const result = await sendOperatorCall(
        { functionName: 'trade', args: [desc] },
        { session: operatorSession, owner, account },
        setLifecycle,
        controller.signal,
      )
      if (result.status === 'reverted') {
        setActionError(revertErrorCode(result.decoded))
      }
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Send failed')
      setLifecycle({ status: 'idle' })
    } finally {
      setConfirming(false)
      sendInFlightRef.current = false
      sendAbortRef.current = null
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <PriceHeader
        market={market}
        chain={chain}
        quote={marketWs.quote}
        status={marketWs.status}
        updatedAtMs={marketWs.updatedAtMs}
      />
      <OrderBook
        market={market}
        book={marketWs.book}
        status={marketWs.status}
      />

      {hasPosition && (
        <PositionCard
          market={market}
          chain={chain}
          isLong={positionIsLong}
          hasActiveCover={hasActiveCover}
          onClose={() => openSheetFor('close')}
          pending={confirming}
        />
      )}

      {!hasPosition && (
        <OpenForm
          market={market}
          chain={chain}
          side={side}
          onSide={(s) => {
            setSide(s)
            resetOrderState()
          }}
          sizeInput={sizeInput}
          onSize={(v) => {
            setSizeInput(v)
            resetOrderState()
          }}
          stopInput={stopInput}
          onStop={(v) => {
            setStopInput(v)
            resetOrderState()
          }}
          guaranteeOn={guaranteeOn}
          onGuarantee={(v) => {
            setGuaranteeOn(v)
            resetOrderState()
          }}
          buysBlocked={buysBlocked}
          perpActive={perpActive}
          confirming={confirming}
          quoting={quoting}
          coverQuote={coverQuote}
          actionError={actionError}
          onReview={() => {
            if (guaranteeOn && !coverQuote) {
              void runProbeOrQuote()
              return
            }
            openSheetFor('open')
          }}
        />
      )}

      {hasPosition && !hasActiveCover && (
        <AddGuaranteeForm
          market={market}
          chain={chain}
          isLong={positionIsLong}
          stopInput={stopInput}
          onStop={(v) => {
            setStopInput(v)
            resetOrderState()
          }}
          buysBlocked={buysBlocked}
          quoting={quoting}
          confirming={confirming}
          coverQuote={coverQuote}
          actionError={actionError}
          onQuote={() => void runProbeOrQuote()}
          onConfirm={() => openSheetFor('guarantee')}
        />
      )}

      {sheet && (
        <TradeConfirmSheet
          kind={sheet}
          market={market}
          chain={chain}
          account={account}
          side={side}
          sizeInput={sizeInput}
          guaranteeOn={guaranteeOn}
          positionIsLong={positionIsLong}
          coverQuote={coverQuote}
          estimate={estimate}
          estimateError={estimateError}
          lifecycle={lifecycle}
          onClose={closeSheet}
          onConfirm={() => {
            if (sheet === 'open') {
              if (guaranteeOn) void handleOpenWithGuarantee()
              else void handleOpenPlain()
            } else if (sheet === 'guarantee') {
              void handleAddGuarantee()
            } else {
              void handleClose()
            }
          }}
        />
      )}
    </div>
  )
}

function revertErrorCode(decoded: DecodedRevert | null): string {
  return errorCopyForRevert(decoded).title
}

/** Builds every `/trade` confirmation sheet (DESIGN 9.1, R.9 item 1) from the
 * same decoded values the page is about to send, never from raw form state. */
function TradeConfirmSheet({
  kind,
  market,
  chain,
  account,
  side,
  sizeInput,
  guaranteeOn,
  positionIsLong,
  coverQuote,
  estimate,
  estimateError,
  lifecycle,
  onClose,
  onConfirm,
}: {
  kind: 'open' | 'guarantee' | 'close'
  market: MarketStatic
  chain: TradeChainState
  account: Address
  side: 'long' | 'short'
  sizeInput: string
  guaranteeOn: boolean
  positionIsLong: boolean
  coverQuote: {
    quotedCNS: bigint
    rentCNS?: bigint
    source: 'probe' | 'quote'
  } | null
  estimate: OperatorCallEstimate | null
  estimateError: string | null
  lifecycle: TxLifecycle
  onClose: () => void
  onConfirm: () => void
}) {
  const networkCost = estimateToNetworkCost(estimate)
  const destination = {
    label: 'Your Gapless account',
    address: account,
    verified: true,
  }

  if (kind === 'close') {
    const size = lnsToSize(chain.position.lotLNS, market.lotDecimals)
    const entry = pnsToPrice(chain.position.pricePNS, market.priceDecimals)
    const limitPNS = closeLimit(positionIsLong, {
      markPNS: chain.markPNS,
      bestBidPNS: chain.bestBidPNS,
      bestAskPNS: chain.bestAskPNS,
    })
    return (
      <ConfirmSheet
        open
        onOpenChange={(v) => !v && onClose()}
        title="Close position"
        totalLabel="Closing"
        total={`${size} BTC ${positionIsLong ? 'long' : 'short'}`}
        totalNote={
          chain.isLocked
            ? 'Locked while a cover is armed or triggered.'
            : undefined
        }
        rows={[
          {
            key: 'entry',
            label: 'Entry price',
            value: entry.toFixed(market.priceDecimals),
          },
          {
            key: 'limit',
            label: 'Close limit price',
            value: pnsToPrice(limitPNS, market.priceDecimals).toFixed(
              market.priceDecimals,
            ),
          },
          {
            key: 'pnl',
            label: 'Unrealized PnL',
            value: formatCNS(chain.position.pnlCNS),
          },
        ]}
        networkCost={networkCost}
        destination={destination}
        footerDetails={{ functionName: 'trade', chainId: 143 }}
        lifecycle={lifecycle}
        destructive
        confirmLabel="Close position"
        onConfirm={onConfirm}
      />
    )
  }

  if (kind === 'guarantee') {
    if (!coverQuote) return null
    const maxPremium = maxPremiumFromQuote(coverQuote.quotedCNS)
    return (
      <ConfirmSheet
        open
        onOpenChange={(v) => !v && onClose()}
        title="Add guarantee"
        totalLabel="You pay at most"
        total={formatCNS(maxPremium)}
        totalNote="A one-time premium for this position's stop."
        rows={[
          {
            key: 'side',
            label: 'Side',
            value: positionIsLong ? 'Long' : 'Short',
          },
          {
            key: 'size',
            label: 'Size',
            value: `${lnsToSize(chain.position.lotLNS, market.lotDecimals)} BTC`,
          },
          ...(coverQuote.rentCNS !== undefined
            ? [
                {
                  key: 'rent',
                  label: 'Rent',
                  value: formatCNS(coverQuote.rentCNS),
                  tag: 'Non-refundable',
                },
              ]
            : []),
        ]}
        networkCost={networkCost}
        destination={destination}
        footerDetails={{ functionName: 'buyCover', chainId: 143 }}
        lifecycle={lifecycle}
        confirmLabel="Buy guarantee"
        onConfirm={onConfirm}
      />
    )
  }

  // kind === 'open'
  const isLong = side === 'long'
  let lots = 0n
  try {
    lots = parseDecimalToUnits(sizeInput, market.lotDecimals, 'size')
  } catch {
    lots = 0n
  }
  const limitPNS = openLimit(isLong, {
    markPNS: chain.markPNS,
    bestBidPNS: chain.bestBidPNS,
    bestAskPNS: chain.bestAskPNS,
  })
  const notionalCNS = tradeNotionalCNS({
    lotLNS: lots,
    limitPNS,
    markPNS: chain.markPNS,
    priceDecimals: market.priceDecimals,
    lotDecimals: market.lotDecimals,
  })
  const withGuarantee = guaranteeOn && coverQuote
  const maxPremium = withGuarantee
    ? maxPremiumFromQuote(coverQuote.quotedCNS)
    : 0n

  return (
    <ConfirmSheet
      open
      onOpenChange={(v) => !v && onClose()}
      title={
        withGuarantee
          ? `Open ${isLong ? 'long' : 'short'} and buy cover`
          : `Open ${isLong ? 'long' : 'short'}`
      }
      totalLabel={withGuarantee ? 'You pay at most' : 'Position size'}
      total={withGuarantee ? formatCNS(maxPremium) : formatCNS(notionalCNS)}
      totalNote={
        withGuarantee
          ? "Includes this cover's rent and escrow."
          : 'This position has no guarantee.'
      }
      rows={[
        { key: 'perp', label: 'Market', value: 'BTC-PERP' },
        { key: 'side', label: 'Side', value: isLong ? 'Long' : 'Short' },
        { key: 'size', label: 'Size', value: `${lots.toString()} lots` },
        {
          key: 'limit',
          label: 'Limit price',
          value: pnsToPrice(limitPNS, market.priceDecimals).toFixed(
            market.priceDecimals,
          ),
        },
        ...(withGuarantee && coverQuote.rentCNS !== undefined
          ? [
              {
                key: 'rent',
                label: 'Rent',
                value: formatCNS(coverQuote.rentCNS),
                tag: 'Non-refundable',
              },
            ]
          : []),
      ]}
      networkCost={networkCost}
      destination={destination}
      footerDetails={{
        functionName: withGuarantee ? 'tradeAndCover' : 'trade',
        chainId: 143,
      }}
      lifecycle={lifecycle}
      disableConfirm={Boolean(estimateError)}
      confirmLabel="Confirm"
      onConfirm={onConfirm}
    />
  )
}

/**
 * DESIGN 8.1: shows WebSocket prices (display only, ARCHITECTURE 5.2); the
 * confirmation sheet shows the onchain mark and limit that are actually in
 * the calldata. Falls back to the chain-read mark/bid/ask until the first
 * WS quote lands, so the header is never blank.
 */
function PriceHeader({
  market,
  chain,
  quote,
  status,
  updatedAtMs,
}: {
  market: MarketStatic
  chain: TradeChainState
  quote: MarketQuoteScaled | null
  status: MarketSyncStatus
  updatedAtMs: number | null
}) {
  const throttledQuote = useThrottledValue(quote, 500)
  const now = useNowTick(1_000)
  const unsynced = status === 'unsynced'

  const mark = throttledQuote
    ? throttledQuote.markScaled / 10 ** market.priceDecimals
    : pnsToPrice(chain.markPNS, market.priceDecimals)
  const bid = throttledQuote
    ? throttledQuote.bidScaled / 10 ** market.priceDecimals
    : pnsToPrice(chain.bestBidPNS, market.priceDecimals)
  const ask = throttledQuote
    ? throttledQuote.askScaled / 10 ** market.priceDecimals
    : pnsToPrice(chain.bestAskPNS, market.priceDecimals)

  const agoS =
    updatedAtMs !== null
      ? Math.max(0, Math.round((now - updatedAtMs) / 1000))
      : null

  return (
    <div className="rounded-lg bg-[#1C1C1E] p-5">
      <div className="mb-3 flex items-center justify-between">
        <p className="type-label text-[#AEAEB2]">BTC-PERP</p>
        <div className="flex items-center gap-1.5">
          <span
            className="size-1.5 rounded-full"
            style={{ backgroundColor: unsynced ? '#FF9230' : '#8E8E93' }}
          />
          <p
            className="type-num-sm"
            style={{ color: unsynced ? '#FF9230' : '#8E8E93' }}
          >
            {unsynced ? 'Reconnecting' : 'Live'} · #
            {chain.blockNumber.toString()}
          </p>
        </div>
      </div>
      <div
        className={cnm(
          'transition-opacity duration-300',
          unsynced && 'opacity-40',
        )}
      >
        <TickText
          text={mark.toFixed(market.priceDecimals)}
          numericValue={mark}
          className="type-num-hero mb-1 block"
        />
        <p className="type-num-sm">
          <TickText
            text={`Bid ${bid.toFixed(market.priceDecimals)}`}
            numericValue={bid}
            className="text-[#30D158]"
          />
          <span className="mx-2 text-[#3A3A3C]">·</span>
          <TickText
            text={`Ask ${ask.toFixed(market.priceDecimals)}`}
            numericValue={ask}
            className="text-[#FF6165]"
          />
        </p>
      </div>
      {unsynced && agoS !== null && (
        <p className="type-footnote mt-1 text-[#8E8E93]">
          Updated {agoS} s ago
        </p>
      )}
    </div>
  )
}

function SideSegmented({
  side,
  onChange,
  disabled,
}: {
  side: 'long' | 'short'
  onChange: (side: 'long' | 'short') => void
  disabled?: boolean
}) {
  return (
    <div className="flex h-10 rounded-full bg-[#2C2C2E] p-1">
      {(['long', 'short'] as const).map((option) => (
        <button
          key={option}
          type="button"
          disabled={disabled}
          onClick={() => onChange(option)}
          className={cnm(
            'type-label flex flex-1 items-center justify-center gap-1 rounded-full capitalize transition-[background-color]',
            side === option ? 'bg-[#636366] text-white' : 'text-[#AEAEB2]',
          )}
        >
          {option}
          {option === 'long' ? (
            <ArrowUpRight className="size-3.5 text-[#30D158]" strokeWidth={2} />
          ) : (
            <ArrowDownRight
              className="size-3.5 text-[#FF4245]"
              strokeWidth={2}
            />
          )}
        </button>
      ))}
    </div>
  )
}

function OpenForm({
  market,
  chain,
  side,
  onSide,
  sizeInput,
  onSize,
  stopInput,
  onStop,
  guaranteeOn,
  onGuarantee,
  buysBlocked,
  perpActive,
  confirming,
  quoting,
  coverQuote,
  actionError,
  onReview,
}: {
  market: MarketStatic
  chain: TradeChainState
  side: 'long' | 'short'
  onSide: (side: 'long' | 'short') => void
  sizeInput: string
  onSize: (v: string) => void
  stopInput: string
  onStop: (v: string) => void
  guaranteeOn: boolean
  onGuarantee: (v: boolean) => void
  buysBlocked: boolean
  perpActive: boolean
  confirming: boolean
  quoting: boolean
  coverQuote: { quotedCNS: bigint; source: 'probe' | 'quote' } | null
  actionError: string | null
  onReview: () => void
}) {
  let lots = 0n
  let sizeErr: string | null = null
  try {
    if (sizeInput.trim())
      lots = parseDecimalToUnits(sizeInput, market.lotDecimals, 'size')
  } catch (err) {
    sizeErr = err instanceof OrderInputError ? err.message : 'Invalid size'
  }

  let stopPNS = 0n
  let stopErr: string | null = null
  if (guaranteeOn && stopInput.trim()) {
    try {
      stopPNS = parseDecimalToUnits(stopInput, market.priceDecimals, 'stop')
      if (
        stopDistanceBps(stopPNS, chain.markPNS) <
        BigInt(market.minStopDistanceBps)
      ) {
        stopErr = `Stop must be at least ${market.minStopDistanceBps} bps from mark`
      }
    } catch (err) {
      stopErr = err instanceof OrderInputError ? err.message : 'Invalid stop'
    }
  }

  const { disabled, reason } = formAction({
    perpActive,
    operatorMonBalanceWei: chain.operatorMonBalanceWei,
    lots,
    sizeErr,
    stopErr,
    guaranteeOn,
    stopInput,
    operatorAvailableCNS: chain.operatorAvailableCNS,
    buysBlocked,
    quoting,
    confirming,
  })

  const reviewLabel =
    guaranteeOn && !coverQuote
      ? quoting
        ? 'Pricing…'
        : 'Get cover price'
      : confirming
        ? 'Sending…'
        : 'Review order'

  return (
    <div className="rounded-lg bg-[#1C1C1E] p-5">
      <h2 className="type-title-2 mb-4">Open position</h2>
      <div className="mb-4">
        <SideSegmented side={side} onChange={onSide} />
      </div>

      <Field
        label="Size"
        error={sizeErr ?? undefined}
        bound={
          lots > 0n ? `${lnsToSize(lots, market.lotDecimals)} BTC` : undefined
        }
        className="mb-3"
      >
        <input
          inputMode="decimal"
          value={sizeInput}
          onChange={(e) => onSize(e.target.value)}
          placeholder="0"
          className="type-num w-full bg-transparent outline-none"
        />
        <span className="type-label text-[#AEAEB2]">lots</span>
      </Field>

      <div className="mb-4 flex items-center justify-between py-2">
        <div>
          <p className="type-body text-white">Guarantee</p>
          {!guaranteeOn && (
            <p className="type-footnote text-[#AEAEB2]">
              Stops on Gapless are guaranteed. Turn on Guarantee to set one.
            </p>
          )}
          {guaranteeOn && buysBlocked && (
            <p className="type-footnote text-[#FF9230]">
              Buys are paused by the protocol right now.
            </p>
          )}
        </div>
        <Switch
          checked={guaranteeOn}
          disabled={buysBlocked}
          onChange={onGuarantee}
        />
      </div>

      {guaranteeOn && (
        <Field
          label="Stop"
          error={stopErr ?? undefined}
          bound={`Min ${market.minStopDistanceBps} bps from mark`}
          className="mb-3"
        >
          <input
            inputMode="decimal"
            value={stopInput}
            onChange={(e) => onStop(e.target.value)}
            placeholder="0"
            className="type-num w-full bg-transparent outline-none"
          />
        </Field>
      )}

      {coverQuote && (
        <div className="mb-4 rounded-md bg-[#2C2C2E] px-4 py-3">
          <p className="type-label text-[#AEAEB2]">You pay at most</p>
          <p className="type-num-lg">
            {formatCNS(maxPremiumFromQuote(coverQuote.quotedCNS))}
          </p>
        </div>
      )}

      {actionError && (
        <div className="mb-4">
          <ErrorBlock
            title={errorCopyFor(actionError).title}
            body={errorCopyFor(actionError).body}
            code={actionError}
          />
        </div>
      )}

      {reason && <p className="type-footnote mb-3 text-[#AEAEB2]">{reason}</p>}
      <GaplessButton
        variant="primary"
        size="lg"
        fullWidth
        isDisabled={disabled}
        isPending={confirming || quoting}
        onPress={onReview}
      >
        {reviewLabel}
      </GaplessButton>
    </div>
  )
}

function formAction(ctx: {
  perpActive: boolean
  operatorMonBalanceWei: bigint
  lots: bigint
  sizeErr: string | null
  stopErr: string | null
  guaranteeOn: boolean
  stopInput: string
  operatorAvailableCNS: bigint
  buysBlocked: boolean
  quoting: boolean
  confirming: boolean
}): { disabled: boolean; reason: string | null } {
  if (!ctx.perpActive)
    return { disabled: true, reason: 'Perpl has halted trading' }
  if (ctx.operatorMonBalanceWei === 0n)
    return { disabled: true, reason: 'Your trading key needs MON for gas' }
  if (ctx.sizeErr) return { disabled: true, reason: ctx.sizeErr }
  if (ctx.lots === 0n) return { disabled: true, reason: 'Enter a size' }
  if (ctx.stopErr) return { disabled: true, reason: ctx.stopErr }
  if (ctx.guaranteeOn && !ctx.stopInput.trim())
    return { disabled: true, reason: 'Enter a stop' }
  if (ctx.operatorAvailableCNS === 0n)
    return { disabled: true, reason: 'Daily limit reached' }
  if (ctx.quoting || ctx.confirming) return { disabled: true, reason: null }
  return { disabled: false, reason: null }
}

function AddGuaranteeForm({
  market,
  chain,
  isLong,
  stopInput,
  onStop,
  buysBlocked,
  quoting,
  confirming,
  coverQuote,
  actionError,
  onQuote,
  onConfirm,
}: {
  market: MarketStatic
  chain: TradeChainState
  isLong: boolean
  stopInput: string
  onStop: (v: string) => void
  buysBlocked: boolean
  quoting: boolean
  confirming: boolean
  coverQuote: { quotedCNS: bigint; source: 'probe' | 'quote' } | null
  actionError: string | null
  onQuote: () => void
  onConfirm: () => void
}) {
  let stopPNS = 0n
  let stopErr: string | null = null
  if (stopInput.trim()) {
    try {
      stopPNS = parseDecimalToUnits(stopInput, market.priceDecimals, 'stop')
      if (
        stopDistanceBps(stopPNS, chain.markPNS) <
        BigInt(market.minStopDistanceBps)
      ) {
        stopErr = `Stop must be at least ${market.minStopDistanceBps} bps from mark`
      }
    } catch (err) {
      stopErr = err instanceof OrderInputError ? err.message : 'Invalid stop'
    }
  }

  return (
    <div className="rounded-lg bg-[#1C1C1E] p-5">
      <h2 className="type-title-2 mb-2">Add guarantee</h2>
      <p className="type-callout mb-4 text-[#AEAEB2]">
        Your {isLong ? 'long' : 'short'} position is open without protection.
        Set a stop to guarantee it.
      </p>

      {buysBlocked && (
        <div className="mb-4 rounded-md bg-[#402F21] px-4 py-3">
          <p className="type-headline text-[#FF9230]">Buys are paused</p>
          <p className="type-callout text-[#AEAEB2]">
            New covers are paused by the protocol. Your position can still be
            closed any time.
          </p>
        </div>
      )}

      <Field
        label="Stop"
        error={stopErr ?? undefined}
        bound={`Min ${market.minStopDistanceBps} bps from mark`}
        className="mb-4"
      >
        <input
          inputMode="decimal"
          value={stopInput}
          onChange={(e) => onStop(e.target.value)}
          placeholder="0"
          className="type-num w-full bg-transparent outline-none"
        />
      </Field>

      {coverQuote && (
        <div className="mb-4 rounded-md bg-[#2C2C2E] px-4 py-3">
          <p className="type-label text-[#AEAEB2]">You pay at most</p>
          <p className="type-num-lg">
            {formatCNS(maxPremiumFromQuote(coverQuote.quotedCNS))}
          </p>
        </div>
      )}

      {actionError && (
        <div className="mb-4">
          <ErrorBlock
            title={errorCopyFor(actionError).title}
            body={errorCopyFor(actionError).body}
            code={actionError}
          />
        </div>
      )}

      <GaplessButton
        variant="primary"
        size="lg"
        fullWidth
        isDisabled={
          buysBlocked ||
          !stopInput.trim() ||
          Boolean(stopErr) ||
          quoting ||
          confirming
        }
        isPending={quoting || confirming}
        onPress={coverQuote ? onConfirm : onQuote}
      >
        {coverQuote ? 'Buy guarantee' : 'Price guarantee'}
      </GaplessButton>
    </div>
  )
}

function PositionCard({
  market,
  chain,
  isLong,
  hasActiveCover,
  onClose,
  pending,
}: {
  market: MarketStatic
  chain: TradeChainState
  isLong: boolean
  hasActiveCover: boolean
  onClose: () => void
  pending: boolean
}) {
  const size = lnsToSize(chain.position.lotLNS, market.lotDecimals)
  const entry = pnsToPrice(chain.position.pricePNS, market.priceDecimals)
  const pnlValue = chain.position.pnlCNS
  const pnlDecimal = Number(pnlValue) / 1e6
  const pnlColor =
    pnlValue > 0n
      ? 'text-[#30D158]'
      : pnlValue < 0n
        ? 'text-[#FF6165]'
        : 'text-[#AEAEB2]'
  return (
    <div className="rounded-lg bg-[#1C1C1E] p-5">
      <div className="mb-3 flex items-center justify-between">
        <p className="type-label text-[#AEAEB2]">Position</p>
        {hasActiveCover ? (
          <Link
            to="/covers/$coverId"
            params={{ coverId: chain.activeCoverId }}
            className="flex items-center gap-1 text-[#A48FFF]"
          >
            <ShieldCheck className="size-4" strokeWidth={1.75} />
            <span className="type-footnote">Covered</span>
            <ChevronRight className="size-4" strokeWidth={1.75} />
          </Link>
        ) : (
          <span className="type-footnote text-[#FF9230]">Uncovered</span>
        )}
      </div>
      <div className="mb-3 flex items-center gap-2">
        {isLong ? (
          <ArrowUpRight className="size-5 text-[#30D158]" strokeWidth={2} />
        ) : (
          <ArrowDownRight className="size-5 text-[#FF4245]" strokeWidth={2} />
        )}
        <p className="type-num-lg">{size} BTC</p>
      </div>
      <p className="type-footnote mb-4 text-[#AEAEB2]">
        Entry {entry.toFixed(market.priceDecimals)} · PnL{' '}
        <span className={pnlColor}>{formatSigned(pnlDecimal)} AUSD</span>
      </p>
      <GaplessButton
        variant="destructive"
        size="md"
        fullWidth
        isDisabled={chain.isLocked || pending}
        isPending={pending}
        onPress={onClose}
      >
        Close position
      </GaplessButton>
      {chain.isLocked && (
        <p className="type-footnote mt-2 text-[#AEAEB2]">
          Locked while a cover is armed or triggered.
        </p>
      )}
    </div>
  )
}

function Switch({
  checked,
  onChange,
  disabled,
}: {
  checked: boolean
  onChange: (v: boolean) => void
  disabled?: boolean
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cnm(
        'h-[31px] w-[51px] rounded-full p-0.5 transition-colors',
        checked ? 'bg-[#6E54FF]' : 'bg-[#3A3A3C]',
        disabled && 'opacity-50',
      )}
    >
      <span
        className={cnm(
          'block size-[27px] rounded-full bg-white transition-transform',
          checked && 'translate-x-5',
        )}
      />
    </button>
  )
}
