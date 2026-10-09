import { createPublicClient, http, type PublicClient } from "viem";

const DEFAULT_FALLBACK_RPC_URL = "https://rpc.monad.xyz";

/**
 * Read-only fallback for when the host's authenticated RPC gateway is unreachable for this chain
 * (observed: MetaMask's relay can fail for chain 143 while the host itself is otherwise healthy).
 * Never used for signing or broadcasting: `submitTx` always goes through `host.walletExecutor`,
 * which this client has no access to and cannot bypass.
 */
export function fallbackClient(): PublicClient {
  const url = process.env.GAPLESS_FALLBACK_RPC_URL?.trim() || DEFAULT_FALLBACK_RPC_URL;
  return createPublicClient({ transport: http(url) }) as PublicClient;
}
