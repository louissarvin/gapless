import { createEffect, S } from "envio";
import { decodeEventLog, toEventSelector, type Abi, type AbiEvent } from "viem";
import coverManagerAbi from "../../abis/CoverManager.json" with { type: "json" };
import perplEventsAbi from "../../abis/IPerplEvents.json" with { type: "json" };
import { perplExchange } from "../lib/env.js";
import { errorSummary, rpcClient } from "./rpc.js";

const TX_HASH_RE = /^0x[0-9a-fA-F]{64}$/;
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

function eventItem(abi: unknown, name: string): AbiEvent {
  const item = (abi as Abi).find((x): x is AbiEvent => x.type === "event" && x.name === name);
  if (!item) throw new Error(`event ${name} missing from ABI`);
  return item;
}

const MAKER_FILLED = eventItem(perplEventsAbi, "MakerOrderFilledV2");
const TRIGGERED = eventItem(coverManagerAbi, "Triggered");
export const MAKER_FILLED_TOPIC = toEventSelector(MAKER_FILLED);
export const TRIGGERED_TOPIC = toEventSelector(TRIGGERED);

const makerFillSchema = S.schema({
  logIndex: S.number,
  perpId: S.bigint,
  accountId: S.bigint,
  orderId: S.bigint,
  pricePNS: S.bigint,
  lotLNS: S.bigint,
});

const receiptPrintsSchema = S.schema({
  fills: S.array(makerFillSchema),
  triggeredLogIndexes: S.array(S.number),
});

export type MakerFill = S.Output<typeof makerFillSchema>;
export type ReceiptPrints = S.Output<typeof receiptPrintsSchema>;

/**
 * Perpl maker fills and the manager's Triggered log indexes from one trigger tx receipt.
 * Only logs emitted by the Perpl Exchange and the given manager count, so another contract in the tx cannot spoof prints.
 */
export const triggerPrints = createEffect(
  {
    name: "triggerPrints",
    input: { txHash: S.string, manager: S.string },
    output: S.nullable(receiptPrintsSchema),
    rateLimit: { calls: 5, per: "second" },
    cache: true,
  },
  async ({ input, context }) => {
    const client = rpcClient();
    if (!client) {
      context.cache = false;
      return null;
    }
    if (!TX_HASH_RE.test(input.txHash) || !ADDRESS_RE.test(input.manager)) {
      context.cache = false;
      context.log.error("triggerPrints bad input", { txHash: input.txHash, manager: input.manager });
      return null;
    }
    try {
      const receipt = await client.getTransactionReceipt({ hash: input.txHash as `0x${string}` });
      const exchange = perplExchange();
      const manager = input.manager.toLowerCase();
      const fills: MakerFill[] = [];
      const triggeredLogIndexes: number[] = [];
      for (const log of receipt.logs) {
        const addr = log.address.toLowerCase();
        const topic0 = log.topics[0];
        if (addr === manager && topic0 === TRIGGERED_TOPIC) {
          triggeredLogIndexes.push(log.logIndex);
        } else if (addr === exchange && topic0 === MAKER_FILLED_TOPIC) {
          const { args } = decodeEventLog({ abi: [MAKER_FILLED], data: log.data, topics: log.topics });
          const a = args as unknown as Record<string, bigint>;
          fills.push({
            logIndex: log.logIndex,
            perpId: a.perpId!,
            accountId: a.accountId!,
            orderId: a.orderId!,
            pricePNS: a.pricePNS!,
            lotLNS: a.lotLNS!,
          });
        }
      }
      return { fills, triggeredLogIndexes };
    } catch (err) {
      context.cache = false;
      context.log.warn("triggerPrints failed", { txHash: input.txHash, error: errorSummary(err) });
      return null;
    }
  },
);

/** Fills that belong to the Triggered log at `logIndex`: same perp, after the previous Triggered log of the tx. */
export function printsFor(r: ReceiptPrints, logIndex: number, perpId: bigint): MakerFill[] {
  const lower = Math.max(-1, ...r.triggeredLogIndexes.filter((i) => i < logIndex));
  return r.fills.filter((f) => f.logIndex > lower && f.logIndex < logIndex && f.perpId === perpId);
}
