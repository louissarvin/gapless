// prepack: ship skills/gapless/SKILL.md inside the package (plan D18). Fails the pack if the skill is missing.
import { copyFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = join(root, "..", "skills", "gapless", "SKILL.md");
if (!existsSync(src)) {
  process.stderr.write(`copy-skill: ${src} not found\n`);
  process.exit(1);
}
copyFileSync(src, join(root, "SKILL.md"));
