// Runs `cre workflow simulate` for one handler with the right flags and preflight checks.
// Usage (from gapless-ref/): bun scripts/simulate.ts ref [broadcast] | watch | armed <txHash> <eventIndex>
// Flags are assembled at runtime so this repo never spells a double hyphen (style rule).
import { join } from "node:path"
import { createPublicClient, http, isAddress, zeroAddress, type Address } from "viem"
import { ICoverManagerAbi } from "../../contracts/abi"

const D = "-".repeat(2)
const MIN_CLI = [1, 29, 0] // Monad mainnet support (CRE release notes, CLI v1.29.0)
const PROJECT_ROOT = join(import.meta.dir, "../..")
const TARGET = "staging-settings"

function fail(msg: string): never {
  console.error(`simulate: ${msg}`)
  process.exit(1)
}

async function run(cmd: string[], capture = false): Promise<{ code: number; out: string }> {
  const p = Bun.spawn(cmd, { cwd: PROJECT_ROOT, stdout: capture ? "pipe" : "inherit", stderr: "inherit", stdin: "inherit" })
  const out = capture ? await new Response(p.stdout).text() : ""
  return { code: await p.exited, out }
}

async function checkCli(): Promise<void> {
  const { code, out } = await run(["cre", "version"], true)
  if (code !== 0) fail("cre CLI not found; install it and run `cre update`")
  const m = /v?(\d+)\.(\d+)\.(\d+)/.exec(out)
  if (!m) fail(`cannot parse cre version from: ${out.trim()}`)
  const v = [Number(m[1]), Number(m[2]), Number(m[3])]
  for (let i = 0; i < 3; i++) {
    if (v[i]! > MIN_CLI[i]!) break
    if (v[i]! < MIN_CLI[i]!) fail(`cre ${v.join(".")} is below ${MIN_CLI.join(".")}; run \`cre update\``)
  }
}

/** ADR-P5: the single kind-1 broadcast only happens while no cover is live. */
async function assertNoLiveCovers(): Promise<void> {
  const cfg = await Bun.file(join(import.meta.dir, "../config.staging.json")).json()
  const manager = cfg.coverManager as string
  if (!isAddress(manager) || manager === zeroAddress) fail("coverManager is unset in config.staging.json")
  const client = createPublicClient({ transport: http(process.env.MONAD_RPC_URL) })
  for (const m of cfg.markets as { perpId: number }[]) {
    const live = await client.readContract({
      address: manager as Address,
      abi: ICoverManagerAbi,
      functionName: "liveCount",
      args: [BigInt(m.perpId)],
    })
    if (live !== 0n) fail(`liveCount(${m.perpId}) = ${live}; broadcast only with no live cover (ADR-P5)`)
  }
  console.info("preflight: liveCount is 0 for every configured perp")
}

const [mode, a1, a2] = process.argv.slice(2)
if (!process.env.MONAD_RPC_URL) fail("MONAD_RPC_URL is not set (project.yaml reads it)")
if (!process.env.CRE_ETH_PRIVATE_KEY) console.warn("simulate: CRE_ETH_PRIVATE_KEY unset; dry runs use a throwaway key")

const args = ["cre", "workflow", "simulate", "gapless-ref", `${D}target`, TARGET, `${D}non-interactive`]
if (mode === "ref" || mode === "watch") {
  args.push(`${D}trigger-index`, mode === "ref" ? "0" : "1")
  if (a1 === "broadcast") {
    if (mode !== "ref") fail("only the kind-1 ref report may be broadcast (ADR-P5)")
    if (!process.env.CRE_ETH_PRIVATE_KEY) fail("broadcast needs CRE_ETH_PRIVATE_KEY in the process env")
    await assertNoLiveCovers()
    args.push(`${D}broadcast`)
  } else if (a1 !== undefined) {
    fail(`unknown option ${a1}`)
  }
} else if (mode === "armed") {
  if (!a1 || !/^0x[0-9a-fA-F]{64}$/.test(a1)) fail("armed needs the Armed tx hash")
  if (!a2 || !/^\d{1,4}$/.test(a2)) fail("armed needs the log index of Armed within that tx")
  // Dry run only: the sink ignores kind 3 older than 400 blocks (D11).
  args.push(`${D}trigger-index`, "2", `${D}evm-tx-hash`, a1, `${D}evm-event-index`, a2)
} else {
  fail("usage: bun scripts/simulate.ts ref [broadcast] | watch | armed <txHash> <eventIndex>")
}

await checkCli()
console.info(`running: ${args.join(" ")}`)
process.exit((await run(args)).code)
