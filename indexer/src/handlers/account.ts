import { indexer } from "envio";
import { loadAccount } from "../lib/accounts.js";
import { loadStats, logId, meta, toInt } from "../lib/common.js";

// event.srcAddress is the clone; rows are upserted because initialize's logs precede AccountCreated.

indexer.onEvent({ contract: "GaplessAccount", event: "OperatorSet" }, async ({ event, context }) => {
  const account = await loadAccount(context, event.srcAddress, event);
  if (context.isPreload) return;
  const p = event.params;
  context.GaplessAccountEntity.set({
    ...account,
    operator: p.key,
    operatorExpiry: p.expiry,
    maxNotionalPerTradeCNS: p.maxNotionalPerTradeCNS,
    maxNotionalPerDayCNS: p.maxNotionalPerDayCNS,
    operatorUpdatedBlock: event.block.number,
  });
});

indexer.onEvent({ contract: "GaplessAccount", event: "PerplActivated" }, async ({ event, context }) => {
  const account = await loadAccount(context, event.srcAddress, event);
  if (context.isPreload) return;
  context.GaplessAccountEntity.set({
    ...account,
    perplAccountId: event.params.perplAccountId,
    perplActivatedBlock: event.block.number,
    perplActivationDepositCNS: event.params.depositCNS,
  });
});

indexer.onEvent({ contract: "GaplessAccount", event: "Traded" }, async ({ event, context }) => {
  const [account, stats] = await Promise.all([loadAccount(context, event.srcAddress, event), loadStats(context)]);
  if (context.isPreload) return;
  const p = event.params;
  context.Trade.set({
    id: logId(event),
    account_id: account.id,
    perpId: toInt(p.perpId, "perpId"),
    orderType: toInt(p.orderType, "orderType"),
    lotLNS: p.lotLNS,
    pricePNS: p.pricePNS,
    by: p.by,
    byOwner: account.owner !== "" && p.by === account.owner,
    ...meta(event),
  });
  context.GaplessAccountEntity.set({ ...account, tradeCount: account.tradeCount + 1 });
  context.Stats.set({ ...stats, trades: stats.trades + 1, updatedBlock: event.block.number });
});

indexer.onEvent({ contract: "GaplessAccount", event: "Withdrawn" }, async ({ event, context }) => {
  const account = await loadAccount(context, event.srcAddress, event);
  if (context.isPreload) return;
  context.GaplessAccountEntity.set({ ...account, withdrawnCNS: account.withdrawnCNS + event.params.amountCNS });
});

indexer.onEvent({ contract: "GaplessAccount", event: "Swept" }, async ({ event, context }) => {
  const account = await loadAccount(context, event.srcAddress, event);
  if (context.isPreload) return;
  context.GaplessAccountEntity.set({ ...account, sweptCNS: account.sweptCNS + event.params.amountCNS });
});

indexer.onEvent({ contract: "GaplessAccount", event: "Credited" }, async ({ event, context }) => {
  const account = await loadAccount(context, event.srcAddress, event);
  if (context.isPreload) return;
  const { amountCNS, toPerpl } = event.params;
  context.GaplessAccountEntity.set({
    ...account,
    creditedCNS: account.creditedCNS + amountCNS,
    creditedToPerplCNS: account.creditedToPerplCNS + (toPerpl ? amountCNS : 0n),
  });
});
