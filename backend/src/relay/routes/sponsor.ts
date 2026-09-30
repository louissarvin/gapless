import type { FastifyPluginAsync } from 'fastify';
import { getAddress, isAddress, type Address, type Hex } from 'viem';
import { z } from 'zod';
import { HttpError, ok } from '../../lib/http.ts';
import { clientKey, registerOriginGuard } from '../../lib/security.ts';
import type { SponsorService } from '../sponsor/service.ts';

/** Per IP per minute on top of the sqlite day caps; each call can wait for receipts. */
export const SPONSOR_RATE_LIMIT = { max: 6, timeWindow: 60_000 } as const;
/** Two sends with reserve-window waits plus the 3-block wait fit inside this (connectionTimeout is longer). */
export const SPONSOR_HANDLER_TIMEOUT_MS = 35_000;

const address = z
  .string()
  .refine((v) => isAddress(v, { strict: true }), 'must be a 0x address')
  .transform((v): Address => getAddress(v));

function uint(bits: number) {
  const max = 1n << BigInt(bits);
  return z
    .string()
    .regex(/^\d{1,78}$/, 'must be a decimal integer string')
    .transform((v) => BigInt(v))
    .refine((v) => v < max, `must fit in uint${bits}`);
}

export const createBody = z.strictObject({
  owner: address,
  // GaplessTypes.OperatorGrant widths; the relay grant policy is checked in the service.
  grant: z.strictObject({ key: address, expiry: uint(64), maxNotionalPerTradeCNS: uint(128), maxNotionalPerDayCNS: uint(128) }),
  deadline: uint(256),
  // 65-byte EOA signature (r, s, v).
  sig: z.string().regex(/^0x[0-9a-fA-F]{130}$/, 'must be a 65-byte hex signature').transform((v) => v as Hex)
});

export const activateBody = z.strictObject({ account: address });

export interface SponsorRoutesOptions {
  appOrigin: string;
  /** Null when SPONSOR_ENABLED is off or sponsoring has not started (yet): routes answer 503. */
  service: () => SponsorService | null;
}

/** POST /sponsor/create and /activate (spec §4.2). */
export const sponsorRoutes: FastifyPluginAsync<SponsorRoutesOptions> = async (scope, opts) => {
  registerOriginGuard(scope, opts.appOrigin);
  const routeOpts = { config: { rateLimit: SPONSOR_RATE_LIMIT }, handlerTimeout: SPONSOR_HANDLER_TIMEOUT_MS };

  const service = (): SponsorService => {
    const svc = opts.service();
    if (!svc) throw new HttpError(503, 'SPONSOR_DISABLED', 'Sponsoring is not available');
    return svc;
  };

  scope.post('/sponsor/create', routeOpts, async (request) => {
    const svc = service();
    const body = createBody.parse(request.body);
    return ok(await svc.create(body, clientKey(request.ip)));
  });

  scope.post('/activate', routeOpts, async (request) => {
    const svc = service();
    const { account } = activateBody.parse(request.body);
    return ok(await svc.activate(account, clientKey(request.ip)));
  });
};
