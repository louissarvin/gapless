import type { Database } from '../lib/db.ts';
import { utcDay } from '../lib/spendGovernor.ts';

/** Keeper migration 3 (F-7): walk starts per cover per UTC day, so the SE3-I2 cap survives a restart. Never deleted. */
export const KEEPER_TOUCHES_SQL = `
CREATE TABLE keeper_touches (
  signer TEXT NOT NULL,
  day TEXT NOT NULL,
  cover_id TEXT NOT NULL,
  starts INTEGER NOT NULL CHECK (starts >= 0),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (signer, day, cover_id)
);
`;

/** Landed walk starts (the contract ran the attempt at step 0) per cover and UTC day, in the keeper db. */
export class TouchLedger {
  constructor(
    private readonly db: Database,
    private readonly signer: string,
    private readonly now: () => number
  ) {}

  startsToday(coverId: string): number {
    return (
      this.db
        .query<{ starts: number }, Record<string, string>>('SELECT starts FROM keeper_touches WHERE signer = $signer AND day = $day AND cover_id = $cover')
        .get({ signer: this.signer.toLowerCase(), day: utcDay(this.now()), cover: coverId.toLowerCase() })?.starts ?? 0
    );
  }

  countStart(coverId: string): void {
    const t = this.now();
    this.db
      .query(
        `INSERT INTO keeper_touches (signer, day, cover_id, starts, updated_at) VALUES ($signer, $day, $cover, 1, $at)
         ON CONFLICT (signer, day, cover_id) DO UPDATE SET starts = starts + 1, updated_at = $at`
      )
      .run({ signer: this.signer.toLowerCase(), day: utcDay(t), cover: coverId.toLowerCase(), at: new Date(t).toISOString() });
  }
}
