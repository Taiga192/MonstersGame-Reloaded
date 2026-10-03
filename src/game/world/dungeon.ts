import { CFG, DAY_MS } from '../../core/config.ts';
import { lootRow, monsterName, relicRow, tierOf } from '../../data/dungeon-data.ts';
import type { DB } from '../../db/core.ts';
import { assert } from '../../core/errors.ts';
import { randRange, type Rng } from '../../core/rng.ts';
import { damage, hitChance } from '../combat/combat.ts';
import { bump } from '../character/counters.ts';
import { gatherBlood } from './blood.ts';
import { modsOf } from '../character/mods.ts';
import { maybeFindComponent } from './components.ts';
import { assertFree, awardXp, battleStats, isInDungeon, loadPlayer, type Stats } from '../character/player.ts';

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
  player_id: number;
  week: number;
  depth: number;
  reached_at: number;
  active: number;
  hp: number;
  max_hp: number;
  last_at: number;
  cooldown_until: number;
  kills: number;
  deaths: number;
  runs: number;
  xp_week: number;
  pending: string | null;
  best_ever: number;
  ready_at: number;
  checkpoint: number;
}
export interface RewardOption {
  name: string;
  value: number;
}
export interface Monster {
  depth: number;
  name: string;
  guardian: boolean;
  stats: Stats;
  hp: number;
  xp: number;
}

export const isGuardian = (depth: number) => depth % CFG.dungeonMilestone === 0;

export function monsterAt(depth: number): Monster {
  const guardian = isGuardian(depth);
  const s = Math.round(CFG.dungeonMonsterStat(depth) * (guardian ? 1.25 : 1));
  return {
    depth,
    name: monsterName(depth),
    guardian,
    stats: { str: s, def: s, agi: s, sta: s, dex: s },
    hp: CFG.dungeonMonsterHp(depth),
    xp: CFG.dungeonXp(depth) * (guardian ? 3 : 1),
  };
}

// ---------------------------------------------------------------- combat
export interface FightLog {
  round: number;
  who: 'you' | 'monster';
  hit: boolean;
  damage: number;
  hpYou: number;
  hpMonster: number;
}
export interface FightResult {
  won: boolean;
  hpLeft: number;
  rounds: number;
  log: FightLog[];
}

/**
 * One duel against a monster. The player brings the dungeon HP they have left; the monster is always fresh. Unlike raids
 * (lost below 10 HP) a dungeon fight ends at 0 HP. Same hit and damage formulas as every other fight in the game.
 */
export function fightMonster(you: Stats, hp: number, maxHp: number, monster: Monster, rng: Rng): FightResult {
  let mine = hp,
    theirs = monster.hp,
    round = 0;
  const log: FightLog[] = [];
  while (mine > 0 && theirs > 0 && round < 400) {
    round++;
    const youAct = round % 2 === 1; // you strike first
    const [att, def] = youAct ? [you, monster.stats] : [monster.stats, you];
    const hit = rng() < hitChance(att.agi, def.def);
    const dmg = hit ? damage(att.str, def.sta, randRange(rng, 0.75, 1.25), youAct ? monster.hp : maxHp) : 0;
    if (youAct) theirs -= dmg;
    else mine -= dmg;
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
  if (r.pending) {
    const best = (JSON.parse(r.pending) as RewardOption[]).sort((a, b) => b.value - a.value)[0];
    addLoot(db, r.player_id, best.name, best.value, r.depth - 1, true, now);
  }
  if (r.kills > 0) db.prepare('INSERT OR REPLACE INTO dungeon_weekly (week, player_id, depth) VALUES (?,?,?)').run(r.week, r.player_id, r.depth - 1); // (only weeks that were played)
  db.prepare(
    `UPDATE dungeon SET week = ?, depth = ?, reached_at = ?, active = 0, hp = 0, kills = 0, deaths = 0, runs = 0, xp_week = 0, pending = NULL, ready_at = 0 WHERE player_id = ?`,
  ).run(weekOf(now), Math.max(1, r.checkpoint), now, r.player_id); // the new week starts at the last checkpoint reached (level 1 when there is none)
  db.prepare('UPDATE players SET dungeon_until = NULL WHERE id = ?').run(r.player_id);
}

/** A run nobody touched for CFG.dungeonIdleLimit is over: the character leaves on its own (progress kept, cooldown counts from the last action). */
function expireIdle(db: DB, r: Row, now: number) {
  if (!r.active) return;
  const until = (db.prepare('SELECT dungeon_until u FROM players WHERE id = ?').get(r.player_id) as { u: number | null }).u ?? 0;
  if (until > now) return;
  db.prepare('UPDATE dungeon SET active = 0, cooldown_until = ? WHERE player_id = ?').run(
    Math.max(r.cooldown_until, r.last_at + CFG.dungeonCooldown),
    r.player_id,
  );
  db.prepare('UPDATE players SET dungeon_until = NULL WHERE id = ?').run(r.player_id);
}

function addLoot(db: DB, playerId: number, name: string, value: number, depth: number, milestone: boolean, now: number) {
  db.prepare('INSERT INTO dungeon_loot (player_id, name, value, depth, milestone, found_at) VALUES (?,?,?,?,?,?)').run(
    playerId,
    name,
    value,
    depth,
    +milestone,
    now,
  );
}

const threat = (ratio: number) => (ratio < 0.5 ? 'trivial' : ratio < 0.8 ? 'easy' : ratio < 1.1 ? 'even' : ratio < 1.4 ? 'dangerous' : 'deadly');
const power = (s: Stats) => s.str + s.def + s.agi + s.sta;

/** Everything the UI needs. Also settles weekly reset / idle expiry. */
export function dungeonState(db: DB, id: number, now: number) {
  const r = load(db, id, now);
  const p = loadPlayer(db, id, now);
  const mon = monsterAt(r.depth);
  const mine = battleStats(db, p, { ancestral: p.level >= CFG.ancestralMinLevel });
  const loot = db.prepare('SELECT id, name, value, depth, milestone FROM dungeon_loot WHERE player_id = ? ORDER BY value DESC, id').all(id) as {
    id: number;
    name: string;
    value: number;
    depth: number;
    milestone: number;
  }[];
  const idleUntil = r.active ? p.dungeon_until : null;
  return {
    week: r.week,
    weekEndsAt: weekStart(r.week + 1),
    depth: r.depth,
    cleared: r.depth - 1,
    bestEver: r.best_ever,
    active: !!r.active,
    hp: r.hp,
    maxHp: r.max_hp,
    idleUntil,
    cooldownUntil: r.cooldown_until,
    readyAt: r.active ? r.ready_at : 0,
    checkpoint: r.checkpoint,
    checkpointEvery: CFG.dungeonCheckpoint,
    nextCheckpoint: (Math.floor(r.depth / CFG.dungeonCheckpoint) + 1) * CFG.dungeonCheckpoint,
    canEnter: !r.active && now >= r.cooldown_until,
    kills: r.kills,
    deaths: r.deaths,
    runs: r.runs,
    xpWeek: r.xp_week,
    pending: r.pending ? (JSON.parse(r.pending) as RewardOption[]) : null,
    monster: {
      depth: mon.depth,
      name: mon.name,
      guardian: mon.guardian,
      xp: mon.xp,
      tier: Math.min(9, tierOf(mon.depth)),
      threat: threat(power(mon.stats) / Math.max(1, power(mine))),
    },
    dropChance: CFG.dungeonDropChance,
    cooldown: CFG.dungeonCooldown,
    fightCooldown: CFG.dungeonFightCooldown,
    idleLimit: CFG.dungeonIdleLimit,
    milestone: CFG.dungeonMilestone,
    loot,
    lootValue: loot.reduce((s, l) => s + l.value, 0),
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
  const pool = Math.round(p.max_hp * (1 + (modsOf(p).dungeonHp ?? 0)));
  db.prepare('UPDATE dungeon SET active = 1, hp = ?, max_hp = ?, last_at = ?, runs = runs + 1, ready_at = 0 WHERE player_id = ?').run(pool, pool, now, id);
  db.prepare('UPDATE players SET dungeon_until = ? WHERE id = ?').run(now + CFG.dungeonIdleLimit, id);
  bump(db, id, 'dungeon_runs');
  return { hp: pool, depth: r.depth };
}

export function leaveDungeon(db: DB, id: number, now: number) {
  const r = load(db, id, now);
  assert(r.active, 'not_in_dungeon', 'You are not inside the dungeon');
  db.prepare('UPDATE dungeon SET active = 0, cooldown_until = ? WHERE player_id = ?').run(now + CFG.dungeonCooldown, id);
  db.prepare('UPDATE players SET dungeon_until = NULL WHERE id = ?').run(id);
  return { depth: r.depth, cooldownUntil: now + CFG.dungeonCooldown };
}

export interface DungeonFightResult {
  won: boolean;
  died: boolean;
  depth: number;
  monster: { name: string; guardian: boolean };
  hpLeft: number;
  hpLost: number;
  rounds: number;
  log: FightLog[];
  xp: number;
  levelsGained: number;
  drop: { name: string; value: number } | null;
  /** a shrine part found with the guardian */ component?: string | null;
  choice: RewardOption[] | null;
  nextDepth: number;
  cooldownUntil: number | null;
  /** when the next fight is allowed (null after dying) */ readyAt: number | null;
  /** a new checkpoint was reached with this victory */ checkpoint: number | null;
}

/** Fight the monster of the current level. Win: XP, maybe a drop, one level deeper. Lose: the run ends, nothing is lost. */
export function fight(db: DB, id: number, now: number, rng: Rng): DungeonFightResult {
  const r = load(db, id, now);
  assert(r.active, 'not_in_dungeon', 'You are not inside the dungeon');
  assert(!r.pending, 'choose_reward', 'Choose your guardian reward first');
  assert(now >= r.ready_at, 'fight_cooldown', `The next monster is not here yet: ${Math.ceil((r.ready_at - now) / 1000)} s`);
  const p = loadPlayer(db, id, now);
  const mon = monsterAt(r.depth);
  gatherBlood(db, id, 'dungeon');
  const res = fightMonster(battleStats(db, p, { ancestral: p.level >= CFG.ancestralMinLevel }), r.hp, r.max_hp, mon, rng);
  const base = { depth: r.depth, monster: { name: mon.name, guardian: mon.guardian }, rounds: res.rounds, log: res.log, hpLost: r.hp - res.hpLeft };

  if (!res.won) {
    // death: the run is over, XP and items are kept, the level is still to be beaten
    const cooldownUntil = now + CFG.dungeonCooldown;
    db.prepare('UPDATE dungeon SET active = 0, hp = 0, deaths = deaths + 1, cooldown_until = ? WHERE player_id = ?').run(cooldownUntil, id);
    db.prepare('UPDATE players SET dungeon_until = NULL WHERE id = ?').run(id);
    return {
      ...base,
      won: false,
      died: true,
      hpLeft: 0,
      xp: 0,
      levelsGained: 0,
      drop: null,
      choice: null,
      nextDepth: r.depth,
      cooldownUntil,
      readyAt: null,
      checkpoint: null,
    };
  }

  const m = modsOf(p);
  const loot = 1 + (m.dungeonLoot ?? 0);
  const xp = Math.round(mon.xp * (1 + (m.dungeonXp ?? 0)));
  const lv = awardXp(db, id, xp, now);
  const xpGained = lv.xpGained;
  let drop: { name: string; value: number } | null = null;
  if (rng() < CFG.dungeonDropChance + (m.dungeonDrop ?? 0)) {
    const row = lootRow(r.depth);
    drop = { name: row[Math.floor(rng() * row.length)], value: Math.max(1, Math.round(CFG.dungeonLootValue(r.depth) * randRange(rng, 0.8, 1.2) * loot)) };
    addLoot(db, id, drop.name, drop.value, r.depth, false, now);
  }
  let choice: RewardOption[] | null = null;
  const part = mon.guardian ? maybeFindComponent(db, id, CFG.componentDropGuardian, now, rng) : null;
  if (mon.guardian) {
    // guardians offer a choice of high value items
    const names = [...relicRow(r.depth)];
    const opts: RewardOption[] = [];
    for (let i = 0; i < CFG.dungeonRewardOptions && names.length; i++) {
      const [lo, hi] = CFG.dungeonRelicMultiplier;
      opts.push({
        name: names.splice(Math.floor(rng() * names.length), 1)[0],
        value: Math.round(CFG.dungeonLootValue(r.depth) * randRange(rng, lo, hi) * loot),
      });
    }
    choice = opts;
  }
  const depth = r.depth + 1;
  const every = Math.max(1, CFG.dungeonCheckpoint),
    reachedCheckpoint = Math.floor(depth / every) * every; // standing on level 25, 50, 75 ... saves it
  const newCheckpoint = reachedCheckpoint >= every && reachedCheckpoint > r.checkpoint ? reachedCheckpoint : null;
  const readyAt = now + CFG.dungeonFightCooldown;
  db.prepare(
    `UPDATE dungeon SET depth = ?, reached_at = ?, hp = ?, last_at = ?, kills = kills + 1, xp_week = xp_week + ?, best_ever = MAX(best_ever, ?), pending = ?, ready_at = ?, checkpoint = MAX(checkpoint, ?) WHERE player_id = ?`,
  ).run(depth, now, res.hpLeft, now, xpGained, depth - 1, choice ? JSON.stringify(choice) : null, readyAt, newCheckpoint ?? r.checkpoint, id);
  db.prepare('UPDATE players SET dungeon_until = ? WHERE id = ?').run(now + CFG.dungeonIdleLimit, id); // activity keeps the run alive
  bump(db, id, 'dungeon_levels');
  if (mon.guardian) bump(db, id, 'dungeon_guardians');
  return {
    ...base,
    won: true,
    died: false,
    hpLeft: res.hpLeft,
    xp: xpGained,
    levelsGained: lv.levelsGained,
    drop,
    choice,
    nextDepth: depth,
    cooldownUntil: null,
    readyAt,
    checkpoint: newCheckpoint,
    component: part?.name ?? null,
  };
}

export interface AutoDelve {
  ran: boolean;
  cleared: number;
  died: boolean;
  xp: number;
  checkpoint: number | null;
}

/**
 * An automated run for the shrine (shrine.ts): up to `fights` fights back to back, one per wait between fights, at `share` of the
 * normal XP and loot value. Same monsters, same dungeon HP (full at the start, never regenerating), same checkpoints and the same
 * once-a-day cooldown as a run by hand. Guardian rewards are taken automatically (the most valuable one). Nothing happens when
 * the character is inside by hand or the cooldown has not run out at `startAt`.
 */
export function delveAuto(db: DB, id: number, startAt: number, fights: number, share: number, now: number, rng: Rng): AutoDelve {
  const none: AutoDelve = { ran: false, cleared: 0, died: false, xp: 0, checkpoint: null };
  const r = load(db, id, now);
  if (r.active || startAt < r.cooldown_until) return none;
  if (r.pending) {
    const best = (JSON.parse(r.pending) as RewardOption[]).sort((a, b) => b.value - a.value)[0];
    addLoot(db, id, best.name, best.value, r.depth - 1, true, now);
  }
  const p = loadPlayer(db, id, now);
  const stats = battleStats(db, p, { ancestral: p.level >= CFG.ancestralMinLevel });
  const m = modsOf(p),
    loot = 1 + (m.dungeonLoot ?? 0),
    pool = Math.round(p.max_hp * (1 + (m.dungeonHp ?? 0)));
  let depth = r.depth,
    hp = pool,
    cleared = 0,
    died = false,
    xpTotal = 0,
    checkpoint = r.checkpoint;
  const every = Math.max(1, CFG.dungeonCheckpoint);
  for (let i = 0; i < fights; i++) {
    const mon = monsterAt(depth);
    const res = fightMonster(stats, hp, pool, mon, rng);
    if (!res.won) {
      died = true;
      break;
    }
    hp = res.hpLeft;
    xpTotal += awardXp(db, id, Math.max(1, Math.round(mon.xp * (1 + (m.dungeonXp ?? 0)) * share)), now).xpGained;
    if (rng() < CFG.dungeonDropChance + (m.dungeonDrop ?? 0)) {
      const row = lootRow(depth);
      addLoot(
        db,
        id,
        row[Math.floor(rng() * row.length)],
        Math.max(1, Math.round(CFG.dungeonLootValue(depth) * randRange(rng, 0.8, 1.2) * share * loot)),
        depth,
        false,
        now,
      );
    }
    if (mon.guardian) {
      bump(db, id, 'dungeon_guardians');
      const names = [...relicRow(depth)];
      let best: RewardOption | null = null;
      for (let k = 0; k < CFG.dungeonRewardOptions && names.length; k++) {
        const [lo, hi] = CFG.dungeonRelicMultiplier;
        const o = {
          name: names.splice(Math.floor(rng() * names.length), 1)[0],
          value: Math.round(CFG.dungeonLootValue(depth) * randRange(rng, lo, hi) * share * loot),
        };
        if (!best || o.value > best.value) best = o;
      }
      if (best) addLoot(db, id, best.name, best.value, depth, true, now);
      maybeFindComponent(db, id, CFG.componentDropGuardian, now, rng);
    }
    depth++;
    cleared++;
    if (Math.floor(depth / every) * every >= every) checkpoint = Math.max(checkpoint, Math.floor(depth / every) * every);
  }
  const wait = Math.max(CFG.dungeonFightCooldown, MIN_FIGHT_MS),
    endAt = startAt + (cleared + (died ? 1 : 0)) * wait;
  db.prepare(
    `UPDATE dungeon SET depth = ?, reached_at = ?, hp = 0, last_at = ?, kills = kills + ?, deaths = deaths + ?, runs = runs + 1, xp_week = xp_week + ?,
       best_ever = MAX(best_ever, ?), checkpoint = ?, cooldown_until = ?, active = 0, pending = NULL, ready_at = 0 WHERE player_id = ?`,
  ).run(depth, endAt, endAt, cleared, died ? 1 : 0, xpTotal, depth - 1, checkpoint, endAt + CFG.dungeonCooldown, id);
  bump(db, id, 'dungeon_levels', cleared);
  bump(db, id, 'dungeon_runs');
  return { ran: true, cleared, died, xp: xpTotal, checkpoint: checkpoint > r.checkpoint ? checkpoint : null };
}
/** The shortest time one automated fight takes (also when the wait between fights is switched off). */
export const MIN_FIGHT_MS = 60_000;

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
  const rows = (
    lootId === 'all'
      ? db.prepare('SELECT id, value FROM dungeon_loot WHERE player_id = ?').all(id)
      : db.prepare('SELECT id, value FROM dungeon_loot WHERE player_id = ? AND id = ?').all(id, lootId)
  ) as { id: number; value: number }[];
  assert(rows.length, 'no_loot', 'Nothing to sell', 404);
  const gold = Math.round(rows.reduce((s, r) => s + r.value, 0) * CFG.rateGold * (1 + (modsOf(loadPlayer(db, id, now)).gold ?? 0)));
  db.prepare(`DELETE FROM dungeon_loot WHERE player_id = ? ${lootId === 'all' ? '' : 'AND id = ?'}`).run(...(lootId === 'all' ? [id] : [id, lootId]));
  db.prepare('UPDATE players SET gold = gold + ? WHERE id = ?').run(gold, id);
  bump(db, id, 'dungeon_gold', gold);
  bump(db, id, 'gold_earned', gold);
  return { gold, count: rows.length };
}

export { isInDungeon };
