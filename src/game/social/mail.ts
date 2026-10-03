import { CFG, HOUR } from '../../core/config.ts';
import type { DB } from '../../db/core.ts';
import { assert } from '../../core/errors.ts';
import { notify } from './notify.ts';
import { bump } from '../character/counters.ts';

/** System messages have from_id = NULL (arena results, market sales, ...). */
/** `opts.kind` / `opts.link` say how the notification (bell) for this message looks and where it leads. */
export function systemMail(db: DB, toId: number, subject: string, body: string, now: number, opts: { kind?: string; link?: string } = {}) {
  // bots never read mail: skip it instead of piling up thousands of rows
  if ((db.prepare('SELECT is_bot FROM players WHERE id = ?').get(toId) as { is_bot: number } | undefined)?.is_bot) return;
  db.prepare('INSERT INTO mail (from_id, to_id, subject, body, sent_at) VALUES (NULL,?,?,?,?)').run(toId, subject, body, now);
  notify(db, toId, opts.kind ?? 'mail', subject, body, opts.link ?? '#/mail', now);
}

export function sendMail(db: DB, fromId: number, toName: string, subject: string, body: string, now: number) {
  subject = String(subject ?? '').trim();
  body = String(body ?? '').trim();
  assert(subject.length >= 1 && subject.length <= 60, 'bad_subject', 'Subject must be 1-60 characters');
  assert(body.length >= 1 && body.length <= 2000, 'bad_body', 'Message must be 1-2000 characters');
  const to = db.prepare('SELECT id FROM players WHERE name = ?').get(String(toName ?? '')) as { id: number } | undefined;
  assert(to, 'no_recipient', 'No such player', 404);
  assert(to.id !== fromId, 'bad_recipient', 'You cannot write to yourself');
  const recent = (db.prepare('SELECT COUNT(*) n FROM mail WHERE from_id = ? AND sent_at > ?').get(fromId, now - HOUR) as { n: number }).n;
  assert(recent < CFG.mailPerHour, 'rate_limited', `You can send ${CFG.mailPerHour} messages per hour`, 429);
  const id = Number(
    db.prepare('INSERT INTO mail (from_id, to_id, subject, body, sent_at) VALUES (?,?,?,?,?)').run(fromId, to.id, subject, body, now).lastInsertRowid,
  );
  bump(db, fromId, 'mails_sent');
  notify(db, to.id, 'mail', `Mail from ${(db.prepare('SELECT name FROM players WHERE id = ?').get(fromId) as { name: string }).name}`, subject, '#/mail', now);
  return { id };
}

const PAGE = 25;
export function inbox(db: DB, playerId: number, page = 0) {
  return db
    .prepare(
      `SELECT m.id, m.from_id, COALESCE(p.name, 'System') AS from_name, m.subject, m.sent_at, m.read_at IS NOT NULL AS read
       FROM mail m LEFT JOIN players p ON p.id = m.from_id
      WHERE m.to_id = ? AND m.del_to = 0 ORDER BY m.sent_at DESC, m.id DESC LIMIT ? OFFSET ?`,
    )
    .all(playerId, PAGE, page * PAGE);
}
export function sentbox(db: DB, playerId: number, page = 0) {
  return db
    .prepare(
      `SELECT m.id, m.to_id, p.name AS to_name, m.subject, m.sent_at
       FROM mail m JOIN players p ON p.id = m.to_id
      WHERE m.from_id = ? AND m.del_from = 0 ORDER BY m.sent_at DESC, m.id DESC LIMIT ? OFFSET ?`,
    )
    .all(playerId, PAGE, page * PAGE);
}

/** Only sender or recipient can read; reading as the recipient marks it read. */
export function readMail(db: DB, playerId: number, mailId: number, now: number) {
  const m = db
    .prepare(
      `SELECT m.*, COALESCE(f.name, 'System') AS from_name, t.name AS to_name FROM mail m
       LEFT JOIN players f ON f.id = m.from_id JOIN players t ON t.id = m.to_id WHERE m.id = ?`,
    )
    .get(mailId) as any;
  assert(m && ((m.to_id === playerId && !m.del_to) || (m.from_id === playerId && !m.del_from)), 'not_found', 'Message not found', 404);
  if (m.to_id === playerId && !m.read_at) db.prepare('UPDATE mail SET read_at = ? WHERE id = ?').run(now, mailId);
  return { id: m.id, from_id: m.from_id, from_name: m.from_name, to_id: m.to_id, to_name: m.to_name, subject: m.subject, body: m.body, sent_at: m.sent_at };
}

export function deleteMail(db: DB, playerId: number, mailId: number) {
  const m = db.prepare('SELECT from_id, to_id FROM mail WHERE id = ?').get(mailId) as { from_id: number | null; to_id: number } | undefined;
  assert(m && (m.to_id === playerId || m.from_id === playerId), 'not_found', 'Message not found', 404);
  if (m.to_id === playerId) db.prepare('UPDATE mail SET del_to = 1 WHERE id = ?').run(mailId);
  if (m.from_id === playerId) db.prepare('UPDATE mail SET del_from = 1 WHERE id = ?').run(mailId);
}

export const unreadCount = (db: DB, playerId: number) =>
  (db.prepare('SELECT COUNT(*) n FROM mail WHERE to_id = ? AND read_at IS NULL AND del_to = 0').get(playerId) as { n: number }).n;
