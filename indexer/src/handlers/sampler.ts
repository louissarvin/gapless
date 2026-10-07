import { indexer } from "envio";
import { blockTime } from "../effects/blockTime.js";
import { perpInfo } from "../effects/perpInfo.js";
import { monadRpcUrl, samplerPerps } from "../lib/env.js";

const CHAIN_ID = 143;
const SAMPLE_EVERY_BLOCKS = 200;
const MAX_UINT256 = 2n ** 256n - 1n;
const INT32_MAX = 2_147_483_647n;
const min = (a: bigint, b: bigint) => (a < b ? a : b);

// Fail fast on a malformed env at startup rather than on the first sampled block.
const PERPS = samplerPerps();
monadRpcUrl();

const age = (now: number, ts: bigint) => now - Number(ts);
const bookSide = (base: bigint, ons: bigint) => (ons === 0n || ons === MAX_UINT256 ? undefined : base + ons);

indexer.onBlock(
  {
    name: "StalenessSampler",
    // start_block 0 means the deploy block is not set yet; sampling from genesis would be ~550K RPC reads.
    where: ({ chain }) =>
      chain.id === CHAIN_ID && chain.startBlock > 0
        ? { block: { number: { _gte: chain.startBlock, _every: SAMPLE_EVERY_BLOCKS } } }
        : false,
  },
  async ({ block, context }) => {
    const [ts, infos] = await Promise.all([
      context.effect(blockTime, block.number),
      Promise.all(PERPS.map((perpId) => context.effect(perpInfo, { perpId, blockNumber: block.number }))),
    ]);
    if (context.isPreload || ts === null) return;
    PERPS.forEach((perpId, i) => {
      const info = infos[i];
      if (!info) return;
      const diff = info.markPNS > info.oraclePNS ? info.markPNS - info.oraclePNS : info.oraclePNS - info.markPNS;
      context.StalenessSample.set({
        id: `${perpId}-${block.number}`,
        market_id: perpId.toString(),
        perpId,
        blockNumber: block.number,
        timestamp: ts,
        markPNS: info.markPNS,
        markAgeSec: age(ts, info.markTimestamp),
        oraclePNS: info.oraclePNS,
        oracleAgeSec: age(ts, info.oracleTimestampSec),
        lastPNS: info.lastPNS,
        lastAgeSec: age(ts, info.lastTimestamp),
        bestBidPNS: bookSide(info.basePricePNS, info.maxBidPriceONS),
        bestAskPNS: bookSide(info.basePricePNS, info.minAskPriceONS),
        markOracleDiffBps: info.oraclePNS === 0n ? undefined : Number(min((diff * 10_000n) / info.oraclePNS, INT32_MAX)),
      });
    });
  },
);
