/**
 * Notifications: what happened to a player while they were away (raided, item sold, war declared, level reached ...).
 * Humans only (bots would never read them). A leaf file: the game rules call it, it calls nothing of theirs.
 * The page shows them in a bell with an unread badge, an alert bar and toasts; "things that need doing" (a finished hunt, unspent
 * skill points ...) are not stored here, they are derived from the character's state, see alerts.ts.
 */
import type { DB } from '../../db/core.ts';
import { assert } from '../../core/errors.ts';

export interface Notification {
  id: number;
  kind: string;
  title: string;
  body: string;
  link: string;
  at: number;
  read: boolean;
}
const KEEP = 100; // per player

/** Only links inside the game ("#/raid", "#/town/temple") are kept; anything else becomes "". */
const cleanLink = (l: string) => (/^#\/[A-Za-z0-9_\/.%-]{0,80}$/.test(l) ? l : '');

export function notify(db: DB, playerId: number, kind: string, title: string, body: string, link: string, now: number) {
  const p = db.prepare('SELECT is_bot FROM players WHERE id = ?').get(playerId) as { is_bot: number } | undefined;
  if (!p || p.is_bot) return;
  db.prepare('INSERT INTO notifications (player_id, kind, title, body, link, at) VALUES (?,?,?,?,?,?)').run(
    playerId,
    kind.slice(0, 20),
    title.slice(0, 120),
    body.slice(0, 300),
    cleanLink(link),
    now,
  );
  db.prepare(
    'DELETE FROM notifications WHERE player_id = ? AND id <= COALESCE((SELECT id FROM notifications WHERE player_id = ? ORDER BY id DESC LIMIT 1 OFFSET ?), 0)',
  ).run(playerId, playerId, KEEP); // (the 101st newest and everything older goes)
}

/** Notify everybody in a clan (humans only; `except` is left out, usually whoever caused it). */
export function notifyClan(db: DB, clanId: number, kind: string, title: string, body: string, link: string, now: number, except?: number) {
  for (const m of db.prepare('SELECT id FROM players WHERE clan_id = ? AND is_bot = 0').all(clanId) as { id: number }[])
    if (m.id !== except) notify(db, m.id, kind, title, body, link, now);
}

const row = (r: any): Notification => ({ id: r.id, kind: r.kind, title: r.title, body: r.body, link: r.link, at: r.at, read: !!r.is_read });

export const unreadCount = (db: DB, playerId: number) =>
  (db.prepare('SELECT COUNT(*) n FROM notifications WHERE player_id = ? AND is_read = 0').get(playerId) as { n: number }).n;

/** The id of the newest notification (0 when there is none): where the page starts polling from. */
export const latestId = (db: DB, playerId: number) =>
  (db.prepare('SELECT MAX(id) m FROM notifications WHERE player_id = ?').get(playerId) as { m: number | null }).m ?? 0;

export function listNotifications(db: DB, playerId: number, limit = 50): Notification[] {
  return (
    db
      .prepare('SELECT * FROM notifications WHERE player_id = ? ORDER BY id DESC LIMIT ?')
      .all(playerId, Math.max(1, Math.min(KEEP, Math.floor(limit) || 50))) as any[]
  ).map(row);
}
/** Everything newer than `afterId` (for the page that polls), oldest first. */
export function newerThan(db: DB, playerId: number, afterId: number): Notification[] {
  const a = Number.isFinite(afterId) && afterId > 0 ? Math.floor(afterId) : 0;
  return (db.prepare('SELECT * FROM notifications WHERE player_id = ? AND id > ? ORDER BY id LIMIT 20').all(playerId, a) as any[]).map(row);
}

/** Mark as read: `{ all: true }` or `{ ids: [1, 2] }`. Other players' notifications are never touched. */
export function markRead(db: DB, playerId: number, o: { all?: unknown; ids?: unknown }) {
  if (o.all === true) {
    db.prepare('UPDATE notifications SET is_read = 1 WHERE player_id = ?').run(playerId);
    return;
  }
  assert(Array.isArray(o.ids), 'bad_request', 'Say which notifications: { "all": true } or { "ids": [1, 2] }');
  for (const id of (o.ids as unknown[]).slice(0, 200))
    if (Number.isInteger(id)) db.prepare('UPDATE notifications SET is_read = 1 WHERE player_id = ? AND id = ?').run(playerId, id);
}
