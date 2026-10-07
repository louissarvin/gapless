import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { encodeAbiParameters, keccak256, toHex } from "viem";

type Address = `0x${string}`;

const CONFIG = readFileSync(new URL("../config.yaml", import.meta.url), "utf8");

/** The default config.yaml resolves for a @deploy key without ENVIO_* overrides, lowercased per address_format. */
export function deployedDefault(key: string): Address {
  const m = CONFIG.match(new RegExp(`:-(0x[0-9a-fA-F]{40})\\}"? # @deploy:${key}$`, "m"));
  if (!m) throw new Error(`config.yaml has no address default for @deploy:${key}`);
  return m[1]!.toLowerCase() as Address;
}

export const MANAGER = deployedDefault("CoverManager");
export const VAULT = deployedDefault("CoverVault");
export const FACTORY = deployedDefault("GaplessFactory");
export const SINK = deployedDefault("GaplessCreSink");
export const EXCHANGE: Address = "0x34b6552d57a35a1d042ccae1951bd1c370112a6f";
export const ZERO: Address = "0x0000000000000000000000000000000000000000";
export const DEAD: Address = "0x000000000000000000000000000000000000dead";

export const addr = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as Address;
export const OWNER = addr(0xa11ce);
export const CLONE = addr(0xc10e);
export const OPERATOR = addr(0x0b0b);
export const KEEPER = addr(0x4ee9);
export const LP = addr(0x1b);
export const TREASURY = addr(0x7ea5);
export const FEED = addr(0xfeed);

/** CoverManager: coverId = keccak256(abi.encode(account, perpId, coverNonce[account]++)). */
export const coverIdOf = (account: `0x${string}`, perpId: bigint, nonce: bigint) =>
  keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint256" }, { type: "uint256" }], [account, perpId, nonce]));
export const txHash = (n: number) => keccak256(toHex(`tx-${n}`));

/** Block 1000 + n at a fixed 0.4 s cadence; every simulated item gets a real tx hash and timestamp. */
export const BASE_TS = 1_790_000_000;
export const at = (block: number, tx = block) => ({
  block: { number: block, timestamp: BASE_TS + Math.floor((block - 1000) * 0.4) },
  transaction: { hash: txHash(tx) },
});

export const defaultParams = () => ({
  slipAllowanceBps: 5n,
  maxGapBpsCap: 200n,
  floorSlackBps: 100n,
  refTolBps: 50n,
  minStopDistanceBps: 10n,
  kDistE2: 300n,
  loadBps: 5000n,
  rentAprBps: 2000n,
  uKinkBps: 5000n,
  slope1Bps: 5000n,
  slope2Bps: 40000n,
  marketCapBps: 10000n,
  perBlockPayoutCapBps: 2500n,
  maxLossToDepositBps: 4000n,
  impactBpsPerKE2: 10n,
  maxMatchesClose: 16n,
  warmupBlocks: 200n,
  armTtlBlocks: 200n,
  exclusiveBlocks: 3n,
  windowBlocks: 40n,
  minDurationBlocks: 1000n,
  maxDurationBlocks: 48000n,
  sigmaMaxAgeBlocks: 6000n,
  refFreshSec: 60n,
  feedMaxAgeSec: 120n,
  minFeeCNS: 20000n,
  maxCoverNotionalCNS: 20_000_000n,
  zEdgesE2: [50n, 100n, 150n, 200n, 250n, 300n, 400n, 600n],
  gapBpsE2: [194n, 91n, 101n, 143n, 229n, 452n, 492n, 999n, 950n],
});

export const zeroParams = () =>
  Object.fromEntries(
    Object.entries(defaultParams()).map(([k, v]) => [k, Array.isArray(v) ? v.map(() => 0n) : 0n]),
  ) as ReturnType<typeof defaultParams>;

/** BTC perp 1 as listed on mainnet: pd 1, ld 5, scale 10^(6 - 1 - 5) = 1. */
export const listingItems = (block: number) => [
  {
    contract: "CoverManager" as const,
    event: "MarketListed" as const,
    ...at(block),
    params: {
      perpId: 1n,
      cfg: { listed: true, priceDecimals: 1n, lotDecimals: 5n, scale: 1n, feed: FEED, feedDecimals: 8n, creRefStore: ZERO },
    },
  },
  {
    contract: "CoverManager" as const,
    event: "MarketParamsSet" as const,
    ...at(block),
    params: { perpId: 1n, oldP: zeroParams(), newP: defaultParams() },
  },
];

/** Factory createAccountFor: initialize's OperatorSet (clone) precedes AccountCreated in the same tx. */
export const accountItems = (block: number, clone = CLONE, owner = OWNER) => [
  {
    contract: "GaplessFactory" as const,
    event: "AccountCreated" as const,
    ...at(block),
    params: { owner, account: clone, operator: OPERATOR },
  },
  {
    contract: "GaplessAccount" as const,
    event: "OperatorSet" as const,
    srcAddress: clone,
    ...at(block),
    params: { key: OPERATOR, expiry: 1_800_000_000n, maxNotionalPerTradeCNS: 25_000_000n, maxNotionalPerDayCNS: 100_000_000n },
  },
];

type JsonRpcRequest = { id: number; method: string; params: unknown[] };
export type RpcHandler = (method: string, params: unknown[]) => unknown;

/** Minimal JSON-RPC server (single and batch requests) so the Effects run their real viem code path offline. */
export async function startRpcStub(handler: RpcHandler): Promise<{ url: string; calls: string[]; close: () => Promise<void> }> {
  const calls: string[] = [];
  const server: Server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const parsed = JSON.parse(body) as JsonRpcRequest | JsonRpcRequest[];
      const one = (r: JsonRpcRequest) => {
        calls.push(r.method);
        try {
          return { jsonrpc: "2.0", id: r.id, result: handler(r.method, r.params) };
        } catch (e) {
          return { jsonrpc: "2.0", id: r.id, error: { code: -32000, message: (e as Error).message } };
        }
      };
      const out = Array.isArray(parsed) ? parsed.map(one) : one(parsed);
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(out));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    calls,
    close: () => new Promise((r) => server.close(() => r())),
  };
}
