import { type CommandIO, type InputSchema, PluginCommand, schemaToArgs, schemaToFlags } from "@metamask/agent-wallet/plugin";
import { accountFields, dryRunField, orderFields, positionFields, premiumField } from "../../lib/inputs.js";
import { runTrade } from "../../ops/trade.js";

const inputs = { ...positionFields, ...orderFields, ...premiumField, ...accountFields, ...dryRunField } satisfies InputSchema;

type Result = Awaited<ReturnType<typeof runTrade>>;

export default class GaplessTrade extends PluginCommand<Result> {
  static override description = "Open a Perpl position with a guaranteed stop in one transaction (tradeAndCover). Signed and policy-checked by Agent Wallet.";
  static override examples = [
    "<%= config.bin %> gapless trade BTC long --size 0.001 --stop 84000 --account 0x... --dry-run --json",
    "<%= config.bin %> gapless trade BTC long --size 0.001 --stop 84000 --account 0x... --json",
  ];
  static override flags = schemaToFlags(inputs);
  static override args = schemaToArgs(inputs);
  protected readonly pluginCommandId = "gapless:trade";

  async execute(io: CommandIO): Promise<Result> {
    return runTrade(this.ctx, io, await io.resolveInputs(inputs));
  }

  override successHint(d: Result): string {
    if (!d.submitted) return `Dry run ok: premium ${d.premiumAUSD} AUSD, gas limit ${d.gasLimit}`;
    return d.coverId ? `Cover ${d.coverId} is live` : `Submitted, status ${d.status}${d.pollingId ? `, pollingId ${d.pollingId}` : ""}`;
  }
}
