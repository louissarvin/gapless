import { type CommandIO, InputFieldType, type InputSchema, PluginCommand, schemaToArgs, schemaToFlags } from "@metamask/agent-wallet/plugin";
import { DEFAULTS } from "../../lib/config.js";
import { accountFields, dryRunField } from "../../lib/inputs.js";
import { runLink } from "../../ops/link.js";

const opt = { required: false, prompt: false } as const;
const inputs = {
  ...accountFields,
  maxPerTrade: { type: InputFieldType.Text, flag: "max-per-trade", message: `Per-trade notional cap in AUSD (default ${DEFAULTS.maxPerTrade})`, ...opt },
  maxPerDay: { type: InputFieldType.Text, flag: "max-per-day", message: `Rolling daily notional budget in AUSD (default ${DEFAULTS.maxPerDay})`, ...opt },
  expiry: { type: InputFieldType.Text, flag: "expiry", message: `Grant expiry, +4h style or unix seconds (default ${DEFAULTS.expiry})`, ...opt },
  deadline: { type: InputFieldType.Text, flag: "deadline", message: `Signature deadline, +1h style or unix seconds (default ${DEFAULTS.deadline})`, ...opt },
  sig: { type: InputFieldType.Text, flag: "sig", message: "Owner's EIP-712 SetOperator signature", ...opt },
  ...dryRunField,
} satisfies InputSchema;

type Result = Awaited<ReturnType<typeof runLink>>;

export default class GaplessLink extends PluginCommand<Result> {
  static override description = "Link this Agent Wallet as the operator of a GaplessAccount. Without --sig it prints the typed data the owner signs; with --sig it submits setOperatorWithSig.";
  static override examples = [
    "<%= config.bin %> gapless link --account 0x... --max-per-trade 25 --max-per-day 100 --expiry +4h --json",
    "<%= config.bin %> gapless link --account 0x... --expiry 1760000000 --deadline 1759990000 --max-per-trade 25 --max-per-day 100 --sig 0x... --json",
  ];
  static override flags = schemaToFlags(inputs);
  static override args = schemaToArgs(inputs);
  protected readonly pluginCommandId = "gapless:link";

  async execute(io: CommandIO): Promise<Result> {
    return runLink(this.ctx, io, await io.resolveInputs(inputs));
  }

  override successHint(d: Result): string {
    if (d.mode === "unsigned") return `Owner ${d.signer} must sign the typed data, then run: ${d.next}`;
    if (!d.submitted) return `Dry run ok: gas limit ${d.gasLimit}`;
    return d.role === "operator" ? `Linked: this wallet operates ${d.account} until ${d.expiresAt}` : `Submitted, status ${d.status}`;
  }
}
