import { describe, it } from "vitest";
import { createTestIndexer } from "envio";
import { CLONE, OPERATOR, OWNER, accountItems, addr, at } from "./helpers.js";

describe("factory and dynamic GaplessAccount clones", () => {
  it("registers the clone, keeps initialize's grant, then indexes the clone's own events", async (t) => {
    const indexer = createTestIndexer();
    const first = await indexer.process({ chains: { 143: { simulate: accountItems(1001) } } });
    t.expect(first.changes.flatMap((c) => c.addresses?.sets ?? [])).toEqual([{ address: CLONE, contract: "GaplessAccount" }]);
    t.expect(indexer.chains[143].GaplessAccount.addresses).toContain(CLONE);

    await indexer.process({
      chains: {
        143: {
          simulate: [
            { contract: "GaplessAccount", event: "PerplActivated", srcAddress: CLONE, ...at(1002), params: { perplAccountId: 5401n, depositCNS: 10_000_000n } },
            { contract: "GaplessAccount", event: "Swept", srcAddress: CLONE, ...at(1002), params: { amountCNS: 10_000_000n } },
            { contract: "GaplessAccount", event: "Traded", srcAddress: CLONE, ...at(1003), params: { perpId: 1n, orderType: 0n, lotLNS: 100n, pricePNS: 1_234_560n, by: OPERATOR } },
            { contract: "GaplessAccount", event: "Traded", srcAddress: CLONE, ...at(1004), params: { perpId: 1n, orderType: 2n, lotLNS: 40n, pricePNS: 1_230_000n, by: OWNER } },
            { contract: "GaplessAccount", event: "Credited", srcAddress: CLONE, ...at(1005), params: { amountCNS: 700_000n, toPerpl: true } },
            { contract: "GaplessAccount", event: "Credited", srcAddress: CLONE, ...at(1006), params: { amountCNS: 50_000n, toPerpl: false } },
            { contract: "GaplessAccount", event: "Withdrawn", srcAddress: CLONE, ...at(1007), params: { to: OWNER, amountCNS: 1_000_000n } },
            { contract: "GaplessAccount", event: "OperatorSet", srcAddress: CLONE, ...at(1008), params: { key: addr(0), expiry: 0n, maxNotionalPerTradeCNS: 0n, maxNotionalPerDayCNS: 0n } },
          ],
        },
      },
    });

    const acc = await indexer.GaplessAccountEntity.getOrThrow(CLONE);
    t.expect(acc).toMatchObject({
      owner: OWNER,
      createdBlock: 1001,
      operator: addr(0),
      operatorExpiry: 0n,
      operatorUpdatedBlock: 1008,
      perplAccountId: 5401n,
      perplActivatedBlock: 1002,
      perplActivationDepositCNS: 10_000_000n,
      sweptCNS: 10_000_000n,
      tradeCount: 2,
      creditedCNS: 750_000n,
      creditedToPerplCNS: 700_000n,
      withdrawnCNS: 1_000_000n,
    });
    const trades = (await indexer.Trade.getAll()).sort((a, b) => a.blockNumber - b.blockNumber);
    t.expect(trades.map((x) => [x.account_id, x.orderType, x.byOwner])).toEqual([
      [CLONE, 0, false],
      [CLONE, 2, true],
    ]);
    const stats = await indexer.Stats.getOrThrow("global");
    t.expect([stats.accounts, stats.trades, stats.owners]).toEqual([1, 2, 0]);
  });

  it("keeps the full operator grant from initialize's OperatorSet logged before AccountCreated", async (t) => {
    const indexer = createTestIndexer();
    const [created, opSet] = accountItems(1001);
    // Real order inside createAccountFor: clone initialize (OperatorSet) then AccountCreated.
    await indexer.process({ chains: { 143: { simulate: [{ ...opSet!, logIndex: 0 }, { ...created!, logIndex: 1 }] } } });
    const acc = await indexer.GaplessAccountEntity.get(CLONE);
    t.expect(acc?.owner).toBe(OWNER);
    t.expect(acc?.operator).toBe(OPERATOR);
    // Only the clone's OperatorSet carries the budget, so this proves the earlier same-tx clone log was indexed.
    t.expect(acc?.maxNotionalPerDayCNS).toBe(100_000_000n);
  });
});
