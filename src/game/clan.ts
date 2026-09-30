import { CFG } from '../config.ts';
import type { DB } from '../db-core.ts';
import { assert } from '../errors.ts';
import { loadPlayer } from './player.ts';
import { systemMail } from './mail.ts';

interface ClanRow { id: number; name: string; race: string; leader_id: number; domicile_level: number; treasury: number; is_open: number }

/** Delegable rights. The leader always has all of them; only the leader can hand them out. */
export const CLAN_PERMS = ['recruit', 'kick', 'war', 'treasury', 'forum'] as const;
export type ClanPerm = (typeof CLAN_PERMS)[number];
export function permsOf(db: DB, playerId: number): ClanPerm[] {
  const p = db.prepare('SELECT clan_id FROM players WHERE id = ?').get(playerId) as { clan_id: number | null } | undefined;
  if (!p?.clan_id) return [];
  const c = db.prepare('SELECT leader_id FROM clans WHERE id = ?').get(p.clan_id) as { leader_id: number } | undefined;
  if (c?.leader_id === playerId) return [...CLAN_PERMS];
  const r = db.prepare('SELECT perms FROM clan_perms WHERE player_id = ? AND clan_id = ?').get(playerId, p.clan_id) as { perms: string } | undefined;
  return r ? (JSON.parse(r.perms) as ClanPerm[]) : [];
}
export function requirePerm(db: DB, playerId: number, perm: ClanPerm, now: number) {
  const p = loadPlayer(db, playerId, now);
  assert(p.clan_id, 'no_clan', 'You are not in a clan');
  assert(permsOf(db, playerId).includes(perm), 'no_permission', `You need the "${perm}" permission for that`, 403);
  return { p, c: getClan(db, p.clan_id) };
}
export interface WarRow { id: number; aggressor_id: number; defender_id: number; status: string; started_at: number; peace_offer_by: number | null; ceasefire_offer_by: number | null }

const getClan = (db: DB, id: number) => {
  const c = db.prepare('SELECT * FROM clans WHERE id = ?').get(id) as ClanRow | undefined;
  assert(c, 'no_clan', 'Clan not found', 404);
  return c;
};
export const clanCapacity = (c: ClanRow) => CFG.clanBaseSlots + c.domicile_level * CFG.clanSlotsPerLevel;
const memberCount = (db: DB, clanId: number) => (db.prepare('SELECT COUNT(*) n FROM players WHERE clan_id = ?').get(clanId) as { n: number }).n;

function requireLeader(db: DB, playerId: number, now: number) {
  const p = loadPlayer(db, playerId, now);
  assert(p.clan_id, 'no_clan', 'You are not in a clan');
  const c = getClan(db, p.clan_id);
  assert(c.leader_id === playerId, 'not_leader', 'Only the clan leader can do that', 403);
  return { p, c };
}

export function createClan(db: DB, playerId: number, name: string, now: number) {
  const p = loadPlayer(db, playerId, now);
  assert(p.level >= CFG.clanMinLevel, 'level_too_low', `Clans require level ${CFG.clanMinLevel}`);
  assert(!p.clan_id, 'in_clan', 'Leave your current clan first');
  assert(/^[A-Za-z0-9 _\-]{3,24}$/.test(name), 'bad_name', 'Clan name must be 3-24 chars');
  assert(!db.prepare('SELECT 1 FROM clans WHERE name = ?').get(name), 'name_taken', 'Clan name taken', 409);
  const id = Number(db.prepare('INSERT INTO clans (name, race, leader_id, created_at) VALUES (?,?,?,?)').run(name, p.race, playerId, now).lastInsertRowid);
  db.prepare("UPDATE players SET clan_id = ?, clan_role = 'leader' WHERE id = ?").run(id, playerId);
  return id;
}

export function joinClan(db: DB, playerId: number, clanId: number, now: number) {
  const p = loadPlayer(db, playerId, now);
  const c = getClan(db, clanId);
  assert(!p.clan_id, 'in_clan', 'Leave your current clan first');
  assert(c.race === p.race, 'wrong_race', 'Clans are single-race');
  assert(c.is_open, 'clan_closed', 'This clan only accepts applications');
  addMember(db, c, playerId);
}

function addMember(db: DB, c: ClanRow, playerId: number) {
  assert(memberCount(db, c.id) < clanCapacity(c), 'clan_full', 'Clan domicile is full');
  assert(!activeWarFor(db, c.id), 'clan_at_war', 'Cannot join a clan that is at war');
  db.prepare("UPDATE players SET clan_id = ?, clan_role = 'member' WHERE id = ?").run(c.id, playerId);
  db.prepare('DELETE FROM clan_applications WHERE player_id = ?').run(playerId);
}

export function applyToClan(db: DB, playerId: number, clanId: number, message: string, now: number) {
  const p = loadPlayer(db, playerId, now);
  const c = getClan(db, clanId);
  assert(!p.clan_id, 'in_clan', 'Leave your current clan first');
  assert(c.race === p.race, 'wrong_race', 'Clans are single-race');
  assert(String(message ?? '').length <= 300, 'bad_message', 'Message too long (300 max)');
  db.prepare('INSERT OR REPLACE INTO clan_applications (clan_id, player_id, message, at) VALUES (?,?,?,?)').run(clanId, playerId, String(message ?? ''), now);
}

export function listApplications(db: DB, actorId: number, now: number) {
  const { c } = requirePerm(db, actorId, 'recruit', now);
  return db.prepare('SELECT a.player_id, p.name, p.level, a.message, a.at FROM clan_applications a JOIN players p ON p.id = a.player_id WHERE a.clan_id = ? ORDER BY a.at').all(c.id);
}

export function decideApplication(db: DB, actorId: number, applicantId: number, accept: boolean, now: number) {
  const { c } = requirePerm(db, actorId, 'recruit', now);
  assert(db.prepare('SELECT 1 FROM clan_applications WHERE clan_id = ? AND player_id = ?').get(c.id, applicantId), 'not_found', 'No such application', 404);
  if (accept) {
    assert(!loadPlayer(db, applicantId, now).clan_id, 'in_clan', 'That player already joined a clan');
    addMember(db, c, applicantId);
  } else db.prepare('DELETE FROM clan_applications WHERE clan_id = ? AND player_id = ?').run(c.id, applicantId);
  systemMail(db, applicantId, `Clan ${c.name}: application ${accept ? 'accepted' : 'declined'}`, accept ? `Welcome to ${c.name}!` : `${c.name} declined your application.`, now);
}

export function setRecruiting(db: DB, actorId: number, open: boolean, now: number) {
  const { c } = requirePerm(db, actorId, 'recruit', now);
  db.prepare('UPDATE clans SET is_open = ? WHERE id = ?').run(+!!open, c.id);
}

/** Leader only: replace a member's permission list. */
export function setPerms(db: DB, leaderId: number, memberId: number, perms: string[], now: number) {
  const { c } = requireLeader(db, leaderId, now);
  assert(memberId !== leaderId, 'bad_target', 'The leader already has every permission');
  assert(Array.isArray(perms) && perms.every((x) => (CLAN_PERMS as readonly string[]).includes(x)), 'bad_perm', `Permissions: ${CLAN_PERMS.join(', ')}`);
  assert(loadPlayer(db, memberId, now).clan_id === c.id, 'bad_target', 'Not in your clan');
  db.prepare('INSERT INTO clan_perms (player_id, clan_id, perms) VALUES (?,?,?) ON CONFLICT(player_id) DO UPDATE SET perms = excluded.perms, clan_id = excluded.clan_id')
    .run(memberId, c.id, JSON.stringify([...new Set(perms)]));
}

export function leaveClan(db: DB, playerId: number, now: number) {
  const p = loadPlayer(db, playerId, now);
  assert(p.clan_id, 'no_clan', 'You are not in a clan');
  const c = getClan(db, p.clan_id);
  db.prepare('UPDATE players SET clan_id = NULL, clan_role = NULL WHERE id = ?').run(playerId);
  db.prepare('DELETE FROM clan_perms WHERE player_id = ?').run(playerId);
  if (c.leader_id === playerId) {
    const next = db.prepare('SELECT id FROM players WHERE clan_id = ? ORDER BY level DESC, id LIMIT 1').get(c.id) as { id: number } | undefined;
    if (next) {
      db.prepare('UPDATE clans SET leader_id = ? WHERE id = ?').run(next.id, c.id);
      db.prepare("UPDATE players SET clan_role = 'leader' WHERE id = ?").run(next.id);
    } else db.prepare('DELETE FROM clans WHERE id = ?').run(c.id);
  }
}

export function kickMember(db: DB, actorId: number, memberId: number, now: number) {
  const { c } = requirePerm(db, actorId, 'kick', now);
  assert(memberId !== actorId, 'bad_target', 'Use leave instead');
  assert(memberId !== c.leader_id, 'bad_target', 'The leader cannot be kicked', 403);
  const m = loadPlayer(db, memberId, now);
  assert(m.clan_id === c.id, 'bad_target', 'Not in your clan');
  // only the leader may kick someone who holds permissions themselves
  assert(actorId === c.leader_id || !permsOf(db, memberId).length, 'no_permission', 'Only the leader can kick officers', 403);
  db.prepare('UPDATE players SET clan_id = NULL, clan_role = NULL WHERE id = ?').run(memberId);
  db.prepare('DELETE FROM clan_perms WHERE player_id = ?').run(memberId);
}

export function donate(db: DB, playerId: number, amount: number, now: number) {
  const p = loadPlayer(db, playerId, now);
  assert(p.clan_id, 'no_clan', 'You are not in a clan');
  assert(Number.isInteger(amount) && amount > 0 && amount <= p.gold, 'bad_amount', 'Invalid amount');
  db.prepare('UPDATE players SET gold = gold - ? WHERE id = ?').run(amount, playerId);
  db.prepare('UPDATE clans SET treasury = treasury + ? WHERE id = ?').run(amount, p.clan_id);
}

export function upgradeDomicile(db: DB, actorId: number, now: number) {
  const { c } = requirePerm(db, actorId, 'treasury', now);
  const cost = CFG.clanUpgradeCost(c.domicile_level);
  assert(c.treasury >= cost, 'no_funds', `Need ${cost} gold in the clan treasury`);
  db.prepare('UPDATE clans SET treasury = treasury - ?, domicile_level = domicile_level + 1 WHERE id = ?').run(cost, c.id);
}

// ---------------- wars ----------------

export function activeWarFor(db: DB, clanId: number): WarRow | undefined {
  return db.prepare("SELECT * FROM clan_wars WHERE status != 'ended' AND (aggressor_id = ? OR defender_id = ?)").get(clanId, clanId) as WarRow | undefined;
}

/** Active (or ceasefired) war where both players were on opposite sides at declaration (snapshot). */
export function warBetween(db: DB, a: number, b: number): WarRow | undefined {
  return db.prepare(
    `SELECT w.* FROM clan_wars w
       JOIN clan_war_members ma ON ma.war_id = w.id AND ma.player_id = ?
       JOIN clan_war_members mb ON mb.war_id = w.id AND mb.player_id = ?
      WHERE w.status != 'ended' AND ma.clan_id != mb.clan_id`,
  ).get(a, b) as WarRow | undefined;
}

export function declareWar(db: DB, actorId: number, targetClanId: number, now: number) {
  const { c } = requirePerm(db, actorId, 'war', now);
  const t = getClan(db, targetClanId);
  assert(t.id !== c.id, 'bad_target', 'Cannot war yourself');
  assert(t.race !== c.race, 'same_race', 'Clan wars are fought against the enemy race');
  assert(memberCount(db, c.id) >= CFG.warMinAttackers, 'too_small', `Need at least ${CFG.warMinAttackers} members to declare war`);
  assert(!activeWarFor(db, c.id) && !activeWarFor(db, t.id), 'already_at_war', 'One of the clans is already at war');
  const id = Number(db.prepare('INSERT INTO clan_wars (aggressor_id, defender_id, started_at) VALUES (?,?,?)').run(c.id, t.id, now).lastInsertRowid);
  db.prepare('INSERT INTO clan_war_members (war_id, player_id, clan_id) SELECT ?, id, clan_id FROM players WHERE clan_id IN (?, ?)').run(id, c.id, t.id);
  return id;
}

function warOf(db: DB, actorId: number, now: number) {
  const { c } = requirePerm(db, actorId, 'war', now);
  const w = activeWarFor(db, c.id);
  assert(w, 'no_war', 'Your clan is not at war');
  return { c, w };
}
const endWar = (db: DB, id: number, reason: string, now: number) =>
  db.prepare("UPDATE clan_wars SET status = 'ended', ended_at = ?, end_reason = ? WHERE id = ?").run(now, reason, id);

/** Peace: needs both leaders to agree. */
export function offerPeace(db: DB, leaderId: number, now: number) {
  const { c, w } = warOf(db, leaderId, now);
  if (w.peace_offer_by && w.peace_offer_by !== c.id) { endWar(db, w.id, 'peace', now); return 'peace'; }
  db.prepare('UPDATE clan_wars SET peace_offer_by = ? WHERE id = ?').run(c.id, w.id);
  return 'offered';
}

export function offerCeasefire(db: DB, leaderId: number, now: number) {
  const { c, w } = warOf(db, leaderId, now);
  if (w.ceasefire_offer_by && w.ceasefire_offer_by !== c.id) {
    db.prepare("UPDATE clan_wars SET status = 'ceasefire', ceasefire_offer_by = NULL WHERE id = ?").run(w.id);
    return 'ceasefire';
  }
  db.prepare('UPDATE clan_wars SET ceasefire_offer_by = ? WHERE id = ?').run(c.id, w.id);
  return 'offered';
}

export function capitulate(db: DB, leaderId: number, now: number) {
  const { w } = warOf(db, leaderId, now);
  endWar(db, w.id, 'capitulation', now);
}

/** Attacking during a ceasefire resumes the war automatically. */
export function resumeIfCeasefire(db: DB, war: WarRow) {
  if (war.status === 'ceasefire') db.prepare("UPDATE clan_wars SET status = 'active' WHERE id = ?").run(war.id);
}
