import type { CommandIO } from "@metamask/agent-wallet/plugin";
import { type AccountSel, connect, notOperator, readGrant, resolveAccount } from "../lib/chain.js";
import { type Host, resolveWallet } from "../lib/host.js";
import { cns } from "../lib/units.js";

export type GrantInputs = AccountSel & { from?: string };

/** Operator grant and budget; exits with GAPLESS_NOT_OPERATOR when this wallet cannot act for the account. */
export async function runGrant(host: Host, _io: CommandIO, r: GrantInputs) {
  const g = await connect(host);
  const wallet = resolveWallet(host, r.from, false);
  const account = await resolveAccount(g, r, wallet);
  const grant = await readGrant(g, account, wallet);
  if (grant.role === "none") throw notOperator(grant, account, wallet);
  return {
    account,
    wallet,
    role: grant.role,
    owner: grant.owner,
    operator: grant.key,
    expiry: grant.expiry.toString(),
    expiresAt: new Date(Number(grant.expiry) * 1000).toISOString(),
    expiresInSec: (grant.expiry > grant.now ? grant.expiry - grant.now : 0n).toString(),
    ...cns("maxPerTrade", grant.maxPerTrade),
    ...cns("maxPerDay", grant.maxPerDay),
    ...cns("usedToday", grant.used),
    ...cns("available", grant.available),
    opNonce: grant.opNonce.toString(),
    perplAccountId: grant.perplAccountId.toString(),
    perplActive: grant.perplAccountId !== 0n,
  };
}
