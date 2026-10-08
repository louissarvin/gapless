import type { CommandIO } from "@metamask/agent-wallet/plugin";
import { type Address, encodeFunctionData, getAddress } from "viem";
import { IGaplessAccountAbi } from "../abi/index.js";
import { type AccountSel, connect, type Gapless, read, readGrant, resolveAccount } from "../lib/chain.js";
import { CHAIN_ID, DEFAULTS } from "../lib/config.js";
import { fail } from "../lib/errors.js";
import { type Host, resolveWallet } from "../lib/host.js";
import { findEvent, prepareTx, submitTx } from "../lib/submit.js";
import { ausd, parseDecimal, parseSignature, parseTime } from "../lib/units.js";

export type LinkInputs = AccountSel & {
  from?: string;
  maxPerTrade?: string;
  maxPerDay?: string;
  expiry?: string;
  deadline?: string;
  sig?: string;
  dryRun?: boolean;
};

const MAX_GRANT_SEC = 30n * 86_400n;

/** IGaplessAccount: keccak256("SetOperator(address account,address key,uint64 expiry,uint128 maxNotional,uint128 maxNotionalPerDay,uint256 nonce,uint256 deadline)") */
export const SET_OPERATOR_TYPES = {
  EIP712Domain: [
    { name: "name", type: "string" },
    { name: "version", type: "string" },
    { name: "chainId", type: "uint256" },
    { name: "verifyingContract", type: "address" },
  ],
  SetOperator: [
    { name: "account", type: "address" },
    { name: "key", type: "address" },
    { name: "expiry", type: "uint64" },
    { name: "maxNotional", type: "uint128" },
    { name: "maxNotionalPerDay", type: "uint128" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
} as const;

async function domainOf(g: Gapless, account: Address) {
  const [, name, version, chainId, verifyingContract] = await read("account eip712Domain", () =>
    g.client.readContract({ address: account, abi: IGaplessAccountAbi, functionName: "eip712Domain" }),
  );
  if (name !== "GaplessAccount" || version !== "1" || chainId !== BigInt(CHAIN_ID) || getAddress(verifyingContract) !== account) {
    fail("GAPLESS_DOMAIN_MISMATCH", `${account} reports an unexpected EIP-712 domain.`, "Do not sign; verify the account address.");
  }
  return { name, version, chainId: CHAIN_ID, verifyingContract: account };
}

/**
 * Without a signature: prints the SetOperator typed data the owner must sign (key = this wallet).
 * With one: submits setOperatorWithSig through Agent Wallet, then checks operator().key == this wallet.
 */
export async function runLink(host: Host, io: CommandIO, r: LinkInputs) {
  const sig = r.sig?.trim() ? parseSignature(r.sig) : undefined;
  const g = await connect(host);
  const wallet = resolveWallet(host, r.from, sig !== undefined);
  const account = await resolveAccount(g, r, wallet);
  const before = await readGrant(g, account, wallet);
  const now = before.now;

  const expiry = parseTime(r.expiry ?? DEFAULTS.expiry, "expiry", now, !sig);
  const deadline = parseTime(r.deadline ?? DEFAULTS.deadline, "deadline", now, !sig);
  if (expiry <= now || expiry > now + MAX_GRANT_SEC) fail("GAPLESS_BAD_INPUT", "--expiry must be in the future and at most 30 days out.", "Use e.g. --expiry +4h");
  if (deadline <= now) fail("GAPLESS_BAD_INPUT", "--deadline has passed.", "Ask the owner to sign a fresh grant.");
  const grant = {
    key: wallet,
    expiry,
    maxNotionalPerTradeCNS: parseDecimal(r.maxPerTrade ?? DEFAULTS.maxPerTrade, 6, "max-per-trade"),
    maxNotionalPerDayCNS: parseDecimal(r.maxPerDay ?? DEFAULTS.maxPerDay, 6, "max-per-day"),
  };
  const domain = await domainOf(g, account);
  const message = {
    account,
    key: wallet,
    expiry: expiry.toString(),
    maxNotional: grant.maxNotionalPerTradeCNS.toString(),
    maxNotionalPerDay: grant.maxNotionalPerDayCNS.toString(),
    nonce: before.opNonce.toString(),
    deadline: deadline.toString(),
  };
  const summaryFields = {
    account,
    owner: before.owner,
    operator: wallet,
    expiry: expiry.toString(),
    expiresAt: new Date(Number(expiry) * 1000).toISOString(),
    deadline: deadline.toString(),
    maxPerTradeAUSD: ausd(grant.maxNotionalPerTradeCNS),
    maxPerDayAUSD: ausd(grant.maxNotionalPerDayCNS),
    nonce: message.nonce,
  };

  if (!sig) {
    return {
      mode: "unsigned" as const,
      ...summaryFields,
      signer: before.owner,
      typedData: { domain, types: SET_OPERATOR_TYPES, primaryType: "SetOperator", message },
      next: `mm gapless link --account ${account} --expiry ${expiry} --deadline ${deadline} --max-per-trade ${ausd(grant.maxNotionalPerTradeCNS)} --max-per-day ${ausd(grant.maxNotionalPerDayCNS)} --sig <owner signature>`,
    };
  }

  const data = encodeFunctionData({ abi: IGaplessAccountAbi, functionName: "setOperatorWithSig", args: [grant, deadline, sig] });
  const tx = await prepareTx(g, io, { from: wallet, to: account, data, action: "setOperatorWithSig" });
  if (r.dryRun) return { mode: "signed" as const, submitted: false as const, ...summaryFields, to: account, gasLimit: tx.gas.toString() };

  const summary = `Gapless: make ${wallet} the operator of ${account} until ${summaryFields.expiresAt} (per trade ${summaryFields.maxPerTradeAUSD} AUSD, per day ${summaryFields.maxPerDayAUSD} AUSD, no withdrawals)`;
  const sent = await submitTx(host, io, g, "gapless:link", tx, summary);
  const ev = sent.receipt ? findEvent(sent.receipt.logs, account, IGaplessAccountAbi, "OperatorSet") : undefined;
  const after = sent.receipt ? await readGrant(g, account, wallet) : null;
  return {
    mode: "signed" as const,
    submitted: true as const,
    ...summaryFields,
    hash: sent.hash,
    status: sent.status,
    explorerUrl: sent.explorerUrl,
    pollingId: sent.pollingId,
    operatorSet: ev ? getAddress(ev.key as Address) === wallet : null,
    role: after?.role ?? null,
  };
}
