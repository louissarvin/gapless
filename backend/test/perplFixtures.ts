import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import pino from 'pino';

const DIR = join(import.meta.dir, 'fixtures', 'perpl');

/** Raw frames captured from the live Perpl market-data WS, one per line, untouched. */
export function loadWsFixture(): string[] {
  return readFileSync(join(DIR, 'ws_market_data.jsonl'), 'utf8').split('\n').filter(Boolean);
}

/** Raw REST body captured from the live Perpl API. */
export function loadRestFixture(name: string): string {
  return readFileSync(join(DIR, name), 'utf8');
}

/** pino logger that records parsed lines for assertions. */
export function captureLogger() {
  const lines: Record<string, unknown>[] = [];
  const log = pino({ level: 'debug' }, { write: (s: string) => void lines.push(JSON.parse(s)) });
  return { log, lines, events: () => lines.map((l) => l.msg) };
}
