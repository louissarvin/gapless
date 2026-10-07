import { afterAll, beforeAll, describe, it } from "vitest";
import { createTestIndexer } from "envio";
import {
  encodeAbiParameters,
  encodeEventTopics,
  encodeFunctionResult,
  toHex,
  type Abi,
  type Hex,
} from "viem";
import coverManagerAbi from "../abis/CoverManager.json" with { type: "json" };
import perplEventsAbi from "../abis/IPerplEvents.json" with { type: "json" };
import perplMinAbi from "../abis/IPerplMin.json" with { type: "json" };
import { BASE_TS, CLONE, EXCHANGE, MANAGER, accountItems, addr, at, coverIdOf, listingItems, startRpcStub, txHash } from "./helpers.js";

const tsOf = (block: number) => BASE_TS + Math.floor((block - 1000) * 0.4);
const FAILING_BLOCK = 1200;
const TRIGGER_BLOCK = 1300;
const TRIGGER_TX = txHash(TRIGGER_BLOCK);
const [COVER_A, COVER_B] = [coverIdOf(CLONE, 1n, 0n), coverIdOf(addr(0xc20e), 1n, 0n)];

function perpInfoResult(block: number): Hex {
  const t = BigInt(tsOf(block));
  const info = {
    name: "BTC", symbol: "BTC", priceDecimals: 1n, lotDecimals: 5n, linkFeedId: `0x${"00".repeat(32)}` as Hex,
    priceTolPer100K: 0n, marginTol: 0n, marginTolDecimals: 0n, refPriceMaxAgeSec: 60n, positionBalanceCNS: 0n,
    insuranceBalanceCNS: 0n, markPNS: 600_300n, markTimestamp: t - 12n, lastPNS: 600_100n, lastTimestamp: t - 2n,
    oraclePNS: 600_000n, oracleTimestampSec: t - 30n, longOpenInterestLNS: 0n, shortOpenInterestLNS: 0n,
    fundingStartBlock: 0n, fundingRatePct100k: 0, absFundingClampPctPer100K: 0n, status: 0, basePricePNS: 590_000n,
    maxBidPriceONS: 10_250n, minBidPriceONS: 0n, maxAskPriceONS: 0n, minAskPriceONS: 2n ** 256n - 1n, numOrders: 0n,
    ignOracle: false,
  };
  return encodeFunctionResult({ abi: perplMinAbi as Abi, functionName: "getPerpetualInfo", result: info });
}

const makerFillEvent = (perplEventsAbi as Abi).find((x) => x.type === "event" && x.name === "MakerOrderFilledV2")!;
const triggeredEvent = (coverManagerAbi as Abi).find((x) => x.type === "event" && x.name === "Triggered")!;

function makerLog(logIndex: number, perpId: bigint, accountId: bigint, pricePNS: bigint, lotLNS: bigint, address = EXCHANGE) {
  if (makerFillEvent.type !== "event") throw new Error("abi");
  const data = encodeAbiParameters(makerFillEvent.inputs, [perpId, accountId, 77n, pricePNS, lotLNS, 0n, 0n, 0n, 0n, 0n, 0n]);
  return { address, topics: encodeEventTopics({ abi: [makerFillEvent] }), data, logIndex };
}

function triggeredLog(logIndex: number, coverId: Hex) {
  if (triggeredEvent.type !== "event") throw new Error("abi");
  const topics = encodeEventTopics({ abi: [triggeredEvent], args: { coverId, perpId: 1n } as never });
  const data = encodeAbiParameters(triggeredEvent.inputs.filter((i) => !i.indexed), [
    BigInt(TRIGGER_BLOCK), 10n, -5n, 100n, 598_000n, 50n, 0n,
  ]);
  return { address: MANAGER, topics, data, logIndex };
}

// One keeper tx triggering two covers: A's fills come before A's Triggered log, B's between A's and B's.
const RECEIPT_LOGS = [
  makerLog(3, 1n, 9001n, 597_900n, 6n),
  makerLog(4, 1n, 9002n, 597_800n, 4n),
  makerLog(5, 2n, 9003n, 31_000n, 50n), // another perp in the same tx
  makerLog(6, 1n, 6666n, 1n, 1_000n, addr(0xbad)), // same event from a non-Exchange contract
  triggeredLog(7, COVER_A),
  makerLog(8, 1n, 9004n, 597_700n, 10n),
  triggeredLog(9, COVER_B),
];

const rpcLog = (l: (typeof RECEIPT_LOGS)[number]) => ({
  ...l,
  logIndex: toHex(l.logIndex),
  blockNumber: toHex(TRIGGER_BLOCK),
  blockHash: `0x${"11".repeat(32)}`,
  transactionHash: TRIGGER_TX,
  transactionIndex: "0x0",
  removed: false,
});

let stub: Awaited<ReturnType<typeof startRpcStub>>;

beforeAll(async () => {
  stub = await startRpcStub((method, params) => {
    if (method === "eth_call") {
      const block = Number(params[1] as string);
      if (block === FAILING_BLOCK) throw new Error("missing trie node");
      return perpInfoResult(block);
    }
    if (method === "eth_getBlockByNumber") {
      const n = Number(params[0] as string);
      return {
        number: toHex(n), hash: `0x${n.toString(16).padStart(64, "0")}`, parentHash: `0x${"00".repeat(32)}`,
        timestamp: toHex(tsOf(n)), gasLimit: "0x1", gasUsed: "0x0", transactions: [], uncles: [], size: "0x0",
        logsBloom: `0x${"00".repeat(256)}`, miner: addr(0), nonce: "0x0000000000000000", difficulty: "0x0",
        extraData: "0x", sha3Uncles: `0x${"00".repeat(32)}`, stateRoot: `0x${"00".repeat(32)}`,
        receiptsRoot: `0x${"00".repeat(32)}`, transactionsRoot: `0x${"00".repeat(32)}`, mixHash: `0x${"00".repeat(32)}`,
      };
    }
    if (method === "eth_getTransactionReceipt") {
      if (params[0] !== TRIGGER_TX) return null;
      return {
        transactionHash: TRIGGER_TX, transactionIndex: "0x0", blockHash: `0x${"11".repeat(32)}`, blockNumber: toHex(TRIGGER_BLOCK),
        from: addr(0x4ee9), to: MANAGER, cumulativeGasUsed: "0x1", gasUsed: "0x1", effectiveGasPrice: "0x1",
        contractAddress: null, logs: RECEIPT_LOGS.map(rpcLog), logsBloom: `0x${"00".repeat(256)}`, status: "0x1", type: "0x2",
      };
    }
    throw new Error(`unexpected ${method}`);
  });
  process.env.ENVIO_MONAD_RPC_URL = stub.url;
});

afterAll(async () => {
  delete process.env.ENVIO_MONAD_RPC_URL;
  await stub.close();
});

const bought = (coverId: Hex, account: Hex) => ({
  contract: "CoverManager" as const,
  event: "CoverBought" as const,
  ...at(1010),
  params: {
    coverId, account, perpId: 1n, isLong: true, lots: 20n, stopPNS: 600_000n, maxGapBps: 200n,
    escrowCNS: 60_000n, rentCNS: 20_000n, capCNS: 240_000n, expiryBlock: 2210n,
  },
});
const triggered = (coverId: Hex, logIndex: number) => ({
  contract: "CoverManager" as const,
  event: "Triggered" as const,
  ...at(TRIGGER_BLOCK),
  logIndex,
  params: {
    coverId, perpId: 1n, blockNumber: BigInt(TRIGGER_BLOCK), filledLots: 10n, realizedCNS: -5n, gRealCumCNS: 100n,
    refTrigPNS: 598_000n, paidNowCNS: 50n, owedCNS: 0n,
  },
});

describe("effects over a stub RPC", () => {
  it("StalenessSampler samples every 200 blocks from start_block and leaves a gap where the historical call fails", async (t) => {
    const indexer = createTestIndexer();
    // A simulated listing keeps the run offline (no simulate array means real HyperSync).
    await indexer.process({ chains: { 143: { startBlock: 1000, endBlock: 1400, simulate: listingItems(1000) } } });
    const samples = (await indexer.StalenessSample.getAll()).sort((a, b) => a.blockNumber - b.blockNumber);
    t.expect(samples.map((s) => s.blockNumber)).toEqual([1000, 1400]);
    t.expect(samples[0]).toMatchObject({
      id: "1-1000",
      market_id: "1",
      timestamp: tsOf(1000),
      markPNS: 600_300n,
      markAgeSec: 12,
      oracleAgeSec: 30,
      lastAgeSec: 2,
      bestBidPNS: 600_250n, // base 590,000 + maxBid ONS 10,250
      bestAskPNS: undefined, // max uint256 sentinel means an empty side
      markOracleDiffBps: 5, // floor(300 x 1e4 / 600,000)
    });
    t.expect(stub.calls).toContain("eth_call");
  });

  it("attributes maker prints to the right Triggered log and ignores other perps and spoofed emitters", async (t) => {
    const indexer = createTestIndexer();
    await indexer.process({
      chains: {
        143: {
          startBlock: 1001,
          endBlock: TRIGGER_BLOCK,
          simulate: [
            ...accountItems(1001),
            ...accountItems(1001, addr(0xc20e), addr(0xb0b)),
            ...listingItems(1002),
            bought(COVER_A, CLONE),
            bought(COVER_B, addr(0xc20e)),
            triggered(COVER_A, 7),
            triggered(COVER_B, 9),
          ],
        },
      },
    });
    const fills = await indexer.Fill.getAll();
    const a = fills.find((f) => f.cover_id === COVER_A)!;
    const b = fills.find((f) => f.cover_id === COVER_B)!;
    // A: 6 @ 597,900 + 4 @ 597,800 -> VWAP floor(5,978,600 / 10) = 597,860.
    t.expect([a.makerCount, a.printLots, a.vwapPNS]).toEqual([2, 10n, 597_860n]);
    t.expect([b.makerCount, b.printLots, b.vwapPNS]).toEqual([1, 10n, 597_700n]);
    const prints = (await indexer.TriggerPrint.getAll()).sort((x, y) => x.logIndex - y.logIndex);
    t.expect(prints.map((p) => [p.logIndex, p.makerAccountId, p.cover_id])).toEqual([
      [3, 9001n, COVER_A],
      [4, 9002n, COVER_A],
      [8, 9004n, COVER_B],
    ]);
  });
});
