import { type CommandIO, InputFieldType, type InputSchema, PluginCommand, schemaToArgs, schemaToFlags } from "@metamask/agent-wallet/plugin";
import { accountFields, dryRunField } from "../../lib/inputs.js";
import { runCancel } from "../../ops/cancel.js";

const inputs = {
  coverId: { type: InputFieldType.Text, flag: "cover-id", message: "Cover id (0x, 32 bytes)", index: 0, required: false, prompt: false },
  market: { type: InputFieldType.Text, flag: "market", message: "Cancel the active cover on this perp instead", required: false, prompt: false },
  ...accountFields,
  ...dryRunField,
} satisfies InputSchema;

type Result = Awaited<ReturnType<typeof runCancel>>;

export default class GaplessCancel extends PluginCommand<Result> {
  static override description = "Cancel a live guaranteed stop (cancelCover). Rent is kept; escrow is refunded only away from the stop.";
  static override examples = [
    "<%= config.bin %> gapless cancel 0xCOVER_ID --account 0x... --json",
    "<%= config.bin %> gapless cancel --market BTC --account 0x... --json",
  ];
  static override flags = schemaToFlags(inputs);
  static override args = schemaToArgs(inputs);
  protected readonly pluginCommandId = "gapless:cancel";

  async execute(io: CommandIO): Promise<Result> {
    return runCancel(this.ctx, io, await io.resolveInputs(inputs));
  }

  override successHint(d: Result): string {
    if (!d.submitted) return `Dry run ok: gas limit ${d.gasLimit}`;
    return `Cover ${d.coverId} ${d.endStatus ?? d.status}; refund ${d.refundAUSD} AUSD`;
  }
}
