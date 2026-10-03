import { CFG } from '../config.ts';
import type { DB } from '../db-core.ts';
import { assert } from '../errors.ts';
import { randRange, type Rng } from '../rng.ts';
import { accomplishmentBonus } from './accomplishments.ts';
import { resumeIfCeasefire, warBetween } from './clan.ts';
import { bump } from './counters.ts';
import { simulate } from './combat.ts';
import { gatherBlood, isAutomated } from './blood.ts';
import { assertFree, awardXp, isBusy, battleStats, equipmentLoadout, hideoutTotal, loadPlayer, setHp, type Player } from './player.ts';


export function assertCanAttack(p: Player, now: number) {
  assertFree(p, now);
  assert(p.hp >= CFG.hpProtectThreshold, 'too_weak', `You need at least ${CFG.hpProtectThreshold} HP to raid`);
  const wait = p.last_attack_at + CFG.attackCooldown - now;
  assert(wait <= 0, 'cooldown', `You can attack again in ${Math.ceil(wait / 60000)} min`);
}

export const protectedUntil = (db: DB, targetId: number) => {
  const r = db.prepare('SELECT MAX(at) t FROM battles WHERE defender_id = ?').get(targetId) as { t: number | null };
  return r.t ? r.t + CFG.postBattleProtection : 0;
};

export function attacksInWindow(db: DB, a: number, d: number, now: number) {
  return (db.prepare('SELECT COUNT(*) n FROM battles WHERE attacker_id = ? AND defender_id = ? AND at > ?').get(a, d, now - CFG.sameOpponentWindow) as { n: number }).n;
}

/** Roll a discovery: dexterity vs. the target's hideout. */
export const discoverChance = (dex: number, hideout: number) =>
  Math.min(0.95, Math.max(0.15, 0.7 + (dex - hideout * CFG.hideoutHideWeight) / 100));

export function searchOpponent(db: DB, id: number, now: number, rng: Rng, opts: { botsOnly?: boolean } = {}) {
  const p = loadPlayer(db, id, now);
  assertCanAttack(p, now);
  const rows = db.prepare(
    `SELECT id FROM players
      WHERE race != ? AND id != ? AND ABS(level - ?) <= ?
        AND MIN(max_hp, hp + ? * (? - hp_at) / ?) >= ?
        AND (work_until IS NULL OR work_until <= ?)
        AND (hunt_until IS NULL OR hunt_until <= ?)
        AND (dungeon_until IS NULL OR dungeon_until <= ?)
        ${opts.botsOnly ? 'AND is_bot = 1' : ''}`,
  ).all(p.race, id, p.level, CFG.levelRangeForSearch, CFG.hpRegenPerHour, now, 3_600_000, CFG.hpProtectThreshold, now, now, now) as { id: number }[];
  const eligible = rows.filter((r) => {
    if (protectedUntil(db, r.id) > now) return false;
    const limit = warBetween(db, id, r.id) ? CFG.sameOpponentMaxWar : CFG.sameOpponentMax;
    return attacksInWindow(db, id, r.id, now) < limit;
  });
  if (!eligible.length) return { found: false as const, reason: 'no_opponents' };
  const target = eligible[Math.floor(rng() * eligible.length)];
  const chance = discoverChance(equipmentTotalDex(db, p), hideoutTotal(db, target.id));
  if (rng() > chance) return { found: false as const, reason: 'lost_track' };
  db.prepare('UPDATE players SET found_target = ?, found_at = ? WHERE id = ?').run(target.id, now, id);
  const t = db.prepare('SELECT id, name, level, race FROM players WHERE id = ?').get(target.id) as { id: number; name: string; level: number; race: string };
  return { found: true as const, target: t };
}

const equipmentTotalDex = (db: DB, p: Player) => p.dex + equipmentLoadout(db, p).bonus.dex;

export interface RaidResult {
  battleId: number; winner: string; rounds: number; gold: number; xpAttacker: number; xpDefender: number; warId: number | null;
  attackerHp: number; defenderHp: number;
}

export function attack(db: DB, id: number, targetId: number, now: number, rng: Rng): RaidResult {
  const a = loadPlayer(db, id, now);
  assertCanAttack(a, now);
  assert(a.found_target === targetId && now - a.found_at <= CFG.searchValidity, 'not_found', 'Search for an opponent first');
  return fight(db, a, loadPlayer(db, targetId, now), now, rng);
}

/**
 * One raid battle between two already-loaded players: validates the target, simulates, moves gold, records the battle.
 * Used by both the normal search-and-attack flow and the clan-war attack. The attacker must already have passed assertCanAttack.
 */
export function fight(db: DB, a: Player, d: Player, now: number, rng: Rng): RaidResult {
  assert(d.race !== a.race, 'same_race', 'You can only raid the enemy race');
  assert(d.hp >= CFG.hpProtectThreshold, 'target_weak', 'Target is too weak to be attacked');
  assert(!isBusy(d, now), 'target_busy', 'Target is working or hunting and cannot be attacked');
  assert(protectedUntil(db, d.id) <= now, 'protected', 'Target was just attacked and is protected');
  const war = warBetween(db, a.id, d.id);
  const limit = war ? CFG.sameOpponentMaxWar : CFG.sameOpponentMax;
  assert(attacksInWindow(db, a.id, d.id, now) < limit, 'same_opponent', 'You already attacked this opponent recently');
  if (war) resumeIfCeasefire(db, war);

  const ancestral = a.level >= CFG.ancestralMinLevel && d.level >= CFG.ancestralMinLevel;
  const sa = battleStats(db, a, { ancestral });
  const sd = battleStats(db, d, { ancestral });
  // Home advantage: the defender's hideout adds defense, reduced by the attacker's dexterity.
  sd.def += Math.max(0, hideoutTotal(db, d.id) * CFG.hideoutDefPerLevel - Math.floor(sa.dex / 2));

  const res = simulate({ name: a.name, stats: sa, hp: a.hp, maxHp: a.max_hp }, { name: d.name, stats: sd, hp: d.hp, maxHp: d.max_hp }, rng);
  const attackerWon = res.winner === 'a';
  const winner = attackerWon ? a : d, loser = attackerWon ? d : a;

  let gold = 0;
  if (attackerWon) {
    let share = randRange(rng, CFG.stealMin, CFG.stealMax);
    if (isAutomated(db, d.id)) share = Math.min(share, CFG.shrineRaidLossCap); // no protection while the shrine runs, but a reasonable limit
    gold = Math.floor(d.gold * share * (1 + equipmentLoadout(db, a).goldBonus + accomplishmentBonus(db, a.id).raidGold));
    gold = Math.min(gold, d.gold);
    db.prepare('UPDATE players SET gold = gold - ? WHERE id = ?').run(gold, d.id);
    db.prepare('UPDATE players SET gold = gold + ? WHERE id = ?').run(gold, a.id);
  }

  // XP: equal level 1; beating a higher-level opponent 2; everything else 1.
  const xpFor = (self: Player, other: Player, won: boolean) => (won && other.level > self.level ? 2 : 1);
  const xpA = xpFor(a, d, attackerWon), xpD = xpFor(d, a, !attackerWon);

  setHp(db, a.id, res.hpA, now);
  setHp(db, d.id, res.hpB, now);
  db.prepare('UPDATE players SET wins = wins + 1 WHERE id = ?').run(winner.id);
  db.prepare('UPDATE players SET losses = losses + 1 WHERE id = ?').run(loser.id);
  db.prepare('UPDATE players SET last_attack_at = ?, found_target = NULL WHERE id = ?').run(now, a.id);
  const battleId = Number(db.prepare(
    'INSERT INTO battles (attacker_id, defender_id, winner_id, gold, xp_attacker, xp_defender, war_id, at, rounds, log) VALUES (?,?,?,?,?,?,?,?,?,?)',
  ).run(a.id, d.id, winner.id, gold, xpA, xpD, war?.id ?? null, now, res.rounds, JSON.stringify(res.log)).lastInsertRowid);
  if (attackerWon) { bump(db, a.id, 'raids_won'); bump(db, a.id, 'gold_stolen', gold); if (war) bump(db, a.id, 'war_wins'); }
  else { bump(db, d.id, 'defenses_won'); if (war) bump(db, d.id, 'war_wins'); }
  awardXp(db, a.id, xpA, now);
  awardXp(db, d.id, xpD, now);
  gatherBlood(db, a.id, 'raid');

  return { battleId, winner: winner.name, rounds: res.rounds, gold, xpAttacker: xpA, xpDefender: xpD, warId: war?.id ?? null, attackerHp: res.hpA, defenderHp: res.hpB };
}

