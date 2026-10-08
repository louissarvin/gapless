import { type CommandIO, type InputSchema, PluginCommand, schemaToArgs, schemaToFlags } from "@metamask/agent-wallet/plugin";
import { accountFields } from "../../lib/inputs.js";
import { runGrant } from "../../ops/grant.js";

const inputs = { ...accountFields } satisfies InputSchema;

type Result = Awaited<ReturnType<typeof runGrant>>;

export default class GaplessGrant extends PluginCommand<Result> {
  static override description = "Show the owner's onchain grant for this wallet (per-trade cap, daily budget, expiry). Fails if this wallet is not the live operator or owner.";
  static override examples = ["<%= config.bin %> gapless grant --account 0x... --json"];
  static override flags = schemaToFlags(inputs);
  static override args = schemaToArgs(inputs);
  protected readonly pluginCommandId = "gapless:grant";

  async execute(io: CommandIO): Promise<Result> {
    return runGrant(this.ctx, io, await io.resolveInputs(inputs));
  }

  override successHint(d: Result): string {
    return `${d.role}: ${d.availableAUSD} AUSD of ${d.maxPerDayAUSD} AUSD daily budget left, expires ${d.expiresAt}`;
  }
}
