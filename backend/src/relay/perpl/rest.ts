import type { z } from 'zod';
import { HttpError } from '../../lib/http.ts';
import type { Logger } from '../../lib/log.ts';

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

/**
 * Upstream budgets per class, per minute. Perpl allows about 100 public REST requests/min per
 * IP and every user shares the relay's IP, so a flood on one class cannot starve the others.
 */
export const UPSTREAM_BUDGET_PER_MIN = { live: 40, history: 30, context: 10 } as const;
export type BudgetClass = keyof typeof UPSTREAM_BUDGET_PER_MIN;

const DEFAULTS = {
  timeoutMs: 5_000,
  maxEntries: 512,
  maxBodyBytes: 2 * 1024 * 1024,
  // A stale value may be served this long past expiry when the upstream fails or the budget is spent.
  maxStaleMs: 60_000,
  // Docs: back off on 429.
  cooldownMs: 10_000,
  // Upstream 400/404 (unknown market, rejected range) stay cached at least this long.
  negativeTtlMs: 60_000
};

interface Entry {
  value: unknown;
  status: 200 | 400 | 404;
  fetchedAt: number;
  expiresAt: number;
}

export interface CachedResult<T> {
  value: T;
  ageMs: number;
  /** cache: fresh hit; upstream: fetched now (or joined an inflight fetch); stale: expired entry served as fallback. */
  source: 'cache' | 'upstream' | 'stale';
}

class TokenBucket {
  private tokens: number;
  private last: number;
  constructor(
    private readonly perMinute: number,
    private readonly now: () => number
  ) {
    this.tokens = perMinute;
    this.last = now();
  }
  take(): boolean {
    const t = this.now();
    this.tokens = Math.min(this.perMinute, this.tokens + ((t - this.last) * this.perMinute) / 60_000);
    this.last = t;
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }
}

export interface PerplRestOptions {
  baseUrl: string;
  log: Logger;
  fetch?: FetchLike;
  now?: () => number;
  timeoutMs?: number;
  maxEntries?: number;
  maxBodyBytes?: number;
  maxStaleMs?: number;
  negativeTtlMs?: number;
  budgets?: Partial<Record<BudgetClass, number>>;
}

export interface GetOptions {
  /** Charged only when this call would spend an upstream request; false means the caller is over its own budget. */
  charge?: () => boolean;
}

/**
 * GET-only client for public Perpl REST paths with a TTL cache, single-flight per key, per-class
 * upstream budgets and stale fallback. Sends fixed headers only; nothing from the client request.
 */
export class PerplRestClient {
  private readonly base: string;
  private readonly fetchImpl: FetchLike;
  private readonly now: () => number;
  private readonly cfg: typeof DEFAULTS;
  private readonly cache = new Map<string, Entry>();
  private readonly inflight = new Map<string, Promise<Entry>>();
  private readonly buckets: Record<BudgetClass, TokenBucket>;
  private cooldownUntil = 0;

  constructor(private readonly opts: PerplRestOptions) {
    this.base = opts.baseUrl.replace(/\/+$/, '');
    this.fetchImpl = opts.fetch ?? ((url, init) => fetch(url, init));
    this.now = opts.now ?? Date.now;
    this.cfg = {
      timeoutMs: opts.timeoutMs ?? DEFAULTS.timeoutMs,
      maxEntries: opts.maxEntries ?? DEFAULTS.maxEntries,
      maxBodyBytes: opts.maxBodyBytes ?? DEFAULTS.maxBodyBytes,
      maxStaleMs: opts.maxStaleMs ?? DEFAULTS.maxStaleMs,
      cooldownMs: DEFAULTS.cooldownMs,
      negativeTtlMs: opts.negativeTtlMs ?? DEFAULTS.negativeTtlMs
    };
    const b = { ...UPSTREAM_BUDGET_PER_MIN, ...opts.budgets };
    this.buckets = {
      live: new TokenBucket(b.live, this.now),
      history: new TokenBucket(b.history, this.now),
      context: new TokenBucket(b.context, this.now)
    };
  }

  /**
   * @param path Upstream path after the base, built only from validated values (e.g. `/v1/pub/context`).
   * @param schema Validates the upstream body before it is cached or served.
   * @throws HttpError 404 (unknown market), 400 (rejected upstream), 429 (caller over its miss budget),
   *   503 (budget or cooldown), 502 (upstream failure).
   */
  async get<T>(path: string, cls: BudgetClass, ttlMs: number, schema: z.ZodType<T>, opts: GetOptions = {}): Promise<CachedResult<T>> {
    const now = this.now();
    const hit = this.cache.get(path);
    if (hit && now < hit.expiresAt) {
      // LRU: hot keys survive a flood of one-off keys.
      this.cache.delete(path);
      this.cache.set(path, hit);
      return this.result(hit, 'cache');
    }

    const pending = this.inflight.get(path);
    if (pending) return this.settle(path, pending);

    const staleOk = hit && hit.status === 200 && now - hit.expiresAt <= this.cfg.maxStaleMs;
    // The caller's own budget is checked first so a capped client never spends a shared token.
    if (opts.charge && !opts.charge()) {
      if (staleOk) return this.result(hit, 'stale');
      throw new HttpError(429, 'RATE_LIMITED', 'Too many requests');
    }
    if (now < this.cooldownUntil || !this.buckets[cls].take()) {
      if (staleOk) return this.result(hit, 'stale');
      this.opts.log.warn({ path, cls }, 'perpl.rest_budget_exhausted');
      throw new HttpError(503, 'UPSTREAM_BUSY', 'Market data is busy, retry shortly');
    }

    const p = this.fetchEntry(path, ttlMs, schema).finally(() => this.inflight.delete(path));
    this.inflight.set(path, p);
    return this.settle(path, p);
  }

  /** Awaits a fetch; on upstream failure falls back to a recent good value. */
  private async settle<T>(path: string, p: Promise<Entry>): Promise<CachedResult<T>> {
    let entry: Entry;
    try {
      entry = await p;
    } catch (err) {
      const stale = this.cache.get(path);
      if (stale && stale.status === 200 && this.now() - stale.expiresAt <= this.cfg.maxStaleMs) {
        return this.result(stale, 'stale');
      }
      throw err;
    }
    return this.result(entry, 'upstream');
  }

  private result<T>(e: Entry, source: CachedResult<T>['source']): CachedResult<T> {
    if (e.status === 404) throw new HttpError(404, 'NOT_FOUND', 'Unknown market');
    if (e.status === 400) throw new HttpError(400, 'UPSTREAM_REJECTED', 'Request rejected by market data source');
    return { value: e.value as T, ageMs: Math.max(0, this.now() - e.fetchedAt), source };
  }

  private async fetchEntry<T>(path: string, ttlMs: number, schema: z.ZodType<T>): Promise<Entry> {
    const started = this.now();
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.base}${path}`, {
        method: 'GET',
        headers: { accept: 'application/json' },
        redirect: 'error',
        signal: AbortSignal.timeout(this.cfg.timeoutMs)
      });
    } catch (err) {
      this.opts.log.warn({ err, path }, 'perpl.rest_fetch_failed');
      throw new HttpError(502, 'UPSTREAM_UNAVAILABLE', 'Market data temporarily unavailable');
    }

    if (res.status === 400 || res.status === 404) {
      await res.body?.cancel();
      // Negative results are cached too, so unknown ids cannot burn the upstream budget.
      return this.store(path, {
        value: null,
        status: res.status,
        fetchedAt: started,
        expiresAt: started + Math.max(ttlMs, this.cfg.negativeTtlMs)
      });
    }
    if (res.status === 429) this.cooldownUntil = this.now() + this.cfg.cooldownMs;
    if (res.status !== 200) {
      await res.body?.cancel();
      this.opts.log.warn({ path, status: res.status }, 'perpl.rest_upstream_status');
      throw new HttpError(res.status === 429 || res.status === 503 ? 503 : 502, 'UPSTREAM_UNAVAILABLE', 'Market data temporarily unavailable');
    }

    let body: unknown;
    try {
      body = JSON.parse(await readCapped(res, this.cfg.maxBodyBytes));
    } catch (err) {
      this.opts.log.warn({ err, path }, 'perpl.rest_body_invalid');
      throw new HttpError(502, 'UPSTREAM_UNAVAILABLE', 'Market data temporarily unavailable');
    }
    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      this.opts.log.error({ path, issues: parsed.error.issues.slice(0, 3) }, 'perpl.rest_schema_mismatch');
      throw new HttpError(502, 'UPSTREAM_UNAVAILABLE', 'Market data temporarily unavailable');
    }
    const fetchedAt = this.now();
    return this.store(path, { value: parsed.data, status: 200, fetchedAt, expiresAt: fetchedAt + ttlMs });
  }

  private store(key: string, e: Entry): Entry {
    this.cache.delete(key);
    this.cache.set(key, e);
    while (this.cache.size > this.cfg.maxEntries) {
      const oldest = this.cache.keys().next().value;
      if (oldest === undefined) break;
      this.cache.delete(oldest);
    }
    return e;
  }
}

async function readCapped(res: Response, maxBytes: number): Promise<string> {
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await res.body?.cancel();
    throw new Error('upstream body too large');
  }
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new Error('upstream body too large');
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}
