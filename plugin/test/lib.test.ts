import { CommandError } from "@metamask/agent-wallet/plugin";
import { readFileSync } from "node:fs";
import { type Abi, encodeErrorResult, getAddress, parseAbi } from "viem";
import { afterEach, describe, expect, it, vi } from "vitest";
import { IAUSDAbi, IPerplErrorsAbi } from "../src/abi/index.js";
import { DEPLOYMENT } from "../src/addresses.js";
import { resolveDeployment } from "../src/lib/config.js";
import { maxPremium, withinMarkBand } from "../src/lib/cover.js";
import { ERROR_ABI, ERROR_HINTS, errorCode, toCommandError } from "../src/lib/errors.js";
import { activeAddress, resolveWallet } from "../src/lib/host.js";
import { parseDecimal, parseLeverage, parseTime } from "../src/lib/units.js";
import { A } from "./helpers/fake.js";

type AbiError = Extract<Abi[number], { type: "error" }>;

function code(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (e) {
    return e instanceof CommandError ? e.code : "not-a-command-error";
  }
  return undefined;
}

describe("error decoding", () => {
  const nested = (data: string) => {
    const root = new Error("execution reverted");
    return Object.assign(new Error("CallExecutionError"), { cause: Object.assign(new Error("x"), { cause: Object.assign(root, { data }) }) });
  };

  it("decodes Perpl errors bubbling out of trades", () => {
    const item = IPerplErrorsAbi.find(
      (x) => x.type === "error" && x.inputs.length > 0 && x.inputs.every((i) => i.type === "uint256"),
    ) as unknown as AbiError;
    const perplName = item.name;
    const data = encodeErrorResult({ abi: [item], errorName: perplName, args: item.inputs.map(() => 1n) } as never);
    const e = toCommandError(nested(data), "Simulation of trade");
    expect(e.code).toBe(errorCode(perplName));
    expect(e.message).toContain(perplName);
  });

  it("decodes AUSD and Error(string) reverts", () => {
    const frozen = IAUSDAbi.find((x) => x.type === "error" && x.name === "AccountIsFrozen") as unknown as AbiError;
    const d = encodeErrorResult({ abi: [frozen], errorName: "AccountIsFrozen", args: frozen.inputs.map(() => A.owner) } as never);
    expect(toCommandError(nested(d), "x").code).toBe("GAPLESS_ACCOUNT_IS_FROZEN");
    const s = encodeErrorResult({ abi: parseAbi(["error Error(string)"]), errorName: "Error", args: ["nope"] });
    expect(toCommandError(nested(s), "x").message).toContain("Error(message=nope)");
  });

  it("reports unknown selectors and never echoes URLs", () => {
    expect(toCommandError(nested("0xdeadbeef00"), "x").code).toBe("GAPLESS_UNKNOWN_REVERT");
    const e = toCommandError(new Error("HTTP request failed. URL: https://rpc.example/key-123 status 500"), "read");
    expect(e.code).toBe("GAPLESS_RPC_ERROR");
    expect(e.message).not.toContain("key-123");
  });

  it("covers every hinted error in the merged ABI", () => {
    const names = new Set(ERROR_ABI.map((e) => e.name));
    for (const n of Object.keys(ERROR_HINTS)) expect(names, n).toContain(n);
  });

  it("snake cases names", () => {
    expect(errorCode("StopTooClose")).toBe("GAPLESS_STOP_TOO_CLOSE");
    expect(errorCode("ERC20InsufficientBalance")).toBe("GAPLESS_ERC20_INSUFFICIENT_BALANCE");
  });
});

describe("units", () => {
  it("parses exact decimals", () => {
    expect(parseDecimal("84000.5", 1, "stop")).toBe(840_005n);
    expect(parseDecimal("0.00022", 5, "size")).toBe(22n);
    expect(parseDecimal("25", 6, "x")).toBe(25_000_000n);
    expect(code(() => parseDecimal("1e3", 6, "x"))).toBe("GAPLESS_BAD_INPUT");
    expect(code(() => parseDecimal("-1", 6, "x"))).toBe("GAPLESS_BAD_INPUT");
    expect(code(() => parseDecimal("1;rm", 6, "x"))).toBe("GAPLESS_BAD_INPUT");
  });

  it("parses leverage and times", () => {
    expect(parseLeverage("5")).toBe(500n);
    expect(parseLeverage("2.5")).toBe(250n);
    expect(code(() => parseLeverage("0.5"))).toBe("GAPLESS_BAD_INPUT");
    expect(parseTime("+4h", "expiry", 100n, true)).toBe(14_500n);
    expect(parseTime("1760000000", "expiry", 100n, false)).toBe(1_760_000_000n);
    expect(code(() => parseTime("+4h", "expiry", 100n, false))).toBe("GAPLESS_BAD_INPUT");
  });

  it("applies the maxPremium and limit band rules", () => {
    expect(maxPremium(29_770n, undefined)).toBe(30_365n);
    expect(maxPremium(29_770n, "0")).toBe(29_770n);
    expect(maxPremium(10_000n, "1000")).toBe(11_000n);
    expect(withinMarkBand(105_000n, 100_000n)).toBe(true);
    expect(withinMarkBand(105_001n, 100_000n)).toBe(false);
    expect(withinMarkBand(95_000n, 100_000n)).toBe(true);
    expect(withinMarkBand(1n, 0n)).toBe(false);
  });
});

describe("active wallet", () => {
  const host = (state: unknown) => ({ walletStateManager: { read: () => state } });

  it("follows the host's selection by id, address or name", () => {
    const wallets = [{ id: "a", address: A.owner, name: "one" }, { id: "b", address: A.agent, name: "two" }];
    expect(activeAddress(host({ selectedWallet: { namespace: "evm", ref: { id: "b" } }, remoteWallets: wallets }))).toBe(getAddress(A.agent));
    expect(activeAddress(host({ selectedWallet: { namespace: "evm", ref: { address: A.owner.toLowerCase() } }, byokWallets: wallets }))).toBe(getAddress(A.owner));
    expect(activeAddress(host({ selectedWallet: { namespace: "evm", ref: { name: "two" } }, remoteWallets: wallets }))).toBe(getAddress(A.agent));
    expect(activeAddress(host({ selectedWallet: { namespace: "solana", ref: { id: "a" } }, remoteWallets: wallets }))).toBeUndefined();
    expect(activeAddress(host({ remoteWallets: wallets }))).toBeUndefined();
    expect(activeAddress(host({ remoteWallets: [wallets[0]] }))).toBe(getAddress(A.owner));
  });

  it("uses --from only as a fallback or a matching override for submits", () => {
    const empty = host({});
    expect(resolveWallet(empty, A.agent, true)).toBe(getAddress(A.agent));
    expect(code(() => resolveWallet(empty, undefined, false))).toBe("GAPLESS_NO_WALLET");
    const sel = host({ selectedWallet: { namespace: "evm", ref: { address: A.agent } } });
    expect(code(() => resolveWallet(sel, A.other, true))).toBe("GAPLESS_FROM_MISMATCH");
    expect(resolveWallet(sel, A.other, false)).toBe(getAddress(A.other));
  });
});

describe("deployment config", () => {
  const packaged = { manager: getAddress(A.manager), factory: getAddress(A.factory) };

  it("ships the canary addresses from deployments/143.json", () => {
    const dep = JSON.parse(readFileSync(new URL("../../deployments/143.json", import.meta.url), "utf8"));
    expect(DEPLOYMENT.chainId).toBe(dep.chainId);
    expect(DEPLOYMENT.CoverManager).toBe(dep.contracts.CoverManager.address);
    expect(DEPLOYMENT.GaplessFactory).toBe(dep.contracts.GaplessFactory.address);
    expect(packaged).toEqual({ manager: dep.contracts.CoverManager.address, factory: dep.contracts.GaplessFactory.address });
  });

  it("uses the packaged addresses and accepts only a matching env override", () => {
    expect(resolveDeployment({})).toEqual(packaged);
    expect(
      resolveDeployment({ GAPLESS_COVER_MANAGER_ADDRESS: A.manager.toLowerCase(), GAPLESS_FACTORY_ADDRESS: A.factory.toLowerCase() }),
    ).toEqual(packaged);
  });

  it("refuses an env address that differs from the packaged deployment", () => {
    expect(code(() => resolveDeployment({ GAPLESS_COVER_MANAGER_ADDRESS: A.other }))).toBe("GAPLESS_BAD_CONFIG");
    expect(code(() => resolveDeployment({ GAPLESS_FACTORY_ADDRESS: A.other }))).toBe("GAPLESS_BAD_CONFIG");
    expect(code(() => resolveDeployment({ GAPLESS_COVER_MANAGER_ADDRESS: "nope" }))).toBe("GAPLESS_BAD_CONFIG");
  });

  describe("without generated addresses", () => {
    afterEach(() => {
      vi.doUnmock("../src/addresses.js");
      vi.resetModules();
    });

    it("falls back to env and validates it", async () => {
      vi.resetModules();
      vi.doMock("../src/addresses.js", () => ({ DEPLOYMENT: { chainId: 143, CoverManager: null, GaplessFactory: null } }));
      const { resolveDeployment: resolve } = await import("../src/lib/config.js");
      expect(resolve({ GAPLESS_COVER_MANAGER_ADDRESS: A.other })).toEqual({ manager: getAddress(A.other), factory: null });
      expect(code(() => resolve({ GAPLESS_COVER_MANAGER_ADDRESS: "nope" }))).toBe("GAPLESS_BAD_CONFIG");
      expect(code(() => resolve({}))).toBe("GAPLESS_NOT_CONFIGURED");
    });
  });
});
