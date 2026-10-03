import type { DB } from '../../db/core.ts';

/** Lifetime counters that drive accomplishments. */
export function bump(db: DB, playerId: number, key: string, n = 1) {
  if (n <= 0) return;
  db.prepare('INSERT INTO counters (player_id, key, value) VALUES (?,?,?) ON CONFLICT(player_id, key) DO UPDATE SET value = value + excluded.value').run(
    playerId,
    key,
    Math.floor(n),
  );
}

export function counters(db: DB, playerId: number): Record<string, number> {
  const rows = db.prepare('SELECT key, value FROM counters WHERE player_id = ?').all(playerId) as { key: string; value: number }[];
  return Object.fromEntries(rows.map((r) => [r.key, r.value]));
}
