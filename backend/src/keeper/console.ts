import type { Address, Hex } from 'viem';
import { multicall } from 'viem/actions';
import { ICoverManagerAbi } from '../abi/index.ts';
import type { MonadPublicClient } from '../lib/chain.ts';
import type { Database } from '../lib/db.ts';
import type { Logger } from '../lib/log.ts';
import type { ContractSend, SendOutcome, SendQueue, SendQueueStatus, TransferSend } from '../lib/sendQueue.ts';
import type { SpendUsage } from '../lib/spendGovernor.ts';
import { percentile } from '../jobs/stats.ts';
import type { KeeperSnapshot } from './keeper.ts';

// Read-only view for GET /console (ADR-P7). Nothing here can change what the keeper sends: the recorder only
// copies outcomes after the queue returns them, and every other input is a getter or a SELECT.

export const CONSOLE_RECENT_MAX = 50;
/** liveCount reads hit the keeper's RPC; one multicall per this interval at most. */
export const LIVE_COUNT_TTL_MS = 10_000;

export interface RecentSend {
  block: number | null;
  action: string;
  coverId: Hex | null;
  txHash: Hex | null;
  outcome: 'confirmed' | 'reverted' | 'pending';
  gasLimit: number | null;
}

const BYTES32 = /^0x[0-9a-fA-F]{64}$/;

/** Ring of the last sends that reached the chain, newest first. */
export class SendRecorder {
  private readonly ring: RecentSend[] = [];

  record(req: ContractSend | TransferSend, out: SendOutcome): void {
    if (out.status === 'skipped') return;
    this.ring.unshift({
      block: out.status === 'pending' ? null : Number(out.blockNumber),
      action: req.label,
      coverId: req.ref && BYTES32.test(req.ref) ? (req.ref.toLowerCase() as Hex) : null,
      txHash: out.hash,
      outcome: out.status,
      gasLimit: 'gas' in req ? Number(req.gas) : null
    });
    if (this.ring.length > CONSOLE_RECENT_MAX) this.ring.length = CONSOLE_RECENT_MAX;
  }

  recent(): RecentSend[] {
    return this.ring.map((r) => ({ ...r }));
  }
}

/**
 * Observes the queue's results without altering them: the original promise result is returned unchanged and a
 * recorder failure is logged, never thrown into the send path.
 */
export function observeSends(queue: SendQueue, recorder: SendRecorder, log: Logger): void {
  const send = queue.send.bind(queue);
  queue.send = async (req) => {
    const out = await send(req);
    try {
      recorder.record(req, out);
    } catch (err) {
      log.warn({ err }, 'console.record_failed');
    }
    return out;
  };
}

/** Today's exempt (hot path) spend for the signer, from the ledger (same accounting as the governor). */
export function exemptUsedWei(db: Database, signer: Address, day: string): bigint {
  const rows = db
    .query<{ reserved_wei: string; actual_wei: string | null; status: string }, { signer: string; day: string }>(
      `SELECT reserved_wei, actual_wei, status FROM spend_ledger
       WHERE signer = $signer AND day = $day AND exempt = 1 AND status != 'released'`
    )
    .all({ signer, day });
  return rows.reduce((s, r) => s + BigInt(r.status === 'settled' ? (r.actual_wei ?? r.reserved_wei) : r.reserved_wei), 0n);
}

/** Cached liveCount(perp) per listed perp; a failed read keeps the last value (null before the first). */
export function liveCountReader(client: MonadPublicClient, manager: Address, perps: readonly number[], log: Logger, now: () => number = Date.now) {
  let last = new Map<number, number | null>(perps.map((p) => [p, null]));
  let at = Number.NEGATIVE_INFINITY;
  let inflight: Promise<void> | null = null;
  const refresh = async () => {
    try {
      const res = await multicall(client, {
        allowFailure: false,
        contracts: perps.map((p) => ({ address: manager, abi: ICoverManagerAbi, functionName: 'liveCount' as const, args: [BigInt(p)] as const }))
      });
      last = new Map(perps.map((p, i) => [p, Number(res[i])]));
    } catch (err) {
      log.debug({ err }, 'console.live_count_failed');
    } finally {
      at = now();
    }
  };
  return async (): Promise<Map<number, number | null>> => {
    if (now() - at >= LIVE_COUNT_TTL_MS) {
      inflight ??= refresh().finally(() => {
        inflight = null;
      });
      await inflight;
    }
    return last;
  };
}

export interface GapSample {
  gapBlocks: number;
  path: 'lane' | 'cycle';
}

export interface ConsoleDeps {
  health: () => { status: 'ok' | 'degraded'; alerts?: unknown };
  snapshot: () => Pick<KeeperSnapshot, 'proposed' | 'lagBlocks'>;
  markets: () => { perpId: number; gated: boolean; maxMatchesClose: number | null }[];
  gaps: () => readonly GapSample[];
  queueStatus: () => Pick<SendQueueStatus, 'address' | 'balanceWei'>;
  usage: () => SpendUsage;
  exemptUsed: (day: string) => bigint;
  liveCounts: () => Promise<Map<number, number | null>>;
  recorder: SendRecorder;
  startedAtMs: number;
  now?: () => number;
}

// Heads unsubscribed or stale: the keeper is not acting on chain at all.
const DOWN_ALERTS = new Set(['heads_unsubscribed', 'head_stale']);

/** Builds the console document field by field, so no keeper internal reaches it by accident. */
export async function buildConsole(d: ConsoleDeps) {
  const now = d.now ?? Date.now;
  const h = d.health();
  const alerts = Array.isArray(h.alerts) ? h.alerts.filter((a): a is string => typeof a === 'string') : [];
  const status = alerts.some((a) => DOWN_ALERTS.has(a)) ? 'down' : h.status === 'ok' ? 'up' : 'degraded';
  const snap = d.snapshot();
  const q = d.queueStatus();
  const usage = d.usage();
  const remaining = usage.capWei - usage.committedWei;
  const live = await d.liveCounts();
  const gaps = d.gaps();
  const sorted = gaps.map((g) => g.gapBlocks).sort((a, b) => a - b);
  return {
    schemaVersion: 1 as const,
    status,
    head: { block: snap.proposed === null ? null : Number(snap.proposed), lagBlocks: snap.lagBlocks },
    signer: { address: q.address, balanceWei: q.balanceWei },
    governor: {
      utcDay: usage.day,
      capWei: usage.capWei.toString(),
      usedWei: usage.committedWei.toString(),
      exemptUsedWei: d.exemptUsed(usage.day).toString(),
      remainingWei: (remaining > 0n ? remaining : 0n).toString()
    },
    markets: d.markets().map((m) => ({ perpId: m.perpId, gated: m.gated, maxMatchesClose: m.maxMatchesClose, liveCovers: live.get(m.perpId) ?? null })),
    recent: d.recorder.recent(),
    walks: {
      samples: sorted.length,
      chainGapP50: percentile(sorted, 50),
      chainGapMax: sorted.length ? sorted[sorted.length - 1]! : null,
      laneShare: gaps.length ? Math.round((gaps.filter((g) => g.path === 'lane').length / gaps.length) * 1e4) / 1e4 : null
    },
    uptimeS: Math.max(0, Math.floor((now() - d.startedAtMs) / 1000))
  };
}

export type KeeperConsole = Awaited<ReturnType<typeof buildConsole>>;
