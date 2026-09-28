import type { Logger } from './log.ts';

/**
 * F-5: a warn condition checked on every head (about 3 per second) is a transition, not a stream. Same 10 min
 * repeat as keeper.low_balance: long enough to keep alerting quiet, short enough that a stuck condition still shows.
 */
export const CONDITION_REPEAT_MS = 10 * 60_000;

interface Held {
  since: number;
  seenAt: number;
  warnedAt: number;
  suppressed: number;
}

/**
 * Logs a per-key condition at warn when it starts and again every `repeatMs` while it holds; the heads in between log
 * at debug. Clearing logs `<event>_resolved` at info. A key not seen for `repeatMs` is over (`how: 'unobserved'`).
 */
export class ConditionLog {
  private readonly held = new Map<string, Held>();

  constructor(
    private readonly log: Logger,
    private readonly event: string,
    private readonly now: () => number,
    private readonly repeatMs = CONDITION_REPEAT_MS
  ) {}

  hold(key: string, fields: Record<string, unknown>): void {
    const t = this.now();
    this.sweep(t);
    const h = this.held.get(key);
    if (!h) {
      this.held.set(key, { since: t, seenAt: t, warnedAt: t, suppressed: 0 });
      this.log.warn({ ...fields, state: 'start' }, this.event);
      return;
    }
    h.seenAt = t;
    if (t - h.warnedAt >= this.repeatMs) {
      this.log.warn({ ...fields, state: 'persists', heldMs: t - h.since, suppressed: h.suppressed }, this.event);
      h.warnedAt = t;
      h.suppressed = 0;
      return;
    }
    h.suppressed++;
    this.log.debug({ ...fields, state: 'persists' }, this.event);
  }

  clear(key: string, fields: Record<string, unknown> = {}): void {
    this.sweep(this.now());
    const h = this.held.get(key);
    if (h) this.end(key, h, 'cleared', fields);
  }

  private sweep(t: number): void {
    for (const [key, h] of this.held) if (t - h.seenAt > this.repeatMs) this.end(key, h, 'unobserved', {});
  }

  private end(key: string, h: Held, how: 'cleared' | 'unobserved', fields: Record<string, unknown>): void {
    this.held.delete(key);
    this.log.info({ ...fields, key, how, heldMs: h.seenAt - h.since, suppressed: h.suppressed }, `${this.event}_resolved`);
  }
}
