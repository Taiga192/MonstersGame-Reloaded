/**
 * Admin tools: look at and change the world. Every function here assumes the caller was already checked with isAdmin();
 * every change is written to the audit log (admin_log).
 */
import { CFG, ITEM_BY_KEY } from '../../core/config.ts';
import type { DB } from '../../db/core.ts';
import { assert, GameError } from '../../core/errors.ts';
import { systemMail } from '../social/mail.ts';
import { modsOf } from '../character/mods.ts';
import { reconcile as reconcileSkills } from '../character/skills.ts';
import type { Player } from '../character/player.ts';

/** Single player: the one human is always an admin. Multiplayer: the flag in the database (set by hand, see scripts/admin.ts). */
export function isAdmin(db: DB, playerId: number, singlePlayer: boolean): boolean {
  const p = db.prepare('SELECT is_admin, is_bot FROM players WHERE id = ?').get(playerId) as { is_admin: number; is_bot: number } | undefined;
  if (!p || p.is_bot) return false;
  return singlePlayer || p.is_admin === 1;
}

export function log(db: DB, adminId: number, action: string, detail: string, now: number) {
  const name = (db.prepare('SELECT name FROM players WHERE id = ?').get(adminId) as { name: string } | undefined)?.name ?? '?';
  db.prepare('INSERT INTO admin_log (at, admin_id, admin_name, action, detail) VALUES (?,?,?,?,?)').run(now, adminId, name, action, detail.slice(0, 500));
  db.prepare('DELETE FROM admin_log WHERE id <= (SELECT MAX(id) FROM admin_log) - 1000').run(); // keep the last 1000 entries
}

export function overview(db: DB, now: number) {
  const n = (sql: string) => (db.prepare(sql).get() as { n: number }).n;
  const meta = (k: string) => (db.prepare('SELECT value FROM meta WHERE key = ?').get(k) as { value: string } | undefined)?.value;
  const first = (db.prepare('SELECT MIN(created_at) m FROM players').get() as { m: number | null }).m;
  return {
    worldStartedAt: Number(meta('world_started') ?? first ?? now),
    wipes: Number(meta('wipes') ?? 0),
    humans: n('SELECT COUNT(*) n FROM players WHERE is_bot = 0'),
    bots: n('SELECT COUNT(*) n FROM players WHERE is_bot = 1'),
    admins: n('SELECT COUNT(*) n FROM players WHERE is_admin = 1 AND is_bot = 0'),
    clans: n('SELECT COUNT(*) n FROM clans'),
    battles: n('SELECT COUNT(*) n FROM battles'),
    topLevel: n('SELECT COALESCE(MAX(level), 0) n FROM players'),
    totalGold: n('SELECT COALESCE(SUM(gold), 0) n FROM players'),
    log: db.prepare('SELECT id, at, admin_name, action, detail FROM admin_log ORDER BY id DESC LIMIT 40').all(),
  };
}

const PAGE = 25;
export function listPlayers(db: DB, o: { q?: unknown; page?: number; who?: unknown }) {
  const q = typeof o.q === 'string' ? o.q.trim().slice(0, 40) : '';
  const cond = ['1 = 1'];
  const args: (string | number)[] = [];
  if (q) {
    cond.push("name LIKE ? ESCAPE '\\'");
    args.push('%' + q.replace(/[\\%_]/g, '\\$&') + '%');
  }
  if (o.who === 'humans') cond.push('is_bot = 0');
  else if (o.who === 'bots') cond.push('is_bot = 1');
  else if (o.who === 'admins') cond.push('is_admin = 1');
  const where = cond.join(' AND ');
  const total = (db.prepare(`SELECT COUNT(*) n FROM players WHERE ${where}`).get(...args) as { n: number }).n;
  const pages = Math.max(1, Math.ceil(total / PAGE)),
    page = Math.min(Math.max(1, Math.floor(o.page ?? 1)), pages);
  const rows = db
    .prepare(
      `SELECT id, name, race, level, xp, gold, hp, max_hp, str, def, agi, sta, dex, wins, losses, is_bot, is_admin, created_at,
            (hunt_until IS NOT NULL OR work_until IS NOT NULL OR dungeon_until IS NOT NULL) busy
       FROM players WHERE ${where} ORDER BY is_bot, level DESC, id LIMIT ? OFFSET ?`,
    )
    .all(...args, PAGE, (page - 1) * PAGE);
  return { page, pages, total, rows };
}

/** One character with everything an admin may edit, plus its inventory. */
export function playerDetail(db: DB, id: number) {
  const p = db
    .prepare(
      `SELECT id, name, race, level, xp, gold, hp, max_hp, str, def, agi, sta, dex, vitality_hp, wins, losses, is_bot, is_admin, created_at, clan_id,
            hunt_until, work_until, dungeon_until, last_attack_at, ancestral_at FROM players WHERE id = ?`,
    )
    .get(id);
  if (!p) throw new GameError('not_found', 'No such player', 404);
  const inventory = db.prepare('SELECT id, item_key, hardening FROM inventory WHERE player_id = ? ORDER BY id').all(id);
  return { ...(p as object), hp: Math.floor((p as { hp: number }).hp), inventory };
}

// [min, max] of every number an admin may set on a character
const FIELDS: Record<string, [number, number]> = {
  level: [1, 1000],
  xp: [0, 1e9],
  gold: [0, 1e12],
  str: [1, 1e6],
  def: [1, 1e6],
  agi: [1, 1e6],
  sta: [1, 1e6],
  dex: [1, 1e6],
  max_hp: [1, 1e7],
  hp: [0, 1e7],
  vitality_hp: [0, 1e6],
  wins: [0, 1e9],
  losses: [0, 1e9],
  is_admin: [0, 1],
};
export const PLAYER_FIELDS = Object.keys(FIELDS);

function target(db: DB, id: unknown): Player {
  const p = Number.isInteger(id) ? (db.prepare('SELECT * FROM players WHERE id = ?').get(id as number) as Player | undefined) : undefined;
  if (!p) throw new GameError('not_found', 'No such player', 404);
  return p;
}

export function setPlayerField(db: DB, adminId: number, playerId: unknown, field: unknown, value: unknown, singlePlayer: boolean, now: number) {
  const p = target(db, playerId);
  const range = typeof field === 'string' && Object.hasOwn(FIELDS, field) ? FIELDS[field] : undefined;
  assert(range, 'bad_field', 'That value cannot be edited');
  const f = field as string;
  const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN;
  assert(Number.isInteger(n) && n >= range[0] && n <= range[1], 'bad_value', `${f}: a whole number from ${range[0]} to ${range[1]}`);
  if (f === 'is_admin') {
    assert(!singlePlayer, 'single_player', 'In single player you are always the admin');
    assert(!p.is_bot, 'bad_target', 'Bots cannot be admins');
    assert(!(p.id === adminId && n === 0), 'self_demote', 'You cannot remove your own admin flag (you would lock yourself out)');
  }
  if (f === 'level') {
    // a new level also sets max health the way levelling would have, and heals
    const maxHp = CFG.startMaxHp + (n - 1) * CFG.levelUpMaxHp + p.vitality_hp + (modsOf(p).maxHp ?? 0);
    db.prepare('UPDATE players SET level = ?, xp = 0, max_hp = ?, hp = ?, hp_at = ? WHERE id = ?').run(n, maxHp, maxHp, now, p.id);
    reconcileSkills(db, p.id, now); // fewer points than nodes now: the board is reset (free)
  } else if (f === 'max_hp') db.prepare('UPDATE players SET max_hp = ?, hp = MIN(hp, ?), hp_at = ? WHERE id = ?').run(n, n, now, p.id);
  else if (f === 'hp') db.prepare('UPDATE players SET hp = MIN(?, max_hp), hp_at = ? WHERE id = ?').run(n, now, p.id);
  else db.prepare(`UPDATE players SET ${f} = ? WHERE id = ?`).run(n, p.id); // (f is one of the keys above, never user text)
  log(db, adminId, 'player.set', `${p.name}: ${f} = ${n}`, now);
}

export function giveItem(db: DB, adminId: number, playerId: unknown, key: unknown, now: number) {
  const p = target(db, playerId);
  const def = typeof key === 'string' ? ITEM_BY_KEY.get(key) : undefined;
  assert(def, 'bad_item', 'Unknown item');
  db.prepare('INSERT INTO inventory (player_id, item_key, bought_at) VALUES (?,?,?)').run(p.id, def.key, now);
  log(db, adminId, 'player.give', `${p.name}: ${def.name}`, now);
}

/** Free a character: ends hunt / work / dungeon lock and clears every cooldown. */
export function release(db: DB, adminId: number, playerId: unknown, now: number) {
  const p = target(db, playerId);
  db.prepare(
    `UPDATE players SET hunt_started = NULL, hunt_until = NULL, hunt_portions = NULL, work_started = NULL, work_until = NULL, work_hours = NULL,
    dungeon_until = NULL, last_attack_at = 0, ancestral_at = 0, hunt_used = 0, found_target = NULL WHERE id = ?`,
  ).run(p.id);
  db.prepare('UPDATE dungeon SET active = 0, cooldown_until = 0 WHERE player_id = ?').run(p.id);
  log(db, adminId, 'player.release', p.name, now);
}

export function announce(db: DB, adminId: number, subject: unknown, body: unknown, now: number) {
  assert(typeof subject === 'string' && subject.trim().length >= 1 && subject.length <= 100, 'bad_subject', 'Subject: 1-100 characters');
  assert(typeof body === 'string' && body.trim().length >= 1 && body.length <= 2000, 'bad_body', 'Message: 1-2000 characters');
  const ids = db.prepare('SELECT id FROM players WHERE is_bot = 0').all() as { id: number }[];
  for (const { id } of ids) systemMail(db, id, subject.trim(), body.trim(), now, { kind: 'announce', link: '#/mail' });
  log(db, adminId, 'announce', `"${subject.trim()}" to ${ids.length} players`, now);
  return { sent: ids.length };
}

/** Tables that describe a player's own data (deleted with the player). */
const OWN_TABLES: [string, string][] = [
  ['sessions', 'player_id'],
  ['inventory', 'player_id'],
  ['sentinels', 'player_id'],
  ['hideouts', 'player_id'],
  ['ancestral_skills', 'player_id'],
  ['bots', 'player_id'],
  ['notifications', 'player_id'],
  ['quest_base', 'player_id'],
  ['quest_state', 'player_id'],
  ['skills', 'player_id'],
  ['shrine_components', 'player_id'],
  ['shrine', 'player_id'],
  ['dungeon', 'player_id'],
  ['dungeon_loot', 'player_id'],
  ['dungeon_weekly', 'player_id'],
  ['counters', 'player_id'],
  ['acc_sets', 'player_id'],
  ['arena_points', 'player_id'],
  ['clan_perms', 'player_id'],
  ['clan_applications', 'player_id'],
  ['clan_war_members', 'player_id'],
  ['bites', 'link_player'],
  ['mail', 'to_id'],
  ['temple_listings', 'seller_id'],
];

export function deletePlayer(db: DB, adminId: number, playerId: unknown, now: number) {
  const p = target(db, playerId);
  assert(p.id !== adminId, 'self_delete', 'You cannot delete yourself');
  assert(
    !db.prepare('SELECT 1 FROM clans WHERE leader_id = ?').get(p.id),
    'clan_leader',
    'This player leads a clan. Hand the clan over (or wipe the world) first',
  );
  for (const [table, col] of OWN_TABLES) db.prepare(`DELETE FROM ${table} WHERE ${col} = ?`).run(p.id);
  db.prepare('UPDATE players SET referrer_id = NULL WHERE referrer_id = ?').run(p.id);
  db.prepare('DELETE FROM players WHERE id = ?').run(p.id);
  log(db, adminId, 'player.delete', p.name, now);
}

/** Tables a wipe never touches. */
const KEEP = new Set(['players', 'sessions', 'settings', 'meta', 'admin_log']);

/**
 * Start the world over.
 *  - 'progress':   every account stays (name, password, admin flag), but all characters start again from level 1. Bots are removed
 *                  (the server creates fresh ones).
 *  - 'everything': like 'progress', but only admin accounts survive. Everyone else has to register again.
 * Clans, wars, battles, market, mail, forum, arena, dungeon and all other game data are deleted. Settings and the audit log stay.
 */
export function wipeWorld(db: DB, adminId: number, mode: unknown, now: number) {
  assert(mode === 'progress' || mode === 'everything', 'bad_mode', 'Unknown wipe mode');
  const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all() as { name: string }[]).map(
    (r) => r.name,
  );
  for (const name of tables) if (!KEEP.has(name)) db.exec(`DELETE FROM "${name}"`);
  db.prepare('UPDATE players SET referrer_id = NULL, clan_id = NULL, clan_role = NULL').run();
  const keepSql = mode === 'everything' ? 'is_bot = 0 AND is_admin = 1' : 'is_bot = 0';
  db.prepare(`DELETE FROM sessions WHERE player_id NOT IN (SELECT id FROM players WHERE ${keepSql})`).run();
  const removed = Number(db.prepare(`DELETE FROM players WHERE NOT (${keepSql})`).run().changes);
  const s = CFG.startStat;
  db.prepare(
    `UPDATE players SET level = 1, xp = 0, gold = ?, hp = ?, hp_at = ?, max_hp = ?, str = ?, def = ?, agi = ?, sta = ?, dex = ?,
       last_attack_at = 0, found_target = NULL, found_at = 0, hunt_day = 0, hunt_used = 0, hunt_started = NULL, hunt_until = NULL, hunt_portions = NULL,
       dungeon_until = NULL, work_started = NULL, work_until = NULL, work_hours = NULL, ancestral_at = 0, ancestral_wins = 0,
       potion_stat_until = 0, vitality_hp = 0, referral_paid = 0, wins = 0, losses = 0, blood = 0, skill_mods = '{}', skill_start = NULL`,
  ).run(CFG.startGold, CFG.startMaxHp, now, CFG.startMaxHp, s, s, s, s, s);
  for (const { id } of db.prepare('SELECT id FROM players').all() as { id: number }[]) db.prepare('INSERT INTO hideouts (player_id) VALUES (?)').run(id);
  const wipes = Number((db.prepare("SELECT value FROM meta WHERE key = 'wipes'").get() as { value: string } | undefined)?.value ?? 0) + 1;
  db.prepare("INSERT INTO meta (key, value) VALUES ('world_started', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(String(now));
  db.prepare("INSERT INTO meta (key, value) VALUES ('wipes', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(String(wipes));
  log(db, adminId, 'wipe', `${mode}; ${removed} account(s) removed`, now);
  return { removed, kept: (db.prepare('SELECT COUNT(*) n FROM players').get() as { n: number }).n };
}
