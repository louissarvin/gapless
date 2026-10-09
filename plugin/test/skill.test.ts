import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ERROR_HINTS, errorCode } from "../src/lib/errors.js";

const root = join(import.meta.dirname, "..");
const skill = readFileSync(join(root, "..", "skills", "gapless", "SKILL.md"), "utf8");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

describe("skills/gapless/SKILL.md", () => {
  it("has the agent-skills frontmatter", () => {
    const fm = /^---\n([\s\S]*?)\n---\n/.exec(skill)?.[1] ?? "";
    expect(fm).toMatch(/^name: gapless$/m);
    expect(fm).toMatch(/^description: .{40,}$/m);
    expect(fm).toMatch(/^license: MIT$/m);
    expect(fm).toMatch(/^ {2}author: /m);
    expect(fm).toMatch(new RegExp(`^ {2}version: "${pkg.version}"$`, "m"));
    expect(fm).toMatch(/^ {2}cliVersion: "7\.0\.0"$/m);
  });

  it("routes to every plugin command and the install lines", () => {
    for (const c of pkg.mm.commands as { id: string }[]) expect(skill).toContain(`mm gapless ${c.id.split(":")[1]}`);
    expect(skill).toContain("mm config set experimentalPlugins true");
    expect(skill).toContain("mm config set experimentalAllowUnverifiedInstalls true");
  });

  it("maps the main contract errors", () => {
    for (const n of ["SigmaStale", "StopTooClose", "CoverShareExceeded", "OperatorBudgetExceeded", "PremiumTooHigh", "BadSig"]) {
      expect(ERROR_HINTS[n]).toBeDefined();
      expect(skill).toContain(errorCode(n));
    }
    expect(skill).toContain("GAPLESS_NOT_OPERATOR");
    expect(skill).toContain("GAPLESS_PENDING");
  });

  it("uses no em dashes", () => {
    expect(skill).not.toContain(String.fromCharCode(0x2014));
  });
});
