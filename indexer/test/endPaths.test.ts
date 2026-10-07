import { describe, it } from "vitest";
import { createTestIndexer } from "envio";
import { CLONE, KEEPER, accountItems, addr, at, coverIdOf, listingItems } from "./helpers.js";

const M = { contract: "CoverManager" as const };
const CLONE2 = addr(0xc20e);
const [CANCEL, EXPIRE, VOID, RESIZE] = [
  coverIdOf(CLONE, 1n, 0n),
  coverIdOf(CLONE, 1n, 1n),
  coverIdOf(CLONE2, 1n, 0n),
  coverIdOf(CLONE2, 1n, 1n),
];

const bought = (block: number, coverId: `0x${string}`, account: `0x${string}`, escrowCNS = 90_000n) => ({
  ...M,
  event: "CoverBought" as const,
  ...at(block),
  params: {
    coverId, account, perpId: 1n, isLong: false, lots: 30n, stopPNS: 640_000n, maxGapBps: 200n,
    escrowCNS, rentCNS: 20_000n, capCNS: 384_000n, expiryBlock: 2210n,
  },
});
const ended = (block: number, coverId: `0x${string}`, status: bigint, reason: bigint, refundCNS: bigint) => ({
  ...M, event: "CoverEnded" as const, ...at(block), params: { coverId, status, reason, refundCNS },
});
const forfeited = (block: number, coverId: `0x${string}`, amountCNS: bigint) => ({
  ...M, event: "EscrowForfeited" as const, ...at(block), params: { coverId, amountCNS },
});

describe("cover end paths", () => {
  it("cancel, expire after arm, void, resize with refund then forfeiture, refund ledger", async (t) => {
    const indexer = createTestIndexer();
    await indexer.process({
      chains: {
        143: {
          simulate: [
            ...accountItems(1001),
            ...accountItems(1001, CLONE2, addr(0xb0b)),
            ...listingItems(1002),
            bought(1010, CANCEL, CLONE),
            bought(1011, VOID, CLONE2),
            ended(1100, CANCEL, 5n, 1n, 90_000n),
            bought(1110, EXPIRE, CLONE),
            // Odd escrow so the ceil in PayoutMath.resize matters: 90,001 -> 60,001 -> 21,001.
            bought(1111, RESIZE, CLONE2, 90_001n),
            { ...M, event: "Armed", ...at(1320), params: { coverId: EXPIRE, perpId: 1n, armer: KEEPER, blockNumber: 1320n, bookPNS: 641_000n, refPNS: 640_500n } },
            ended(1400, VOID, 7n, 5n, 0n),
            forfeited(1400, VOID, 90_000n),
            // Shrink 30 to 20 lots far from the stop: cap and escrow keep ceil(x * 20 / 30), freed escrow refunded.
            { ...M, event: "CoverResized", ...at(1500), params: { coverId: RESIZE, newLots: 20n, releasedCapCNS: 128_000n, refundCNS: 30_000n } },
            // Shrink 20 to 7 near the stop: freed escrow forfeited.
            { ...M, event: "CoverResized", ...at(1600), params: { coverId: RESIZE, newLots: 7n, releasedCapCNS: 166_400n, refundCNS: 0n } },
            forfeited(1600, RESIZE, 39_000n),
            { ...M, event: "RefundOwed", ...at(1700), params: { account: CLONE2, amountCNS: 30_000n } },
            { ...M, event: "RefundClaimed", ...at(1800), params: { account: CLONE2, amountCNS: 30_000n } },
            // Ever armed: the escrow stays with the vault at expiry.
            ended(2300, EXPIRE, 6n, 2n, 0n),
            forfeited(2300, EXPIRE, 90_000n),
          ],
        },
      },
    });
    const get = (id: string) => indexer.Cover.getOrThrow(id);
    const [c, e, v, r] = await Promise.all([get(CANCEL), get(EXPIRE), get(VOID), get(RESIZE)]);
    t.expect([c.status, c.endReason, c.refundCNS, c.escrowForfeitedCNS, c.endedBlock]).toEqual(["CANCELLED", "OWNER_CANCEL", 90_000n, 0n, 1100]);
    t.expect([e.status, e.endReason, e.refundCNS, e.escrowForfeitedCNS, e.armCount]).toEqual(["EXPIRED", "EXPIRED", 0n, 90_000n, 1]);
    t.expect([v.status, v.endReason, v.escrowForfeitedCNS]).toEqual(["VOIDED", "LIQUIDATED_OR_ADL", 90_000n]);
    t.expect([r.status, r.lots, r.initialLots, r.capCNS, r.escrowCNS, r.refundCNS, r.escrowForfeitedCNS]).toEqual([
      "LIVE", 7n, 30n, 89_600n, 21_001n, 30_000n, 39_000n,
    ]);

    const stats = await indexer.Stats.getOrThrow("global");
    t.expect(stats).toMatchObject({
      coversTotal: 4,
      coversLive: 1,
      coversArmed: 0,
      coversCancelled: 1,
      coversExpired: 1,
      coversVoided: 1,
      owners: 2,
      escrowToVaultCNS: 219_000n,
      rentCNS: 80_000n,
    });
    t.expect((await indexer.Market.getOrThrow("1")).liveCount).toBe(1);

    const acc = await indexer.GaplessAccountEntity.getOrThrow(CLONE2);
    t.expect([acc.refundOwedCNS, acc.refundClaimedCNS, acc.coverCount]).toEqual([0n, 30_000n, 2]);
  });
});
