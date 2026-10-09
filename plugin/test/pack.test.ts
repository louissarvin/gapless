import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = join(import.meta.dirname, "..");

describe("npm pack", () => {
  it("ships only dist, the oclif manifest, SKILL.md, README.md, LICENSE and package.json", () => {
    // prepack builds, writes oclif.manifest.json and copies the skill; pack itself then runs without scripts.
    execFileSync("npm", ["run", "prepack"], { cwd: root, stdio: "ignore" });
    const out = execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], { cwd: root, encoding: "utf8" });
    const [info] = JSON.parse(out) as [{ name: string; version: string; files: { path: string }[] }];
    expect(info.name).toBe("mm-plugin-gapless");

    const paths = info.files.map((f) => f.path);
    expect([...new Set(paths.map((p) => p.split("/")[0]))].sort()).toEqual(
      ["LICENSE", "README.md", "SKILL.md", "dist", "oclif.manifest.json", "package.json"].sort(),
    );
    expect(paths.filter((p) => p.startsWith("dist/")).every((p) => p.endsWith(".js"))).toBe(true);
    for (const id of ["quote", "trade", "cover", "cancel", "status", "grant", "link", "account"]) {
      expect(paths).toContain(`dist/commands/gapless/${id}.js`);
    }

    const manifest = JSON.parse(readFileSync(join(root, "oclif.manifest.json"), "utf8"));
    expect(Object.keys(manifest.commands).sort()).toEqual(
      ["account", "cancel", "cover", "grant", "link", "quote", "status", "trade"].map((c) => `gapless:${c}`),
    );
    expect(readFileSync(join(root, "SKILL.md"), "utf8")).toBe(readFileSync(join(root, "..", "skills", "gapless", "SKILL.md"), "utf8"));
  }, 180_000);
});
