import { type CommandIO, InputFieldType, type InputSchema, PluginCommand, schemaToArgs, schemaToFlags } from "@metamask/agent-wallet/plugin";
import { accountFields, orderFields, positionFields, premiumField } from "../../lib/inputs.js";
import { runQuote } from "../../ops/quote.js";

const inputs = {
  ...positionFields,
  open: { type: InputFieldType.Boolean, flag: "open", message: "Price opening the position together with the cover", default: false, required: false, prompt: false },
  ...orderFields,
  ...premiumField,
  ...accountFields,
} satisfies InputSchema;

type Result = Awaited<ReturnType<typeof runQuote>>;

export default class GaplessQuote extends PluginCommand<Result> {
  static override description = "Quote a guaranteed stop on a Perpl perp (Monad 143). Read-only.";
  static override examples = [
    "<%= config.bin %> gapless quote BTC long --size 0.001 --stop 84000 --json",
    "<%= config.bin %> gapless quote BTC long --size 0.001 --stop 84000 --open --account 0x... --json",
  ];
  static override flags = schemaToFlags(inputs);
  static override args = schemaToArgs(inputs);
  protected readonly pluginCommandId = "gapless:quote";

  async execute(io: CommandIO): Promise<Result> {
    return runQuote(this.ctx, io, await io.resolveInputs(inputs));
  }

  override successHint(d: Result): string {
    return `Premium ${d.premiumAUSD} AUSD guarantees the ${d.market} ${d.side} stop at ${d.stop} (cap ${d.capAUSD} AUSD)`;
  }
}
