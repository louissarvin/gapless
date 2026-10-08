import type { CommandIO } from "@metamask/agent-wallet/plugin";
import { type Address, zeroAddress, zeroHash } from "viem";
import { ICoverManagerAbi } from "../abi/index.js";
import { type AccountSel, connect, type Gapless, read, readGrant, resolveAccount, resolveMarket } from "../lib/chain.js";
import { fail } from "../lib/errors.js";
import { type Host, resolveWallet } from "../lib/host.js";
import { cns, price } from "../lib/units.js";

export const STATUS = ["None", "Live", "Armed", "Triggered", "Finalized", "Cancelled", "Expired", "Voided"] as const;
export const END_REASON = ["None", "OwnerCancel", "Expired", "PositionReduced", "PositionClosedOrFlipped", "LiquidatedOrAdl"] as const;

export type StatusInputs = AccountSel & { market?: string; from?: string; graphql?: string };

export async function runStatus(host: Host, io: CommandIO, r: StatusInputs) {
  const g = await connect(host);
  const wallet = resolveWallet(host, r.from, false);
  const account = await resolveAccount(g, r, wallet);
  const [grant, blockNumber, refundOwed] = await Promise.all([
    readGrant(g, account, wallet),
    read("blockNumber", () => g.client.getBlockNumber()),
    read("refundOwed", () => g.client.readContract({ address: g.manager, abi: ICoverManagerAbi, functionName: "refundOwed", args: [account] })),
  ]);
  const perps = r.market?.trim()
    ? [(await resolveMarket(g, r.market)).perpId]
    : await read("listedPerps", () => g.client.readContract({ address: g.manager, abi: ICoverManagerAbi, functionName: "listedPerps" }));

  const covers = (await Promise.all(perps.map((id) => coverOn(g, account, id, blockNumber)))).filter((c) => c !== null);
  const history = r.graphql?.trim() ? await fetchHistory(r.graphql.trim(), account, io.signal) : null;
  return {
    account,
    wallet,
    role: grant.role,
    owner: grant.owner,
    operator: grant.key === zeroAddress ? null : grant.key,
    operatorExpiresAt: grant.key === zeroAddress ? null : new Date(Number(grant.expiry) * 1000).toISOString(),
    blockNumber: blockNumber.toString(),
    listedPerps: perps.map(String),
    covers,
    ...cns("refundOwed", refundOwed),
    history,
  };
}

async function coverOn(g: Gapless, account: Address, perpId: bigint, blockNumber: bigint) {
  const m = { address: g.manager, abi: ICoverManagerAbi } as const;
  const id = await read("activeCoverOf", () => g.client.readContract({ ...m, functionName: "activeCoverOf", args: [account, perpId] }));
  if (id === zeroHash) return null;
  const [c, locked, cfg] = await read("cover state", () =>
    Promise.all([
      g.client.readContract({ ...m, functionName: "getCover", args: [id] }),
      g.client.readContract({ ...m, functionName: "isLocked", args: [account, perpId] }),
      g.client.readContract({ ...m, functionName: "marketConfig", args: [perpId] }),
    ]),
  );
  return {
    coverId: id,
    perpId: perpId.toString(),
    status: STATUS[c.status] ?? String(c.status),
    side: c.isLong ? "long" : "short",
    lots: c.lots.toString(),
    size: price(BigInt(c.lots), cfg.lotDecimals),
    stop: price(BigInt(c.stopPNS), cfg.priceDecimals),
    maxGapBps: c.maxGapBps,
    locked,
    startBlock: c.startBlock.toString(),
    expiryBlock: c.expiryBlock.toString(),
    blocksLeft: (BigInt(c.expiryBlock) > blockNumber ? BigInt(c.expiryBlock) - blockNumber : 0n).toString(),
    armedBlock: c.armedBlock.toString(),
    triggerBlock: c.triggerBlock.toString(),
    filledLots: c.filledLots.toString(),
    ...cns("cap", c.capCNS),
    ...cns("escrow", c.escrowCNS),
    ...cns("rent", c.rentCNS),
    ...cns("paid", c.paidCNS),
    ...cns("owed", c.owedCNS),
  };
}

const HISTORY_QUERY = "query($a:String!){Cover(where:{account:{_eq:$a}},limit:50){id status perpId stopPNS lots paidCNS}}";
const HISTORY_FIELDS = ["id", "status", "perpId", "stopPNS", "lots", "paidCNS"] as const;
const MAX_BODY = 512 * 1024;

async function readCapped(res: Response): Promise<string | null> {
  const reader = res.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** Untrusted rows: keep known scalar fields only, short strings, so nothing else reaches the agent. */
function cleanRow(row: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!row || typeof row !== "object") return out;
  for (const k of HISTORY_FIELDS) {
    const v = (row as Record<string, unknown>)[k];
    if (typeof v === "string" || typeof v === "number" || typeof v === "bigint") out[k] = String(v).slice(0, 80);
  }
  return out;
}

/** Optional Envio GraphQL history. Only https (or http on localhost); failures are reported, not thrown. */
export async function fetchHistory(raw: string, account: Address, signal: AbortSignal) {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return fail("GAPLESS_BAD_INPUT", "--graphql is not a URL.", "Pass the Envio GraphQL endpoint URL.");
  }
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) {
    fail("GAPLESS_BAD_INPUT", "--graphql must use https.", "Pass the https Envio GraphQL endpoint.");
  }
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: HISTORY_QUERY, variables: { a: account.toLowerCase() } }),
      signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
      redirect: "error",
    });
    if (!res.ok) return { error: `HTTP ${res.status}` };
    const text = await readCapped(res);
    if (text === null) return { error: "response too large" };
    const body = JSON.parse(text) as { data?: { Cover?: unknown }; errors?: unknown };
    if (Array.isArray(body.errors) && body.errors.length > 0) return { error: "graphql error" };
    const rows = Array.isArray(body.data?.Cover) ? body.data.Cover.slice(0, 50) : [];
    return { covers: rows.map(cleanRow) };
  } catch (err) {
    return { error: err instanceof Error ? err.name : "fetch failed" };
  }
}
