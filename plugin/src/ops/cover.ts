import type { CommandIO } from "@metamask/agent-wallet/plugin";
import { encodeFunctionData } from "viem";
import { ICoverManagerAbi, IGaplessAccountAbi } from "../abi/index.js";
import { type AccountSel, authorize, connect, resolveAccount, resolveMarket } from "../lib/chain.js";
import { coverParams, describe, maxPremium, type PositionInputs, quoteExisting } from "../lib/cover.js";
import { type Host, resolveWallet } from "../lib/host.js";
import { findEvent, prepareTx, submitTx } from "../lib/submit.js";
import { cns } from "../lib/units.js";

export type CoverInputs = AccountSel & PositionInputs & { market?: string; from?: string; maxPremiumBps?: string; dryRun?: boolean };

/** account.buyCover on an existing position; premium comes from the account's own AUSD. */
export async function runCover(host: Host, io: CommandIO, r: CoverInputs) {
  const g = await connect(host);
  const wallet = resolveWallet(host, r.from, true);
  const account = await resolveAccount(g, r, wallet);
  const grant = await authorize(g, account, wallet);
  const m = await resolveMarket(g, r.market);
  const p = coverParams(m, r);

  const q = await quoteExisting(g, account, p);
  const need = q.escrowCNS + q.rentCNS;
  const maxPrem = maxPremium(need, r.maxPremiumBps);
  const data = encodeFunctionData({ abi: IGaplessAccountAbi, functionName: "buyCover", args: [p, maxPrem] });
  const tx = await prepareTx(g, io, { from: wallet, to: account, data, action: "buyCover" });

  const d = describe(m, p);
  const plan = {
    account,
    wallet,
    role: grant.role,
    ...d,
    ...cns("premium", need),
    ...cns("maxPremium", maxPrem),
    ...cns("escrow", q.escrowCNS),
    ...cns("rent", q.rentCNS),
    ...cns("cap", q.capCNS),
    minDistanceBps: q.minDistanceBps.toString(),
    expiryBlock: q.expiryBlock.toString(),
    to: account,
    gasLimit: tx.gas.toString(),
  };
  if (r.dryRun) return { submitted: false as const, ...plan };

  const summary = `Gapless: guarantee the ${d.market} ${d.side} stop at ${d.stop} for ${d.size}, premium at most ${plan.maxPremiumAUSD} AUSD`;
  const sent = await submitTx(host, io, g, "gapless:cover", tx, summary);
  const ev = sent.receipt ? findEvent(sent.receipt.logs, g.manager, ICoverManagerAbi, "CoverBought") : undefined;
  return {
    submitted: true as const,
    ...plan,
    hash: sent.hash,
    status: sent.status,
    explorerUrl: sent.explorerUrl,
    pollingId: sent.pollingId,
    coverId: (ev?.coverId as string | undefined) ?? null,
  };
}
