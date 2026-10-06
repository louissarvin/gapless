import type { GaplessAccountEntity } from "envio";
import { ZERO_ADDRESS, type Ctx } from "./common.js";

/** Blank clone row. owner stays "" until AccountCreated, which initialize's OperatorSet precedes in the same tx. */
export function newAccount(id: string, block: number, timestamp: number, txHash: string): GaplessAccountEntity {
  return {
    id,
    owner: "",
    createdBlock: block,
    createdTimestamp: timestamp,
    createdTx: txHash,
    operator: ZERO_ADDRESS,
    operatorExpiry: 0n,
    maxNotionalPerTradeCNS: 0n,
    maxNotionalPerDayCNS: 0n,
    operatorUpdatedBlock: block,
    perplAccountId: 0n,
    perplActivatedBlock: undefined,
    perplActivationDepositCNS: undefined,
    tradeCount: 0,
    coverCount: 0,
    sweptCNS: 0n,
    withdrawnCNS: 0n,
    creditedCNS: 0n,
    creditedToPerplCNS: 0n,
    refundOwedCNS: 0n,
    refundClaimedCNS: 0n,
  };
}

type Meta = { readonly block: { readonly number: number; readonly timestamp: number }; readonly transaction: { readonly hash: string } };

export async function loadAccount(context: Ctx, id: string, e: Meta): Promise<GaplessAccountEntity> {
  return (await context.GaplessAccountEntity.get(id)) ?? newAccount(id, e.block.number, e.block.timestamp, e.transaction.hash);
}
