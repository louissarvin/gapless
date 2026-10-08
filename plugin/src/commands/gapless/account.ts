import { type CommandIO, InputFieldType, type InputSchema, PluginCommand, schemaToArgs, schemaToFlags } from "@metamask/agent-wallet/plugin";
import { dryRunField } from "../../lib/inputs.js";
import { runAccount } from "../../ops/account.js";

const inputs = {
  deposit: { type: InputFieldType.Text, flag: "deposit", message: "AUSD to deposit (default 0)", index: 0, required: false, prompt: false },
  from: { type: InputFieldType.Text, flag: "from", message: "Wallet address override (must match the active Agent Wallet)", required: false, prompt: false },
  ...dryRunField,
} satisfies InputSchema;

type Result = Awaited<ReturnType<typeof runAccount>>;

export default class GaplessAccount extends PluginCommand<Result> {
  static override description = "Owner mode: create a GaplessAccount owned by this Agent Wallet (AUSD approve, then factory.createAccount).";
  static override examples = ["<%= config.bin %> gapless account 15 --dry-run --json", "<%= config.bin %> gapless account 15 --json"];
  static override flags = schemaToFlags(inputs);
  static override args = schemaToArgs(inputs);
  protected readonly pluginCommandId = "gapless:account";

  async execute(io: CommandIO): Promise<Result> {
    return runAccount(this.ctx, io, await io.resolveInputs(inputs));
  }

  override successHint(d: Result): string {
    if (d.existed) return `Account already exists: ${d.account}`;
    if ("firstStep" in d) return `Dry run ok: first step ${d.firstStep}`;
    if ("created" in d) return `Account ${d.created ?? d.account}: status ${d.status}`;
    return `Approve submitted, status ${"status" in d ? d.status : "unknown"}; run gapless:account again once it confirms`;
  }
}
