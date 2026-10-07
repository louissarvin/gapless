import { describe, expect, test as bunTest } from "bun:test"
import { getNetwork, hexToBase64 } from "@chainlink/cre-sdk"
import { test } from "@chainlink/cre-sdk/test"
import { join } from "node:path"
import { keccak256, toBytes } from "viem"
import { ICoverManagerAbi, IGaplessCreSinkAbi } from "../../contracts/abi"
import { initWorkflow } from "../main"
import { armedTopic0, resolveSelector } from "../src/chain"
import { configSchema } from "../src/config"
import { MONAD_MAINNET_SELECTOR } from "../src/report"
import { MANAGER, config, rawConfig } from "./helpers"

const ROOT = join(import.meta.dir, "..")

describe("config schema", () => {
  bunTest("valid config parses, with bigint gas and checksummed addresses", () => {
    const c = config({ coverManager: MANAGER.toLowerCase() })
    expect(c.gasCap).toBe(9_500_000n)
    expect(c.coverManager).toBe(MANAGER)
  })

  bunTest("rejects the zero-address placeholders, foreign chains and unsafe gas", () => {
    const bad = [
      { receiver: "0x0000000000000000000000000000000000000000" },
      { coverManager: "0x1234" },
      { chainSelectorName: "monad-testnet" },
      { gasCap: "10000001" },
      { gasRef: "9600000" },
      { gasPerTrigger: "0" },
      { maxIdsPerReport: 4 },
      { httpTimeout: "30s" },
      { unknownKey: 1 },
    ]
    for (const over of bad) expect(configSchema.safeParse(rawConfig(over as never)).success).toBe(false)
  })

  bunTest("rejects http sources, duplicate perps and too few sources", () => {
    const m = rawConfig().markets[0]!
    const http = { ...m, sources: m.sources.map((s) => ({ ...s, url: s.url.replace("https", "http") })) }
    expect(configSchema.safeParse(rawConfig({ markets: [http] })).success).toBe(false)
    expect(configSchema.safeParse(rawConfig({ markets: [m, m] })).success).toBe(false)
    expect(configSchema.safeParse(rawConfig({ minSources: 4 })).success).toBe(false)
  })

  bunTest("shipped configs carry the canary addresses; production receiver stays unset", async () => {
    const staging = await Bun.file(join(ROOT, "config.staging.json")).json()
    const production = await Bun.file(join(ROOT, "config.production.json")).json()
    const s = configSchema.safeParse(staging)
    expect(s.success).toBe(true)

    const deployment = Bun.file(join(ROOT, "../../../deployments/143.json"))
    if (await deployment.exists()) {
      const dep = await deployment.json()
      const manager = dep.contracts.CoverManager.address
      if (s.success) expect([s.data.coverManager, s.data.receiver]).toEqual([manager, dep.contracts.GaplessCreSink.address])
      expect(production.coverManager).toBe(manager)
    }

    // No production sink yet (simulation-only GaplessCreSink), so the schema must keep refusing it.
    const p = configSchema.safeParse(production)
    expect(p.success).toBe(false)
    if (!p.success) {
      expect(p.error.issues.map((i) => i.path.join("."))).toEqual(["receiver"])
      expect(p.error.issues[0]!.message).toContain("sync-abi")
    }
    expect(configSchema.safeParse({ ...production, receiver: MANAGER }).success).toBe(true)
  })
})

describe("chain constants", () => {
  bunTest("monad-mainnet selector matches Constants.CHAIN_SELECTOR", () => {
    expect(getNetwork({ chainFamily: "evm", chainSelectorName: "monad-mainnet" })?.chainSelector.selector).toBe(
      8_481_857_512_324_358_265n,
    )
    expect(resolveSelector("monad-mainnet")).toBe(MONAD_MAINNET_SELECTOR)
    expect(() => resolveSelector("ethereum-testnet-sepolia")).toThrow("not monad-mainnet")
    expect(() => resolveSelector("nope")).toThrow("unknown network")
  })

  bunTest("Armed topic0 from the ABI equals the pinned signature", () => {
    expect(armedTopic0()).toBe(keccak256(toBytes("Armed(bytes32,uint256,address,uint256,uint256,uint256)")))
  })
})

describe("initWorkflow", () => {
  test("handler order 0 ref cron, 1 watch cron, 2 Armed log trigger", () => {
    const c = config()
    const handlers = initWorkflow(c)
    expect(handlers).toHaveLength(3)
    const cfgOf = (i: number) => (handlers[i]!.trigger as unknown as { config: unknown }).config
    expect(cfgOf(0)).toMatchObject({ schedule: "*/30 * * * * *" })
    expect(cfgOf(1)).toMatchObject({ schedule: "*/30 * * * * *" })
    const log = cfgOf(2) as {
      addresses: Uint8Array[]
      topics: { values: Uint8Array[] }[]
      confidence: number
    }
    expect(Buffer.from(log.addresses[0]!).toString("base64")).toBe(hexToBase64(MANAGER))
    expect(Buffer.from(log.topics[0]!.values[0]!).toString("base64")).toBe(hexToBase64(armedTopic0()))
    expect(log.topics).toHaveLength(1)
  })
})

describe("bootstrap ABI copies", () => {
  const src = join(ROOT, "../../../contract/abi")
  bunTest("match contract/abi exactly (until scripts/sync-abi.ts owns them)", async () => {
    const manager = Bun.file(join(src, "ICoverManager.json"))
    if (!(await manager.exists())) return // standalone checkout without contract/
    expect(ICoverManagerAbi).toEqual(await manager.json())
    expect(IGaplessCreSinkAbi).toEqual(await Bun.file(join(src, "IGaplessCreSink.json")).json())
  })
})
