import { z } from 'zod'
import { env } from '@/env'

/**
 * Typed relay client (ARCHITECTURE section 5). Every response is zod-validated;
 * callers must map `error.code` to copy (src/lib/errors.ts), never `error.message`.
 */

const hexString = z.string().regex(/^0x[0-9a-fA-F]*$/)
const addressSchema = z.string().regex(/^0x[0-9a-fA-F]{40}$/)
const decimalString = z.string().regex(/^[0-9]+$/)

const errorEnvelopeSchema = z.object({
  success: z.literal(false),
  data: z.null(),
  error: z.object({
    code: z.string(),
    message: z.string(),
    requestId: z.string().optional(),
    details: z.unknown().optional(),
  }),
})

function successEnvelopeSchema<T extends z.ZodTypeAny>(dataSchema: T) {
  return z.object({
    success: z.literal(true),
    data: dataSchema,
    error: z.null(),
  })
}

export class RelayError extends Error {
  code: string
  requestId?: string

  constructor(code: string, message: string, requestId?: string) {
    super(message)
    this.name = 'RelayError'
    this.code = code
    this.requestId = requestId
  }
}

/** A 429: the caller should keep showing its last good value, never an error wall (phase 2 section 8). */
export class RelayRateLimitError extends RelayError {
  retryAfterS: number | null

  constructor(retryAfterS: number | null) {
    super('RATE_LIMITED', 'Rate limited, try again shortly')
    this.name = 'RelayRateLimitError'
    this.retryAfterS = retryAfterS
  }
}

/** `/sponsor/create` (ARCHITECTURE 5.1). */
export const sponsorCreateRequestSchema = z.object({
  owner: addressSchema,
  grant: z.object({
    key: addressSchema,
    expiry: decimalString,
    maxNotionalPerTradeCNS: decimalString,
    maxNotionalPerDayCNS: decimalString,
  }),
  deadline: decimalString,
  sig: z
    .string()
    .regex(/^0x[0-9a-fA-F]{130}$/, 'sig must be 65 bytes (130 hex chars)'),
})
export type SponsorCreateRequest = z.infer<typeof sponsorCreateRequestSchema>

export const sponsorCreateDataSchema = z.object({
  owner: addressSchema,
  account: addressSchema,
  status: z.enum(['created', 'pending']),
  txHash: hexString.nullable(),
  blockNumber: decimalString.nullable(),
})
export type SponsorCreateData = z.infer<typeof sponsorCreateDataSchema>

/** `/activate` (ARCHITECTURE 5.1). */
export const activateRequestSchema = z.object({
  account: addressSchema,
})
export type ActivateRequest = z.infer<typeof activateRequestSchema>

const dripSchema = z.object({
  to: addressSchema,
  wei: decimalString,
  txHash: hexString,
  blockNumber: decimalString,
})

export const dripSkippedReasonSchema = z.enum([
  'disabled',
  'no_operator',
  'operator_expired',
  'operator_no_budget',
  'not_allowlisted',
  'already_funded',
  'drip_reverted',
])

export const activateDataSchema = z.object({
  account: addressSchema,
  perplAccountId: decimalString.nullable(),
  sweepTx: hexString.nullable(),
  drip: dripSchema.nullable(),
  dripSkipped: dripSkippedReasonSchema.nullable(),
})
export type ActivateData = z.infer<typeof activateDataSchema>

/** `/sigma-refresh` (ARCHITECTURE 5.2). Typed for a future pass; not called while /trade is on hold. */
export const sigmaRefreshRequestSchema = z.object({
  perpId: z.number().int().positive(),
  account: addressSchema,
})
export const sigmaRefreshDataSchema = z.object({
  queued: z.literal(true),
})

const REQUEST_TIMEOUT_MS = 40_000

async function postJson<TReq, TData>(
  path: string,
  body: TReq,
  dataSchema: z.ZodType<TData>,
): Promise<TData> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)

  let response: Response
  try {
    response = await fetch(new URL(path, env.VITE_RELAY_URL), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    })
  } finally {
    clearTimeout(timeout)
  }

  const json = await response.json()

  const errorResult = errorEnvelopeSchema.safeParse(json)
  if (errorResult.success) {
    const { code, message, requestId } = errorResult.data.error
    throw new RelayError(code, message, requestId)
  }

  const okResult = successEnvelopeSchema(dataSchema).safeParse(json)
  if (!okResult.success) {
    throw new RelayError(
      'BAD_RESPONSE',
      'The relay response did not match the expected shape',
    )
  }
  return okResult.data.data
}

export function sponsorCreate(
  request: SponsorCreateRequest,
): Promise<SponsorCreateData> {
  const body = sponsorCreateRequestSchema.parse(request)
  return postJson('/sponsor/create', body, sponsorCreateDataSchema)
}

export function activate(request: ActivateRequest): Promise<ActivateData> {
  const body = activateRequestSchema.parse(request)
  return postJson('/activate', body, activateDataSchema)
}

/**
 * Phase 2 section 6: public, read-only GET routes. 10s timeout, 429 raises
 * `RelayRateLimitError` with `Retry-After` so callers can keep the last value.
 * Schemas use `z.object` (unknown keys stripped, never strict): additive
 * relay fields never break the page, and only rendered fields are validated.
 */
const GET_TIMEOUT_MS = 10_000

async function getJson<TData>(
  path: string,
  dataSchema: z.ZodType<TData>,
): Promise<TData> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), GET_TIMEOUT_MS)

  let response: Response
  try {
    response = await fetch(new URL(path, env.VITE_RELAY_URL), {
      method: 'GET',
      headers: { accept: 'application/json' },
      signal: controller.signal,
    })
  } finally {
    clearTimeout(timeout)
  }

  if (response.status === 429) {
    const header = response.headers.get('retry-after')
    const retryAfterS = header && /^\d+$/.test(header) ? Number(header) : null
    throw new RelayRateLimitError(retryAfterS)
  }

  const json = await response.json()

  const errorResult = errorEnvelopeSchema.safeParse(json)
  if (errorResult.success) {
    const { code, message, requestId } = errorResult.data.error
    throw new RelayError(code, message, requestId)
  }

  const okResult = successEnvelopeSchema(dataSchema).safeParse(json)
  if (!okResult.success) {
    throw new RelayError(
      'BAD_RESPONSE',
      'The relay response did not match the expected shape',
    )
  }
  return okResult.data.data
}

const count = z.number().int().nonnegative()
const cns = z.string().regex(/^\d{1,78}$/)
const blockNo = z.number().int().nonnegative()
const stat = z.number().finite().nullable()
const txHashNullable = z
  .string()
  .regex(/^0x[0-9a-fA-F]{64}$/)
  .nullable()

/** `GET /api/stats` (phase 2 section 6). 503 `STATS_NOT_READY` is an empty state, not an error. */
export const statsDataSchema = z.object({
  methodVersion: z.string(),
  generatedAt: z.string(),
  stale: z.boolean(),
  gapless: z.object({
    covers: z.object({
      total: count,
      live: count,
      armed: count,
      triggered: count,
      finalized: count,
      expired: count,
      cancelled: count,
      voided: count,
    }),
    owners: count,
    accounts: count,
    notionalCoveredCNS: cns,
    premiums: z.object({
      escrowToVaultCNS: cns,
      rentCNS: cns,
      toLpsCNS: cns,
      toTreasuryCNS: cns,
    }),
    payouts: z.object({ count, paidCNS: cns, owedCNS: cns }),
    armToTriggerBlocks: z.object({ n: count, p50: stat, max: stat }),
    vault: z.object({
      totalAssetsCNS: cns.nullable(),
      lpCount: count,
      utilizationBps: stat,
    }),
    cre: z.object({ reports: count, armed: count, triggered: count }),
    firsts: z.object({
      deployTx: txHashNullable,
      firstCoverTx: txHashNullable,
      firstTriggerTx: txHashNullable,
    }),
  }),
  perplNativeStops: z
    .object({
      window: z.object({ fromBlock: blockNo, toBlock: blockNo }),
      executions: count,
      joinRate: stat,
      slippageVsTriggerBps: z.object({ p50: stat, p95: stat }),
      delayBlocks: z.object({ p50: stat, p95: stat }),
    })
    .nullable(),
})
export type StatsData = z.infer<typeof statsDataSchema>

export function getStats(): Promise<StatsData> {
  return getJson('/api/stats', statsDataSchema)
}

const intervalStats = z.object({ p50: stat, p90: stat, max: stat, mean: stat })

/** `GET /api/gap-index/staleness`. */
export const stalenessDataSchema = z.object({
  generatedAt: z.string(),
  stale: z.boolean(),
  window: z.object({ fromBlock: blockNo, toBlock: blockNo, seconds: count }),
  perps: z.array(
    z.object({
      perpId: count,
      symbol: z.string(),
      mark: z.object({
        publishes: count,
        intervalSec: intervalStats,
        staleFraction: stat,
        ageSecAtWindowEnd: stat,
      }),
      oracle: z.object({
        intervalSec: intervalStats,
        reportLagSec: intervalStats,
        staleFraction: stat,
      }),
      markOracleDivergenceBps: z.object({ p50: stat, p99: stat, max: stat }),
    }),
  ),
  method: z.record(z.string(), z.unknown()).or(z.string()),
})
export type StalenessData = z.infer<typeof stalenessDataSchema>

export function getStaleness(): Promise<StalenessData> {
  return getJson('/api/gap-index/staleness', stalenessDataSchema)
}

const nativeStopAggregate = z.object({
  executions: count,
  joined: count,
  joinRate: stat,
  full: count,
  partial: count,
  unfilled: count,
  slippageVsTriggerBps: z.object({ n: count, p50: stat, p95: stat, max: stat }),
  delayBlocks: z.object({ n: count, p50: stat, p95: stat, max: stat }),
})

/** `GET /api/gap-index/native-stops`. */
export const nativeStopsDataSchema = z.object({
  generatedAt: z.string(),
  stale: z.boolean(),
  window: z.object({ fromBlock: blockNo, toBlock: blockNo }),
  totals: nativeStopAggregate,
  perps: z.array(
    nativeStopAggregate.extend({ perpId: count, symbol: z.string() }),
  ),
  method: z.record(z.string(), z.unknown()).or(z.string()),
})
export type NativeStopsData = z.infer<typeof nativeStopsDataSchema>

export function getNativeStops(): Promise<NativeStopsData> {
  return getJson('/api/gap-index/native-stops', nativeStopsDataSchema)
}

/** `GET /api/gap-index/summary`. */
export const summaryDataSchema = z.object({
  generatedAt: z.string(),
  stale: z.boolean(),
  perps: z.array(
    z.object({
      perpId: count,
      symbol: z.string(),
      lastMark: z.object({
        pricePNS: count,
        price: z.string(),
        block: blockNo,
      }),
      headline: z.array(
        z.object({
          side: z.string(),
          distanceBps: count,
          horizonBlocks: count,
          pHit: stat,
          markGapP99Bps: stat,
          markGapMaxBps: stat,
          distinctTriggers: count,
        }),
      ),
    }),
  ),
})
export type SummaryData = z.infer<typeof summaryDataSchema>

export function getSummary(): Promise<SummaryData> {
  return getJson('/api/gap-index/summary', summaryDataSchema)
}

/** `GET /api/gap-index/premium-curve`. Fetched only on expand (phase 2 5.3). */
export const premiumCurveDataSchema = z.object({
  generatedAt: z.string(),
  stale: z.boolean(),
  method: z.looseObject({ inputs: z.unknown() }),
  perps: z.array(
    z.object({
      perpId: count,
      curves: z.object({
        fitProposal: z.array(
          z.object({
            distanceBps: count,
            allowed: z.boolean(),
            rejectReasons: z.array(z.string()),
            feeBpsE2: stat,
            escrowCNS: cns.nullable(),
            rentCNS: cns.nullable(),
          }),
        ),
        specDefault: z.array(
          z.object({
            distanceBps: count,
            allowed: z.boolean(),
            rejectReasons: z.array(z.string()),
            feeBpsE2: stat,
            escrowCNS: cns.nullable(),
            rentCNS: cns.nullable(),
          }),
        ),
      }),
    }),
  ),
})
export type PremiumCurveData = z.infer<typeof premiumCurveDataSchema>

export function getPremiumCurve(): Promise<PremiumCurveData> {
  return getJson('/api/gap-index/premium-curve', premiumCurveDataSchema)
}

const wei = z.string().regex(/^\d{1,40}$/)

/** `GET /api/keeper/console` (phase 2 section 6, backend `routes/keeperConsole.ts` `consoleSchema`). */
export const keeperConsoleDataSchema = z.object({
  status: z.enum(['up', 'degraded', 'down']),
  head: z.object({
    block: blockNo.nullable(),
    lagBlocks: z.number().int().nullable(),
  }),
  signer: z.object({
    address: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
    balanceWei: wei.nullable(),
  }),
  governor: z.object({
    utcDay: z.string(),
    capWei: wei,
    usedWei: wei,
    exemptUsedWei: wei,
    remainingWei: wei,
  }),
  markets: z.array(
    z.object({
      perpId: count,
      gated: z.boolean(),
      maxMatchesClose: count.nullable(),
      liveCovers: count.nullable(),
    }),
  ),
  recent: z.array(
    z.object({
      block: blockNo.nullable(),
      action: z.string(),
      coverId: z
        .string()
        .regex(/^0x[0-9a-f]{64}$/)
        .nullable(),
      txHash: txHashNullable,
      outcome: z.enum(['confirmed', 'reverted', 'pending']),
      gasLimit: count.nullable(),
    }),
  ),
  walks: z.object({
    samples: count,
    chainGapP50: count.nullable(),
    chainGapMax: count.nullable(),
    laneShare: z.number().min(0).max(1).nullable(),
  }),
  uptimeS: count,
})
export type KeeperConsoleData = z.infer<typeof keeperConsoleDataSchema>

/** Throws `RelayError('KEEPER_UNAVAILABLE' | 'KEEPER_CONSOLE_DISABLED', ...)` on 503 (ADR-W17). */
export function getKeeperConsole(): Promise<KeeperConsoleData> {
  return getJson('/api/keeper/console', keeperConsoleDataSchema)
}

const accountNativeStopSchema = z.object({
  perpId: count,
  side: z.enum(['long', 'short']),
  triggerPNS: z.number().finite().nullable(),
  lotLNS: z.number().finite().nullable(),
  executedBlock: blockNo.nullable(),
  execTx: txHashNullable,
  fillVwapPNS: z.number().finite().nullable(),
  filledLNS: z.number().finite().nullable(),
  slippageVsTriggerBps: z.number().finite().nullable(),
  delayBlocks: count.nullable(),
  joinStatus: z.enum(['open', 'cancelled', 'joined', 'ambiguous', 'unjoined']),
})
export type AccountNativeStop = z.infer<typeof accountNativeStopSchema>

/** `GET /api/wallet/:addr`. Only the fields `/proof`'s plain side reads are validated. */
export const walletDataSchema = z.object({
  address: z.string(),
  nativeStops: z.array(accountNativeStopSchema),
})
export type WalletData = z.infer<typeof walletDataSchema>

export function getWalletHistory(
  address: string,
  limit = 50,
): Promise<WalletData> {
  const path = `/api/wallet/${address}?${new URLSearchParams({ limit: String(limit) }).toString()}`
  return getJson(path, walletDataSchema)
}
