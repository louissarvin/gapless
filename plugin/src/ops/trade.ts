import type { CommandIO } from "@metamask/agent-wallet/plugin";
import { encodeFunctionData } from "viem";
import { ICoverManagerAbi, IGaplessAccountAbi } from "../abi/index.js";
import { type AccountSel, authorize, connect, resolveAccount, resolveMarket } from "../lib/chain.js";
import { capOf, coverParams, describe, maxPremium, openDesc, openLimit, type PositionInputs, probeOpenPremium } from "../lib/cover.js";
import { type Host, resolveWallet } from "../lib/host.js";
import { findEvent, prepareTx, submitTx } from "../lib/submit.js";
import { cns, price } from "../lib/units.js";

export type TradeInputs = AccountSel &
  PositionInputs & {
    market?: string;
    from?: string;
    limit?: string;
    slippageBps?: string;
    leverage?: string;
    maxPremiumBps?: string;
    dryRun?: boolean;
  };

/** account.tradeAndCover: IOC open within 500 bps of mark plus a guaranteed stop, one Agent Wallet tx. */
export async function runTrade(host: Host, io: CommandIO, r: TradeInputs) {
  const g = await connect(host);
  const wallet = resolveWallet(host, r.from, true);
  const account = await resolveAccount(g, r, wallet);
  const grant = await authorize(g, account, wallet);
  const m = await resolveMarket(g, r.market);
  const p = coverParams(m, r);
  const limit = openLimit(m, p.isLong, r);
  const desc = openDesc(p, limit, r.leverage);

  const need = await probeOpenPremium(g, wallet, account, desc, p);
  const maxPrem = maxPremium(need, r.maxPremiumBps);
  const data = encodeFunctionData({ abi: IGaplessAccountAbi, functionName: "tradeAndCover", args: [desc, p, maxPrem] });
  const tx = await prepareTx(g, io, { from: wallet, to: account, data, action: "tradeAndCover" });

  const d = describe(m, p);
  const plan = {
    account,
    wallet,
    role: grant.role,
    ...d,
    limitPNS: limit.toString(),
    limit: price(limit, m.priceDecimals),
    leverageHdths: desc.leverageHdths.toString(),
    ...cns("premium", need),
    ...cns("maxPremium", maxPrem),
    ...cns("cap", capOf(p, m.scale).capCNS),
    to: account,
    gasLimit: tx.gas.toString(),
  };
  if (r.dryRun) return { submitted: false as const, ...plan };

  const summary = `Gapless: open ${d.market} ${d.side} ${d.size} at limit ${plan.limit} with a guaranteed stop at ${d.stop}, premium at most ${plan.maxPremiumAUSD} AUSD`;
  const sent = await submitTx(host, io, g, "gapless:trade", tx, summary);
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
