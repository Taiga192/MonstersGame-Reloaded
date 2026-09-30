import { ANCESTRAL, CFG, HOUR, ITEM_BY_KEY, MAIN_STATS, SENTINEL_BY_KEY, type ItemDef, type Race, type Stat } from '../config.ts';
import type { DB } from '../db-core.ts';
import { assert, GameError } from '../errors.ts';
import { accomplishmentBonus } from './accomplishments.ts';

export interface Player {
  id: number; name: string; pass_hash: string; race: Race; level: number; xp: number; gold: number;
  hp: number; hp_at: number; max_hp: number;
  str: number; def: number; agi: number; sta: number; dex: number;
  last_attack_at: number;
  found_target: number | null; found_at: number;
  hunt_day: number; hunt_used: number;
  hunt_started: number | null; hunt_until: number | null; hunt_portions: number | null;
  dungeon_until: number | null;
  work_started: number | null; work_until: number | null; work_hours: number | null;
  ancestral_at: number; ancestral_wins: number; potion_stat_until: number; vitality_hp: number;
  referrer_id: number | null; referral_paid: number;
  clan_id: number | null; clan_role: string | null;
  wins: number; losses: number; is_bot: number; created_at: number;
}

export type Stats = Record<Stat, number>;

/** Load a player and settle lazy health regeneration. Also settles finished graveyard work. */
export function loadPlayer(db: DB, id: number, now: number): Player {
  const p = db.prepare('SELECT * FROM players WHERE id = ?').get(id) as Player | undefined;
  if (!p) throw new GameError('not_found', 'Player not found', 404);
  const hp = Math.min(p.max_hp, p.hp + (CFG.hpRegenPerHour * (now - p.hp_at)) / HOUR);
  if (Math.abs(hp - p.hp) > 1e-9 || p.hp_at !== now) {
    db.prepare('UPDATE players SET hp = ?, hp_at = ? WHERE id = ?').run(hp, now, id);
    p.hp = hp; p.hp_at = now;
  }
  return p;
}

export function setHp(db: DB, id: number, hp: number, now: number, maxHp?: number) {
  db.prepare('UPDATE players SET hp = ?, hp_at = ?, max_hp = COALESCE(?, max_hp) WHERE id = ?').run(hp, now, maxHp ?? null, id);
}

export function isWorking(p: Player, now: number) {
  return p.work_until != null && p.work_until > now;
}
export function isHunting(p: Player, now: number) {
  return p.hunt_until != null && p.hunt_until > now;
}
/** Inside the dungeon (an idle run ends by itself, see CFG.dungeonIdleLimit). */
export function isInDungeon(p: Player, now: number) {
  return p.dungeon_until != null && p.dungeon_until > now;
}
/** Working, hunting or delving locks the character out of every other action (and out of being raided). */
export const isBusy = (p: Player, now: number) => isWorking(p, now) || isHunting(p, now) || isInDungeon(p, now);
export function assertFree(p: Player, now: number) {
  assert(!isInDungeon(p, now), 'in_dungeon', 'You are inside the dungeon. Leave it first');
  assert(!isWorking(p, now), 'working', 'You are working in the graveyard');
  assert(!isHunting(p, now), 'hunting', 'You are out hunting. Wait for the hunt to end or cancel it');
}

/**
 * How many more Vitality Potions could still be USED: the cap (CFG.vitalityCap max HP in total) minus what was already
 * gained, minus the unused potions already in the bag. Buying or trading for more than this would waste gold.
 */
export function vitalityRoom(db: DB, p: Player): number {
  const left = Math.floor((CFG.vitalityCap - p.vitality_hp) / CFG.vitalityGain);
  const owned = ownedItems(db, p.id).filter((o) => o.def.potion === 'maxhp').length;
  return Math.max(0, left - owned);
}

export function ownedItems(db: DB, playerId: number): { id: number; def: ItemDef; hardening: number; boughtAt: number }[] {
  const rows = db.prepare('SELECT id, item_key, hardening, bought_at FROM inventory WHERE player_id = ?').all(playerId) as { id: number; item_key: string; hardening: number; bought_at: number }[];
  return rows.flatMap((r) => { const def = ITEM_BY_KEY.get(r.item_key); return def ? [{ id: r.id, def, hardening: r.hardening, boughtAt: r.bought_at }] : []; });
}

/** Item bonuses including weapon hardening (+Strength per level). */
export function effectiveBonus(def: ItemDef, hardening: number): Partial<Record<Stat, number>> {
  if (def.slot !== 'weapon' || !hardening) return def.bonus;
  return { ...def.bonus, str: (def.bonus.str ?? 0) + hardening * CFG.hardenBonusPerLevel };
}

export interface Loadout { bonus: Stats; goldBonus: number; huntBonus: number; perfection: boolean; equipped: number[] /* inventory ids in use */ }

/** Equipment is auto-equipped: best usable item per category. Only the best ring of each kind counts. */
export function equipmentLoadout(db: DB, p: Player): Loadout {
  const bonus: Stats = { str: 0, def: 0, agi: 0, sta: 0, dex: 0 };
  type Cand = { id: number; def: ItemDef; b: Partial<Record<Stat, number>> };
  const best = new Map<string, Cand>();
  const score = (c: Cand) => Object.values(c.b).reduce((a, b) => a + b, 0) + (c.def.goldBonus ?? 0) * 1000 + (c.def.huntBonus ?? 0);
  for (const { id, def, hardening } of ownedItems(db, p.id)) {
    if (def.slot === 'potion' || def.minLevel > p.level) continue;
    const c: Cand = { id, def, b: effectiveBonus(def, hardening) };
    const primary = MAIN_STATS.find((s) => def.bonus[s]) ?? def.ringKind ?? def.key;
    const cat = def.slot === 'ring' ? `ring:${def.ringKind}` : `${def.slot}:${primary}`;
    const cur = best.get(cat);
    if (!cur || score(c) > score(cur)) best.set(cat, c);
  }
  let goldBonus = 0, huntBonus = 0, perfection = false;
  for (const { def, b } of best.values()) {
    for (const s of MAIN_STATS) bonus[s] += b[s] ?? 0;
    goldBonus += def.goldBonus ?? 0;
    if (def.key === 'amulet_perfection') perfection = true;
    else huntBonus += def.huntBonus ?? 0;
  }
  return { bonus, goldBonus, huntBonus, perfection, equipped: [...best.values()].map((c) => c.id) };
}

export function sentinelBonus(db: DB, playerId: number): { atk: number; def: number; sta: number } {
  const s = db.prepare('SELECT * FROM sentinels WHERE player_id = ? AND active = 1').get(playerId) as
    | { sentinel_key: string; t_atk: number; t_def: number; t_sta: number } | undefined;
  const def = s && SENTINEL_BY_KEY.get(s.sentinel_key);
  if (!s || !def) return { atk: 0, def: 0, sta: 0 };
  return { atk: def.atk + s.t_atk, def: def.def + s.t_def, sta: def.sta + s.t_sta };
}

export function ancestralBonus(db: DB, p: Player): Stats {
  const out: Stats = { str: 0, def: 0, agi: 0, sta: 0, dex: 0 };
  if (p.level < CFG.ancestralMinLevel) return out;
  const rows = db.prepare('SELECT skill_key, level FROM ancestral_skills WHERE player_id = ?').all(p.id) as { skill_key: string; level: number }[];
  const slots = CFG.ancestralSlots(p.level);
  const known = new Map(ANCESTRAL[p.race].map((a) => [a.key, a.stat]));
  for (const r of rows.slice(0, slots)) {
    const stat = known.get(r.skill_key);
    if (stat) out[stat] += r.level * CFG.ancestralStatPerLevel;
  }
  return out;
}

export function hideoutTotal(db: DB, playerId: number): number {
  const h = db.prepare('SELECT * FROM hideouts WHERE player_id = ?').get(playerId) as
    | { surroundings: number; path: number; wall: number; building: number } | undefined;
  return h ? h.surroundings + h.path + h.wall + h.building : 0;
}

export interface Fighter { id: number; name: string; level: number; stats: Stats; hp: number; maxHp: number }

/**
 * Full battle stats: base + gear (equipment, accomplishments) + sentinel (+ ancestral if asked).
 * `equipment` toggles gear AND the active accomplishment set; the arena can switch each group off.
 */
export function battleStats(db: DB, p: Player, opts: { ancestral: boolean; equipment?: boolean; sentinels?: boolean; potion?: boolean }): Stats {
  const st: Stats = { str: p.str, def: p.def, agi: p.agi, sta: p.sta, dex: p.dex };
  if (opts.equipment !== false) {
    const l = equipmentLoadout(db, p).bonus, a = accomplishmentBonus(db, p.id).stats;
    for (const s of MAIN_STATS) st[s] += l[s] + a[s];
  }
  if (opts.sentinels !== false) { const s = sentinelBonus(db, p.id); st.str += s.atk; st.def += s.def; st.sta += s.sta; }
  if (opts.ancestral) { const a = ancestralBonus(db, p); for (const s of MAIN_STATS) st[s] += a[s]; }
  if (opts.potion !== false && p.potion_stat_until > p.hp_at) for (const s of MAIN_STATS) st[s] = Math.round(st[s] * 1.1);
  return st;
}

export interface XpResult { levelsGained: number; goldBonus: number; referralPaid: boolean }

/** Award XP, handle level-ups (gold bonus, max HP, partial heal) and the recruit bonus at level 3. */
export function awardXp(db: DB, id: number, xp: number, now: number): XpResult {
  const p = loadPlayer(db, id, now);
  let { level, xp: cur, max_hp: maxHp, gold, hp } = p;
  cur += xp;
  let levelsGained = 0, goldBonus = 0;
  while (cur >= CFG.xpToNext(level)) {
    cur -= CFG.xpToNext(level);
    level++; levelsGained++;
    goldBonus += CFG.levelUpGold(level);
    maxHp += CFG.levelUpMaxHp;
    hp = Math.min(maxHp, hp + CFG.levelUpHeal);
  }
  db.prepare('UPDATE players SET level = ?, xp = ?, gold = ?, max_hp = ?, hp = ?, hp_at = ? WHERE id = ?')
    .run(level, cur, gold + goldBonus, maxHp, hp, now, id);
  let referralPaid = false;
  if (level >= CFG.recruitLevel && p.referrer_id && !p.referral_paid) {
    db.prepare('UPDATE players SET referral_paid = 1 WHERE id = ?').run(id);
    db.prepare('UPDATE players SET gold = gold + ? WHERE id = ?').run(CFG.recruitGold, p.referrer_id);
    awardXp(db, p.referrer_id, CFG.recruitXp, now);
    referralPaid = true;
  }
  return { levelsGained, goldBonus, referralPaid };
}
