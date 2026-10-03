import { CFG } from '../../core/config.ts';
import type { DB } from '../../db/core.ts';
import { bump } from '../character/counters.ts';
import { assert } from '../../core/errors.ts';
import { permsOf } from './clan.ts';
import { loadPlayer } from '../character/player.ts';

const PAGE = 20;

function member(db: DB, playerId: number, now: number) {
  const p = loadPlayer(db, playerId, now);
  assert(p.clan_id, 'no_clan', 'You are not in a clan');
  return { p, clanId: p.clan_id, mod: permsOf(db, playerId).includes('forum') };
}
function thread(db: DB, id: number, clanId: number) {
  const t = db.prepare('SELECT * FROM forum_threads WHERE id = ? AND clan_id = ?').get(id, clanId) as any;
  assert(t, 'not_found', 'Thread not found', 404);
  return t;
}
/** A player may write CFG.forumPostsPerHour posts per hour (stops flooding a clan's forum). */
function assertCanPost(db: DB, playerId: number, now: number) {
  const n = (db.prepare('SELECT COUNT(*) n FROM forum_posts WHERE author_id = ? AND created_at > ?').get(playerId, now - 3_600_000) as { n: number }).n;
  assert(n < CFG.forumPostsPerHour, 'rate_limited', `You can write ${CFG.forumPostsPerHour} forum posts per hour`, 429);
}
function clean(text: unknown, max: number, what: string) {
  const v = String(text ?? '').trim();
  assert(v.length >= 1 && v.length <= max, 'bad_text', `${what} must be 1-${max} characters`);
  return v;
}

export function createThread(db: DB, playerId: number, title: string, body: string, now: number) {
  const { clanId } = member(db, playerId, now);
  assertCanPost(db, playerId, now);
  title = clean(title, 80, 'Title');
  body = clean(body, 4000, 'Post');
  const id = Number(
    db.prepare('INSERT INTO forum_threads (clan_id, author_id, title, created_at, last_at) VALUES (?,?,?,?,?)').run(clanId, playerId, title, now, now)
      .lastInsertRowid,
  );
  db.prepare('INSERT INTO forum_posts (thread_id, author_id, body, created_at) VALUES (?,?,?,?)').run(id, playerId, body, now);
  bump(db, playerId, 'forum_posts');
  return { id };
}

export function reply(db: DB, playerId: number, threadId: number, body: string, now: number) {
  const { clanId, mod } = member(db, playerId, now);
  assertCanPost(db, playerId, now);
  const t = thread(db, threadId, clanId);
  assert(!t.locked || mod, 'locked', 'This thread is locked', 403);
  db.prepare('INSERT INTO forum_posts (thread_id, author_id, body, created_at) VALUES (?,?,?,?)').run(threadId, playerId, clean(body, 4000, 'Post'), now);
  db.prepare('UPDATE forum_threads SET last_at = ? WHERE id = ?').run(now, threadId);
  bump(db, playerId, 'forum_posts');
}

export function listThreads(db: DB, playerId: number, now: number) {
  const { clanId } = member(db, playerId, now);
  return db
    .prepare(
      `SELECT t.id, t.title, t.pinned, t.locked, t.last_at, p.name AS author, (SELECT COUNT(*) FROM forum_posts x WHERE x.thread_id = t.id) - 1 AS replies
       FROM forum_threads t JOIN players p ON p.id = t.author_id WHERE t.clan_id = ? ORDER BY t.pinned DESC, t.last_at DESC LIMIT 100`,
    )
    .all(clanId);
}

export function getThread(db: DB, playerId: number, threadId: number, page: number, now: number) {
  const { clanId, mod } = member(db, playerId, now);
  const t = thread(db, threadId, clanId);
  const posts = db
    .prepare(
      'SELECT x.id, x.author_id, p.name AS author, x.body, x.created_at FROM forum_posts x JOIN players p ON p.id = x.author_id WHERE x.thread_id = ? ORDER BY x.id LIMIT ? OFFSET ?',
    )
    .all(threadId, PAGE, page * PAGE);
  return { ...t, posts, mod };
}

/** Moderation (needs the "forum" permission): pin, lock. */
export function setFlag(db: DB, playerId: number, threadId: number, flag: 'pinned' | 'locked', value: boolean, now: number) {
  const { clanId, mod } = member(db, playerId, now);
  assert(mod, 'no_permission', 'You need the "forum" permission', 403);
  thread(db, threadId, clanId);
  assert(flag === 'pinned' || flag === 'locked', 'bad_flag', 'Unknown flag');
  db.prepare(`UPDATE forum_threads SET ${flag} = ? WHERE id = ?`).run(+!!value, threadId);
}

/** Authors can delete their own posts; moderators any. Deleting the first post removes the whole thread. */
export function deletePost(db: DB, playerId: number, postId: number, now: number) {
  const { clanId, mod } = member(db, playerId, now);
  const post = db.prepare('SELECT * FROM forum_posts WHERE id = ?').get(postId) as any;
  assert(post, 'not_found', 'Post not found', 404);
  thread(db, post.thread_id, clanId);
  assert(post.author_id === playerId || mod, 'no_permission', 'You cannot delete that post', 403);
  const first = db.prepare('SELECT MIN(id) id FROM forum_posts WHERE thread_id = ?').get(post.thread_id) as { id: number };
  if (first.id === postId) {
    db.prepare('DELETE FROM forum_posts WHERE thread_id = ?').run(post.thread_id);
    db.prepare('DELETE FROM forum_threads WHERE id = ?').run(post.thread_id);
  } else db.prepare('DELETE FROM forum_posts WHERE id = ?').run(postId);
}
