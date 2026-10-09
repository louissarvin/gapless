import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CAPABILITIES, PluginManifestSchema, RESERVED_CAPABILITIES } from "@metamask/agent-wallet/plugin";
import { describe, expect, it } from "vitest";

const root = join(import.meta.dirname, "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const commandsDir = join(root, "src/commands/gapless");

// Plan W3 command table: wallet-submit only where a command submits.
const EXPECTED: Record<string, string[]> = {
  "gapless:quote": ["wallet-read"],
  "gapless:trade": ["wallet-read", "wallet-submit"],
  "gapless:cover": ["wallet-read", "wallet-submit"],
  "gapless:cancel": ["wallet-read", "wallet-submit"],
  "gapless:status": ["wallet-read"],
  "gapless:grant": ["wallet-read"],
  "gapless:link": ["wallet-read", "wallet-submit"],
  "gapless:account": ["wallet-read", "wallet-submit"],
};

describe("package manifest", () => {
  it("passes the host's own PluginManifestSchema", () => {
    expect(PluginManifestSchema.safeParse(pkg.mm).success).toBe(true);
    expect(pkg.mm.schemaVersion).toBe(1);
    expect(pkg.mm.minCliVersion).toBe("^6.2.0");
  });

  it("keeps plugin-wide capabilities empty and per-command capabilities minimal", () => {
    expect(pkg.mm.capabilities).toEqual([]);
    const byId = Object.fromEntries(pkg.mm.commands.map((c: { id: string; capabilities: string[] }) => [c.id, [...c.capabilities].sort()]));
    expect(byId).toEqual(EXPECTED);
    for (const c of pkg.mm.commands) {
      expect(c.targetChains).toEqual([143]);
      for (const cap of c.capabilities) {
        expect(CAPABILITIES).toContain(cap);
        expect(RESERVED_CAPABILITIES).not.toContain(cap);
        expect(cap).not.toBe("network-manage");
      }
      expect(c.dataAccess).not.toContain("mnemonic");
      expect(c.dataAccess).not.toContain("session");
    }
  });

  it("meets the install requirements: keyword, peer dep, oclif block, no hooks", () => {
    expect(pkg.keywords).toContain("oclif-plugin");
    expect(pkg.peerDependencies["@metamask/agent-wallet"]).toBe("^6.2.0");
    expect(pkg.dependencies["@metamask/agent-wallet"]).toBeUndefined();
    expect(pkg.dependencies.viem).toBe("2.57.3");
    expect(pkg.oclif.commands).toBe("./dist/commands");
    expect(pkg.oclif.hooks).toBeUndefined();
    expect(pkg.oclif.plugins).toBeUndefined();
    expect(pkg.files).toEqual(["dist", "oclif.manifest.json", "SKILL.md"]);
    expect(pkg.scripts.postinstall).toBeUndefined();
    expect(pkg.type).toBe("module");
  });

  it("has one command file per manifest id, with a matching pluginCommandId and no sealed overrides", () => {
    const files = readdirSync(commandsDir).filter((f) => f.endsWith(".ts")).sort();
    expect(files.map((f) => `gapless:${f.replace(/\.ts$/, "")}`).sort()).toEqual(Object.keys(EXPECTED).sort());
    for (const f of files) {
      const src = readFileSync(join(commandsDir, f), "utf8");
      const id = `gapless:${f.replace(/\.ts$/, "")}`;
      expect(src).toContain(`pluginCommandId = "${id}"`);
      expect(src).toMatch(/extends PluginCommand</);
      for (const sealed of ["run(", "runLifecycle", "beforeExecute", "init(", "prepareForRepl", "withPluginIsolation", "requiresAuth", "requiresInit", "requiresFees"]) {
        expect(src, `${f} overrides ${sealed}`).not.toContain(sealed);
      }
    }
  });

  it("reaches the wallet executor only through lib/submit", () => {
    const srcRoot = join(root, "src");
    const all = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? all(join(dir, d.name)) : [join(dir, d.name)]));
    for (const file of all(srcRoot).filter((f) => f.endsWith(".ts"))) {
      const src = readFileSync(file, "utf8");
      if (!file.endsWith(join("lib", "submit.ts")) && !file.endsWith(join("lib", "host.ts"))) {
        expect(src, file).not.toMatch(/walletExecutor\(/);
      }
      expect(src, file).not.toMatch(/sendRawTransaction|sendTransaction\(|privateKey|mnemonic/i);
    }
  });
});
