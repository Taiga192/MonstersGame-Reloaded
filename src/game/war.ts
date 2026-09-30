import { CFG, HOUR } from '../config.ts';
import type { DB } from '../db-core.ts';
import { assert } from '../errors.ts';
import type { Rng } from '../rng.ts';
import { skillAverage } from './arena.ts';
import type { WarRow } from './clan.ts';
import { assertCanAttack, attacksInWindow, fight, protectedUntil, type RaidResult } from './raid.ts';
import { loadPlayer } from './player.ts';

export type TargetStatus = 'available' | 'range' | 'low_hp' | 'busy' | 'protected' | 'limit';

export interface WarTarget { id: number; name: string; level: number; status: TargetStatus; hitsLeft: number; protectedUntil: number | null }

/** The unfinished war the player takes part in (roster is snapshotted at declaration, so leaving a clan is no escape). */
export function warOf(db: DB, playerId: number) {
  const r = db.prepare(
    `SELECT w.*, m.clan_id AS my_clan FROM clan_wars w JOIN clan_war_members m ON m.war_id = w.id
      WHERE m.player_id = ? AND w.status != 'ended' ORDER BY w.id DESC LIMIT 1`,
  ).get(playerId) as (WarRow & { my_clan: number; aggressor_id: number; defender_id: number }) | undefined;
  if (!r) return null;
  return { war: r as WarRow, myClan: r.my_clan, enemyClan: r.aggressor_id === r.my_clan ? r.defender_id : r.aggressor_id };
}

/** Every enemy war member with a status telling whether they can be hit right now by this player. */
export function warRoster(db: DB, playerId: number, now: number) {
  const ctx = warOf(db, playerId);
  assert(ctx, 'no_war', 'Your clan is not at war');
  const me = db.prepare('SELECT str, def, agi, sta, dex FROM players WHERE id = ?').get(playerId) as any;
  const mySkill = skillAverage(me);
  const rows = db.prepare(
    `SELECT p.id, p.name, p.level, p.str, p.def, p.agi, p.sta, p.dex, p.max_hp, p.hp, p.hp_at, p.work_until, p.hunt_until, p.dungeon_until
       FROM clan_war_members m JOIN players p ON p.id = m.player_id WHERE m.war_id = ? AND m.clan_id = ? ORDER BY p.name`,
  ).all(ctx.war.id, ctx.enemyClan) as any[];
  const targets: WarTarget[] = rows.map((p) => {
    const hp = Math.min(p.max_hp, p.hp + (CFG.hpRegenPerHour * (now - p.hp_at)) / HOUR);
    const prot = protectedUntil(db, p.id);
    const used = attacksInWindow(db, playerId, p.id, now);
    let status: TargetStatus = 'available';
    if (Math.abs(skillAverage(p) - mySkill) > mySkill * CFG.warSkillBand) status = 'range';
    else if (hp < CFG.hpProtectThreshold) status = 'low_hp';
    else if ((p.work_until ?? 0) > now || (p.hunt_until ?? 0) > now || (p.dungeon_until ?? 0) > now) status = 'busy';
    else if (prot > now) status = 'protected';
    else if (used >= CFG.sameOpponentMaxWar) status = 'limit';
    return { id: p.id, name: p.name, level: p.level, status, hitsLeft: Math.max(0, CFG.sameOpponentMaxWar - used), protectedUntil: prot > now ? prot : null };
  });
  return { ...ctx, targets };
}

const STATUS_TEXT: Record<TargetStatus, string> = {
  available: 'attackable', range: 'outside your skill range', low_hp: 'too wounded', busy: 'busy (working/hunting)', protected: 'recently attacked (protected)', limit: `already hit ${CFG.sameOpponentMaxWar}x in 12 h`,
};

/**
 * War attack: picks a random enemy war member whose skill level is close to yours and fights them right away.
 * Same rules as any raid (attack cooldown, 25 HP minimum, 1 h protection, 4 hits per enemy per 12 h); no search roll needed.
 */
export function warAttack(db: DB, playerId: number, now: number, rng: Rng): RaidResult & { target: { id: number; name: string; level: number } } {
  const a = loadPlayer(db, playerId, now);
  const { targets } = warRoster(db, playerId, now); // throws no_war
  assertCanAttack(a, now);
  const eligible = targets.filter((t) => t.status === 'available');
  if (!eligible.length) {
    const why = Object.entries(targets.reduce<Record<string, number>>((m, t) => ((m[t.status] = (m[t.status] ?? 0) + 1), m), {})).map(([k, n]) => `${n} ${STATUS_TEXT[k as TargetStatus]}`).join(', ');
    assert(false, 'no_targets', `No enemy is attackable right now (${why || 'no enemies'})`);
  }
  const t = eligible[Math.floor(rng() * eligible.length)];
  const result = fight(db, a, loadPlayer(db, t.id, now), now, rng);
  return { ...result, target: { id: t.id, name: t.name, level: t.level } };
}

/** Score = battles won (attack or defence) by members of each clan. */
export function warScoreboard(db: DB, warId: number) {
  const clans = db.prepare(
    `SELECT c.id AS clan_id, c.name,
            (SELECT COUNT(*) FROM battles b JOIN clan_war_members m ON m.war_id = b.war_id AND m.player_id = b.winner_id WHERE b.war_id = ? AND m.clan_id = c.id) AS points,
            (SELECT COUNT(*) FROM battles b JOIN clan_war_members m ON m.war_id = b.war_id AND m.player_id = b.attacker_id WHERE b.war_id = ? AND m.clan_id = c.id) AS attacks,
            (SELECT COALESCE(SUM(b.gold), 0) FROM battles b JOIN clan_war_members m ON m.war_id = b.war_id AND m.player_id = b.attacker_id WHERE b.war_id = ? AND m.clan_id = c.id) AS gold
       FROM clans c WHERE c.id IN (SELECT DISTINCT clan_id FROM clan_war_members WHERE war_id = ?)`,
  ).all(warId, warId, warId, warId);
  const members = db.prepare(
    `SELECT p.id AS player_id, p.name, p.level, m.clan_id,
            (SELECT COUNT(*) FROM battles b WHERE b.war_id = m.war_id AND b.attacker_id = p.id) AS attacks,
            (SELECT COUNT(*) FROM battles b WHERE b.war_id = m.war_id AND b.attacker_id = p.id AND b.winner_id = p.id) AS wins,
            (SELECT COUNT(*) FROM battles b WHERE b.war_id = m.war_id AND b.defender_id = p.id AND b.winner_id = p.id) AS defended,
            (SELECT COALESCE(SUM(b.gold), 0) FROM battles b WHERE b.war_id = m.war_id AND b.attacker_id = p.id) AS gold
       FROM clan_war_members m JOIN players p ON p.id = m.player_id WHERE m.war_id = ? ORDER BY (wins + defended) DESC, attacks DESC, p.name`,
  ).all(warId);
  return { clans, members };
}
