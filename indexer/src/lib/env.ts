const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const PERP_RE = /^\d{1,5}$/;

/** Perpl Exchange proxy, same value as contract/src/Constants.sol PERPL_EXCHANGE. */
const DEFAULT_PERPL_EXCHANGE = "0x34b6552d57a35a1d042ccae1951bd1c370112a6f";

/** Historical-state RPC for Effects (D1: monadinfra). Undefined when unset, so tests and M1 stay offline. */
export function monadRpcUrl(): string | undefined {
  const raw = process.env.ENVIO_MONAD_RPC_URL?.trim();
  if (!raw) return undefined;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    // Never echo the value: RPC URLs can carry API keys.
    throw new Error("ENVIO_MONAD_RPC_URL is not a valid URL");
  }
  const ok = url.protocol === "https:" || (url.protocol === "http:" && LOCAL_HOSTS.has(url.hostname));
  if (!ok) throw new Error("ENVIO_MONAD_RPC_URL must use https (http only for localhost)");
  return raw;
}

export function perplExchange(): `0x${string}` {
  const raw = process.env.ENVIO_PERPL_EXCHANGE_ADDRESS?.trim() || DEFAULT_PERPL_EXCHANGE;
  if (!ADDRESS_RE.test(raw)) throw new Error("ENVIO_PERPL_EXCHANGE_ADDRESS is not an address");
  return raw.toLowerCase() as `0x${string}`;
}

/** Comma-separated perp ids for the sampler, default "1". */
export function samplerPerps(): number[] {
  const raw = process.env.ENVIO_SAMPLER_PERPS?.trim() || "1";
  const parts = raw.split(",").map((p) => p.trim());
  const perps = parts.map((p) => (PERP_RE.test(p) ? Number(p) : NaN));
  if (perps.some((p) => !Number.isInteger(p) || p < 1 || p > 65_535)) {
    throw new Error(`ENVIO_SAMPLER_PERPS must be comma-separated perp ids in [1, 65535], got "${raw}"`);
  }
  return [...new Set(perps)];
}
