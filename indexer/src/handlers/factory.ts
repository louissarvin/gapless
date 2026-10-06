import { indexer } from "envio";
import { loadAccount } from "../lib/accounts.js";
import { ZERO_ADDRESS, loadStats } from "../lib/common.js";

// Clones are EIP-1167 proxies created by the factory; index their events from the creation block on.
indexer.contractRegister({ contract: "GaplessFactory", event: "AccountCreated" }, async ({ event, context }) => {
  context.chain.GaplessAccount.add(event.params.account);
});

indexer.onEvent({ contract: "GaplessFactory", event: "AccountCreated" }, async ({ event, context }) => {
  const { owner, account: id, operator } = event.params;
  const [account, stats] = await Promise.all([loadAccount(context, id, event), loadStats(context)]);
  if (context.isPreload) return;
  const fresh = account.owner === "";
  context.GaplessAccountEntity.set({
    ...account,
    owner,
    createdBlock: event.block.number,
    createdTimestamp: event.block.timestamp,
    createdTx: event.transaction.hash,
    // initialize's OperatorSet precedes this log and already holds the full grant; this is the fallback.
    operator: account.operator === ZERO_ADDRESS ? operator : account.operator,
  });
  if (fresh) context.Stats.set({ ...stats, accounts: stats.accounts + 1, updatedBlock: event.block.number });
});
