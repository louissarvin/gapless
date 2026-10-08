import type { CommandIO } from "@metamask/agent-wallet/plugin";
import { encodeFunctionData, getAddress, zeroAddress } from "viem";
import { IAUSDAbi, IGaplessFactoryAbi } from "../abi/index.js";
import { connect, read } from "../lib/chain.js";
import { fail } from "../lib/errors.js";
import { type Host, resolveWallet } from "../lib/host.js";
import { findEvent, prepareTx, submitTx } from "../lib/submit.js";
import { ausd, cns, parseDecimal } from "../lib/units.js";

export type AccountInputs = { from?: string; deposit?: string; dryRun?: boolean };

const NO_GRANT = { key: zeroAddress, expiry: 0n, maxNotionalPerTradeCNS: 0n, maxNotionalPerDayCNS: 0n } as const;

/** Owner mode: exact AUSD approve(factory, deposit) if needed, then factory.createAccount(deposit, no operator). */
export async function runAccount(host: Host, io: CommandIO, r: AccountInputs) {
  const g = await connect(host);
  const wallet = resolveWallet(host, r.from, true);
  const deposit = parseDecimal(r.deposit ?? "0", 6, "deposit");
  const f = { address: g.factory, abi: IGaplessFactoryAbi } as const;
  const predicted = await read("factory.accountOf", () => g.client.readContract({ ...f, functionName: "accountOf", args: [wallet] }));
  const deployed = await read("factory.isAccount", () => g.client.readContract({ ...f, functionName: "isAccount", args: [predicted] }));
  if (deployed) return { submitted: false as const, existed: true, account: getAddress(predicted), owner: wallet };

  const u = { address: g.ausd, abi: IAUSDAbi } as const;
  const [balance, allowance] = await read("AUSD balance", () =>
    Promise.all([
      g.client.readContract({ ...u, functionName: "balanceOf", args: [wallet] }),
      g.client.readContract({ ...u, functionName: "allowance", args: [wallet, g.factory] }),
    ]),
  );
  if (balance < deposit) fail("GAPLESS_INSUFFICIENT_AUSD", `Wallet holds ${ausd(balance)} AUSD, deposit needs ${ausd(deposit)}.`, "Fund the Agent Wallet with AUSD on Monad first.");
  const needsApprove = deposit > 0n && allowance < deposit;
  const plan = { existed: false, account: getAddress(predicted), owner: wallet, ...cns("deposit", deposit), needsApprove };

  const approveData = encodeFunctionData({ abi: IAUSDAbi, functionName: "approve", args: [g.factory, deposit] });
  const createData = encodeFunctionData({ abi: IGaplessFactoryAbi, functionName: "createAccount", args: [deposit, NO_GRANT] });
  if (r.dryRun) {
    // createAccount can only be simulated once the allowance exists.
    const step = needsApprove
      ? await prepareTx(g, io, { from: wallet, to: g.ausd, data: approveData, action: "AUSD approve" })
      : await prepareTx(g, io, { from: wallet, to: g.factory, data: createData, action: "createAccount" });
    return { submitted: false as const, ...plan, firstStep: needsApprove ? "approve" : "createAccount", gasLimit: step.gas.toString() };
  }

  let approveHash: string | null = null;
  if (needsApprove) {
    const atx = await prepareTx(g, io, { from: wallet, to: g.ausd, data: approveData, action: "AUSD approve" });
    const sent = await submitTx(host, io, g, "gapless:account", atx, `Gapless: approve exactly ${ausd(deposit)} AUSD to the GaplessFactory for the account deposit`);
    if (!sent.receipt) {
      return { submitted: true as const, ...plan, step: "approve", hash: sent.hash, status: sent.status, explorerUrl: sent.explorerUrl, pollingId: sent.pollingId };
    }
    approveHash = sent.hash;
  }
  const ctx = await prepareTx(g, io, { from: wallet, to: g.factory, data: createData, action: "createAccount" });
  const sent = await submitTx(host, io, g, "gapless:account", ctx, `Gapless: create your GaplessAccount with a ${ausd(deposit)} AUSD deposit (no operator)`);
  const ev = sent.receipt ? findEvent(sent.receipt.logs, g.factory, IGaplessFactoryAbi, "AccountCreated") : undefined;
  return {
    submitted: true as const,
    ...plan,
    step: "createAccount",
    approveHash,
    hash: sent.hash,
    status: sent.status,
    explorerUrl: sent.explorerUrl,
    pollingId: sent.pollingId,
    created: ev ? getAddress(ev.account as string) : null,
  };
}
