import type { Logger } from '../lib/log.ts';

export interface Runner {
  /** Stops scheduling, aborts the current run and resolves once it has settled. */
  stop(): Promise<void>;
}

/** Timer seam so tests drive ticks on a manual clock. */
export interface RunnerTimers {
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

const realTimers: RunnerTimers = {
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (h) => clearInterval(h as ReturnType<typeof setInterval>)
};

/**
 * Runs `task` now and then every `intervalMs`, skipping a tick while the previous run is going.
 * After `alertAfter` consecutive failures each one logs at error level as `jobs.degraded`.
 */
export function startRunner(opts: {
  intervalMs: number;
  task: (signal: AbortSignal) => Promise<void>;
  log: Logger;
  alertAfter?: number;
  timers?: RunnerTimers;
  now?: () => number;
}): Runner {
  const timers = opts.timers ?? realTimers;
  const now = opts.now ?? Date.now;
  const ac = new AbortController();
  const alertAfter = opts.alertAfter ?? 3;
  let current: Promise<void> | null = null;
  let failures = 0;

  const tick = () => {
    if (ac.signal.aborted) return;
    if (current) {
      opts.log.warn('jobs.tick_skipped: previous run still in progress');
      return;
    }
    const started = now();
    current = opts
      .task(ac.signal)
      .then(() => {
        failures = 0;
        opts.log.info({ ms: now() - started }, 'jobs.run_ok');
      })
      .catch((err: unknown) => {
        failures++;
        if (failures >= alertAfter) opts.log.error({ err, failures }, 'jobs.degraded');
        else opts.log.warn({ err, failures }, 'jobs.run_failed');
      })
      .finally(() => {
        current = null;
      });
  };

  tick();
  const timer = timers.setInterval(tick, opts.intervalMs);
  return {
    async stop() {
      timers.clearInterval(timer);
      ac.abort();
      await current;
    }
  };
}
