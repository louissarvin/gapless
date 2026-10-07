import { describe, it } from "vitest";
import { createTestIndexer } from "envio";
import { CLONE, KEEPER, accountItems, addr, at, coverIdOf, listingItems } from "./helpers.js";

const COVER = coverIdOf(CLONE, 1n, 0n);
const M = { contract: "CoverManager" as const };

// 30 lots (ld 5) at stop 60,000.0 (pd 1, scale 1): notional 18 AUSD, cap 2% = 0.36 AUSD.
const bought = (block: number, coverId = COVER, account = CLONE) => ({
  ...M,
  event: "CoverBought" as const,
  ...at(block),
  params: {
    coverId,
    account,
    perpId: 1n,
    isLong: true,
    lots: 30n,
    stopPNS: 600_000n,
    maxGapBps: 200n,
    escrowCNS: 90_000n,
    rentCNS: 20_000n,
    capCNS: 360_000n,
    expiryBlock: 2210n,
  },
});

const armed = (block: number, coverId = COVER) => ({
  ...M,
  event: "Armed" as const,
  ...at(block),
  params: { coverId, perpId: 1n, armer: KEEPER, blockNumber: BigInt(block), bookPNS: 599_000n, refPNS: 599_500n },
});

const triggered = (block: number, filledLots: bigint, gRealCumCNS: bigint, paidNowCNS: bigint, owedCNS: bigint, coverId = COVER) => ({
  ...M,
  event: "Triggered" as const,
  ...at(block),
  params: {
    coverId,
    perpId: 1n,
    blockNumber: BigInt(block),
    filledLots,
    realizedCNS: -5_000n,
    gRealCumCNS,
    refTrigPNS: 598_000n,
    paidNowCNS,
    owedCNS,
  },
});

describe("cover lifecycle", () => {
  it("bought, armed, disarmed, re-armed, 5 no-fills, 3 fills with a deferral, observed, finalized", async (t) => {
    const indexer = createTestIndexer();
    await indexer.process({
      chains: {
        143: {
          simulate: [
            ...accountItems(1001),
            ...listingItems(1002),
            { ...M, event: "SigmaPosted", ...at(1003), params: { perpId: 1n, sigmaBlkBpsE2: 27n, blockNumber: 1003n } },
            bought(1010),
            armed(1220),
            { ...M, event: "Disarmed", ...at(1222), params: { coverId: COVER, reason: 0n } },
            armed(1230),
            ...[1231, 1232, 1233, 1234, 1235].map((b, i) => ({
              ...M,
              event: "TriggerNoFill" as const,
              ...at(b),
              params: { coverId: COVER, blockNumber: BigInt(b), limitPNS: 597_000n - BigInt(i) * 3_000n },
            })),
            // _settle emits PayoutDeferred before the Triggered log of the same call.
            { ...M, event: "PayoutDeferred", ...at(1236), params: { coverId: COVER, owedCNS: 1_000n } },
            triggered(1236, 10n, 4_000n, 3_000n, 1_000n),
            triggered(1240, 10n, 9_000n, 4_000n, 0n),
            triggered(1250, 10n, 15_000n, 6_000n, 0n),
            { ...M, event: "Observed", ...at(1252), params: { coverId: COVER, refPostPNS: 597_000n, blockNumber: 1252n } },
            {
              ...M,
              event: "Finalized",
              ...at(1300),
              params: { coverId: COVER, topUpCNS: 500n, totalPaidCNS: 13_500n, refFinalPNS: 597_000n, escrowToVaultCNS: 90_000n },
            },
          ],
        },
      },
    });

    const cover = await indexer.Cover.getOrThrow(COVER);
    t.expect(cover).toMatchObject({
      account_id: CLONE,
      owner: addr(0xa11ce),
      market_id: "1",
      side: "LONG",
      status: "FINALIZED",
      endReason: "NONE",
      notionalCNS: 18_000_000n,
      armCount: 2,
      disarmCount: 1,
      noFillCount: 5,
      armedBlock: 1230,
      armer: KEEPER,
      triggerBlock: 1236,
      armToTriggerBlocks: 6,
      filledLots: 30n,
      gRealCumCNS: 15_000n,
      paidCNS: 13_500n,
      owedCNS: 0n,
      observed: true,
      refPostPNS: 597_000n,
      refFinalPNS: 597_000n,
      escrowToVaultCNS: 90_000n,
      refundCNS: 0n,
      endedBlock: 1300,
      boughtBlock: 1010,
    });

    const events = (await indexer.CoverEvent.getAll()).sort((a, b) => a.blockNumber - b.blockNumber || a.logIndex - b.logIndex);
    t.expect(events.map((e) => e.kind)).toEqual([
      "BOUGHT", "ARMED", "DISARMED", "ARMED",
      "TRIGGER_NO_FILL", "TRIGGER_NO_FILL", "TRIGGER_NO_FILL", "TRIGGER_NO_FILL", "TRIGGER_NO_FILL",
      "PAYOUT_DEFERRED", "TRIGGERED", "TRIGGERED", "TRIGGERED", "OBSERVED", "FINALIZED",
    ]);
    t.expect(events.find((e) => e.kind === "DISARMED")?.reason).toBe("CONDITION_GONE");
    t.expect(events.every((e) => e.txHash.length === 66 && e.timestamp > 0)).toBe(true);

    const fills = (await indexer.Fill.getAll()).sort((a, b) => a.blockNumber - b.blockNumber);
    t.expect(fills.map((f) => [f.isFirst, f.filledLots, f.paidNowCNS, f.owedCNS])).toEqual([
      [true, 10n, 3_000n, 1_000n],
      [false, 10n, 4_000n, 0n],
      [false, 10n, 6_000n, 0n],
    ]);
    // No RPC configured in this file: receipt-derived fields stay null instead of guessing.
    t.expect(fills.every((f) => f.makerCount === undefined && f.vwapPNS === undefined)).toBe(true);

    const market = await indexer.Market.getOrThrow("1");
    t.expect(market).toMatchObject({ liveCount: 0, coverCount: 1, sigmaBlkBpsE2: 27, sigmaPosts: 1, warmupBlocks: 200, scale: 1n });

    const stats = await indexer.Stats.getOrThrow("global");
    t.expect(stats).toMatchObject({
      coversTotal: 1,
      coversLive: 0,
      coversArmed: 0,
      coversTriggered: 0,
      coversFinalized: 1,
      owners: 1,
      accounts: 1,
      notionalCoveredCNS: 18_000_000n,
      rentCNS: 20_000n,
      escrowToVaultCNS: 90_000n,
      armCount: 2,
      fillCount: 3,
      triggerNoFillCount: 5,
      armToTriggerCount: 1,
      armToTriggerSum: 6,
      armToTriggerMax: 6,
      firstCoverTx: at(1010).transaction.hash,
      firstTriggerTx: at(1236).transaction.hash,
    });
    // Edges 1, 2, 3, 4, 6, ...: 6 blocks lands in bucket 4.
    t.expect(stats.armToTriggerHist).toEqual([0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0]);
  });

  it("Live fast path and a lapsed arm do not count as arm-to-trigger", async (t) => {
    const indexer = createTestIndexer();
    const fast = coverIdOf(CLONE, 1n, 0n);
    const lapsed = coverIdOf(addr(0xc20e), 1n, 0n);
    await indexer.process({
      chains: {
        143: {
          simulate: [
            ...accountItems(1001),
            ...accountItems(1001, addr(0xc20e), addr(0xb0b)),
            ...listingItems(1002),
            bought(1010, fast),
            bought(1010, lapsed, addr(0xc20e)),
            triggered(1220, 30n, 2_000n, 2_000n, 0n, fast),
            armed(1220, lapsed),
            // trigger() past armTtl: Disarmed(ArmTtlElapsed) then the fast-path fill in the same call.
            { ...M, event: "Disarmed", ...at(1500), params: { coverId: lapsed, reason: 1n } },
            triggered(1500, 30n, 2_000n, 2_000n, 0n, lapsed),
          ],
        },
      },
    });
    const [a, b] = await Promise.all([indexer.Cover.getOrThrow(fast), indexer.Cover.getOrThrow(lapsed)]);
    t.expect([a.status, a.armToTriggerBlocks, a.armCount]).toEqual(["TRIGGERED", undefined, 0]);
    t.expect([b.status, b.armToTriggerBlocks, b.armCount, b.disarmCount]).toEqual(["TRIGGERED", undefined, 1, 1]);
    const stats = await indexer.Stats.getOrThrow("global");
    t.expect([stats.coversTriggered, stats.coversLive, stats.armToTriggerCount, stats.owners]).toEqual([2, 0, 0, 2]);
    // Triggered covers stay in the manager's live set until Finalized.
    t.expect((await indexer.Market.getOrThrow("1")).liveCount).toBe(2);
  });
});
