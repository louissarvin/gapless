import { indexer } from "envio";
import { loadStats, logId, meta, toInt } from "../lib/common.js";

indexer.onEvent({ contract: "GaplessCreSink", event: "CreReport" }, async ({ event, context }) => {
  const stats = await loadStats(context);
  if (context.isPreload) return;
  const p = event.params;
  const armed = toInt(p.armed, "armed");
  const triggered = toInt(p.triggered, "triggered");
  context.CreReportEntity.set({
    id: logId(event),
    kind: toInt(p.kind, "kind"),
    perpId: toInt(p.perpId, "perpId"),
    refPricePNS: p.refPricePNS,
    armed,
    triggered,
    ...meta(event),
  });
  context.Stats.set({
    ...stats,
    creReports: stats.creReports + 1,
    creArmed: stats.creArmed + armed,
    creTriggered: stats.creTriggered + triggered,
    updatedBlock: event.block.number,
  });
});
