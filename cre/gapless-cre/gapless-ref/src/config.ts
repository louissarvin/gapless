import { getAddress, isAddress, zeroAddress, type Address } from "viem"
import { z } from "zod"

/** CRE EVM write quota per transaction (docs.chain.link/cre/service-quotas). */
export const MAX_TX_GAS = 10_000_000n
/** HTTP calls per execution quota is 15; keep headroom for retries by the platform. */
export const MAX_TOTAL_SOURCES = 12
/** Mirrors Constants.CRE_MAX_IDS: the sink ignores ids past the third. */
export const SINK_MAX_IDS = 3

const PLACEHOLDER_HINT = "set by scripts/sync-abi.ts from deployments/143.json"

const address = z
  .string()
  .refine((s) => isAddress(s, { strict: false }), "not an address")
  .transform((s) => getAddress(s))
  .refine((a) => a !== zeroAddress, `zero address: ${PLACEHOLDER_HINT}`)

const gas = z
  .string()
  .regex(/^[1-9]\d{0,8}$/, "decimal gas amount")
  .transform((s) => BigInt(s))
  .refine((g) => g <= MAX_TX_GAS, "above the CRE 10,000,000 gas quota")

const source = z
  .object({
    name: z.string().min(1).max(32),
    // Regex, not z.url(): the WASM runtime may lack the URL global.
    url: z.string().max(256).regex(/^https:\/\/[A-Za-z0-9.-]+(:\d{1,5})?(\/[!-~]*)?$/, "https URL"),
    path: z.array(z.string().min(1).max(64)).min(1).max(8),
  })
  .strict()

const market = z
  .object({
    perpId: z.number().int().positive(),
    priceDecimals: z.number().int().min(0).max(8),
    sources: z.array(source).min(2).max(5),
  })
  .strict()

export const configSchema = z
  .object({
    schedule: z.string().min(9).max(64),
    chainSelectorName: z.literal("monad-mainnet"),
    receiver: address,
    coverManager: address,
    logConfidence: z
      .enum(["CONFIDENCE_LEVEL_LATEST", "CONFIDENCE_LEVEL_SAFE", "CONFIDENCE_LEVEL_FINALIZED"])
      .default("CONFIDENCE_LEVEL_SAFE"),
    maxIdsPerReport: z.number().int().min(1).max(SINK_MAX_IDS),
    gasRef: gas,
    gasBase: gas,
    gasPerArm: gas,
    gasPerTrigger: gas,
    gasCap: gas,
    maxSourceDevBps: z.number().int().min(1).max(1000),
    minSources: z.number().int().min(2).max(5),
    httpTimeout: z.string().regex(/^(10|[1-9])s$/, "1s to 10s"),
    markets: z.array(market).min(1).max(3),
  })
  .strict()
  .superRefine((c, ctx) => {
    if (c.gasRef > c.gasCap) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "gasRef above gasCap" })
    const perps = new Set(c.markets.map((m) => m.perpId))
    if (perps.size !== c.markets.length) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "duplicate perpId" })
    const total = c.markets.reduce((n, m) => n + m.sources.length, 0)
    if (total > MAX_TOTAL_SOURCES) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "too many HTTP sources" })
    for (const m of c.markets) {
      if (m.sources.length < c.minSources) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `perp ${m.perpId}: fewer sources than minSources` })
      }
    }
  })

export type RawConfig = z.input<typeof configSchema>
export type Config = z.output<typeof configSchema>
export type Market = Config["markets"][number]
export type Source = Market["sources"][number]
export type { Address }
