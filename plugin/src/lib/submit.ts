import { CommandError, type CommandIO } from "@metamask/agent-wallet/plugin";
import { type Abi, type Address, decodeEventLog, type Hex, type Log, type TransactionReceipt } from "viem";
import type { Gapless } from "./chain.js";
import { CHAIN_ID, explorerUrl, GAS_MUL_DEN, GAS_MUL_NUM, MAX_GAS } from "./config.js";
import { fail, toCommandError } from "./errors.js";
import type { Host, TxRequest, WalletExecutor } from "./host.js";
import { ceilDiv } from "./units.js";

export type PreparedTx = { from: Address; to: Address; data: Hex; gas: bigint; estimate: bigint; action: string };

export function gasLimit(estimate: bigint): bigint {
  return ceilDiv(estimate * GAS_MUL_NUM, GAS_MUL_DEN);
}

/** eth_call simulation from the signing wallet, then a tight gas limit. Throws before anything is signed. */
export async function prepareTx(g: Gapless, io: CommandIO, tx: { from: Address; to: Address; data: Hex; action: string }): Promise<PreparedTx> {
  const base = { account: tx.from, to: tx.to, data: tx.data, value: 0n } as const;
  io.progress(`Simulating ${tx.action}...`);
  try {
    await g.client.call(base);
  } catch (err) {
    throw toCommandError(err, `Simulation of ${tx.action}`);
  } finally {
    io.progress();
  }
  let estimate: bigint;
  try {
    estimate = await g.client.estimateGas(base);
  } catch (err) {
    throw toCommandError(err, `Gas estimate for ${tx.action}`);
  }
  const gas = gasLimit(estimate);
  if (gas > MAX_GAS) {
    fail("GAPLESS_GAS_TOO_HIGH", `${tx.action} needs ${gas} gas, above the ${MAX_GAS} safety cap.`, "Use a smaller size; Monad bills the full gas limit.");
  }
  return { ...tx, gas, estimate };
}

export type Submitted = {
  hash: Hex | null;
  status: string;
  explorerUrl: string | null;
  pollingId: string | null;
  receipt: TransactionReceipt | null;
};

/**
 * One executor request per call, never retried here: Agent Wallet owns signing, policy and 2FA.
 * A pending job (2FA wait interrupted) is surfaced with its pollingId instead of being re-sent.
 */
export async function submitTx(host: Host, io: CommandIO, g: Gapless, source: string, tx: PreparedTx, summary: string): Promise<Submitted> {
  const exec = (await host.walletExecutor(io, source)) as WalletExecutor;
  const request: TxRequest = {
    kind: "transaction",
    chainId: CHAIN_ID,
    transaction: { to: tx.to, data: tx.data, value: 0n, gas: tx.gas },
    intent: { action: "custom", summary },
  };
  let res;
  try {
    res = await exec(request, { signal: io.signal });
  } catch (err) {
    const pollingId = (err as { pendingJob?: { pollingId?: string } })?.pendingJob?.pollingId;
    if (pollingId) {
      throw new CommandError(
        "GAPLESS_PENDING",
        `${tx.action} is still pending in Agent Wallet (pollingId ${pollingId}).`,
        `Do not retry. Track it with: mm wallet requests watch ${pollingId}`,
      );
    }
    throw err;
  }
  const pollingId = res.pendingJob?.pollingId ?? null;
  const hash = res.hash && /^0x[0-9a-fA-F]{64}$/.test(res.hash) ? (res.hash as Hex) : null;
  if (!hash) {
    return { hash: null, status: res.status, explorerUrl: null, pollingId, receipt: null };
  }
  io.progress("Waiting for the receipt...");
  let receipt: TransactionReceipt;
  try {
    receipt = await g.client.waitForTransactionReceipt({ hash, pollingInterval: 1_000, timeout: 120_000 });
  } catch {
    return { hash, status: res.status, explorerUrl: explorerUrl(hash), pollingId, receipt: null };
  } finally {
    io.progress();
  }
  if (receipt.status !== "success") {
    fail("GAPLESS_TX_REVERTED", `${tx.action} reverted onchain (${hash}).`, `Inspect ${explorerUrl(hash)}, then run gapless:status before acting again.`);
  }
  return { hash, status: res.status, explorerUrl: explorerUrl(hash), pollingId, receipt };
}

/** First matching event emitted by `address` in a receipt. */
export function findEvent<const A extends Abi>(logs: readonly Log[], address: Address, abi: A, eventName: string) {
  for (const log of logs) {
    if (log.address.toLowerCase() !== address.toLowerCase()) continue;
    try {
      const ev = decodeEventLog({ abi, data: log.data, topics: log.topics });
      if (ev.eventName === eventName) return ev.args as Record<string, unknown>;
    } catch {
      // other events from the same contract
    }
  }
  return undefined;
}
