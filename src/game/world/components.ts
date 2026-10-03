/** Finding shrine parts (tier 2) while playing. A leaf file: the game rules call it, it calls nothing of theirs. */
import { ITEM_BY_KEY, type ItemDef } from '../../core/config.ts';
import type { DB } from '../../db/core.ts';
import type { Rng } from '../../core/rng.ts';

const KINDS = ['chalice', 'altar', 'idol'] as const;

/** With the given chance, put a random tier 2 part into the character's inventory. Returns what was found. */
export function maybeFindComponent(db: DB, playerId: number, chance: number, now: number, rng: Rng): ItemDef | null {
  if (!(chance > 0) || rng() >= chance) return null;
  const def = ITEM_BY_KEY.get(`shrine_${KINDS[Math.floor(rng() * KINDS.length)]}_2`)!;
  db.prepare('INSERT INTO inventory (player_id, item_key, bought_at) VALUES (?,?,?)').run(playerId, def.key, now);
  return def;
}
