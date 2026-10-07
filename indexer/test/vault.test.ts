import { describe, it } from "vitest";
import { createTestIndexer } from "envio";
import { CLONE, DEAD, LP, TREASURY, VAULT, ZERO, addr, at } from "./helpers.js";

const V = { contract: "CoverVault" as const };
const LP2 = addr(0x2b);
const DEPLOYER = addr(0xde9);
// decimalsOffset 6: one CNS of assets mints 1e6 shares at par.
const sh = (cns: bigint) => cns * 1_000_000n;

const mint = (block: number, to: `0x${string}`, assets: bigint, sender = to) => [
  { ...V, event: "Transfer" as const, ...at(block), params: { from: ZERO, to, value: sh(assets) } },
  { ...V, event: "Deposit" as const, ...at(block), params: { sender, owner: to, assets, shares: sh(assets) } },
];
const request = (block: number, owner: `0x${string}`, requestId: bigint, assets: bigint) => [
  { ...V, event: "Transfer" as const, ...at(block), params: { from: owner, to: VAULT, value: sh(assets) } },
  {
    ...V,
    event: "RedeemRequested" as const,
    ...at(block),
    params: { owner, requestId, shares: sh(assets), assetsAtRequest: assets, claimableBlock: BigInt(block + 48_300) },
  },
];
const claim = (block: number, owner: `0x${string}`, requestId: bigint, assets: bigint) => [
  { ...V, event: "Transfer" as const, ...at(block), params: { from: VAULT, to: ZERO, value: sh(assets) } },
  { ...V, event: "RedeemClaimed" as const, ...at(block), params: { owner, requestId, receiver: owner, assets, shares: sh(assets) } },
];

describe("vault mirror", () => {
  it("tracks gross assets, owed, reserved, utilization, LPs and redeem requests like CoverVault", async (t) => {
    const indexer = createTestIndexer();
    await indexer.process({
      chains: {
        143: {
          simulate: [
            ...mint(1000, DEAD, 1_000_000n, DEPLOYER), // constructor seed
            { ...V, event: "ManagerSet", ...at(1001), params: { manager: addr(0xc01), factory: addr(0xc03) } },
            ...mint(1002, LP, 3_000_000n),
            ...mint(1003, LP2, 1_000_000n),
            { ...V, event: "Reserved", ...at(1010), params: { perpId: 1n, amountCNS: 360_000n, reservedTotalCNS: 360_000n } },
            { ...V, event: "PremiumReceived", ...at(1011), params: { amountCNS: 20_000n, toLpsCNS: 18_000n, toTreasuryCNS: 2_000n } },
            { ...V, event: "Paid", ...at(1012), params: { perpId: 1n, account: CLONE, amountCNS: 3_000n } },
            { ...V, event: "OwedUpdated", ...at(1012), params: { owedTotalCNS: 1_000n } },
          ],
        },
      },
    });

    let s = await indexer.Stats.getOrThrow("global");
    t.expect(s).toMatchObject({
      vaultDeployTx: at(1000).transaction.hash,
      vaultGrossAssetsCNS: 5_015_000n, // 1 + 3 + 1 AUSD + 18,000 to LPs - 3,000 paid
      vaultTotalAssetsCNS: 5_014_000n, // net of owed
      vaultReservedTotalCNS: 357_000n, // payCapped consumes the reservation
      vaultUtilizationBps: 711, // floor(357,000 x 1e4 / 5,015,000)
      owedCNS: 1_000n,
      payoutCount: 1,
      paidCNS: 3_000n,
      premiumReceivedCNS: 20_000n,
      premiumToLpsCNS: 18_000n,
      premiumToTreasuryCNS: 2_000n,
      lpCount: 2, // 0xdead seed excluded
    });

    await indexer.process({
      chains: {
        143: {
          simulate: [
            { ...V, event: "OwedUpdated", ...at(1020), params: { owedTotalCNS: 0n } },
            { ...V, event: "Paid", ...at(1020), params: { perpId: 1n, account: CLONE, amountCNS: 1_000n } },
            { ...V, event: "Released", ...at(1021), params: { perpId: 1n, amountCNS: 356_000n, reservedTotalCNS: 0n } },
            ...request(1030, LP, 0n, 1_000_000n), // partial: LP keeps 2 AUSD of shares
            ...request(1031, LP2, 1n, 1_000_000n), // full exit
            { ...V, event: "ConfigSet", ...at(1040), params: {
              oldConfig: { treasury: TREASURY, maxUtilizationBps: 8000n, protocolFeeBps: 1000n, minDepositCNS: 1_000_000n },
              newConfig: { treasury: TREASURY, maxUtilizationBps: 8000n, protocolFeeBps: 500n, minDepositCNS: 1_000_000n },
            } },
          ],
        },
      },
    });
    s = await indexer.Stats.getOrThrow("global");
    // LP2's shares sit in escrow until the claim, so both LPs still count.
    t.expect([s.lpCount, s.vaultGrossAssetsCNS, s.vaultReservedTotalCNS, s.vaultUtilizationBps]).toEqual([2, 5_014_000n, 0n, 0]);

    await indexer.process({
      // Jump past the 48,300-block cooldown without walking every block.
      chains: { 143: { startBlock: 49_400, simulate: [...claim(49_400, LP, 0n, 1_000_000n), ...claim(49_431, LP2, 1n, 1_000_000n)] } },
    });
    s = await indexer.Stats.getOrThrow("global");
    t.expect([s.lpCount, s.vaultGrossAssetsCNS, s.vaultTotalAssetsCNS]).toEqual([1, 3_014_000n, 3_014_000n]);

    const get = (id: string) => indexer.LiquidityProvider.getOrThrow(id);
    const [lp, lp2, dead] = await Promise.all([get(LP), get(LP2), get(DEAD)]);
    t.expect([lp.shares, lp.escrowedShares, lp.depositedCNS, lp.claimedCNS, lp.redeemRequests]).toEqual([
      sh(2_000_000n), 0n, 3_000_000n, 1_000_000n, 1,
    ]);
    t.expect([lp2.shares, lp2.escrowedShares, lp2.claimedCNS]).toEqual([0n, 0n, 1_000_000n]);
    t.expect(dead.shares).toBe(sh(1_000_000n));

    const req = await indexer.RedeemRequest.getOrThrow("1");
    t.expect(req).toMatchObject({ lp_id: LP2, claimed: true, claimedAssetsCNS: 1_000_000n, claimedBlock: 49_431, claimableBlock: 1031 + 48_300 });

    const flows = await indexer.VaultFlow.getAll();
    const kinds = flows.reduce<Record<string, number>>((acc, f) => ({ ...acc, [f.kind]: (acc[f.kind] ?? 0) + 1 }), {});
    t.expect(kinds).toEqual({ DEPOSIT: 3, RESERVED: 1, PREMIUM: 1, PAID: 2, RELEASED: 1, REDEEM_REQUESTED: 2, REDEEM_CLAIMED: 2 });
    const admin = (await indexer.AdminEvent.getAll()).map((a) => [a.contract, a.kind]).sort();
    t.expect(admin).toEqual([["CoverVault", "ConfigSet"], ["CoverVault", "ManagerSet"]]);
  });
});
