import { indexer, type Cover, type CoverEvent, type Enum, type Market, type Stats } from "envio";
import { triggerPrints, printsFor } from "../effects/triggerPrints.js";
import { loadAccount } from "../lib/accounts.js";
import { recordAdmin } from "../lib/admin.js";
import {
  TERMINAL,
  armToTriggerBucket,
  ceilDiv,
  coverStatusOf,
  disarmReasonOf,
  endReasonOf,
  jsonParams,
  loadStats,
  logId,
  meta,
  moveStatus,
  toInt,
  type CoverStatus,
  type Ctx,
  type EventMeta,
} from "../lib/common.js";

type Ev = EventMeta & { readonly params: { readonly coverId: string } };
type CoverEventExtra = Partial<Pick<CoverEvent, "actor" | "amountCNS" | "pricePNS" | "refPNS" | "lots" | "reason">>;

function recordCoverEvent(context: Ctx, e: Ev, kind: Enum<"CoverEventKind">, extra: CoverEventExtra = {}): void {
  context.CoverEvent.set({
    id: logId(e),
    cover_id: e.params.coverId,
    kind,
    ...meta(e),
    actor: extra.actor,
    amountCNS: extra.amountCNS,
    pricePNS: extra.pricePNS,
    refPNS: extra.refPNS,
    lots: extra.lots,
    reason: extra.reason,
    params: jsonParams(e.params),
  });
}

function missing(context: Ctx, e: Ev, eventName: string): void {
  // Only possible if start_block is after the cover's purchase: visible in logs, never fatal.
  context.log.error("cover not indexed", { event: eventName, coverId: e.params.coverId, block: e.block.number });
}

/** Applies a status change to the cover, Stats counters and, on a terminal move, the market's liveCount. */
async function transition(context: Ctx, cover: Cover, to: CoverStatus, stats: Stats): Promise<[Cover, Stats]> {
  const from = cover.status;
  if (!TERMINAL.has(from) && TERMINAL.has(to)) {
    const market = await context.Market.get(cover.market_id);
    if (market) context.Market.set({ ...market, liveCount: market.liveCount - 1 });
  }
  return [{ ...cover, status: to }, moveStatus(stats, from, to)];
}

const paramsFields = (p: {
  readonly slipAllowanceBps: bigint;
  readonly maxGapBpsCap: bigint;
  readonly floorSlackBps: bigint;
  readonly refTolBps: bigint;
  readonly minStopDistanceBps: bigint;
  readonly marketCapBps: bigint;
  readonly perBlockPayoutCapBps: bigint;
  readonly maxMatchesClose: bigint;
  readonly warmupBlocks: bigint;
  readonly armTtlBlocks: bigint;
  readonly exclusiveBlocks: bigint;
  readonly windowBlocks: bigint;
  readonly minDurationBlocks: bigint;
  readonly maxDurationBlocks: bigint;
  readonly minFeeCNS: bigint;
  readonly maxCoverNotionalCNS: bigint;
}) => ({
  slipAllowanceBps: toInt(p.slipAllowanceBps, "slipAllowanceBps"),
  maxGapBpsCap: toInt(p.maxGapBpsCap, "maxGapBpsCap"),
  floorSlackBps: toInt(p.floorSlackBps, "floorSlackBps"),
  refTolBps: toInt(p.refTolBps, "refTolBps"),
  minStopDistanceBps: toInt(p.minStopDistanceBps, "minStopDistanceBps"),
  marketCapBps: toInt(p.marketCapBps, "marketCapBps"),
  perBlockPayoutCapBps: toInt(p.perBlockPayoutCapBps, "perBlockPayoutCapBps"),
  maxMatchesClose: toInt(p.maxMatchesClose, "maxMatchesClose"),
  warmupBlocks: toInt(p.warmupBlocks, "warmupBlocks"),
  armTtlBlocks: toInt(p.armTtlBlocks, "armTtlBlocks"),
  exclusiveBlocks: toInt(p.exclusiveBlocks, "exclusiveBlocks"),
  windowBlocks: toInt(p.windowBlocks, "windowBlocks"),
  minDurationBlocks: toInt(p.minDurationBlocks, "minDurationBlocks"),
  maxDurationBlocks: toInt(p.maxDurationBlocks, "maxDurationBlocks"),
  minFeeCNS: p.minFeeCNS,
  maxCoverNotionalCNS: p.maxCoverNotionalCNS,
  params: jsonParams(p),
});

// Markets

indexer.onEvent({ contract: "CoverManager", event: "MarketListed" }, async ({ event, context }) => {
  const id = event.params.perpId.toString();
  const existing = await context.Market.get(id);
  if (context.isPreload) return;
  const cfg = event.params.cfg;
  const perpId = toInt(event.params.perpId, "perpId");
  const blank = paramsFields({
    slipAllowanceBps: 0n, maxGapBpsCap: 0n, floorSlackBps: 0n, refTolBps: 0n, minStopDistanceBps: 0n,
    marketCapBps: 0n, perBlockPayoutCapBps: 0n, maxMatchesClose: 0n, warmupBlocks: 0n, armTtlBlocks: 0n,
    exclusiveBlocks: 0n, windowBlocks: 0n, minDurationBlocks: 0n, maxDurationBlocks: 0n, minFeeCNS: 0n,
    maxCoverNotionalCNS: 0n,
  });
  const market: Market = {
    ...blank,
    paramsUpdatedBlock: event.block.number,
    sigmaBlkBpsE2: undefined,
    sigmaPostedBlock: undefined,
    sigmaPosts: 0,
    paused: false,
    liveCount: 0,
    coverCount: 0,
    // Keep anything a pre-listing SigmaPosted may have set (should not happen: listing comes first).
    ...existing,
    id,
    perpId,
    priceDecimals: toInt(cfg.priceDecimals, "priceDecimals"),
    lotDecimals: toInt(cfg.lotDecimals, "lotDecimals"),
    scale: cfg.scale,
    feed: cfg.feed,
    feedDecimals: toInt(cfg.feedDecimals, "feedDecimals"),
    creRefStore: cfg.creRefStore,
    listedBlock: event.block.number,
    listedTx: event.transaction.hash,
  };
  context.Market.set(market);
  recordAdmin(context, event, "CoverManager", "MarketListed", { perpId });
});

indexer.onEvent({ contract: "CoverManager", event: "MarketParamsSet" }, async ({ event, context }) => {
  const market = await context.Market.get(event.params.perpId.toString());
  if (context.isPreload) return;
  const perpId = toInt(event.params.perpId, "perpId");
  recordAdmin(context, event, "CoverManager", "MarketParamsSet", { perpId });
  if (!market) {
    context.log.error("MarketParamsSet for unknown market", { perpId });
    return;
  }
  context.Market.set({ ...market, ...paramsFields(event.params.newP), paramsUpdatedBlock: event.block.number });
});

indexer.onEvent({ contract: "CoverManager", event: "SigmaPosted" }, async ({ event, context }) => {
  const market = await context.Market.get(event.params.perpId.toString());
  if (context.isPreload) return;
  if (!market) {
    context.log.error("SigmaPosted for unknown market", { perpId: event.params.perpId.toString() });
    return;
  }
  context.Market.set({
    ...market,
    sigmaBlkBpsE2: toInt(event.params.sigmaBlkBpsE2, "sigmaBlkBpsE2"),
    sigmaPostedBlock: toInt(event.params.blockNumber, "blockNumber"),
    sigmaPosts: market.sigmaPosts + 1,
  });
});

indexer.onEvent({ contract: "CoverManager", event: "MarketPauseSet" }, async ({ event, context }) => {
  const market = await context.Market.get(event.params.perpId.toString());
  if (context.isPreload) return;
  const perpId = toInt(event.params.perpId, "perpId");
  recordAdmin(context, event, "CoverManager", "MarketPauseSet", { perpId });
  if (market) context.Market.set({ ...market, paused: event.params.paused });
  else context.log.error("MarketPauseSet for unknown market", { perpId });
});

// Cover lifecycle

indexer.onEvent({ contract: "CoverManager", event: "CoverBought" }, async ({ event, context }) => {
  const p = event.params;
  const [market, account, stats] = await Promise.all([
    context.Market.get(p.perpId.toString()),
    loadAccount(context, p.account, event),
    loadStats(context),
  ]);
  if (context.isPreload) return;
  if (!market) context.log.error("CoverBought on unknown market", { perpId: p.perpId.toString(), coverId: p.coverId });
  const notional = p.lots * p.stopPNS * (market?.scale ?? 0n);
  const m = meta(event);
  context.Cover.set({
    id: p.coverId,
    account_id: p.account,
    owner: account.owner || undefined,
    market_id: p.perpId.toString(),
    perpId: toInt(p.perpId, "perpId"),
    side: p.isLong ? "LONG" : "SHORT",
    lots: p.lots,
    initialLots: p.lots,
    stopPNS: p.stopPNS,
    maxGapBps: toInt(p.maxGapBps, "maxGapBps"),
    notionalCNS: notional,
    escrowCNS: p.escrowCNS,
    rentCNS: p.rentCNS,
    capCNS: p.capCNS,
    expiryBlock: toInt(p.expiryBlock, "expiryBlock"),
    status: "LIVE",
    endReason: "NONE",
    observed: false,
    armedBlock: undefined,
    armer: undefined,
    armCount: 0,
    disarmCount: 0,
    noFillCount: 0,
    triggerBlock: undefined,
    refTrigPNS: undefined,
    refPostPNS: undefined,
    refFinalPNS: undefined,
    armToTriggerBlocks: undefined,
    filledLots: 0n,
    gRealCumCNS: 0n,
    paidCNS: 0n,
    owedCNS: 0n,
    refundCNS: 0n,
    escrowForfeitedCNS: 0n,
    escrowToVaultCNS: 0n,
    boughtBlock: m.blockNumber,
    boughtTimestamp: m.timestamp,
    boughtTx: m.txHash,
    endedBlock: undefined,
    endedTimestamp: undefined,
    endedTx: undefined,
    updatedBlock: m.blockNumber,
  });
  recordCoverEvent(context, event, "BOUGHT", { amountCNS: p.escrowCNS + p.rentCNS, lots: p.lots, pricePNS: p.stopPNS });
  if (market) context.Market.set({ ...market, liveCount: market.liveCount + 1, coverCount: market.coverCount + 1 });
  context.GaplessAccountEntity.set({ ...account, coverCount: account.coverCount + 1 });
  const next = moveStatus(stats, undefined, "LIVE");
  context.Stats.set({
    ...next,
    coversTotal: stats.coversTotal + 1,
    owners: stats.owners + (account.coverCount === 0 ? 1 : 0),
    notionalCoveredCNS: stats.notionalCoveredCNS + notional,
    rentCNS: stats.rentCNS + p.rentCNS,
    firstCoverTx: stats.firstCoverTx ?? m.txHash,
    updatedBlock: m.blockNumber,
  });
});

indexer.onEvent({ contract: "CoverManager", event: "CoverResized" }, async ({ event, context }) => {
  const cover = await context.Cover.get(event.params.coverId);
  if (context.isPreload) return;
  if (!cover) return missing(context, event, "CoverResized");
  const { newLots, releasedCapCNS, refundCNS } = event.params;
  // PayoutMath.resize: escrow keeps ceil(escrow x newLots / oldLots).
  const escrow = cover.lots === 0n ? 0n : ceilDiv(cover.escrowCNS * newLots, cover.lots);
  context.Cover.set({
    ...cover,
    lots: newLots,
    capCNS: cover.capCNS - releasedCapCNS,
    escrowCNS: escrow,
    refundCNS: cover.refundCNS + refundCNS,
    updatedBlock: event.block.number,
  });
  recordCoverEvent(context, event, "RESIZED", { lots: newLots, amountCNS: refundCNS });
});

indexer.onEvent({ contract: "CoverManager", event: "Armed" }, async ({ event, context }) => {
  const [cover, stats] = await Promise.all([context.Cover.get(event.params.coverId), loadStats(context)]);
  if (context.isPreload) return;
  if (!cover) return missing(context, event, "Armed");
  const [next, s] = await transition(context, cover, "ARMED", stats);
  context.Cover.set({
    ...next,
    armedBlock: toInt(event.params.blockNumber, "blockNumber"),
    armer: event.params.armer,
    armCount: cover.armCount + 1,
    updatedBlock: event.block.number,
  });
  context.Stats.set({ ...s, armCount: s.armCount + 1, updatedBlock: event.block.number });
  recordCoverEvent(context, event, "ARMED", {
    actor: event.params.armer,
    pricePNS: event.params.bookPNS,
    refPNS: event.params.refPNS,
  });
});

indexer.onEvent({ contract: "CoverManager", event: "Disarmed" }, async ({ event, context }) => {
  const [cover, stats] = await Promise.all([context.Cover.get(event.params.coverId), loadStats(context)]);
  if (context.isPreload) return;
  if (!cover) return missing(context, event, "Disarmed");
  const reason = disarmReasonOf(event.params.reason);
  const [next, s] = await transition(context, cover, "LIVE", stats);
  context.Cover.set({ ...next, disarmCount: cover.disarmCount + 1, updatedBlock: event.block.number });
  context.Stats.set({ ...s, updatedBlock: event.block.number });
  recordCoverEvent(context, event, "DISARMED", { reason });
});

indexer.onEvent({ contract: "CoverManager", event: "TriggerNoFill" }, async ({ event, context }) => {
  const [cover, stats] = await Promise.all([context.Cover.get(event.params.coverId), loadStats(context)]);
  if (context.isPreload) return;
  if (!cover) return missing(context, event, "TriggerNoFill");
  context.Cover.set({ ...cover, noFillCount: cover.noFillCount + 1, updatedBlock: event.block.number });
  context.Stats.set({ ...stats, triggerNoFillCount: stats.triggerNoFillCount + 1, updatedBlock: event.block.number });
  recordCoverEvent(context, event, "TRIGGER_NO_FILL", { pricePNS: event.params.limitPNS });
});

indexer.onEvent({ contract: "CoverManager", event: "Triggered" }, async ({ event, context }) => {
  const p = event.params;
  const [cover, stats, receipt] = await Promise.all([
    context.Cover.get(p.coverId),
    loadStats(context),
    context.effect(triggerPrints, { txHash: event.transaction.hash, manager: event.srcAddress }),
  ]);
  if (context.isPreload) return;
  if (!cover) return missing(context, event, "Triggered");
  const block = toInt(p.blockNumber, "blockNumber");
  const isFirst = cover.triggerBlock === undefined;
  let next: Cover = cover;
  let s: Stats = stats;
  if (isFirst) {
    // An arm that lapsed was already disarmed by the contract (status LIVE here): that is the fast path, not arm-to-trigger.
    const armToTrigger = cover.status === "ARMED" && cover.armedBlock !== undefined ? block - cover.armedBlock : undefined;
    [next, s] = await transition(context, cover, "TRIGGERED", stats);
    next = { ...next, triggerBlock: block, refTrigPNS: p.refTrigPNS, armToTriggerBlocks: armToTrigger };
    if (armToTrigger !== undefined) {
      const hist = [...s.armToTriggerHist];
      const b = armToTriggerBucket(armToTrigger);
      hist[b] = (hist[b] ?? 0) + 1;
      s = {
        ...s,
        armToTriggerCount: s.armToTriggerCount + 1,
        armToTriggerSum: s.armToTriggerSum + armToTrigger,
        armToTriggerMax: Math.max(s.armToTriggerMax, armToTrigger),
        armToTriggerHist: hist,
      };
    }
    s = { ...s, firstTriggerTx: s.firstTriggerTx ?? event.transaction.hash };
  }
  context.Cover.set({
    ...next,
    filledLots: cover.filledLots + p.filledLots,
    gRealCumCNS: p.gRealCumCNS,
    paidCNS: cover.paidCNS + p.paidNowCNS,
    owedCNS: p.owedCNS,
    updatedBlock: event.block.number,
  });
  context.Stats.set({ ...s, fillCount: s.fillCount + 1, updatedBlock: event.block.number });

  const fillId = logId(event);
  const prints = receipt ? printsFor(receipt, event.logIndex, p.perpId) : undefined;
  const printLots = prints?.reduce((acc, f) => acc + f.lotLNS, 0n);
  const notional = prints?.reduce((acc, f) => acc + f.pricePNS * f.lotLNS, 0n);
  context.Fill.set({
    id: fillId,
    cover_id: p.coverId,
    perpId: toInt(p.perpId, "perpId"),
    isFirst,
    ...meta(event),
    filledLots: p.filledLots,
    realizedCNS: p.realizedCNS,
    gRealCumCNS: p.gRealCumCNS,
    refTrigPNS: p.refTrigPNS,
    paidNowCNS: p.paidNowCNS,
    owedCNS: p.owedCNS,
    makerCount: prints?.length,
    printLots,
    vwapPNS: printLots && notional !== undefined ? notional / printLots : undefined,
  });
  for (const f of prints ?? []) {
    context.TriggerPrint.set({
      id: `${event.block.number}-${f.logIndex}`,
      fill_id: fillId,
      cover_id: p.coverId,
      perpId: toInt(f.perpId, "perpId"),
      makerAccountId: f.accountId,
      orderId: f.orderId,
      pricePNS: f.pricePNS,
      lotLNS: f.lotLNS,
      blockNumber: event.block.number,
      txHash: event.transaction.hash,
      logIndex: f.logIndex,
    });
  }
  recordCoverEvent(context, event, "TRIGGERED", { amountCNS: p.paidNowCNS, lots: p.filledLots, refPNS: p.refTrigPNS });
});

indexer.onEvent({ contract: "CoverManager", event: "Observed" }, async ({ event, context }) => {
  const cover = await context.Cover.get(event.params.coverId);
  if (context.isPreload) return;
  if (!cover) return missing(context, event, "Observed");
  context.Cover.set({ ...cover, observed: true, refPostPNS: event.params.refPostPNS, updatedBlock: event.block.number });
  recordCoverEvent(context, event, "OBSERVED", { refPNS: event.params.refPostPNS });
});

indexer.onEvent({ contract: "CoverManager", event: "Finalized" }, async ({ event, context }) => {
  const [cover, stats] = await Promise.all([context.Cover.get(event.params.coverId), loadStats(context)]);
  if (cover) await context.Market.get(cover.market_id); // preload for transition()
  if (context.isPreload) return;
  if (!cover) return missing(context, event, "Finalized");
  const p = event.params;
  const [next, s] = await transition(context, cover, "FINALIZED", stats);
  // PayoutMath.escrowSplit: the account gets escrow - toVault back.
  const refund = cover.escrowCNS > p.escrowToVaultCNS ? cover.escrowCNS - p.escrowToVaultCNS : 0n;
  context.Cover.set({
    ...next,
    paidCNS: p.totalPaidCNS,
    owedCNS: 0n,
    refFinalPNS: p.refFinalPNS,
    escrowToVaultCNS: p.escrowToVaultCNS,
    refundCNS: cover.refundCNS + refund,
    endedBlock: event.block.number,
    endedTimestamp: event.block.timestamp,
    endedTx: event.transaction.hash,
    updatedBlock: event.block.number,
  });
  context.Stats.set({ ...s, escrowToVaultCNS: s.escrowToVaultCNS + p.escrowToVaultCNS, updatedBlock: event.block.number });
  recordCoverEvent(context, event, "FINALIZED", { amountCNS: p.topUpCNS, refPNS: p.refFinalPNS });
});

indexer.onEvent({ contract: "CoverManager", event: "CoverEnded" }, async ({ event, context }) => {
  const [cover, stats] = await Promise.all([context.Cover.get(event.params.coverId), loadStats(context)]);
  if (cover) await context.Market.get(cover.market_id); // preload for transition()
  if (context.isPreload) return;
  if (!cover) return missing(context, event, "CoverEnded");
  const status = coverStatusOf(event.params.status);
  const reason = endReasonOf(event.params.reason);
  const [next, s] = await transition(context, cover, status, stats);
  context.Cover.set({
    ...next,
    endReason: reason,
    refundCNS: cover.refundCNS + event.params.refundCNS,
    endedBlock: event.block.number,
    endedTimestamp: event.block.timestamp,
    endedTx: event.transaction.hash,
    updatedBlock: event.block.number,
  });
  context.Stats.set({ ...s, updatedBlock: event.block.number });
  recordCoverEvent(context, event, "ENDED", { amountCNS: event.params.refundCNS, reason });
});

indexer.onEvent({ contract: "CoverManager", event: "PayoutDeferred" }, async ({ event, context }) => {
  const cover = await context.Cover.get(event.params.coverId);
  if (context.isPreload) return;
  if (!cover) return missing(context, event, "PayoutDeferred");
  context.Cover.set({ ...cover, owedCNS: event.params.owedCNS, updatedBlock: event.block.number });
  recordCoverEvent(context, event, "PAYOUT_DEFERRED", { amountCNS: event.params.owedCNS });
});

indexer.onEvent({ contract: "CoverManager", event: "EscrowForfeited" }, async ({ event, context }) => {
  const [cover, stats] = await Promise.all([context.Cover.get(event.params.coverId), loadStats(context)]);
  if (context.isPreload) return;
  if (!cover) return missing(context, event, "EscrowForfeited");
  const amount = event.params.amountCNS;
  context.Cover.set({ ...cover, escrowForfeitedCNS: cover.escrowForfeitedCNS + amount, updatedBlock: event.block.number });
  context.Stats.set({ ...stats, escrowToVaultCNS: stats.escrowToVaultCNS + amount, updatedBlock: event.block.number });
  recordCoverEvent(context, event, "ESCROW_FORFEITED", { amountCNS: amount });
});

// Refund ledger (frozen-AUSD fallback, L-05)

indexer.onEvent({ contract: "CoverManager", event: "RefundOwed" }, async ({ event, context }) => {
  const account = await loadAccount(context, event.params.account, event);
  if (context.isPreload) return;
  context.GaplessAccountEntity.set({ ...account, refundOwedCNS: account.refundOwedCNS + event.params.amountCNS });
});

indexer.onEvent({ contract: "CoverManager", event: "RefundClaimed" }, async ({ event, context }) => {
  const account = await loadAccount(context, event.params.account, event);
  if (context.isPreload) return;
  const amount = event.params.amountCNS;
  context.GaplessAccountEntity.set({
    ...account,
    refundOwedCNS: account.refundOwedCNS > amount ? account.refundOwedCNS - amount : 0n,
    refundClaimedCNS: account.refundClaimedCNS + amount,
  });
});

// Admin

indexer.onEvent({ contract: "CoverManager", event: "FactorySet" }, async ({ event, context }) => {
  if (context.isPreload) return;
  recordAdmin(context, event, "CoverManager", "FactorySet", { account: event.params.factory });
});

indexer.onEvent({ contract: "CoverManager", event: "Paused" }, async ({ event, context }) => {
  if (context.isPreload) return;
  recordAdmin(context, event, "CoverManager", "Paused", { account: event.params.account });
});

indexer.onEvent({ contract: "CoverManager", event: "Unpaused" }, async ({ event, context }) => {
  if (context.isPreload) return;
  recordAdmin(context, event, "CoverManager", "Unpaused", { account: event.params.account });
});

indexer.onEvent({ contract: "CoverManager", event: "RoleGranted" }, async ({ event, context }) => {
  if (context.isPreload) return;
  recordAdmin(context, event, "CoverManager", "RoleGranted", { account: event.params.account, role: event.params.role });
});

indexer.onEvent({ contract: "CoverManager", event: "RoleRevoked" }, async ({ event, context }) => {
  if (context.isPreload) return;
  recordAdmin(context, event, "CoverManager", "RoleRevoked", { account: event.params.account, role: event.params.role });
});

indexer.onEvent(
  { contract: "CoverManager", event: "DefaultAdminTransferScheduled" },
  async ({ event, context }) => {
    if (context.isPreload) return;
    recordAdmin(context, event, "CoverManager", "DefaultAdminTransferScheduled", { account: event.params.newAdmin });
  },
);
