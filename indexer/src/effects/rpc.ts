import { BaseError, createPublicClient, http, type PublicClient } from "viem";
import { monadRpcUrl } from "../lib/env.js";

let cached: { url: string; client: PublicClient } | undefined;

/** Shared batched client, rebuilt only if the URL changes. Undefined when no RPC is configured. */
export function rpcClient(): PublicClient | undefined {
  const url = monadRpcUrl();
  if (!url) return undefined;
  if (cached?.url !== url) {
    cached = { url, client: createPublicClient({ transport: http(url, { batch: true, timeout: 15_000, retryCount: 2 }) }) };
  }
  return cached.client;
}

/** Log-safe error summary: viem's full message can embed the request URL (and any key in it). */
export function errorSummary(err: unknown): string {
  if (err instanceof BaseError) return `${err.name}: ${err.shortMessage}`;
  return err instanceof Error ? err.name : "unknown error";
}
