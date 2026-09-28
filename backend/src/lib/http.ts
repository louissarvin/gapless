import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

export interface ApiErrorBody {
  code: string;
  message: string;
  requestId?: string;
  details?: { path: string; message: string }[];
}

export type ApiResponse<T> =
  | { success: true; data: T; error: null }
  | { success: false; data: null; error: ApiErrorBody };

export function ok<T>(data: T): ApiResponse<T> {
  return { success: true, data, error: null };
}

/** Throw from handlers for expected failures. `message` is sent to the client, so keep it generic. */
export class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

const MAX_DETAILS = 10;

// Fixed client messages per status: library error messages may reveal internals, so never forward them.
const STATUS_DEFAULTS: Record<number, { code: string; message: string }> = {
  400: { code: 'BAD_REQUEST', message: 'Bad request' },
  401: { code: 'UNAUTHORIZED', message: 'Unauthorized' },
  403: { code: 'FORBIDDEN', message: 'Forbidden' },
  404: { code: 'NOT_FOUND', message: 'Not found' },
  405: { code: 'METHOD_NOT_ALLOWED', message: 'Method not allowed' },
  406: { code: 'NOT_ACCEPTABLE', message: 'Not acceptable' },
  408: { code: 'REQUEST_TIMEOUT', message: 'Request timeout' },
  411: { code: 'LENGTH_REQUIRED', message: 'Length required' },
  413: { code: 'PAYLOAD_TOO_LARGE', message: 'Payload too large' },
  414: { code: 'URI_TOO_LONG', message: 'URI too long' },
  415: { code: 'UNSUPPORTED_MEDIA_TYPE', message: 'Unsupported media type' },
  429: { code: 'RATE_LIMITED', message: 'Too many requests' },
  431: { code: 'HEADERS_TOO_LARGE', message: 'Request header fields too large' }
};

const INTERNAL = { code: 'INTERNAL_ERROR', message: 'Internal server error' };

interface Mapped {
  status: number;
  body: ApiErrorBody;
}

function zodDetails(err: z.ZodError): ApiErrorBody['details'] {
  return err.issues.slice(0, MAX_DETAILS).map((i) => ({
    path: i.path.map(String).join('.'),
    message: i.message
  }));
}

/** Pure mapping from any thrown value to a safe status and body. Exported for tests. */
export function mapError(error: unknown): Mapped {
  if (error instanceof HttpError) {
    return { status: error.statusCode, body: { code: error.code, message: error.message } };
  }
  if (error instanceof z.ZodError) {
    return {
      status: 400,
      body: { code: 'VALIDATION_ERROR', message: 'Invalid request', details: zodDetails(error) }
    };
  }
  const fe = error as Partial<FastifyError> | null;
  if (fe && typeof fe === 'object' && Array.isArray(fe.validation)) {
    return { status: 400, body: { code: 'VALIDATION_ERROR', message: 'Invalid request' } };
  }
  const status = typeof fe?.statusCode === 'number' ? fe.statusCode : 500;
  if (status >= 400 && status < 500) {
    return { status, body: { ...(STATUS_DEFAULTS[status] ?? STATUS_DEFAULTS[400]!) } };
  }
  return { status: 500, body: { ...INTERNAL } };
}

function send(reply: FastifyReply, request: FastifyRequest, mapped: Mapped) {
  const body: ApiResponse<never> = {
    success: false,
    data: null,
    error: { ...mapped.body, requestId: String(request.id) }
  };
  return reply.code(mapped.status).type('application/json; charset=utf-8').send(body);
}

/**
 * Installs the error and 404 handlers. Clients get stable codes only; stacks and causes go to logs.
 * Call after @fastify/rate-limit is registered so 404 probing is rate limited too.
 */
export function registerErrorHandling(app: FastifyInstance): void {
  app.setErrorHandler((error, request, reply) => {
    const mapped = mapError(error);
    if (mapped.status >= 500) {
      request.log.error({ err: error }, 'request.failed');
    } else {
      // Client errors are routine (scanners, 429 floods): debug keeps them out of production logs.
      const code = (error as Partial<FastifyError>)?.code;
      request.log.debug({ status: mapped.status, code: mapped.body.code, cause: code }, 'request.rejected');
    }
    return send(reply, request, mapped);
  });

  const preHandler = 'rateLimit' in app ? [app.rateLimit()] : [];
  app.setNotFoundHandler({ preHandler }, (request, reply) =>
    send(reply, request, { status: 404, body: { ...STATUS_DEFAULTS[404]! } })
  );
}
