import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { CFG, type Race } from '../config.ts';
import type { DB } from '../db-core.ts';
import { assert, GameError } from '../errors.ts';

// (Only standard typed arrays here, no Buffer: this file also runs in the browser build, where node:crypto is replaced by src/browser/crypto-shim.ts.)
const hex = (u8: Uint8Array) => Array.from(u8, (b) => b.toString(16).padStart(2, '0')).join('');
const unhex = (h: string) => Uint8Array.from(h.match(/../g) ?? [], (x) => parseInt(x, 16));
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const hash = (pw: string, salt = hex(randomBytes(16))) => `${salt}:${hex(scryptSync(pw, salt, 32))}`;
function verify(pw: string, stored: string) {
  if (!stored.includes(':')) return false; // bot accounts have no password
  const [salt, h] = stored.split(':');
  const a = unhex(h), b = scryptSync(pw, salt, 32);
  return a.length === b.length && timingSafeEqual(a, b);
}
/** Login for a name that does not exist still does the same expensive work, so response time does not reveal which names exist. */
let dummy: string | undefined;
const dummyHash = () => (dummy ??= hash('this-is-not-a-real-password'));

/** Constant-time comparison of a secret typed by a user with the configured one (e.g. the registration code). */
export function secretMatches(input: unknown, expected: string): boolean {
  if (typeof input !== 'string') { timingSafeEqual(unhex(sha256('x')), unhex(sha256(expected))); return false; } // (same work either way)
  return timingSafeEqual(unhex(sha256(input)), unhex(sha256(expected)));
}

/** Names that could pass for the game itself or its staff (mail from the game shows as "System"). */
const RESERVED = ['system', 'admin', 'moderator', 'support', 'staff', 'official', 'gamemaster', 'server', 'monstersgame', 'monstersgamereloaded', 'reloaded'];
export const isReservedName = (name: string) => { const n = name.toLowerCase().replace(/[^a-z]/g, ''); return RESERVED.some((r) => n.startsWith(r)); };

export function register(db: DB, input: { name: string; password: string; race: Race; referrerId?: number }, now: number) {
  const { name, password, race } = input;
  assert(typeof name === 'string' && /^[A-Za-z0-9_\-]{3,20}$/.test(name), 'bad_name', 'Name must be 3-20 chars: letters, digits, _ or -');
  assert(!isReservedName(name), 'reserved_name', 'That name is reserved');
  assert(typeof password === 'string' && password.length >= CFG.passwordMin && password.length <= CFG.passwordMax, 'bad_password', `Password must be ${CFG.passwordMin}-${CFG.passwordMax} characters`);
  assert(race === 'vampire' || race === 'werewolf', 'bad_race', 'Race must be vampire or werewolf');
  if (db.prepare('SELECT 1 FROM players WHERE name = ?').get(name)) throw new GameError('name_taken', 'Name already taken', 409);
  const refId = Number.isInteger(input.referrerId) ? input.referrerId : null;
  const ref = refId && db.prepare('SELECT id FROM players WHERE id = ?').get(refId) ? refId : null;
  const s = CFG.startStat;
  const r = db.prepare(
    `INSERT INTO players (name, pass_hash, race, gold, hp, hp_at, max_hp, str, def, agi, sta, dex, referrer_id, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(name, hash(password), race, CFG.startGold, CFG.startMaxHp, now, CFG.startMaxHp, s, s, s, s, s, ref, now);
  const id = Number(r.lastInsertRowid);
  db.prepare('INSERT INTO hideouts (player_id) VALUES (?)').run(id);
  return id;
}

/** Bot account: no password (cannot log in) and no expensive hashing, so hundreds can be created instantly. */
export function registerBot(db: DB, name: string, race: Race, now: number) {
  const s = CFG.startStat;
  const r = db.prepare(
    `INSERT INTO players (name, pass_hash, race, gold, hp, hp_at, max_hp, str, def, agi, sta, dex, is_bot, created_at)
     VALUES (?,'!',?,?,?,?,?,?,?,?,?,?,1,?)`,
  ).run(name, race, CFG.startGold, CFG.startMaxHp, now, CFG.startMaxHp, s, s, s, s, s, now);
  const id = Number(r.lastInsertRowid);
  db.prepare('INSERT INTO hideouts (player_id) VALUES (?)').run(id);
  return id;
}

export function login(db: DB, name: unknown, password: unknown, now: number) {
  if (typeof name !== 'string' || typeof password !== 'string' || name.length > 40 || password.length > CFG.passwordMax) throw new GameError('bad_login', 'Wrong name or password', 401);
  const p = db.prepare('SELECT id, pass_hash FROM players WHERE name = ? AND is_bot = 0').get(name) as { id: number; pass_hash: string } | undefined;
  const good = verify(password, p ? p.pass_hash : dummyHash()); // always one scrypt run
  if (!p || !good) throw new GameError('bad_login', 'Wrong name or password', 401);
  const token = hex(randomBytes(24));
  // only the SHA-256 of the token is stored: a leaked database or backup does not hand out working logins
  db.prepare('INSERT INTO sessions (token, player_id, created_at) VALUES (?,?,?)').run(sha256(token), p.id, now);
  return { token, playerId: p.id };
}

/** Change the password (needs the current one); every OTHER session of that player is ended. */
export function changePassword(db: DB, playerId: number, current: unknown, next: unknown, keepToken: string | undefined, now: number) {
  const p = db.prepare('SELECT pass_hash FROM players WHERE id = ? AND is_bot = 0').get(playerId) as { pass_hash: string } | undefined;
  assert(p && typeof current === 'string' && verify(current, p.pass_hash), 'bad_password', 'Your current password is wrong', 403);
  assert(typeof next === 'string' && next.length >= CFG.passwordMin && next.length <= CFG.passwordMax, 'bad_password', `The new password must be ${CFG.passwordMin}-${CFG.passwordMax} characters`);
  db.prepare('UPDATE players SET pass_hash = ? WHERE id = ?').run(hash(next), playerId);
  db.prepare('DELETE FROM sessions WHERE player_id = ? AND token != ?').run(playerId, keepToken ? sha256(keepToken) : '');
  void now;
}

/** Re-check the password of an already logged-in player before a dangerous action (wipe, deleting accounts, admin flags). */
export function confirmPassword(db: DB, playerId: number, password: unknown) {
  const p = db.prepare('SELECT pass_hash FROM players WHERE id = ? AND is_bot = 0').get(playerId) as { pass_hash: string } | undefined;
  assert(p && typeof password === 'string' && password.length <= CFG.passwordMax && verify(password, p.pass_hash), 'bad_password', 'Your password is wrong', 403);
}

/** Admin tool: set a new password for someone and end all their sessions. */
export function adminSetPassword(db: DB, playerId: number, next: unknown) {
  assert(typeof next === 'string' && next.length >= CFG.passwordMin && next.length <= CFG.passwordMax, 'bad_password', `The new password must be ${CFG.passwordMin}-${CFG.passwordMax} characters`);
  const p = db.prepare('SELECT is_bot FROM players WHERE id = ?').get(playerId) as { is_bot: number } | undefined;
  assert(p && !p.is_bot, 'not_found', 'No such player', 404);
  db.prepare('UPDATE players SET pass_hash = ? WHERE id = ?').run(hash(next as string), playerId);
  db.prepare('DELETE FROM sessions WHERE player_id = ?').run(playerId);
}

/** Remove expired sessions (run daily; expired ones are also deleted when they are presented). */
export function purgeExpiredSessions(db: DB, now: number) {
  return Number(db.prepare('DELETE FROM sessions WHERE created_at < ?').run(now - CFG.sessionMaxAge).changes);
}

/** The player a login token belongs to. Tokens expire after CFG.sessionMaxAge; expired ones are deleted. */
export function playerForToken(db: DB, token: string | undefined, now: number): number {
  const key = typeof token === 'string' && token.length <= 200 ? sha256(token) : '';
  const r = key && (db.prepare('SELECT player_id, created_at FROM sessions WHERE token = ?').get(key) as { player_id: number; created_at: number } | undefined);
  if (r && now - r.created_at > CFG.sessionMaxAge) { db.prepare('DELETE FROM sessions WHERE token = ?').run(key); throw new GameError('unauthorized', 'Your session expired. Please log in again', 401); }
  if (!r) throw new GameError('unauthorized', 'Login required', 401);
  return r.player_id;
}

/** Really end a session on the server (deleting the token from the browser alone would leave it valid). */
export function logout(db: DB, token: string | undefined) {
  if (typeof token === 'string' && token.length <= 200) db.prepare('DELETE FROM sessions WHERE token = ?').run(sha256(token));
}
