import { BaseError, createPublicClient, fallback, http, RpcRequestError, webSocket, type Transport } from 'viem';
import { monad } from 'viem/chains';
import { MONAD_CHAIN_ID } from './addresses.ts';
import { redactUrl } from './log.ts';

/** Last-resort public RPC (Ankr): 300 req per 10 s, batch 10, 1B eth_call gas cap. */
export const PUBLIC_FALLBACK_HTTP = 'https://rpc3.monad.xyz';

const REQUEST_TIMEOUT_MS = 8_000;

export interface ChainConfig {
  /** Ordered, private first. */
  httpUrls: readonly string[];
  wsUrl?: string | undefined;
}

export function orderedHttpUrls(cfg: ChainConfig): string[] {
  return [...new Set([...cfg.httpUrls, PUBLIC_FALLBACK_HTTP])];
}

/**
 * WS first when present: viem only uses eth_subscribe (watchBlocks, monadNewHeads) if the
 * first fallback transport is a WebSocket. Reverts never fail over (viem default shouldThrow).
 */
export function createMonadTransport(cfg: ChainConfig) {
  const transports: Transport[] = [];
  if (cfg.wsUrl) {
    transports.push(webSocket(cfg.wsUrl, { timeout: REQUEST_TIMEOUT_MS, retryCount: 1 }));
  }
  for (const url of orderedHttpUrls(cfg)) {
    transports.push(http(url, { timeout: REQUEST_TIMEOUT_MS, retryCount: 1 }));
  }
  // rank stays off: it pings every endpoint each polling interval and burns public rate limits.
  return fallback(transports, { rank: false, retryCount: 2, retryDelay: 250 });
}

/** Read-only client for Monad mainnet. Signing lives in sendQueue.ts (local account, raw sends). */
export function createMonadPublicClient(cfg: ChainConfig) {
  return createPublicClient({ chain: monad, transport: createMonadTransport(cfg) });
}

/** True when a node answered with a JSON-RPC error (revert, nonce, rejection), as opposed to a transport failure. */
export function answeredByNode(err: Error): boolean {
  return err instanceof BaseError && err.walk((e) => e instanceof RpcRequestError) !== null;
}

/**
 * Client for eth_sendRawTransactionSync: HTTP endpoints in order, failing over only when no node
 * answered (spec §4.1). A node error is final for that send; the queue reconciles from chain state.
 * @param timeoutMs transport timeout; must exceed the sync send timeout.
 */
export function createMonadSendClient(cfg: ChainConfig, timeoutMs: number) {
  const transports = orderedHttpUrls(cfg).map((url) => http(url, { timeout: timeoutMs, retryCount: 0 }));
  return createPublicClient({
    chain: monad,
    transport: fallback(transports, { rank: false, retryCount: 0, shouldThrow: answeredByNode })
  });
}

export type MonadPublicClient = ReturnType<typeof createMonadPublicClient>;

export interface ChainHead {
  number: bigint;
  timestamp: bigint;
}

export async function readHead(client: MonadPublicClient): Promise<ChainHead> {
  const block = await client.getBlock({ blockTag: 'latest' });
  return { number: block.number, timestamp: block.timestamp };
}

export type EndpointCheck =
  | { endpoint: string; ok: true }
  | { endpoint: string; ok: false; reason: 'wrong_chain'; chainId: number }
  | { endpoint: string; ok: false; reason: 'unreachable' };

/**
 * Checks each HTTP endpoint on its own, since fallback would hide a misconfigured one
 * (for example a testnet URL) until the primary fails. Endpoints are returned redacted.
 */
export async function checkEndpoints(cfg: ChainConfig): Promise<EndpointCheck[]> {
  return Promise.all(
    orderedHttpUrls(cfg).map(async (url): Promise<EndpointCheck> => {
      const endpoint = redactUrl(url);
      try {
        const client = createPublicClient({
          chain: monad,
          transport: http(url, { timeout: REQUEST_TIMEOUT_MS, retryCount: 0 })
        });
        const chainId = await client.getChainId();
        return chainId === MONAD_CHAIN_ID
          ? { endpoint, ok: true }
          : { endpoint, ok: false, reason: 'wrong_chain', chainId };
      } catch {
        return { endpoint, ok: false, reason: 'unreachable' };
      }
    })
  );
}
