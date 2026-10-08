import { formatUnits, getAddress, isAddress, type Address, type Hex, isHex } from "viem";
import { fail } from "./errors.js";

const DECIMAL = /^\d{1,30}(\.\d{1,30})?$/;
const INTEGER = /^\d{1,30}$/;

/** Exact decimal to integer units; rejects excess precision instead of rounding. */
export function parseDecimal(raw: string | undefined, decimals: number, field: string): bigint {
  const v = (raw ?? "").trim();
  if (!DECIMAL.test(v)) fail("GAPLESS_BAD_INPUT", `--${field} must be a positive decimal, got '${v}'.`, `Pass e.g. --${field} 1.5`);
  const [int = "0", frac = ""] = v.split(".");
  if (frac.length > decimals) {
    fail("GAPLESS_BAD_INPUT", `--${field} allows at most ${decimals} decimals, got '${v}'.`, `Round --${field} to ${decimals} decimals.`);
  }
  return BigInt(int) * 10n ** BigInt(decimals) + BigInt(frac.padEnd(decimals, "0") || "0");
}

export function parseInteger(raw: string | undefined, field: string, min: bigint, max: bigint): bigint {
  const v = (raw ?? "").trim();
  if (!INTEGER.test(v)) fail("GAPLESS_BAD_INPUT", `--${field} must be an integer, got '${v}'.`, `Pass e.g. --${field} ${min}`);
  const n = BigInt(v);
  if (n < min || n > max) fail("GAPLESS_BAD_INPUT", `--${field} must be between ${min} and ${max}.`, `Pass a value in range.`);
  return n;
}

export function parseAddress(raw: string, field: string): Address {
  const v = raw.trim();
  if (!isAddress(v, { strict: false })) fail("GAPLESS_BAD_INPUT", `--${field} is not a 0x address.`, `Pass a 40-hex-character 0x address.`);
  return getAddress(v);
}

export function parseBytes32(raw: string, field: string): Hex {
  const v = raw.trim();
  if (!/^0x[0-9a-fA-F]{64}$/.test(v)) fail("GAPLESS_BAD_INPUT", `--${field} must be a 32-byte 0x hex id.`, "Copy the coverId from gapless:status.");
  return v.toLowerCase() as Hex;
}

export function parseSignature(raw: string): Hex {
  const v = raw.trim();
  // EOA signatures are 65 bytes; ERC-1271 owners may return longer blobs.
  if (!isHex(v) || v.length % 2 !== 0 || v.length < 2 + 130 || v.length > 2 + 8192) {
    fail("GAPLESS_BAD_INPUT", "--sig must be a 0x hex signature of at least 65 bytes.", "Paste the owner's signature of the gapless:link typed data.");
  }
  return v as Hex;
}

/** Leverage like "5" or "2.5" to Perpl hundredths (1000 = 10x). */
export function parseLeverage(raw: string | undefined): bigint {
  const hdths = parseDecimal(raw, 2, "leverage");
  if (hdths < 100n || hdths > 10_000n) fail("GAPLESS_BAD_INPUT", "--leverage must be between 1 and 100.", "Pass e.g. --leverage 5");
  return hdths;
}

/** "+4h" / "+30m" / "+2d" relative to `now`, or an absolute unix second. */
export function parseTime(raw: string | undefined, field: string, now: bigint, allowRelative: boolean): bigint {
  const v = (raw ?? "").trim();
  const rel = /^\+(\d{1,6})([mhd])$/.exec(v);
  if (rel) {
    if (!allowRelative) {
      fail("GAPLESS_BAD_INPUT", `--${field} must be the absolute unix time printed by gapless:link when --sig is given.`, "Reuse the exact values from the unsigned gapless:link output.");
    }
    const unit = rel[2] === "m" ? 60n : rel[2] === "h" ? 3_600n : 86_400n;
    return now + BigInt(rel[1] ?? "0") * unit;
  }
  return parseInteger(v, field, 1n, 2n ** 63n);
}

export const ausd = (cns: bigint): string => formatUnits(cns, 6);
export const price = (pns: bigint, pd: number): string => formatUnits(pns, pd);

/** `{<k>CNS, <k>AUSD}` output pair: raw 6-decimal string plus the human amount. */
export const cns = <K extends string>(k: K, v: bigint) =>
  ({ [`${k}CNS`]: v.toString(), [`${k}AUSD`]: ausd(v) }) as Record<`${K}CNS` | `${K}AUSD`, string>;

export function ceilDiv(a: bigint, b: bigint): bigint {
  return (a + b - 1n) / b;
}
