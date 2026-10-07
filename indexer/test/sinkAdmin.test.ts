import { describe, it } from "vitest";
import { createTestIndexer } from "envio";
import { addr, at } from "./helpers.js";

const RISK_ADMIN_ROLE = "0x" + "ab".repeat(32);

describe("CRE sink and admin logs", () => {
  it("records CreReport rows and Stats counters, and manager admin logs", async (t) => {
    const indexer = createTestIndexer();
    await indexer.process({
      chains: {
        143: {
          simulate: [
            { contract: "CoverManager", event: "FactorySet", ...at(1001), params: { factory: addr(0xc03) } },
            { contract: "CoverManager", event: "RoleGranted", ...at(1002), params: { role: RISK_ADMIN_ROLE, account: addr(0xde9), sender: addr(0xde9) } },
            { contract: "CoverManager", event: "Paused", ...at(1003), params: { account: addr(0xde9) } },
            { contract: "CoverManager", event: "Unpaused", ...at(1004), params: { account: addr(0xde9) } },
            { contract: "CoverManager", event: "DefaultAdminTransferScheduled", ...at(1005), params: { newAdmin: addr(0xad), acceptSchedule: 1_790_003_600n } },
            { contract: "GaplessCreSink", event: "CreReport", ...at(1010), params: { kind: 1n, perpId: 1n, refPricePNS: 600_123n, armed: 0n, triggered: 0n } },
            { contract: "GaplessCreSink", event: "CreReport", ...at(1011), params: { kind: 3n, perpId: 1n, refPricePNS: 598_000n, armed: 0n, triggered: 1n } },
          ],
        },
      },
    });
    const reports = (await indexer.CreReportEntity.getAll()).sort((a, b) => a.blockNumber - b.blockNumber);
    t.expect(reports.map((r) => [r.kind, r.refPricePNS, r.triggered])).toEqual([[1, 600_123n, 0], [3, 598_000n, 1]]);
    const stats = await indexer.Stats.getOrThrow("global");
    t.expect([stats.creReports, stats.creArmed, stats.creTriggered]).toEqual([2, 0, 1]);

    const admin = (await indexer.AdminEvent.getAll()).sort((a, b) => a.blockNumber - b.blockNumber);
    t.expect(admin.map((a) => a.kind)).toEqual(["FactorySet", "RoleGranted", "Paused", "Unpaused", "DefaultAdminTransferScheduled"]);
    t.expect(admin[1]).toMatchObject({ contract: "CoverManager", role: RISK_ADMIN_ROLE, account: addr(0xde9) });
    t.expect(admin[4]?.params).toEqual({ newAdmin: addr(0xad), acceptSchedule: "1790003600" });
  });
});
