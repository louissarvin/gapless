import { CommandError } from "@metamask/agent-wallet/plugin";
import { encodeFunctionData, getAddress, zeroAddress } from "viem";
import { describe, expect, it } from "vitest";
import { ICoverManagerAbi, IGaplessAccountAbi } from "../src/abi/index.js";
import { gasLimit } from "../src/lib/submit.js";
import { runCancel } from "../src/ops/cancel.js";
import { runCover } from "../src/ops/cover.js";
import { runTrade } from "../src/ops/trade.js";
import { A, COVER_ID, callsTo, fakeHost, io, makeLog, Revert, TX_HASH, world } from "./helpers/fake.js";

const P = { perpId: 1n, isLong: true, lots: 22n, stopPNS: 840_000n, maxGapBps: 200, durationBlocks: 12_000 };
const BASE = { market: "BTC", side: "long", size: "0.00022", stop: "84000", account: A.account };
// ceil(bestAsk 852760 x 1.005) with the default 50 bps slippage
const LIMIT = 857_024n;
const DESC = {
  orderDescId: 0n, perpId: 1n, orderType: 0, orderId: 0n, pricePNS: LIMIT, lotLNS: 22n, expiryBlock: 0n, postOnly: false,
  fillOrKill: false, immediateOrCancel: true, maxMatches: 32n, leverageHdths: 500n, lastExecutionBlock: 0n, amountCNS: 0n,
  maxNegPnlCollatBPS: 300n,
};
// quote 29,770 x (1 + 200 bps), floored: 29,770 + 595
const MAX_PREMIUM = 30_365n;

async function rejects(p: Promise<unknown>, code: string) {
  const err = await p.then(() => undefined, (e: unknown) => e);
  expect(err).toBeInstanceOf(CommandError);
  expect((err as CommandError).code).toBe(code);
  return err as CommandError;
}

describe("gas rule", () => {
  it("is estimate x 1.2 rounded up", () => {
    expect(gasLimit(1_000_001n)).toBe(1_200_002n);
    expect(gasLimit(1_000_000n)).toBe(1_200_000n);
  });
});

describe("gapless:trade", () => {
  it("sends exactly one tradeAndCover request: calldata, chain 143, value 0, to the clone, gas and intent", async () => {
    const w = world({ receiptLogs: [coverBought()] });
    const { host, exec, walletExecutor, calls } = fakeHost(w);
    const out = await runTrade(host, io, BASE);

    expect(walletExecutor).toHaveBeenCalledTimes(1);
    expect(walletExecutor.mock.calls[0]?.[1]).toBe("gapless:trade");
    expect(exec).toHaveBeenCalledTimes(1);
    const req = exec.mock.calls[0]?.[0] as Record<string, any>;
    expect(req.kind).toBe("transaction");
    expect(req.chainId).toBe(143);
    expect(req.transaction).toEqual({
      to: getAddress(A.account),
      data: encodeFunctionData({ abi: IGaplessAccountAbi, functionName: "tradeAndCover", args: [DESC, P, MAX_PREMIUM] }),
      value: 0n,
      gas: 1_200_002n,
    });
    expect(req.intent.action).toBe("custom");
    expect(req.intent.summary).toContain("guaranteed stop at 84000");
    expect(req.intent.summary).toContain("0.030365 AUSD");

    expect(out).toMatchObject({
      submitted: true, hash: TX_HASH, coverId: COVER_ID, premiumCNS: "29770", maxPremiumCNS: "30365", limitPNS: "857024",
      role: "operator", explorerUrl: `https://monadvision.com/tx/${TX_HASH}`,
    });
    // probe priced with maxPremium 0 from the signing wallet
    const probe = encodeFunctionData({ abi: IGaplessAccountAbi, functionName: "tradeAndCover", args: [DESC, P, 0n] });
    expect(callsTo(calls, A.account)).toContain(probe);
    expect(calls.some((c) => c.method.startsWith("eth_send"))).toBe(false);
  });

  it("dry run simulates but never touches the executor", async () => {
    const { host, walletExecutor } = fakeHost(world());
    const out = await runTrade(host, io, { ...BASE, dryRun: true });
    expect(out).toMatchObject({ submitted: false, gasLimit: "1200002", maxPremiumCNS: "30365" });
    expect(walletExecutor).not.toHaveBeenCalled();
  });

  it("refuses when this wallet is not the operator", async () => {
    const { host, walletExecutor, calls } = fakeHost(world({ operator: { key: A.other, expiry: 1_760_014_400n, maxNotionalPerTradeCNS: 1n, maxNotionalPerDayCNS: 1n } }));
    const err = await rejects(runTrade(host, io, BASE), "GAPLESS_NOT_OPERATOR");
    expect(err.message).toContain(getAddress(A.other));
    expect(walletExecutor).not.toHaveBeenCalled();
    expect(calls.some((c) => c.method === "eth_estimateGas")).toBe(false);
  });

  it("refuses an expired operator grant", async () => {
    const { host, walletExecutor } = fakeHost(world({ operator: { key: A.agent, expiry: 1_759_999_999n, maxNotionalPerTradeCNS: 1n, maxNotionalPerDayCNS: 1n } }));
    const err = await rejects(runTrade(host, io, BASE), "GAPLESS_NOT_OPERATOR");
    expect(err.message).toContain("expired");
    expect(walletExecutor).not.toHaveBeenCalled();
  });

  it("does not submit when the simulation reverts, and names the custom error", async () => {
    const w = world({ writeRevert: new Revert(IGaplessAccountAbi, "OperatorBudgetExceeded", [18_480_000n, 5_000_000n]) });
    const { host, walletExecutor } = fakeHost(w);
    const err = await rejects(runTrade(host, io, BASE), "GAPLESS_OPERATOR_BUDGET_EXCEEDED");
    expect(err.message).toContain("OperatorBudgetExceeded(notionalCNS=18480000, availableCNS=5000000)");
    expect(walletExecutor).not.toHaveBeenCalled();
  });

  it("enforces the 500 bps limit band around mark before simulating", async () => {
    const { host, walletExecutor, calls } = fakeHost(world());
    await rejects(runTrade(host, io, { ...BASE, limit: "89600" }), "GAPLESS_LIMIT_OFF_MARKET");
    expect(walletExecutor).not.toHaveBeenCalled();
    expect(callsTo(calls, A.account).some((d) => d.startsWith(encodeFunctionData({ abi: IGaplessAccountAbi, functionName: "tradeAndCover", args: [DESC, P, 0n] }).slice(0, 10)))).toBe(false);
  });

  it("caps --max-premium-bps at 1000", async () => {
    const { host } = fakeHost(world());
    await rejects(runTrade(host, io, { ...BASE, maxPremiumBps: "1001" }), "GAPLESS_BAD_INPUT");
  });

  it("surfaces a pending 2FA job without retrying", async () => {
    const pending = Object.assign(new Error("timed out"), { pendingJob: { pollingId: "poll-1" } });
    const { host, exec } = fakeHost(world(), { exec: async () => { throw pending; } });
    const err = await rejects(runTrade(host, io, BASE), "GAPLESS_PENDING");
    expect(err.hint).toContain("mm wallet requests watch poll-1");
    expect(exec).toHaveBeenCalledTimes(1);
  });

  it("returns the pollingId when the executor has no hash yet", async () => {
    const { host, calls } = fakeHost(world(), { exec: async () => ({ kind: "transaction", hash: "", status: "AWAITING_MFA", pendingJob: { pollingId: "p2" } }) });
    const out = await runTrade(host, io, BASE);
    expect(out).toMatchObject({ submitted: true, hash: null, pollingId: "p2", status: "AWAITING_MFA", coverId: null });
    expect(calls.some((c) => c.method === "eth_getTransactionReceipt")).toBe(false);
  });

  it("fails loudly on an onchain revert", async () => {
    const { host } = fakeHost(world({ receiptStatus: "0x0" }));
    await rejects(runTrade(host, io, BASE), "GAPLESS_TX_REVERTED");
  });

  it("refuses --from that differs from the active wallet", async () => {
    const { host, walletExecutor } = fakeHost(world());
    await rejects(runTrade(host, io, { ...BASE, from: A.other }), "GAPLESS_FROM_MISMATCH");
    expect(walletExecutor).not.toHaveBeenCalled();
  });

  it("refuses an address that is not a factory clone", async () => {
    const { host } = fakeHost(world());
    await rejects(runTrade(host, io, { ...BASE, account: A.other }), "GAPLESS_NO_ACCOUNT");
  });

  it("refuses a chain other than 143", async () => {
    const { host } = fakeHost(world({ chainId: 1 }));
    await rejects(runTrade(host, io, BASE), "GAPLESS_WRONG_CHAIN");
  });
});

describe("gapless:cover", () => {
  it("buys cover with maxPremium = quote x 1.02 on the existing position", async () => {
    const { host, exec } = fakeHost(world({ receiptLogs: [coverBought()] }));
    const out = await runCover(host, io, BASE);
    const req = exec.mock.calls[0]?.[0] as Record<string, any>;
    expect(req.transaction.data).toBe(encodeFunctionData({ abi: IGaplessAccountAbi, functionName: "buyCover", args: [P, MAX_PREMIUM] }));
    expect(req.transaction.to).toBe(getAddress(A.account));
    expect(req.transaction.value).toBe(0n);
    expect(req.chainId).toBe(143);
    expect(out).toMatchObject({ coverId: COVER_ID, escrowCNS: "9770", rentCNS: "20000", capCNS: "369600", premiumAUSD: "0.02977" });
  });

  it("maps quote reverts such as StopTooClose", async () => {
    const { host, walletExecutor } = fakeHost(world({ quoteRevert: new Revert(ICoverManagerAbi, "StopTooClose", [5n, 60n]) }));
    const err = await rejects(runCover(host, io, BASE), "GAPLESS_STOP_TOO_CLOSE");
    expect(err.message).toContain("StopTooClose(distanceBps=5, minBps=60)");
    expect(walletExecutor).not.toHaveBeenCalled();
  });

  it("maps SigmaStale and CoverShareExceeded", async () => {
    for (const [name, args, code] of [
      ["SigmaStale", [123n], "GAPLESS_SIGMA_STALE"],
      ["CoverShareExceeded", [400_000n, 300_000n], "GAPLESS_COVER_SHARE_EXCEEDED"],
    ] as const) {
      const { host } = fakeHost(world({ quoteRevert: new Revert(ICoverManagerAbi, name, args) }));
      await rejects(runCover(host, io, BASE), code);
    }
  });
});

describe("gapless:cancel", () => {
  it("cancels the active cover on a market and reports the refund", async () => {
    const logs = [
      makeLog(A.manager, ICoverManagerAbi, "CoverEnded", { coverId: COVER_ID, status: 5, reason: 1, refundCNS: 9_770n }),
    ];
    const { host, exec } = fakeHost(world({ activeCover: COVER_ID, receiptLogs: logs }));
    const out = await runCancel(host, io, { market: "1", account: A.account });
    const req = exec.mock.calls[0]?.[0] as Record<string, any>;
    expect(req.transaction.data).toBe(encodeFunctionData({ abi: IGaplessAccountAbi, functionName: "cancelCover", args: [COVER_ID] }));
    expect(req.transaction.to).toBe(getAddress(A.account));
    expect(out).toMatchObject({ endStatus: "Cancelled", endReason: "OwnerCancel", refundCNS: "9770", escrowForfeitedCNS: "0" });
  });

  it("works for an operator with zero daily budget", async () => {
    const { host, exec } = fakeHost(world({ usage: [100_000_000n, 0n] }));
    await runCancel(host, io, { coverId: COVER_ID, account: A.account });
    expect(exec).toHaveBeenCalledTimes(1);
  });

  it("refuses a cover owned by another account", async () => {
    const { host, walletExecutor } = fakeHost(world({ cover: { account: A.other, status: 1 } }));
    await rejects(runCancel(host, io, { coverId: COVER_ID, account: A.account }), "GAPLESS_NOT_YOUR_COVER");
    expect(walletExecutor).not.toHaveBeenCalled();
  });

  it("refuses a triggered cover", async () => {
    const { host } = fakeHost(world({ cover: { account: A.account, status: 3 } }));
    await rejects(runCancel(host, io, { coverId: COVER_ID, account: A.account }), "GAPLESS_COVER_NOT_LIVE");
  });
});

function coverBought() {
  return makeLog(A.manager, ICoverManagerAbi, "CoverBought", {
    coverId: COVER_ID, account: A.account, perpId: 1n, isLong: true, lots: 22n, stopPNS: 840_000n, maxGapBps: 200n,
    escrowCNS: 9_770n, rentCNS: 20_000n, capCNS: 369_600n, expiryBlock: 1_012_000n,
  });
}

it("unknown operator key reads as nobody", async () => {
  const { host } = fakeHost(world({ operator: { key: zeroAddress, expiry: 0n, maxNotionalPerTradeCNS: 0n, maxNotionalPerDayCNS: 0n } }));
  const err = await rejects(runCover(host, io, BASE), "GAPLESS_NOT_OPERATOR");
  expect(err.message).toContain("nobody");
});
