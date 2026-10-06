import { indexer, type Enum, type LiquidityProvider, type Stats } from "envio";
import { recordAdmin } from "../lib/admin.js";
import {
  DEAD_ADDRESS,
  ZERO_ADDRESS,
  loadStats,
  logId,
  meta,
  toInt,
  withVaultTotals,
  type Ctx,
  type EventMeta,
} from "../lib/common.js";

// Vault accounting mirrored from CoverVault.sol: gross _assets += Deposit, += PremiumReceived.toLps,
// -= Paid, -= RedeemClaimed; owedTotal from OwedUpdated; reservedTotal from Reserved/Released, -= Paid.

function newLp(id: string, block: number): LiquidityProvider {
  return {
    id,
    shares: 0n,
    escrowedShares: 0n,
    depositedCNS: 0n,
    claimedCNS: 0n,
    deposits: 0,
    redeemRequests: 0,
    firstDepositBlock: undefined,
    lastActivityBlock: block,
  };
}

const loadLp = async (context: Ctx, id: string, block: number) =>
  (await context.LiquidityProvider.get(id)) ?? newLp(id, block);

const isActive = (lp: LiquidityProvider) => lp.id !== DEAD_ADDRESS && lp.shares + lp.escrowedShares > 0n;

/** lpCount delta when an LP row changes. */
const lpDelta = (before: LiquidityProvider, after: LiquidityProvider) => Number(isActive(after)) - Number(isActive(before));

type FlowExtra = {
  account?: string;
  perpId?: number;
  shares?: bigint;
  requestId?: bigint;
  toLpsCNS?: bigint;
  toTreasuryCNS?: bigint;
};

function recordFlow(context: Ctx, e: EventMeta, kind: Enum<"VaultFlowKind">, assets: bigint, s: Stats, x: FlowExtra = {}) {
  context.VaultFlow.set({
    id: logId(e),
    kind,
    account: x.account,
    perpId: x.perpId,
    assetsCNS: assets,
    shares: x.shares,
    requestId: x.requestId,
    toLpsCNS: x.toLpsCNS,
    toTreasuryCNS: x.toTreasuryCNS,
    grossAssetsAfterCNS: s.vaultGrossAssetsCNS,
    totalAssetsAfterCNS: s.vaultTotalAssetsCNS,
    reservedTotalAfterCNS: s.vaultReservedTotalCNS,
    ...meta(e),
  });
}

function saveStats(context: Ctx, s: Stats, block: number): Stats {
  const next = withVaultTotals({ ...s, updatedBlock: block });
  if (next.vaultUtilizationBps > 10_000) {
    // reservedTotal <= gross assets onchain; above 100% the mirror has drifted.
    context.log.error("vault mirror drift: utilization above 100%", {
      reserved: next.vaultReservedTotalCNS.toString(),
      gross: next.vaultGrossAssetsCNS.toString(),
    });
  }
  context.Stats.set(next);
  return next;
}

indexer.onEvent({ contract: "CoverVault", event: "Deposit" }, async ({ event, context }) => {
  const { owner, assets, shares } = event.params;
  const [lp, stats] = await Promise.all([loadLp(context, owner, event.block.number), loadStats(context)]);
  if (context.isPreload) return;
  context.LiquidityProvider.set({
    ...lp,
    depositedCNS: lp.depositedCNS + assets,
    deposits: lp.deposits + 1,
    firstDepositBlock: lp.firstDepositBlock ?? event.block.number,
    lastActivityBlock: event.block.number,
  });
  // The constructor's seed deposit to 0xdead is the vault's first log.
  const vaultDeployTx = stats.vaultDeployTx ?? (owner === DEAD_ADDRESS ? event.transaction.hash : undefined);
  const s = saveStats(context, { ...stats, vaultGrossAssetsCNS: stats.vaultGrossAssetsCNS + assets, vaultDeployTx }, event.block.number);
  recordFlow(context, event, "DEPOSIT", assets, s, { account: owner, shares });
});

indexer.onEvent({ contract: "CoverVault", event: "Withdraw" }, async ({ event, context }) => {
  const stats = await loadStats(context);
  if (context.isPreload) return;
  // withdraw/redeem revert AsyncOnly, so this should never fire; record it without touching the mirror.
  context.log.error("unexpected vault Withdraw", { tx: event.transaction.hash });
  recordFlow(context, event, "WITHDRAW", event.params.assets, stats, { account: event.params.owner, shares: event.params.shares });
});

indexer.onEvent({ contract: "CoverVault", event: "Transfer" }, async ({ event, context }) => {
  const { from, to, value } = event.params;
  const vault = event.srcAddress;
  // Mints, burns and request escrow only (shares are non-transferable); escrow is tracked by the redeem events.
  const fromLp = from !== ZERO_ADDRESS && from !== vault;
  const toLp = to !== ZERO_ADDRESS && to !== vault;
  const [a, b, stats] = await Promise.all([
    fromLp ? loadLp(context, from, event.block.number) : undefined,
    toLp ? loadLp(context, to, event.block.number) : undefined,
    loadStats(context),
  ]);
  if (context.isPreload) return;
  let delta = 0;
  if (a) {
    const next = { ...a, shares: a.shares - value, lastActivityBlock: event.block.number };
    delta += lpDelta(a, next);
    context.LiquidityProvider.set(next);
  }
  if (b) {
    const next = { ...b, shares: b.shares + value, lastActivityBlock: event.block.number };
    delta += lpDelta(b, next);
    context.LiquidityProvider.set(next);
  }
  if (delta !== 0) context.Stats.set({ ...stats, lpCount: stats.lpCount + delta, updatedBlock: event.block.number });
});

indexer.onEvent({ contract: "CoverVault", event: "RedeemRequested" }, async ({ event, context }) => {
  const { owner, requestId, shares, assetsAtRequest, claimableBlock } = event.params;
  const [lp, stats] = await Promise.all([loadLp(context, owner, event.block.number), loadStats(context)]);
  if (context.isPreload) return;
  const next = {
    ...lp,
    escrowedShares: lp.escrowedShares + shares,
    redeemRequests: lp.redeemRequests + 1,
    lastActivityBlock: event.block.number,
  };
  context.LiquidityProvider.set(next);
  context.RedeemRequest.set({
    id: requestId.toString(),
    requestId,
    lp_id: owner,
    shares,
    assetsAtRequestCNS: assetsAtRequest,
    claimableBlock: toInt(claimableBlock, "claimableBlock"),
    requestedBlock: event.block.number,
    requestedTimestamp: event.block.timestamp,
    requestTx: event.transaction.hash,
    claimed: false,
    claimedAssetsCNS: undefined,
    receiver: undefined,
    claimedBlock: undefined,
    claimTx: undefined,
  });
  const s = saveStats(context, { ...stats, lpCount: stats.lpCount + lpDelta(lp, next) }, event.block.number);
  recordFlow(context, event, "REDEEM_REQUESTED", assetsAtRequest, s, { account: owner, shares, requestId });
});

indexer.onEvent({ contract: "CoverVault", event: "RedeemClaimed" }, async ({ event, context }) => {
  const { owner, requestId, receiver, assets, shares } = event.params;
  const [lp, request, stats] = await Promise.all([
    loadLp(context, owner, event.block.number),
    context.RedeemRequest.get(requestId.toString()),
    loadStats(context),
  ]);
  if (context.isPreload) return;
  const next = {
    ...lp,
    escrowedShares: lp.escrowedShares - shares,
    claimedCNS: lp.claimedCNS + assets,
    lastActivityBlock: event.block.number,
  };
  context.LiquidityProvider.set(next);
  if (request) {
    context.RedeemRequest.set({
      ...request,
      claimed: true,
      claimedAssetsCNS: assets,
      receiver,
      claimedBlock: event.block.number,
      claimTx: event.transaction.hash,
    });
  } else {
    context.log.error("RedeemClaimed for unknown request", { requestId: requestId.toString() });
  }
  const s = saveStats(
    context,
    { ...stats, lpCount: stats.lpCount + lpDelta(lp, next), vaultGrossAssetsCNS: stats.vaultGrossAssetsCNS - assets },
    event.block.number,
  );
  recordFlow(context, event, "REDEEM_CLAIMED", assets, s, { account: owner, shares, requestId });
});

indexer.onEvent({ contract: "CoverVault", event: "Reserved" }, async ({ event, context }) => {
  const stats = await loadStats(context);
  if (context.isPreload) return;
  const s = saveStats(context, { ...stats, vaultReservedTotalCNS: event.params.reservedTotalCNS }, event.block.number);
  recordFlow(context, event, "RESERVED", event.params.amountCNS, s, { perpId: toInt(event.params.perpId, "perpId") });
});

indexer.onEvent({ contract: "CoverVault", event: "Released" }, async ({ event, context }) => {
  const stats = await loadStats(context);
  if (context.isPreload) return;
  const s = saveStats(context, { ...stats, vaultReservedTotalCNS: event.params.reservedTotalCNS }, event.block.number);
  recordFlow(context, event, "RELEASED", event.params.amountCNS, s, { perpId: toInt(event.params.perpId, "perpId") });
});

indexer.onEvent({ contract: "CoverVault", event: "Paid" }, async ({ event, context }) => {
  const { perpId, account, amountCNS } = event.params;
  const stats = await loadStats(context);
  if (context.isPreload) return;
  const s = saveStats(
    context,
    {
      ...stats,
      payoutCount: stats.payoutCount + 1,
      paidCNS: stats.paidCNS + amountCNS,
      vaultGrossAssetsCNS: stats.vaultGrossAssetsCNS - amountCNS,
      vaultReservedTotalCNS: stats.vaultReservedTotalCNS - amountCNS,
    },
    event.block.number,
  );
  recordFlow(context, event, "PAID", amountCNS, s, { account, perpId: toInt(perpId, "perpId") });
});

indexer.onEvent({ contract: "CoverVault", event: "PremiumReceived" }, async ({ event, context }) => {
  const { amountCNS, toLpsCNS, toTreasuryCNS } = event.params;
  const stats = await loadStats(context);
  if (context.isPreload) return;
  const s = saveStats(
    context,
    {
      ...stats,
      premiumReceivedCNS: stats.premiumReceivedCNS + amountCNS,
      premiumToLpsCNS: stats.premiumToLpsCNS + toLpsCNS,
      premiumToTreasuryCNS: stats.premiumToTreasuryCNS + toTreasuryCNS,
      vaultGrossAssetsCNS: stats.vaultGrossAssetsCNS + toLpsCNS,
    },
    event.block.number,
  );
  recordFlow(context, event, "PREMIUM", amountCNS, s, { toLpsCNS, toTreasuryCNS });
});

indexer.onEvent({ contract: "CoverVault", event: "OwedUpdated" }, async ({ event, context }) => {
  const stats = await loadStats(context);
  if (context.isPreload) return;
  saveStats(context, { ...stats, owedCNS: event.params.owedTotalCNS }, event.block.number);
});

// Admin

indexer.onEvent({ contract: "CoverVault", event: "ConfigSet" }, async ({ event, context }) => {
  if (context.isPreload) return;
  recordAdmin(context, event, "CoverVault", "ConfigSet", { account: event.params.newConfig.treasury });
});

indexer.onEvent({ contract: "CoverVault", event: "ManagerSet" }, async ({ event, context }) => {
  if (context.isPreload) return;
  recordAdmin(context, event, "CoverVault", "ManagerSet", { account: event.params.manager });
});

indexer.onEvent({ contract: "CoverVault", event: "Paused" }, async ({ event, context }) => {
  if (context.isPreload) return;
  recordAdmin(context, event, "CoverVault", "Paused", { account: event.params.account });
});

indexer.onEvent({ contract: "CoverVault", event: "Unpaused" }, async ({ event, context }) => {
  if (context.isPreload) return;
  recordAdmin(context, event, "CoverVault", "Unpaused", { account: event.params.account });
});

indexer.onEvent({ contract: "CoverVault", event: "RoleGranted" }, async ({ event, context }) => {
  if (context.isPreload) return;
  recordAdmin(context, event, "CoverVault", "RoleGranted", { account: event.params.account, role: event.params.role });
});

indexer.onEvent({ contract: "CoverVault", event: "RoleRevoked" }, async ({ event, context }) => {
  if (context.isPreload) return;
  recordAdmin(context, event, "CoverVault", "RoleRevoked", { account: event.params.account, role: event.params.role });
});

indexer.onEvent(
  { contract: "CoverVault", event: "DefaultAdminTransferScheduled" },
  async ({ event, context }) => {
    if (context.isPreload) return;
    recordAdmin(context, event, "CoverVault", "DefaultAdminTransferScheduled", { account: event.params.newAdmin });
  },
);
