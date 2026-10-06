import { createEffect, S } from "envio";
import type { Abi } from "viem";
import perplMinAbi from "../../abis/IPerplMin.json" with { type: "json" };
import { perplExchange } from "../lib/env.js";
import { errorSummary, rpcClient } from "./rpc.js";

const ABI = perplMinAbi as Abi;

const perpInfoSchema = S.schema({
  markPNS: S.bigint,
  markTimestamp: S.bigint,
  oraclePNS: S.bigint,
  oracleTimestampSec: S.bigint,
  lastPNS: S.bigint,
  lastTimestamp: S.bigint,
  basePricePNS: S.bigint,
  maxBidPriceONS: S.bigint,
  minAskPriceONS: S.bigint,
});

export type PerpInfo = S.Output<typeof perpInfoSchema>;

const FIELDS = [
  "markPNS",
  "markTimestamp",
  "oraclePNS",
  "oracleTimestampSec",
  "lastPNS",
  "lastTimestamp",
  "basePricePNS",
  "maxBidPriceONS",
  "minAskPriceONS",
] as const satisfies readonly (keyof PerpInfo)[];

/** Perpl getPerpetualInfo at a historical block. Null (and not cached) when the RPC is unset or fails. */
export const perpInfo = createEffect(
  {
    name: "perpInfo",
    input: { perpId: S.number, blockNumber: S.number },
    output: S.nullable(perpInfoSchema),
    rateLimit: { calls: 5, per: "second" },
    cache: true,
  },
  async ({ input, context }) => {
    const client = rpcClient();
    if (!client) {
      context.cache = false;
      return null;
    }
    try {
      const raw = (await client.readContract({
        address: perplExchange(),
        abi: ABI,
        functionName: "getPerpetualInfo",
        args: [BigInt(input.perpId)],
        blockNumber: BigInt(input.blockNumber),
      })) as Record<string, unknown>;
      const out: Partial<Record<keyof PerpInfo, bigint>> = {};
      for (const k of FIELDS) {
        const v = raw[k];
        if (typeof v !== "bigint") throw new Error(`getPerpetualInfo.${k} missing`);
        out[k] = v;
      }
      return out as PerpInfo;
    } catch (err) {
      context.cache = false;
      context.log.warn("perpInfo failed", { perpId: input.perpId, blockNumber: input.blockNumber, error: errorSummary(err) });
      return null;
    }
  },
);
