import { CommandError } from "@metamask/agent-wallet/plugin";
import { type Abi, decodeErrorResult, type Hex, isHex } from "viem";
import {
  IAUSDAbi,
  ICoverManagerAbi,
  ICoverVaultAbi,
  IGaplessAccountAbi,
  IGaplessFactoryAbi,
  IGaplessInheritedAbi,
  IPerplErrorsAbi,
  IPerplMinAbi,
} from "../abi/index.js";

type AbiError = Extract<Abi[number], { type: "error" }>;

const SOURCES: readonly Abi[] = [
  IGaplessAccountAbi,
  ICoverManagerAbi,
  ICoverVaultAbi,
  IGaplessFactoryAbi,
  IGaplessInheritedAbi,
  IAUSDAbi,
  IPerplMinAbi,
  IPerplErrorsAbi,
];

/** Every custom error a Gapless call can bubble, deduplicated by signature (first source wins). */
export const ERROR_ABI: readonly AbiError[] = (() => {
  const seen = new Set<string>();
  const out: AbiError[] = [];
  for (const abi of SOURCES) {
    for (const item of abi) {
      if (item.type !== "error") continue;
      const sig = `${item.name}(${item.inputs.map((i) => i.type).join(",")})`;
      if (seen.has(sig)) continue;
      seen.add(sig);
      out.push(item);
    }
  }
  return out;
})();

const PERPL_ERRORS = new Set(
  (IPerplErrorsAbi as Abi).filter((i): i is AbiError => i.type === "error").map((i) => i.name),
);

/** Agent-facing hints. Keep in sync with the error map in skills/gapless/SKILL.md. */
export const ERROR_HINTS: Record<string, string> = {
  SigmaStale: "The volatility input is stale. The keeper re-posts it on demand; retry in a few minutes.",
  MarkStale: "Perpl's mark price is stale. Retry when the market is publishing again.",
  StopTooClose: "Move the stop further from the market, at least the quoted minimum distance.",
  StopWrongSide: "A long stop must sit below the market and a short stop above it.",
  CoverShareExceeded: "This cover is too large for the market's capacity. Use fewer lots or a smaller max gap.",
  UtilizationExceeded: "The cover vault is at its utilization limit. Retry later or use a smaller size.",
  MarketCapExceeded: "The market's cover capacity is used up. Retry later or use a smaller size.",
  NotionalTooLarge: "Cover notional exceeds the market maximum. Use fewer lots.",
  DurationOutOfRange: "Choose a duration inside the market's min and max blocks.",
  MaxGapOutOfRange: "Choose a max gap between 50 bps and the market cap (default 200).",
  PremiumTooHigh: "The premium moved above your bound. Quote again, or raise --max-premium-bps.",
  PremiumUnfunded: "The account lacks AUSD for the premium. Ask the owner to deposit AUSD into the GaplessAccount.",
  CoverExists: "This perp already has an active cover. Check gapless:status or cancel it first.",
  LotsExceedPosition: "Cover lots exceed the open position. Open the position first (gapless:trade) or cover fewer lots.",
  WrongSide: "The cover side does not match the open position.",
  LiquidationBufferTooThin: "The stop sits too close to liquidation for this deposit. Add margin or move the stop.",
  MarketNotListed: "This perp is not listed on Gapless. Run gapless:status to see listed markets.",
  MarketPaused: "New covers are paused on this market. Existing covers keep working.",
  EnforcedPause: "New covers are paused protocol-wide. Existing covers keep working.",
  VenueUnavailable: "Perpl is halted or this perp is not active.",
  WhitelistingOn: "Perpl whitelisting is on and this account is not whitelisted.",
  NotOwnerOrOperator: "This wallet is neither the owner nor the operator. Run gapless:grant, then gapless:link.",
  OperatorExpired: "The operator grant expired. Ask the owner for a new grant, then run gapless:link.",
  OperatorBudgetExceeded: "The owner's daily budget for this agent is used up. Wait for it to refill or ask for a larger grant.",
  NotionalCapExceeded: "The order is above the per-trade cap of the grant. Trade smaller.",
  LimitOffMarket: "The limit price must sit within 5% of Perpl's mark.",
  CloseExceedsPosition: "The close is larger than the open position.",
  PerpLocked: "The cover on this perp is armed or triggered; trading it is locked until it settles.",
  PerplNotActive: "The account has no Perpl account yet. The owner must deposit at least the Perpl minimum.",
  BadStatus: "The cover is not in a state that allows this action.",
  NotCoverAccount: "This cover belongs to a different account.",
  BadSig: "The owner signature does not match this grant, nonce or deadline. Sign the typed data from gapless:link again.",
  SigExpired: "The signature deadline passed. Sign a new grant.",
  AccountAlreadyExists: "This owner already has an account. Use it with --account.",
  AccountIsFrozen: "Your dollars are temporarily unavailable (AUSD frozen).",
  AusdFrozen: "Your dollars are temporarily unavailable (AUSD frozen).",
  TransferPaused: "AUSD transfers are paused by the issuer. Retry later.",
  ZeroLots: "Size must be at least one lot.",
};

const DEFAULT_HINT = "Run gapless:status and gapless:grant to check the account, then quote again.";

/** Revert bytes from a viem error, walking the cause chain (custom transports nest them several levels deep). */
export function revertData(err: unknown): Hex | undefined {
  let cur: unknown = err;
  for (let depth = 0; cur && depth < 12; depth++) {
    const c = cur as { data?: unknown; raw?: unknown; cause?: unknown };
    if (typeof c.raw === "string" && isHex(c.raw) && c.raw.length >= 10) return c.raw;
    if (typeof c.data === "string" && isHex(c.data) && c.data.length >= 10) return c.data;
    if (c.data && typeof c.data === "object") {
      const inner = (c.data as { data?: unknown }).data;
      if (typeof inner === "string" && isHex(inner) && inner.length >= 10) return inner;
    }
    cur = c.cause;
  }
  return undefined;
}

export type DecodedRevert = { name: string; args: Record<string, string> };

export function decodeRevert(data: Hex): DecodedRevert | undefined {
  try {
    const { abiItem, args } = decodeErrorResult({ abi: ERROR_ABI, data });
    const inputs = "inputs" in abiItem ? abiItem.inputs : [];
    const named: Record<string, string> = {};
    (args ?? []).forEach((v, i) => {
      named[inputs[i]?.name || `arg${i}`] = String(v);
    });
    return { name: abiItem.name, args: named };
  } catch {
    return undefined;
  }
}

export function errorCode(name: string): string {
  const snake = name
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toUpperCase();
  return `GAPLESS_${snake}`;
}

function formatRevert(d: DecodedRevert): string {
  const parts = Object.entries(d.args).map(([k, v]) => `${k}=${v}`);
  return `${d.name}(${parts.join(", ")})`;
}

/** Maps any failure to a CommandError: decoded custom error name when available, never a stack or RPC URL. */
export function toCommandError(err: unknown, action: string): CommandError {
  if (err instanceof CommandError) return err;
  const data = revertData(err);
  if (data) {
    const decoded = decodeRevert(data);
    if (decoded) {
      const hint = PERPL_ERRORS.has(decoded.name) && !ERROR_HINTS[decoded.name]
        ? "Perpl rejected the order. Check size, price and margin, then quote again."
        : (ERROR_HINTS[decoded.name] ?? DEFAULT_HINT);
      return new CommandError(errorCode(decoded.name), `${action} reverted: ${formatRevert(decoded)}`, hint);
    }
    return new CommandError("GAPLESS_UNKNOWN_REVERT", `${action} reverted with unknown data ${data.slice(0, 10)}`, DEFAULT_HINT);
  }
  const short = (err as { shortMessage?: unknown })?.shortMessage;
  const first = typeof short === "string" ? short : err instanceof Error ? (err.message.split("\n")[0] ?? "") : String(err);
  // The host RPC gateway URL can carry auth; never echo URLs.
  const msg = first.replace(/[a-z][a-z0-9+.-]*:\/\/\S+/gi, "<url>").slice(0, 300);
  return new CommandError("GAPLESS_RPC_ERROR", `${action} failed: ${msg}`, "Check connectivity with mm doctor and retry.");
}

export function fail(code: string, message: string, hint: string): never {
  throw new CommandError(code, message, hint);
}
