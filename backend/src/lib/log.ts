import pino, { type Logger, type LoggerOptions } from 'pino';

export type { Logger };

export type LogLevel = 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace';

// Stops at quotes and backslashes so it can also run over a serialized JSON line.
const URL_PATTERN = /\b(?:https?|wss?):\/\/[^\s"'<>`\\]+/gi;
const CENSOR = '<redacted>';
const MAX_DEPTH = 8;

// Compared after lowercasing and dropping separators, so `Authorization`, `x-api-key` and `PRIVATE_KEY` all match.
const SECRET_KEY_NAMES = new Set([
  'authorization',
  'proxyauthorization',
  'cookie',
  'setcookie',
  'key',
  'token',
  'secret',
  'password',
  'passwd',
  'rpcurl',
  'rpcurls',
  'wsurl',
  'httpurls',
  'monadhttpurls',
  'monadwsurl'
]);
const SECRET_KEY_SUFFIXES = ['token', 'secret', 'password', 'privatekey', 'apikey', 'relaykey', 'keeperkey'];

/** Env vars whose values are secrets; `secretValues` collects them for value-based redaction. */
export const SECRET_ENV_KEYS = [
  'MONAD_HTTP_URLS',
  'MONAD_WS_URL',
  'ENVIO_API_TOKEN',
  'RELAY_INTERNAL_TOKEN',
  'RELAY_KEY',
  'KEEPER_KEY'
] as const;

// Shorter fragments (for example `v2` in a URL path) would redact ordinary text.
const MIN_SECRET_LENGTH = 8;

export function isSecretKey(key: string): boolean {
  const k = key.toLowerCase().replace(/[^a-z0-9]/g, '');
  return SECRET_KEY_NAMES.has(k) || SECRET_KEY_SUFFIXES.some((s) => k.endsWith(s));
}

/**
 * Keeps scheme and host, hides path, query and credentials.
 * RPC providers put API keys in the path (QuickNode, Alchemy) or query.
 */
export function redactUrl(raw: string): string {
  try {
    const u = new URL(raw);
    const hasPath = u.pathname !== '' && u.pathname !== '/';
    return `${u.protocol}//${u.host}${hasPath ? '/<redacted>' : ''}${u.search ? '?<redacted>' : ''}`;
  } catch {
    return '<redacted-url>';
  }
}

export function scrubUrls(text: string): string {
  // A URL already reduced by redactUrl is left alone, so scrubbing twice is stable.
  return text.replace(URL_PATTERN, (m: string, offset: number) =>
    text.startsWith(CENSOR, offset + m.length) ? m : redactUrl(m)
  );
}

/**
 * Secret strings to strip from every log line: whole values plus URL path segments, query values
 * and credentials (an RPC key alone is enough to abuse the endpoint).
 */
export function secretValues(env: Record<string, unknown>): string[] {
  const out = new Set<string>();
  const add = (v: string) => {
    if (v.length < MIN_SECRET_LENGTH) return;
    out.add(v);
    try {
      out.add(decodeURIComponent(v));
    } catch {
      // Malformed escapes: the raw form is already covered.
    }
  };
  for (const name of SECRET_ENV_KEYS) {
    const v = env[name];
    for (const item of Array.isArray(v) ? v : [v]) {
      if (typeof item !== 'string' || item === '') continue;
      add(item);
      // Private keys also leak without their 0x prefix.
      if (/^0x[0-9a-fA-F]{64}$/.test(item)) add(item.slice(2));
      let u: URL;
      try {
        u = new URL(item);
      } catch {
        continue;
      }
      for (const seg of u.pathname.split('/')) add(seg);
      for (const qv of u.searchParams.values()) add(qv);
      add(u.password);
      add(u.username);
    }
  }
  return [...out].sort((a, b) => b.length - a.length);
}

function serializeError(err: Error, depth: number): Record<string, unknown> {
  const base = pino.stdSerializers.errWithCause(err) as unknown as Record<string, unknown>;
  return sanitize(base, depth) as Record<string, unknown>;
}

/** Deep copy with secret keys censored, Errors (and their causes) serialized and URLs scrubbed. */
function sanitize(value: unknown, depth: number): unknown {
  if (typeof value === 'string') return scrubUrls(value);
  if (value === null || typeof value !== 'object') return value;
  if (depth > MAX_DEPTH) return '[depth]';
  if (value instanceof Error) return serializeError(value, depth + 1);
  if (Array.isArray(value)) return value.map((v) => sanitize(v, depth + 1));
  if (value instanceof Date) return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) out[k] = isSecretKey(k) ? CENSOR : sanitize(v, depth + 1);
  return out;
}

function keepSanitized(v: unknown): unknown {
  return v instanceof Error ? serializeError(v, 0) : v;
}

function jsonEscaped(s: string): string {
  return JSON.stringify(s).slice(1, -1);
}

/**
 * @param secrets Exact values to strip from the final line (see `secretValues`); covers text the
 *   key-based checks cannot see, such as a token inside a third-party error message.
 */
export function loggerOptions(service: string, level: LogLevel, secrets: readonly string[] = []): LoggerOptions {
  const needles = [...new Set(secrets.flatMap((s) => [s, jsonEscaped(s)]))].filter((s) => s.length >= MIN_SECRET_LENGTH);
  return {
    level,
    base: { service },
    timestamp: pino.stdTimeFunctions.isoTime,
    // formatters.log already sanitized errors; the default err serializer would re-type them as Object.
    serializers: { err: keepSanitized, error: keepSanitized },
    formatters: {
      level: (label) => ({ level: label }),
      log: (obj) => sanitize(obj, 0) as Record<string, unknown>
    },
    hooks: {
      // Last pass over the whole line: msg text (pino copies err.message there) and exact secret values.
      streamWrite(s: string) {
        let line = scrubUrls(s);
        for (const n of needles) if (line.includes(n)) line = line.replaceAll(n, CENSOR);
        return line;
      }
    }
  };
}

/** Structured JSON logger to stdout. Synchronous, so logs flush before process.exit. */
export function createLogger(service: string, level: LogLevel = 'info', secrets: readonly string[] = []): Logger {
  return pino(loggerOptions(service, level, secrets));
}
