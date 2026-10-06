import { createEffect, S } from "envio";
import { errorSummary, rpcClient } from "./rpc.js";

/** Block timestamp (unix seconds); V3 block handlers only receive the number (D2). Null when the RPC is unset or fails. */
export const blockTime = createEffect(
  {
    name: "blockTime",
    input: S.number,
    output: S.nullable(S.number),
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
      const block = await client.getBlock({ blockNumber: BigInt(input) });
      return Number(block.timestamp);
    } catch (err) {
      context.cache = false;
      context.log.warn("blockTime failed", { blockNumber: input, error: errorSummary(err) });
      return null;
    }
  },
);
