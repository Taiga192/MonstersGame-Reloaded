import { ACC_BY_KEY, ACC_SET_SIZE, ACC_SETS, ACCOMPLISHMENTS, type AccDef, type Stat } from '../config.ts';
import type { DB } from '../db-core.ts';
import { assert } from '../errors.ts';
import { counters } from './counters.ts';

export const tierOf = (def: AccDef, value: number) => def.tiers.filter((t) => value >= t).length;

export interface AccStatus { key: string; name: string; desc: string; value: number; tier: number; maxTier: number; next: number | null; bonusText: string }

function bonusText(def: AccDef, tier: number) {
  const b = def.bonus, amt = tier * b.per;
  if (b.kind === 'stat') return `+${amt} ${b.stat.toUpperCase()}`;
  return `+${Math.round(amt * 100)}% ${{ raidGold: 'raid gold', huntReward: 'hunt XP & gold', workWage: 'work wages' }[b.kind]}`;
}

/** Progress on every accomplishment. All are earned automatically and without limit. */
export function accomplishmentStatus(db: DB, playerId: number): AccStatus[] {
  const c = counters(db, playerId);
  const level = (db.prepare('SELECT level FROM players WHERE id = ?').get(playerId) as { level: number }).level;
  return ACCOMPLISHMENTS.map((def) => {
    const value = def.counter === 'level' ? level : c[def.counter] ?? 0;
    const tier = tierOf(def, value);
    return { key: def.key, name: def.name, desc: def.desc, value, tier, maxTier: def.tiers.length, next: def.tiers[tier] ?? null, bonusText: bonusText(def, Math.max(tier, 1)) };
  });
}

export interface AccBonus { stats: Record<Stat, number>; raidGold: number; huntReward: number; workWage: number }

/** Bonus from the ACTIVE set only. */
export function accomplishmentBonus(db: DB, playerId: number): AccBonus {
  const out: AccBonus = { stats: { str: 0, def: 0, agi: 0, sta: 0, dex: 0 }, raidGold: 0, huntReward: 0, workWage: 0 };
  const set = db.prepare('SELECT keys FROM acc_sets WHERE player_id = ? AND active = 1').get(playerId) as { keys: string } | undefined;
  if (!set) return out;
  const status = new Map(accomplishmentStatus(db, playerId).map((s) => [s.key, s]));
  for (const key of JSON.parse(set.keys) as string[]) {
    const def = ACC_BY_KEY.get(key), st = status.get(key);
    if (!def || !st || !st.tier) continue;
    const b = def.bonus;
    if (b.kind === 'stat') out.stats[b.stat] += st.tier * b.per; else out[b.kind] += st.tier * b.per;
  }
  return out;
}

export function getSets(db: DB, playerId: number) {
  const rows = db.prepare('SELECT slot, keys, active FROM acc_sets WHERE player_id = ?').all(playerId) as { slot: number; keys: string; active: number }[];
  return Array.from({ length: ACC_SETS }, (_, slot) => {
    const r = rows.find((x) => x.slot === slot);
    return { slot, keys: r ? (JSON.parse(r.keys) as string[]) : [], active: !!r?.active };
  });
}

/** Replace the contents of one set. Only accomplishments you have actually earned (tier >= 1) can be slotted. */
export function saveSet(db: DB, playerId: number, slot: number, keys: string[]) {
  assert(Number.isInteger(slot) && slot >= 0 && slot < ACC_SETS, 'bad_set', 'Unknown set');
  assert(Array.isArray(keys) && keys.length <= ACC_SET_SIZE, 'bad_set', `A set holds at most ${ACC_SET_SIZE} accomplishments`);
  assert(new Set(keys).size === keys.length, 'bad_set', 'Duplicate accomplishment');
  const earned = new Set(accomplishmentStatus(db, playerId).filter((s) => s.tier > 0).map((s) => s.key));
  for (const k of keys) assert(earned.has(k), 'not_earned', `You have not earned "${ACC_BY_KEY.get(k)?.name ?? k}" yet`);
  db.prepare(
    'INSERT INTO acc_sets (player_id, slot, keys) VALUES (?,?,?) ON CONFLICT(player_id, slot) DO UPDATE SET keys = excluded.keys',
  ).run(playerId, slot, JSON.stringify(keys));
}

/** Exactly one set is active (premium, which allowed two, does not exist here). */
export function activateSet(db: DB, playerId: number, slot: number) {
  assert(Number.isInteger(slot) && slot >= 0 && slot < ACC_SETS, 'bad_set', 'Unknown set');
  db.prepare('UPDATE acc_sets SET active = 0 WHERE player_id = ?').run(playerId);
  db.prepare(
    "INSERT INTO acc_sets (player_id, slot, keys, active) VALUES (?,?, '[]', 1) ON CONFLICT(player_id, slot) DO UPDATE SET active = 1",
  ).run(playerId, slot);
}
