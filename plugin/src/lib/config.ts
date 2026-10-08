import { type Address, getAddress, isAddress } from "viem";
import { DEPLOYMENT } from "../addresses.js";
import { fail } from "./errors.js";

export const CHAIN_ID = 143;
export const EXPLORER_TX = "https://monadvision.com/tx/";

export const BPS = 10_000n;
/** Monad bills the gas limit, so stay tight: estimate x 1.2, rounded up. */
export const GAS_MUL_NUM = 12n;
export const GAS_MUL_DEN = 10n;
/** About 0.25 MON at 50 gwei; a larger estimate means something is wrong, so refuse instead of overpaying. */
export const MAX_GAS = 5_000_000n;

/** Constants.sol: operator limits must sit within 500 bps of mark (M-01); Perpl price range (L-06). */
export const MAX_LIMIT_DEVIATION_BPS = 500n;
export const PERPL_MIN_PRICE_PNS = 1n;
export const PERPL_MAX_PRICE_PNS = 16_777_215n;

export const DEFAULTS = {
  maxGapBps: "200",
  durationBlocks: "12000",
  maxPremiumBps: "200",
  slippageBps: "50",
  leverage: "5",
  maxPerTrade: "25",
  maxPerDay: "100",
  expiry: "+4h",
  deadline: "+1h",
} as const;
export const MAX_PREMIUM_BPS_CAP = 1_000n;

/** Open-order recipe from the tech spec (user market open), IOC so the cover sees the filled position. */
export const OPEN_ORDER = { maxMatches: 32n, maxNegPnlCollatBPS: 300n } as const;

export type Deployment = { manager: Address; factory: Address | null };

function pick(name: string, generated: string | null, env: string | undefined): Address | null {
  const fromEnv = env?.trim() || undefined;
  if (fromEnv !== undefined && !isAddress(fromEnv, { strict: false })) {
    fail("GAPLESS_BAD_CONFIG", `${name} in the environment is not an address.`, `Unset it or set a 0x address.`);
  }
  if (generated && fromEnv && getAddress(generated) !== getAddress(fromEnv)) {
    fail(
      "GAPLESS_BAD_CONFIG",
      `${name} differs from the deployed address shipped with this plugin.`,
      `Unset ${name}; the packaged deployment is authoritative.`,
    );
  }
  const v = generated ?? fromEnv;
  return v ? getAddress(v) : null;
}

/** Packaged addresses win; env vars only fill gaps before the canary addresses are generated. */
export function resolveDeployment(env: NodeJS.ProcessEnv = process.env): Deployment {
  const manager = pick("GAPLESS_COVER_MANAGER_ADDRESS", DEPLOYMENT.CoverManager, env.GAPLESS_COVER_MANAGER_ADDRESS);
  const factory = pick("GAPLESS_FACTORY_ADDRESS", DEPLOYMENT.GaplessFactory, env.GAPLESS_FACTORY_ADDRESS);
  if (!manager) {
    fail(
      "GAPLESS_NOT_CONFIGURED",
      "No CoverManager address is configured for Monad 143.",
      "Install a released mm-plugin-gapless, or set GAPLESS_COVER_MANAGER_ADDRESS.",
    );
  }
  return { manager, factory };
}

export function explorerUrl(hash: string): string {
  return `${EXPLORER_TX}${hash}`;
}
