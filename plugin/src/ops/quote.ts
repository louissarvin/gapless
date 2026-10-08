import { CommandError, type CommandIO } from "@metamask/agent-wallet/plugin";
import { ICoverManagerAbi, IGaplessAccountAbi } from "../abi/index.js";
import { type AccountSel, connect, read, resolveAccount, resolveMarket } from "../lib/chain.js";
import { DEFAULTS } from "../lib/config.js";
import {
  capOf,
  coverParams,
  describe,
  maxPremium,
  openDesc,
  openLimit,
  type PositionInputs,
  probeOpenPremium,
  quoteExisting,
} from "../lib/cover.js";
import { type Host, resolveWallet } from "../lib/host.js";
import { cns, price } from "../lib/units.js";

export type QuoteInputs = AccountSel &
  PositionInputs & {
    market?: string;
    from?: string;
    open?: boolean;
    limit?: string;
    slippageBps?: string;
    leverage?: string;
    maxPremiumBps?: string;
  };

export async function runQuote(host: Host, io: CommandIO, r: QuoteInputs) {
  const g = await connect(host);
  const wallet = resolveWallet(host, r.from, false);
  const account = await resolveAccount(g, r, wallet);
  const m = await resolveMarket(g, r.market);
  const p = coverParams(m, r);
  const params = await read("marketParams", () =>
    g.client.readContract({ address: g.manager, abi: ICoverManagerAbi, functionName: "marketParams", args: [m.perpId] }),
  );
  const bps = r.maxPremiumBps ?? DEFAULTS.maxPremiumBps;
  const common = { account, ...describe(m, p), warmupBlocks: params.warmupBlocks, maxPremiumBps: Number(bps) };

  if (r.open) {
    // Priced as the owner (never budget-limited), so this works before the agent is linked.
    const owner = await read("account owner", () =>
      g.client.readContract({ address: account, abi: IGaplessAccountAbi, functionName: "owner" }),
    );
    const limit = openLimit(m, p.isLong, r);
    const need = await probeOpenPremium(g, owner, account, openDesc(p, limit, r.leverage), p);
    const { notionalCNS, capCNS } = capOf(p, m.scale);
    return {
      mode: "open" as const,
      ...common,
      limitPNS: limit.toString(),
      limit: price(limit, m.priceDecimals),
      ...cns("premium", need),
      ...cns("maxPremium", maxPremium(need, bps)),
      ...cns("cap", capCNS),
      ...cns("notional", notionalCNS),
    };
  }

  let q;
  try {
    q = await quoteExisting(g, account, p);
  } catch (err) {
    if (err instanceof CommandError && err.code === "GAPLESS_LOTS_EXCEED_POSITION") {
      throw new CommandError(err.code, err.message, "No matching open position. Add --open to price opening it with the cover, or use gapless:trade --dry-run.");
    }
    throw err;
  }
  const need = q.escrowCNS + q.rentCNS;
  return {
    mode: "existing" as const,
    ...common,
    ...cns("premium", need),
    ...cns("maxPremium", maxPremium(need, bps)),
    ...cns("escrow", q.escrowCNS),
    ...cns("rent", q.rentCNS),
    ...cns("cap", q.capCNS),
    ...cns("notional", q.notionalCNS),
    feeBpsE2: q.feeBpsE2.toString(),
    utilAfterBps: q.utilAfterBps.toString(),
    distanceBps: q.distanceBps.toString(),
    minDistanceBps: q.minDistanceBps.toString(),
    expiryBlock: q.expiryBlock.toString(),
  };
}
