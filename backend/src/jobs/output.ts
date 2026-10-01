import { randomUUID } from 'node:crypto';
import { mkdir, open, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';

/** Docs served by GET /api/gap-index/:doc, mapped to fixed file names (never derived from input). */
export const GAP_INDEX_FILES = {
  summary: 'summary.json',
  gaps: 'gaps.json',
  staleness: 'staleness.json',
  'premium-curve': 'premium-curve.json',
  'native-stops': 'native-stops.json'
} as const;
export type GapIndexDoc = keyof typeof GAP_INDEX_FILES;
export const GAP_INDEX_DOCS = Object.keys(GAP_INDEX_FILES) as GapIndexDoc[];

/** Protocol traction numbers served by GET /api/stats. */
export const STATS_FILE = 'stats.json';

/** Proposed MarketParams for setMarketParams; offline artifact, not served. */
export const FIT_FILE = 'fit.json';

/**
 * Writes JSON via temp file, fsync and rename, so readers see the old or the new file and
 * never a partial one. JSON.stringify throws on bigint, so unconverted values fail loudly.
 */
export async function writeJsonAtomic(dir: string, file: string, value: unknown): Promise<void> {
  await mkdir(dir, { recursive: true });
  const body = JSON.stringify(value);
  const tmp = join(dir, `.${file}.${process.pid}.${randomUUID()}.tmp`);
  try {
    const fh = await open(tmp, 'w', 0o644);
    try {
      await fh.writeFile(body, 'utf8');
      await fh.sync();
    } finally {
      await fh.close();
    }
    await rename(tmp, join(dir, file));
  } catch (err) {
    await rm(tmp, { force: true });
    throw err;
  }
}
