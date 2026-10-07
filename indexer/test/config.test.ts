import { readFileSync } from "node:fs";
import { describe, it } from "vitest";
import { keccak256, toEventSelector, toHex, type Abi, type AbiEvent } from "viem";
import coverManagerAbi from "../abis/CoverManager.json" with { type: "json" };
import perplEventsAbi from "../abis/IPerplEvents.json" with { type: "json" };
import { MAKER_FILLED_TOPIC, TRIGGERED_TOPIC } from "../src/effects/triggerPrints.js";
import { deployedDefault } from "./helpers.js";

const config = readFileSync(new URL("../config.yaml", import.meta.url), "utf8");
const event = (abi: unknown, name: string) => (abi as Abi).find((x): x is AbiEvent => x.type === "event" && x.name === name)!;

describe("config.yaml contract for scripts/sync-abi.ts (W5)", () => {
  it("has exactly one @deploy marker per deployment key, each on an ENVIO_* interpolation", (t) => {
    const marked = config.split("\n").filter((l) => l.includes("# @deploy:"));
    const keys = marked.map((l) => l.split("# @deploy:")[1]!.trim());
    t.expect(keys).toEqual(["deployBlock", "CoverManager", "CoverVault", "GaplessFactory", "GaplessCreSink"]);
    for (const l of marked) t.expect(l).toMatch(/\$\{ENVIO_[A-Z_]+:-[^}]+\}/);
    // Unquoted 0x literals parse as YAML integers.
    for (const l of marked.filter((x) => x.includes("address:"))) t.expect(l).toMatch(/address: "\$\{/);
  });

  it("defaults to the canary deployment in deployments/143.json", (t) => {
    const dep = JSON.parse(readFileSync(new URL("../../deployments/143.json", import.meta.url), "utf8"));
    for (const name of ["CoverManager", "CoverVault", "GaplessFactory", "GaplessCreSink"]) {
      t.expect(deployedDefault(name)).toBe(dep.contracts[name].address.toLowerCase());
    }
    t.expect(config).toContain(`\${ENVIO_START_BLOCK:-${dep.deployBlock}} # @deploy:deployBlock`);
  });

  it("keeps the dynamic GaplessAccount contract address-less", (t) => {
    const chainSection = config.slice(config.indexOf("chains:"));
    t.expect(chainSection).not.toMatch(/name: GaplessAccount\b/);
  });
});

describe("ABI topics", () => {
  it("pins Armed to the INTERFACES 5.4 signature", (t) => {
    t.expect(toEventSelector(event(coverManagerAbi, "Armed"))).toBe(
      keccak256(toHex("Armed(bytes32,uint256,address,uint256,uint256,uint256)")),
    );
  });

  it("matches the receipt decoder topics to the Solidity signatures", (t) => {
    t.expect(MAKER_FILLED_TOPIC).toBe(
      keccak256(toHex("MakerOrderFilledV2(uint256,uint256,uint256,uint256,uint256,uint256,uint256,int256,uint256,uint256,uint256)")),
    );
    t.expect(TRIGGERED_TOPIC).toBe(
      keccak256(toHex("Triggered(bytes32,uint256,uint256,uint256,int256,uint256,uint256,uint256,uint256)")),
    );
    t.expect(toEventSelector(event(perplEventsAbi, "MakerOrderFilledV2"))).toBe(MAKER_FILLED_TOPIC);
  });
});
