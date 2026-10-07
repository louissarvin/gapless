// Writes test/fixtures/cre_report_vectors.json for the contract-side parity test (W5, forge).
// Usage: bun scripts/gen-vectors.ts. Bun.write, not node:fs: the CRE SDK types node built-ins as never.
import { join } from "node:path"
import { buildVectors } from "../test/vectors"

const out = join(import.meta.dir, "../test/fixtures/cre_report_vectors.json")
await Bun.write(out, `${JSON.stringify(buildVectors(), null, 2)}\n`)
console.info(`wrote ${out}`)
