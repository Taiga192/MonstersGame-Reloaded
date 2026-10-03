import { mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { DB } from '../db/core.ts';

/**
 * Consistent snapshot of the live database (SQLite "VACUUM INTO": safe while the game runs) into `dir`, then delete all but
 * the newest `keep` snapshots. Returns the new file. Run it outside of a transaction.
 */
export function backupDatabase(db: DB, dir: string, keep: number, now = Date.now()): string {
  mkdirSync(dir, { recursive: true });
  const stamp = new Date(now).toISOString().replace(/[-:]/g, '').replace('T', '-').replace('.', '-').replace('Z', ''); // 20270115-120000-123
  const file = join(dir, `monsters-${stamp}.db`);
  db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
  const all = readdirSync(dir)
    .filter((f) => /^monsters-[\d-]+\.db$/.test(f))
    .sort(); // names sort chronologically
  for (const old of all.slice(0, Math.max(0, all.length - Math.max(1, keep)))) rmSync(join(dir, old), { force: true });
  return file;
}
