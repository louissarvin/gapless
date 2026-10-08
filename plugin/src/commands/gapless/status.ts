import { type CommandIO, InputFieldType, type InputSchema, PluginCommand, schemaToArgs, schemaToFlags } from "@metamask/agent-wallet/plugin";
import { accountFields } from "../../lib/inputs.js";
import { runStatus } from "../../ops/status.js";

const inputs = {
  market: { type: InputFieldType.Text, flag: "market", message: "Only this perp (id or symbol)", required: false, prompt: false },
  graphql: { type: InputFieldType.Text, flag: "graphql", env: "GAPLESS_GRAPHQL_URL", message: "Envio GraphQL URL for cover history", required: false, prompt: false },
  ...accountFields,
} satisfies InputSchema;

type Result = Awaited<ReturnType<typeof runStatus>>;

export default class GaplessStatus extends PluginCommand<Result> {
  static override description = "Show active guaranteed stops, the operator grant and refunds for a GaplessAccount. Read-only.";
  static override examples = ["<%= config.bin %> gapless status --account 0x... --json"];
  static override flags = schemaToFlags(inputs);
  static override args = schemaToArgs(inputs);
  protected readonly pluginCommandId = "gapless:status";

  async execute(io: CommandIO): Promise<Result> {
    return runStatus(this.ctx, io, await io.resolveInputs(inputs));
  }

  override successHint(d: Result): string {
    return `${d.covers.length} active cover(s) on ${d.account}; this wallet is ${d.role}`;
  }
}
