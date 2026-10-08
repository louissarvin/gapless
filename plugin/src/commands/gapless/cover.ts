import { type CommandIO, type InputSchema, PluginCommand, schemaToArgs, schemaToFlags } from "@metamask/agent-wallet/plugin";
import { accountFields, dryRunField, positionFields, premiumField } from "../../lib/inputs.js";
import { runCover } from "../../ops/cover.js";

const inputs = { ...positionFields, ...premiumField, ...accountFields, ...dryRunField } satisfies InputSchema;

type Result = Awaited<ReturnType<typeof runCover>>;

export default class GaplessCover extends PluginCommand<Result> {
  static override description = "Buy a guaranteed stop on an existing Perpl position (buyCover). Signed and policy-checked by Agent Wallet.";
  static override examples = ["<%= config.bin %> gapless cover BTC long --size 0.001 --stop 84000 --account 0x... --json"];
  static override flags = schemaToFlags(inputs);
  static override args = schemaToArgs(inputs);
  protected readonly pluginCommandId = "gapless:cover";

  async execute(io: CommandIO): Promise<Result> {
    return runCover(this.ctx, io, await io.resolveInputs(inputs));
  }

  override successHint(d: Result): string {
    if (!d.submitted) return `Dry run ok: premium ${d.premiumAUSD} AUSD, gas limit ${d.gasLimit}`;
    return d.coverId ? `Cover ${d.coverId} is live` : `Submitted, status ${d.status}${d.pollingId ? `, pollingId ${d.pollingId}` : ""}`;
  }
}
