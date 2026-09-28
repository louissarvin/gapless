import { describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { Writable } from 'node:stream';
import pino from 'pino';
import { loggerOptions, secretValues } from '../src/lib/log.ts';
import { SOURCE_DIR, sync } from '../scripts/sync-abi.ts';

describe('frozen ABIs', () => {
  // The contract tree sits next to backend/ in this workspace; skip where it is absent.
  test.skipIf(!existsSync(SOURCE_DIR))('src/abi matches contract/abi (bun scripts/sync-abi.ts)', () => {
    expect(sync(true)).toEqual([]);
  });
});

describe('signing keys never reach logs', () => {
  test('KEEPER_KEY and RELAY_KEY values are stripped with or without 0x', () => {
    const key = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
    let out = '';
    const stream = new Writable({
      write(chunk, _enc, cb) {
        out += String(chunk);
        cb();
      }
    });
    const log = pino(loggerOptions('test', 'info', secretValues({ KEEPER_KEY: key, RELAY_KEY: key })), stream);
    log.info({ detail: `boom ${key}` }, `failed with ${key.slice(2)}`);
    expect(out).toContain('boom');
    expect(out).not.toContain(key.slice(2));
  });
});
