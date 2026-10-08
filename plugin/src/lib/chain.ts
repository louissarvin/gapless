import { CommandError } from "@metamask/agent-wallet/plugin";
import { type Address, getAddress, type PublicClient, zeroAddress } from "viem";
import { ICoverManagerAbi, IGaplessAccountAbi, IGaplessFactoryAbi, IPerplMinAbi } from "../abi/index.js";
import { CHAIN_ID, resolveDeployment } from "./config.js";
import { fail, toCommandError } from "./errors.js";
import type { Host } from "./host.js";
import { parseAddress, parseInteger } from "./units.js";

export type Gapless = {
  client: PublicClient;
  manager: Address;
  factory: Address;
  exchange: Address;
  ausd: Address;
};

/** Wraps a read so reverts surface as decoded CommandErrors. */
export async function read<T>(action: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    throw toCommandError(err, action);
  }
}

/** Chain 143 check plus the wiring read back from the manager; the packaged factory must match it. */
export async function connect(host: Host): Promise<Gapless> {
  const dep = resolveDeployment();
  const client = host.publicClient(CHAIN_ID);
  const chainId = await read("eth_chainId", () => client.getChainId());
  if (chainId !== CHAIN_ID) {
    fail("GAPLESS_WRONG_CHAIN", `RPC reports chain ${chainId}, Gapless runs on Monad ${CHAIN_ID} only.`, "Run mm chains list and retry.");
  }
  const m = { address: dep.manager, abi: ICoverManagerAbi } as const;
  const [factory, exchange, ausd] = await read("CoverManager wiring", () =>
    Promise.all([
      client.readContract({ ...m, functionName: "factory" }),
      client.readContract({ ...m, functionName: "EXCHANGE" }),
      client.readContract({ ...m, functionName: "AUSD" }),
    ]),
  );
  if (factory === zeroAddress) fail("GAPLESS_NOT_CONFIGURED", "CoverManager has no factory yet.", "The deployment is not wired; retry after the canary is live.");
  if (dep.factory && getAddress(factory) !== dep.factory) {
    fail("GAPLESS_BAD_CONFIG", `CoverManager.factory() ${factory} differs from the configured factory ${dep.factory}.`, "Fix GAPLESS_FACTORY_ADDRESS or reinstall the plugin.");
  }
  return { client, manager: dep.manager, factory: getAddress(factory), exchange: getAddress(exchange), ausd: getAddress(ausd) };
}

export type AccountSel = { account?: string; owner?: string };

/** --account, else factory.accountOf(--owner or wallet); always checked against factory.isAccount. */
export async function resolveAccount(g: Gapless, sel: AccountSel, wallet: Address): Promise<Address> {
  let account: Address;
  if (sel.account?.trim()) {
    account = parseAddress(sel.account, "account");
  } else {
    const owner = sel.owner?.trim() ? parseAddress(sel.owner, "owner") : wallet;
    account = await read("factory.accountOf", () =>
      g.client.readContract({ address: g.factory, abi: IGaplessFactoryAbi, functionName: "accountOf", args: [owner] }),
    );
  }
  const ok = await read("factory.isAccount", () =>
    g.client.readContract({ address: g.factory, abi: IGaplessFactoryAbi, functionName: "isAccount", args: [account] }),
  );
  if (!ok) {
    fail(
      "GAPLESS_NO_ACCOUNT",
      `${account} is not a deployed GaplessAccount.`,
      "Pass --account <clone> or --owner <owner address> (env GAPLESS_ACCOUNT works too), or create one with gapless:account.",
    );
  }
  return getAddress(account);
}

export type Grant = {
  owner: Address;
  key: Address;
  expiry: bigint;
  maxPerTrade: bigint;
  maxPerDay: bigint;
  used: bigint;
  available: bigint;
  opNonce: bigint;
  perplAccountId: bigint;
  now: bigint;
  role: "owner" | "operator" | "none";
};

export async function readGrant(g: Gapless, account: Address, wallet: Address): Promise<Grant> {
  const a = { address: account, abi: IGaplessAccountAbi } as const;
  const [owner, op, usage, opNonce, perplAccountId, block] = await read("account state", () =>
    Promise.all([
      g.client.readContract({ ...a, functionName: "owner" }),
      g.client.readContract({ ...a, functionName: "operator" }),
      g.client.readContract({ ...a, functionName: "operatorUsage" }),
      g.client.readContract({ ...a, functionName: "opNonce" }),
      g.client.readContract({ ...a, functionName: "perplAccountId" }),
      g.client.getBlock(),
    ]),
  );
  const now = block.timestamp;
  // Same rule as GaplessAccount._authorize: owner always, operator iff key matches and block.timestamp < expiry.
  const role = getAddress(owner) === wallet
    ? "owner"
    : getAddress(op.key) === wallet && op.key !== zeroAddress && now < BigInt(op.expiry)
      ? "operator"
      : "none";
  return {
    owner: getAddress(owner),
    key: getAddress(op.key),
    expiry: BigInt(op.expiry),
    maxPerTrade: op.maxNotionalPerTradeCNS,
    maxPerDay: op.maxNotionalPerDayCNS,
    used: usage[0],
    available: usage[1],
    opNonce,
    perplAccountId,
    now,
    role,
  };
}

/** Refuses before any simulation or executor call when this wallet cannot act for the account. */
export async function authorize(g: Gapless, account: Address, wallet: Address): Promise<Grant> {
  const grant = await readGrant(g, account, wallet);
  if (grant.role === "none") throw notOperator(grant, account, wallet);
  return grant;
}

export function notOperator(grant: Grant, account: Address, wallet: Address): CommandError {
  const why = grant.key === wallet
    ? `its operator grant expired at ${new Date(Number(grant.expiry) * 1000).toISOString()}`
    : `the live operator is ${grant.key === zeroAddress ? "nobody" : grant.key}`;
  return new CommandError(
    "GAPLESS_NOT_OPERATOR",
    `Wallet ${wallet} is not the owner or live operator of ${account}: ${why}.`,
    "Ask the owner to sign a grant for this wallet (gapless:link prints it), then run gapless:link with --sig.",
  );
}

export type Market = {
  perpId: bigint;
  symbol: string;
  priceDecimals: number;
  lotDecimals: number;
  scale: bigint;
  markPNS: bigint;
  bestBidPNS: bigint | null;
  bestAskPNS: bigint | null;
};

const MAX_UINT = 2n ** 256n - 1n;
const norm = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, "");

/** Market by perp id or symbol (BTC, BTC-PERP); must be listed on the manager. */
export async function resolveMarket(g: Gapless, raw: string | undefined): Promise<Market> {
  const want = (raw ?? "").trim();
  if (!want) fail("GAPLESS_BAD_INPUT", "--market is required.", "Pass a perp id like 1 or a symbol like BTC.");
  const listed = await read("listedPerps", () =>
    g.client.readContract({ address: g.manager, abi: ICoverManagerAbi, functionName: "listedPerps" }),
  );
  let perpId: bigint | undefined;
  if (/^\d+$/.test(want)) {
    perpId = parseInteger(want, "market", 0n, 65_535n);
  } else {
    const infos = await Promise.all(listed.map((id) => perpInfo(g, id).then((i) => ({ id, sym: norm(i.symbol), name: norm(i.name) }))));
    const w = norm(want);
    const hit = infos.find((x) => x.sym === w || x.name === w || x.sym === `${w}PERP` || x.sym === `${w}USD`);
    perpId = hit?.id;
  }
  if (perpId === undefined || !listed.includes(perpId)) {
    fail("GAPLESS_MARKET_NOT_LISTED", `Market '${want}' is not listed on Gapless.`, `Listed perp ids: ${listed.join(", ") || "none"}.`);
  }
  const [cfg, info] = await Promise.all([
    read("marketConfig", () => g.client.readContract({ address: g.manager, abi: ICoverManagerAbi, functionName: "marketConfig", args: [perpId] })),
    perpInfo(g, perpId),
  ]);
  const base = info.basePricePNS;
  const side = (ons: bigint) => (ons === 0n || ons === MAX_UINT ? null : base + ons);
  return {
    perpId,
    symbol: info.symbol,
    priceDecimals: cfg.priceDecimals,
    lotDecimals: cfg.lotDecimals,
    scale: cfg.scale,
    markPNS: info.markPNS,
    bestBidPNS: side(info.maxBidPriceONS),
    bestAskPNS: side(info.minAskPriceONS),
  };
}

function perpInfo(g: Gapless, perpId: bigint) {
  return read("Perpl getPerpetualInfo", () =>
    g.client.readContract({ address: g.exchange, abi: IPerplMinAbi, functionName: "getPerpetualInfo", args: [perpId] }),
  );
}
