import { randomUUID } from 'node:crypto';
import type { Address } from 'viem';
import type { Database } from './db.ts';
import type { Logger } from './log.ts';

export const LEASE_DEFAULTS = { ttlMs: 30_000, renewMs: 10_000, waitPollMs: 1_000, waitSlackMs: 5_000 } as const;

export interface SignerLeaseOptions {
  db: Database;
  signer: Address;
  log: Logger;
  ttlMs?: number;
  renewMs?: number;
  holder?: string;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * One sending process per key on a shared data volume (rolling deploys, a second container).
 * A row per signer with a TTL; the holder renews it. It cannot see other hosts: deploy one machine.
 */
export class SignerLease {
  readonly holder: string;
  private readonly ttlMs: number;
  private readonly now: () => number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private released = false;

  constructor(private readonly o: SignerLeaseOptions) {
    this.holder = o.holder ?? randomUUID();
    this.ttlMs = o.ttlMs ?? LEASE_DEFAULTS.ttlMs;
    this.now = o.now ?? Date.now;
  }

  /** True when this process now holds the lease (free, expired or already ours). */
  acquire(): boolean {
    const t = this.now();
    return this.o.db
      .transaction((): boolean => {
        const row = this.o.db
          .query<{ holder: string; expires_at: number }, { signer: string }>('SELECT holder, expires_at FROM signer_lease WHERE signer = $signer')
          .get({ signer: this.o.signer });
        if (row && row.holder !== this.holder && row.expires_at > t) return false;
        this.o.db
          .query(
            `INSERT INTO signer_lease (signer, holder, expires_at, updated_at) VALUES ($signer, $holder, $exp, $at)
             ON CONFLICT (signer) DO UPDATE SET holder = excluded.holder, expires_at = excluded.expires_at, updated_at = excluded.updated_at`
          )
          .run({ signer: this.o.signer, holder: this.holder, exp: t + this.ttlMs, at: new Date(t).toISOString() });
        return true;
      })
      .immediate();
  }

  /**
   * SE2-L3: a restart right after a crash finds the dead holder's row; it lapses within the TTL, so poll for TTL plus
   * slack before giving up. A live holder keeps renewing and still wins.
   */
  async acquireWait(timeoutMs = this.ttlMs + LEASE_DEFAULTS.waitSlackMs): Promise<boolean> {
    const deadline = this.now() + timeoutMs;
    const sleep = this.o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    let logged = false;
    for (;;) {
      if (this.acquire()) return true;
      if (this.now() >= deadline) return false;
      if (!logged) {
        this.o.log.warn({ signer: this.o.signer, waitMs: timeoutMs }, 'signer.lease_wait');
        logged = true;
      }
      await sleep(LEASE_DEFAULTS.waitPollMs);
    }
  }

  /** SE3-I3: runs a start step under the acquired lease and releases it if the step throws, so a retry can take it. */
  async holding<T>(start: () => Promise<T>): Promise<T> {
    try {
      return await start();
    } catch (err) {
      this.release();
      throw err;
    }
  }

  /** Renews on a timer; `onLost` runs once if another holder took over (this process must stop sending). */
  start(onLost: () => void): void {
    this.timer = setInterval(() => {
      if (this.acquire()) return;
      this.stop();
      this.o.log.error({ signer: this.o.signer }, 'signer.lease_lost');
      onLost();
    }, this.o.renewMs ?? LEASE_DEFAULTS.renewMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Shutdown or exit: the next process may start at once. Idempotent; never throws (runs in exit handlers). */
  release(): void {
    this.stop();
    if (this.released) return;
    this.released = true;
    try {
      this.o.db.query('DELETE FROM signer_lease WHERE signer = $signer AND holder = $holder').run({ signer: this.o.signer, holder: this.holder });
    } catch (err) {
      this.o.log.warn({ err, signer: this.o.signer }, 'signer.lease_release_failed');
    }
  }
}
