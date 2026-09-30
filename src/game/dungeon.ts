import { CFG, DAY_MS } from '../config.ts';
import { lootRow, monsterName, relicRow, tierOf } from '../dungeon-data.ts';
import type { DB } from '../db-core.ts';
import { assert } from '../errors.ts';
import { randRange, type Rng } from '../rng.ts';
import { damage, hitChance } from './combat.ts';
import { bump } from './counters.ts';
import { assertFree, awardXp, battleStats, isInDungeon, loadPlayer, type Stats } from './player.ts';

// ---------------------------------------------------------------------------------------------------------------------
// The dungeon: an endless ladder. One monster per level, stronger every level. Dungeon HP is its own pool (filled to the
// character's max HP on entry, never regenerating during a run). Progress (the next level) is kept when you leave or die and
// wiped every Monday 00:00 UTC. Loot is kept until sold to the relic dealer in town.
// ---------------------------------------------------------------------------------------------------------------------

export const WEEK_MS = 7 * DAY_MS;
/** Week index; weeks start on Monday 00:00 UTC (1970-01-05 was a Monday). */
export const weekOf = (now: number) => Math.floor((now - 4 * DAY_MS) / WEEK_MS);
export const weekStart = (week: number) => week * WEEK_MS + 4 * DAY_MS;

interface Row {
  player_id: number; week: number; depth: number; reached_at: number; active: number; hp: number; max_hp: number; last_at: number;
  cooldown_until: number; kills: number; deaths: number; runs: number; xp_week: number; pending: string | null; best_ever: number;
}
export interface RewardOption { name: string; value: number }
export interface Monster { depth: number; name: string; guardian: boolean; stats: Stats; hp: number; xp: number }

export const isGuardian = (depth: number) => depth % CFG.dungeonMilestone === 0;

export function monsterAt(depth: number): Monster {
  const guardian = isGuardian(depth);
  const s = Math.round(CFG.dungeonMonsterStat(depth) * (guardian ? 1.25 : 1));
  return { depth, name: monsterName(depth), guardian, stats: { str: s, def: s, agi: s, sta: s, dex: s }, hp: CFG.dungeonMonsterHp(depth), xp: CFG.dungeonXp(depth) * (guardian ? 3 : 1) };
}

// ---------------------------------------------------------------- combat
export interface FightLog { round: number; who: 'you' | 'monster'; hit: boolean; damage: number; hpYou: number; hpMonster: number }
export interface FightResult { won: boolean; hpLeft: number; rounds: number; log: FightLog[] }

/**
 * One duel against a monster. The player brings the dungeon HP they have left; the monster is always fresh. Unlike raids
 * (lost below 10 HP) a dungeon fight ends at 0 HP. Same hit and damage formulas as every other fight in the game.
 */
export function fightMonster(you: Stats, hp: number, maxHp: number, monster: Monster, rng: Rng): FightResult {
  let mine = hp, theirs = monster.hp, round = 0;
  const log: FightLog[] = [];
  while (mine > 0 && theirs > 0 && round < 400) {
    round++;
    const youAct = round % 2 === 1; // you strike first
    const [att, def] = youAct ? [you, monster.stats] : [monster.stats, you];
    const hit = rng() < hitChance(att.agi, def.def);
    const dmg = hit ? damage(att.str, def.sta, randRange(rng, 0.75, 1.25), youAct ? monster.hp : maxHp) : 0;
    if (youAct) theirs -= dmg; else mine -= dmg;
    if (log.length < 300) log.push({ round, who: youAct ? 'you' : 'monster', hit, damage: dmg, hpYou: Math.max(0, mine), hpMonster: Math.max(0, theirs) });
  }
  const won = theirs <= 0 || (mine > 0 && mine / maxHp >= theirs / monster.hp); // (only ever the second clause after 400 rounds)
  return { won, hpLeft: won ? Math.max(1, mine) : 0, rounds: round, log };
}

// ---------------------------------------------------------------- state
function load(db: DB, id: number, now: number): Row {
  let r = db.prepare('SELECT * FROM dungeon WHERE player_id = ?').get(id) as unknown as Row | undefined;
  if (!r) {
    db.prepare('INSERT INTO dungeon (player_id, week, reached_at) VALUES (?,?,?)').run(id, weekOf(now), now);
    r = db.prepare('SELECT * FROM dungeon WHERE player_id = ?').get(id) as unknown as Row;
  }
  if (r.week !== weekOf(now)) rollWeek(db, r, now);
  else expireIdle(db, r, now);
  return db.prepare('SELECT * FROM dungeon WHERE player_id = ?').get(id) as unknown as Row;
}

/** Monday rolled over: an unclaimed guardian reward is auto-claimed (best option), the week is archived, progress resets. */
function rollWeek(db: DB, r: Row, now: number) {
  if (r.pending) { const best = (JSON.parse(r.pending) as RewardOption[]).sort((a, b) => b.value - a.value)[0]; addLoot(db, r.player_id, best.name, best.value, r.depth - 1, true, now); }
  if (r.depth > 1) db.prepare('INSERT OR REPLACE INTO dungeon_weekly (week, player_id, depth) VALUES (?,?,?)').run(r.week, r.player_id, r.depth - 1);
  db.prepare(
    `UPDATE dungeon SET week = ?, depth = 1, reached_at = ?, active = 0, hp = 0, kills = 0, deaths = 0, runs = 0, xp_week = 0, pending = NULL WHERE player_id = ?`,
  ).run(weekOf(now), now, r.player_id);
  db.prepare('UPDATE players SET dungeon_until = NULL WHERE id = ?').run(r.player_id);
}

/** A run nobody touched for CFG.dungeonIdleLimit is over: the character leaves on its own (progress kept, cooldown counts from the last action). */
function expireIdle(db: DB, r: Row, now: number) {
  if (!r.active) return;
  const until = (db.prepare('SELECT dungeon_until u FROM players WHERE id = ?').get(r.player_id) as { u: number | null }).u ?? 0;
  if (until > now) return;
  db.prepare('UPDATE dungeon SET active = 0, cooldown_until = ? WHERE player_id = ?').run(Math.max(r.cooldown_until, r.last_at + CFG.dungeonCooldown), r.player_id);
  db.prepare('UPDATE players SET dungeon_until = NULL WHERE id = ?').run(r.player_id);
}

function addLoot(db: DB, playerId: number, name: string, value: number, depth: number, milestone: boolean, now: number) {
  db.prepare('INSERT INTO dungeon_loot (player_id, name, value, depth, milestone, found_at) VALUES (?,?,?,?,?,?)').run(playerId, name, value, depth, +milestone, now);
}

const threat = (ratio: number) => (ratio < 0.5 ? 'trivial' : ratio < 0.8 ? 'easy' : ratio < 1.1 ? 'even' : ratio < 1.4 ? 'dangerous' : 'deadly');
const power = (s: Stats) => s.str + s.def + s.agi + s.sta;

/** Everything the UI needs. Also settles weekly reset / idle expiry. */
export function dungeonState(db: DB, id: number, now: number) {
  const r = load(db, id, now);
  const p = loadPlayer(db, id, now);
  const mon = monsterAt(r.depth);
  const mine = battleStats(db, p, { ancestral: p.level >= CFG.ancestralMinLevel });
  const loot = db.prepare('SELECT id, name, value, depth, milestone FROM dungeon_loot WHERE player_id = ? ORDER BY value DESC, id').all(id) as { id: number; name: string; value: number; depth: number; milestone: number }[];
  const idleUntil = r.active ? p.dungeon_until : null;
  return {
    week: r.week, weekEndsAt: weekStart(r.week + 1), depth: r.depth, cleared: r.depth - 1, bestEver: r.best_ever,
    active: !!r.active, hp: r.hp, maxHp: r.max_hp, idleUntil, cooldownUntil: r.cooldown_until, canEnter: !r.active && now >= r.cooldown_until,
    kills: r.kills, deaths: r.deaths, runs: r.runs, xpWeek: r.xp_week,
    pending: r.pending ? (JSON.parse(r.pending) as RewardOption[]) : null,
    monster: { depth: mon.depth, name: mon.name, guardian: mon.guardian, xp: mon.xp, tier: Math.min(9, tierOf(mon.depth)), threat: threat(power(mon.stats) / Math.max(1, power(mine))) },
    dropChance: CFG.dungeonDropChance, cooldown: CFG.dungeonCooldown, idleLimit: CFG.dungeonIdleLimit, milestone: CFG.dungeonMilestone,
    loot, lootValue: loot.reduce((s, l) => s + l.value, 0),
  };
}

// ---------------------------------------------------------------- actions
export function enterDungeon(db: DB, id: number, now: number) {
  const r = load(db, id, now);
  const p = loadPlayer(db, id, now);
  assertFree(p, now);
  assert(!r.active, 'in_dungeon', 'You are already inside the dungeon');
  assert(now >= r.cooldown_until, 'cooldown', `You can enter again in ${Math.ceil((r.cooldown_until - now) / 60000)} min`);
  // dungeon HP is separate from real HP: always a full pool, however hurt you are outside
  db.prepare('UPDATE dungeon SET active = 1, hp = ?, max_hp = ?, last_at = ?, runs = runs + 1 WHERE player_id = ?').run(p.max_hp, p.max_hp, now, id);
  db.prepare('UPDATE players SET dungeon_until = ? WHERE id = ?').run(now + CFG.dungeonIdleLimit, id);
  return { hp: p.max_hp, depth: r.depth };
}

export function leaveDungeon(db: DB, id: number, now: number) {
  const r = load(db, id, now);
  assert(r.active, 'not_in_dungeon', 'You are not inside the dungeon');
  db.prepare('UPDATE dungeon SET active = 0, cooldown_until = ? WHERE player_id = ?').run(now + CFG.dungeonCooldown, id);
  db.prepare('UPDATE players SET dungeon_until = NULL WHERE id = ?').run(id);
  return { depth: r.depth, cooldownUntil: now + CFG.dungeonCooldown };
}

export interface DungeonFightResult {
  won: boolean; died: boolean; depth: number; monster: { name: string; guardian: boolean }; hpLeft: number; hpLost: number; rounds: number; log: FightLog[];
  xp: number; levelsGained: number; drop: { name: string; value: number } | null; choice: RewardOption[] | null; nextDepth: number; cooldownUntil: number | null;
}

/** Fight the monster of the current level. Win: XP, maybe a drop, one level deeper. Lose: the run ends, nothing is lost. */
export function fight(db: DB, id: number, now: number, rng: Rng): DungeonFightResult {
  const r = load(db, id, now);
  assert(r.active, 'not_in_dungeon', 'You are not inside the dungeon');
  assert(!r.pending, 'choose_reward', 'Choose your guardian reward first');
  const p = loadPlayer(db, id, now);
  const mon = monsterAt(r.depth);
  const res = fightMonster(battleStats(db, p, { ancestral: p.level >= CFG.ancestralMinLevel }), r.hp, r.max_hp, mon, rng);
  const base = { depth: r.depth, monster: { name: mon.name, guardian: mon.guardian }, rounds: res.rounds, log: res.log, hpLost: r.hp - res.hpLeft };

  if (!res.won) { // death: the run is over, XP and items are kept, the level is still to be beaten
    const cooldownUntil = now + CFG.dungeonCooldown;
    db.prepare('UPDATE dungeon SET active = 0, hp = 0, deaths = deaths + 1, cooldown_until = ? WHERE player_id = ?').run(cooldownUntil, id);
    db.prepare('UPDATE players SET dungeon_until = NULL WHERE id = ?').run(id);
    return { ...base, won: false, died: true, hpLeft: 0, xp: 0, levelsGained: 0, drop: null, choice: null, nextDepth: r.depth, cooldownUntil };
  }

  const xp = mon.xp;
  const lv = awardXp(db, id, xp, now);
  let drop: { name: string; value: number } | null = null;
  if (rng() < CFG.dungeonDropChance) {
    const row = lootRow(r.depth);
    drop = { name: row[Math.floor(rng() * row.length)], value: Math.max(1, Math.round(CFG.dungeonLootValue(r.depth) * randRange(rng, 0.8, 1.2))) };
    addLoot(db, id, drop.name, drop.value, r.depth, false, now);
  }
  let choice: RewardOption[] | null = null;
  if (mon.guardian) { // guardians offer a choice of high value items
    const names = [...relicRow(r.depth)]; const opts: RewardOption[] = [];
    for (let i = 0; i < CFG.dungeonRewardOptions && names.length; i++) {
      const [lo, hi] = CFG.dungeonRelicMultiplier;
      opts.push({ name: names.splice(Math.floor(rng() * names.length), 1)[0], value: Math.round(CFG.dungeonLootValue(r.depth) * randRange(rng, lo, hi)) });
    }
    choice = opts;
  }
  const depth = r.depth + 1;
  db.prepare(
    `UPDATE dungeon SET depth = ?, reached_at = ?, hp = ?, last_at = ?, kills = kills + 1, xp_week = xp_week + ?, best_ever = MAX(best_ever, ?), pending = ? WHERE player_id = ?`,
  ).run(depth, now, res.hpLeft, now, xp, depth - 1, choice ? JSON.stringify(choice) : null, id);
  db.prepare('UPDATE players SET dungeon_until = ? WHERE id = ?').run(now + CFG.dungeonIdleLimit, id); // activity keeps the run alive
  bump(db, id, 'dungeon_levels');
  return { ...base, won: true, died: false, hpLeft: res.hpLeft, xp, levelsGained: lv.levelsGained, drop, choice, nextDepth: depth, cooldownUntil: null };
}

/** Pick one of the guardian's rewards (allowed inside or outside the dungeon; the rest are gone). */
export function chooseReward(db: DB, id: number, index: number, now: number) {
  const r = load(db, id, now);
  assert(r.pending, 'no_choice', 'There is no reward to choose');
  const opts = JSON.parse(r.pending) as RewardOption[];
  assert(Number.isInteger(index) && index >= 0 && index < opts.length, 'bad_choice', 'Choose one of the offered rewards');
  addLoot(db, id, opts[index].name, opts[index].value, r.depth - 1, true, now);
  db.prepare('UPDATE dungeon SET pending = NULL WHERE player_id = ?').run(id);
  if (r.active) db.prepare('UPDATE players SET dungeon_until = ? WHERE id = ?').run(now + CFG.dungeonIdleLimit, id);
  return opts[index];
}

/** The relic dealer in town buys loot for its listed value. Not possible while inside the dungeon. */
export function sellLoot(db: DB, id: number, lootId: number | 'all', now: number) {
  load(db, id, now); // settles an expired run
  assertFree(loadPlayer(db, id, now), now);
  const rows = (lootId === 'all'
    ? db.prepare('SELECT id, value FROM dungeon_loot WHERE player_id = ?').all(id)
    : db.prepare('SELECT id, value FROM dungeon_loot WHERE player_id = ? AND id = ?').all(id, lootId)) as { id: number; value: number }[];
  assert(rows.length, 'no_loot', 'Nothing to sell', 404);
  const gold = rows.reduce((s, r) => s + r.value, 0);
  db.prepare(`DELETE FROM dungeon_loot WHERE player_id = ? ${lootId === 'all' ? '' : 'AND id = ?'}`).run(...(lootId === 'all' ? [id] : [id, lootId]));
  db.prepare('UPDATE players SET gold = gold + ? WHERE id = ?').run(gold, id);
  return { gold, count: rows.length };
}

export { isInDungeon };
