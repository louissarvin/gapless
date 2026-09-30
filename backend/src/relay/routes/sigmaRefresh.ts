import type { FastifyPluginAsync } from 'fastify';
import { getAddress, isAddress, type Address } from 'viem';
import { multicall } from 'viem/actions';
import { z } from 'zod';
import { IGaplessAccountAbi, IGaplessFactoryAbi, IPerplMinAbi } from '../../abi/index.ts';
import { PERPL_EXCHANGE } from '../../lib/addresses.ts';
import type { Database } from '../../lib/db.ts';
import { HttpError, ok } from '../../lib/http.ts';
import type { Logger } from '../../lib/log.ts';
import { registerOriginGuard } from '../../lib/security.ts';
import type { ChainClient } from '../../lib/sendQueue.ts';
import { utcDay } from '../../lib/spendGovernor.ts';
import { DailyCounters, isSponsoredAccount } from '../sponsor/ledger.ts';

/** BUILD_PLAN W4: one forwarded refresh per 60 s, per perp. */
export const SIGMA_REFRESH_INTERVAL_MS = 60_000;
const FORWARD_TIMEOUT_MS = 3_000;

const body = z.strictObject({
  perpId: z.number().int().min(1).max(65_535),
  // The Gapless account asking for a quote; it must hold an open Perpl position on perpId.
  account: z
    .string()
    .refine((v) => isAddress(v, { strict: true }), 'must be a 0x address')
    .transform((v): Address => getAddress(v))
});

export interface SigmaRefreshOptions {
  appOrigin: string;
  /** KEEPER_INTERNAL_URL; unset answers 503. */
  keeperUrl?: string;
  /** RELAY_INTERNAL_TOKEN, sent as a bearer token on the private network. */
  token?: string;
  /** GAPLESS_FACTORY_ADDRESS for the isAccount check; unset answers 503. */
  factory?: Address;
  client: ChainClient;
  db: Database;
  perAccountPerDay: number;
  /**
   * SE3-M3 (SPONSOR_ALLOWLIST_ONLY): only accounts the relay created may ask. The keeper's 12 posts per UTC day are
   * shared by everyone who can ask, so raise SIGMA_POLICY.maxPostsPerDay with the budget before public quotes.
   */
  sponsoredOnly: boolean;
  log: Logger;
  fetch?: typeof fetch;
  now?: () => number;
}

/**
 * POST /sigma-refresh from the PWA after a SigmaStale quote: forwards to the keeper's internal endpoint.
 * M-5: demand must come from a real Gapless account with an open position on that perp (read onchain),
 * limited per account per day; the 60 s slot is per perp so one caller cannot block other markets.
 */
export const sigmaRefreshRoutes: FastifyPluginAsync<SigmaRefreshOptions> = async (scope, opts) => {
  registerOriginGuard(scope, opts.appOrigin);
  const now = opts.now ?? Date.now;
  const doFetch = opts.fetch ?? fetch;
  const counters = new DailyCounters(opts.db);
  const last = new Map<number, number>();

  const eligible = async (account: Address, perpId: number): Promise<boolean> => {
    const [isAcct, perplId, owner] = await multicall(opts.client, {
      allowFailure: true,
      contracts: [
        { address: opts.factory!, abi: IGaplessFactoryAbi, functionName: 'isAccount', args: [account] },
        { address: account, abi: IGaplessAccountAbi, functionName: 'perplAccountId' },
        { address: account, abi: IGaplessAccountAbi, functionName: 'owner' }
      ]
    });
    if (isAcct.status !== 'success' || !isAcct.result || perplId.status !== 'success' || perplId.result === 0n) return false;
    if (opts.sponsoredOnly && (owner.status !== 'success' || !isSponsoredAccount(opts.db, owner.result, account))) return false;
    const [pos] = await multicall(opts.client, {
      allowFailure: false,
      contracts: [{ address: PERPL_EXCHANGE, abi: IPerplMinAbi, functionName: 'getPosition', args: [BigInt(perpId), perplId.result] }]
    });
    return pos[0].lotLNS > 0n;
  };

  scope.post('/sigma-refresh', { config: { rateLimit: { max: 10, timeWindow: 60_000 } } }, async (request, reply) => {
    if (!opts.keeperUrl || !opts.token || !opts.factory) throw new HttpError(503, 'SIGMA_REFRESH_UNAVAILABLE', 'Sigma refresh is not available');
    const { perpId, account } = body.parse(request.body);
    const t = now();
    const prev = last.get(perpId) ?? Number.NEGATIVE_INFINITY;
    if (t - prev < SIGMA_REFRESH_INTERVAL_MS) {
      reply.header('retry-after', String(Math.ceil((prev + SIGMA_REFRESH_INTERVAL_MS - t) / 1000)));
      throw new HttpError(429, 'RATE_LIMITED', 'A sigma refresh was requested recently');
    }
    let isEligible: boolean;
    try {
      isEligible = await eligible(account, perpId);
    } catch (err) {
      opts.log.warn({ err }, 'sigma_refresh.eligibility_failed');
      throw new HttpError(503, 'SIGMA_REFRESH_UNAVAILABLE', 'Sigma refresh is not available right now');
    }
    if (!isEligible) throw new HttpError(403, 'NOT_ELIGIBLE', 'A Gapless onboarding account with an open position on this market is required');
    const day = utcDay(t);
    if (counters.count('sigma_account', account.toLowerCase(), day) >= opts.perAccountPerDay) {
      throw new HttpError(429, 'SIGMA_REFRESH_CAP', 'Daily refresh limit reached for this account');
    }
    // Claim the perp slot before the forward so concurrent requests cannot both forward.
    if (t - (last.get(perpId) ?? Number.NEGATIVE_INFINITY) < SIGMA_REFRESH_INTERVAL_MS) {
      reply.header('retry-after', String(Math.ceil(SIGMA_REFRESH_INTERVAL_MS / 1000)));
      throw new HttpError(429, 'RATE_LIMITED', 'A sigma refresh was requested recently');
    }
    last.set(perpId, t);
    let status: number;
    try {
      const res = await doFetch(new URL('/sigma-refresh', opts.keeperUrl), {
        method: 'POST',
        headers: { authorization: `Bearer ${opts.token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ perpId }),
        redirect: 'error',
        signal: AbortSignal.timeout(FORWARD_TIMEOUT_MS)
      });
      status = res.status;
    } catch (err) {
      opts.log.warn({ err }, 'sigma_refresh.keeper_unreachable');
      status = 0;
    }
    if (status === 202) {
      counters.bump('sigma_account', account.toLowerCase(), day, 1);
      reply.code(202);
      return ok({ queued: true });
    }
    // Only an accepted refresh spends the perp slot.
    last.set(perpId, prev);
    if (status === 404) throw new HttpError(404, 'UNKNOWN_MARKET', 'Market is not covered');
    if (status !== 0) opts.log.warn({ status }, 'sigma_refresh.keeper_rejected');
    throw new HttpError(503, 'KEEPER_UNAVAILABLE', 'Sigma refresh is not available right now');
  });
};
