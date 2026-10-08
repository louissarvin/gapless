import { InputFieldType } from "@metamask/agent-wallet/plugin";
import { DEFAULTS } from "./config.js";

const opt = { required: false, prompt: false } as const;

export const accountFields = {
  account: { type: InputFieldType.Text, flag: "account", env: "GAPLESS_ACCOUNT", message: "GaplessAccount clone address", ...opt },
  owner: { type: InputFieldType.Text, flag: "owner", message: "Owner address (resolves the clone via the factory)", ...opt },
  from: { type: InputFieldType.Text, flag: "from", message: "Wallet address override (must match the active Agent Wallet for submits)", ...opt },
} as const;

// Positionals stay optional for oclif so market and side also work as flags; ops validate presence.
export const positionFields = {
  market: { type: InputFieldType.Text, flag: "market", message: "Perp id or symbol, e.g. 1 or BTC", index: 0, required: false },
  side: {
    type: InputFieldType.Select,
    flag: "side",
    message: "Position side",
    index: 1,
    required: false,
    options: [
      { value: "long", label: "Long" },
      { value: "short", label: "Short" },
    ],
  },
  size: { type: InputFieldType.Text, flag: "size", message: "Size in the base asset, e.g. 0.001", required: true },
  stop: { type: InputFieldType.Text, flag: "stop", message: "Guaranteed stop price, e.g. 84000", required: true },
  maxGapBps: { type: InputFieldType.Text, flag: "max-gap-bps", message: `Max covered gap in bps (default ${DEFAULTS.maxGapBps})`, ...opt },
  blocks: { type: InputFieldType.Text, flag: "blocks", message: `Cover duration in blocks (default ${DEFAULTS.durationBlocks})`, ...opt },
} as const;

export const orderFields = {
  limit: { type: InputFieldType.Text, flag: "limit", message: "Limit price for the open (default: best book price plus slippage)", ...opt },
  slippageBps: { type: InputFieldType.Text, flag: "slippage-bps", message: `Slippage for the default limit (default ${DEFAULTS.slippageBps})`, ...opt },
  leverage: { type: InputFieldType.Text, flag: "leverage", message: `Leverage (default ${DEFAULTS.leverage})`, ...opt },
} as const;

export const premiumField = {
  maxPremiumBps: {
    type: InputFieldType.Text,
    flag: "max-premium-bps",
    message: `Allowed premium move over the quote in bps (default ${DEFAULTS.maxPremiumBps}, max 1000)`,
    ...opt,
  },
} as const;

export const dryRunField = {
  dryRun: { type: InputFieldType.Boolean, flag: "dry-run", message: "Simulate only, never submit", default: false, ...opt },
} as const;
