import type { CommandIO } from "@metamask/agent-wallet/plugin";
import { encodeFunctionData, getAddress, type Hex, zeroHash } from "viem";
import { ICoverManagerAbi, IGaplessAccountAbi } from "../abi/index.js";
import { type AccountSel, authorize, connect, read, resolveAccount, resolveMarket } from "../lib/chain.js";
import { fail } from "../lib/errors.js";
import { type Host, resolveWallet } from "../lib/host.js";
import { findEvent, prepareTx, submitTx } from "../lib/submit.js";
import { cns, parseBytes32 } from "../lib/units.js";
import { STATUS, END_REASON } from "./status.js";

export type CancelInputs = AccountSel & { coverId?: string; market?: string; from?: string; dryRun?: boolean };

/** account.cancelCover on a Live (or Armed) cover; operators may cancel with a zero budget (SA3-I5). */
export async function runCancel(host: Host, io: CommandIO, r: CancelInputs) {
  const g = await connect(host);
  const wallet = resolveWallet(host, r.from, true);
  const account = await resolveAccount(g, r, wallet);
  const grant = await authorize(g, account, wallet);

  let coverId: Hex;
  if (r.coverId?.trim()) {
    coverId = parseBytes32(r.coverId, "cover-id");
  } else if (r.market?.trim()) {
    const m = await resolveMarket(g, r.market);
    coverId = await read("activeCoverOf", () =>
      g.client.readContract({ address: g.manager, abi: ICoverManagerAbi, functionName: "activeCoverOf", args: [account, m.perpId] }),
    );
    if (coverId === zeroHash) fail("GAPLESS_NO_COVER", `No active cover on market ${m.symbol}.`, "Run gapless:status to list covers.");
  } else {
    return fail("GAPLESS_BAD_INPUT", "Pass the cover id or --market.", "Run gapless:status to find the cover id.");
  }

  const c = await read("getCover", () =>
    g.client.readContract({ address: g.manager, abi: ICoverManagerAbi, functionName: "getCover", args: [coverId] }),
  );
  if (c.status === 0 || getAddress(c.account) !== account) {
    fail("GAPLESS_NOT_YOUR_COVER", `Cover ${coverId} does not belong to ${account}.`, "Run gapless:status for this account's covers.");
  }
  if (c.status !== 1 && c.status !== 2) {
    fail("GAPLESS_COVER_NOT_LIVE", `Cover ${coverId} is ${STATUS[c.status] ?? c.status}; only Live covers can be cancelled.`, "Triggered covers settle on their own; check gapless:status.");
  }

  const data = encodeFunctionData({ abi: IGaplessAccountAbi, functionName: "cancelCover", args: [coverId] });
  const tx = await prepareTx(g, io, { from: wallet, to: account, data, action: "cancelCover" });
  const plan = { account, wallet, role: grant.role, coverId, perpId: String(c.perpId), status: STATUS[c.status], to: account, gasLimit: tx.gas.toString() };
  if (r.dryRun) return { submitted: false as const, ...plan };

  const summary = `Gapless: cancel cover ${coverId.slice(0, 10)} on perp ${c.perpId}; rent is kept, escrow is refunded only away from the stop`;
  const sent = await submitTx(host, io, g, "gapless:cancel", tx, summary);
  const ended = sent.receipt ? findEvent(sent.receipt.logs, g.manager, ICoverManagerAbi, "CoverEnded") : undefined;
  const forfeit = sent.receipt ? findEvent(sent.receipt.logs, g.manager, ICoverManagerAbi, "EscrowForfeited") : undefined;
  return {
    submitted: true as const,
    ...plan,
    hash: sent.hash,
    status: sent.status,
    explorerUrl: sent.explorerUrl,
    pollingId: sent.pollingId,
    endStatus: ended ? STATUS[Number(ended.status)] ?? null : null,
    endReason: ended ? END_REASON[Number(ended.reason)] ?? null : null,
    ...cns("refund", (ended?.refundCNS as bigint | undefined) ?? 0n),
    ...cns("escrowForfeited", (forfeit?.amountCNS as bigint | undefined) ?? 0n),
  };
}
