import { jsonParams, logId, meta, type Ctx, type EventMeta } from "./common.js";

type AdminExtra = { perpId?: number; account?: string; role?: string };

export function recordAdmin(
  context: Ctx,
  e: EventMeta & { readonly params: unknown },
  contract: "CoverManager" | "CoverVault",
  kind: string,
  extra: AdminExtra = {},
): void {
  context.AdminEvent.set({
    id: logId(e),
    contract,
    kind,
    perpId: extra.perpId,
    account: extra.account,
    role: extra.role,
    ...meta(e),
    params: jsonParams(e.params),
  });
}
