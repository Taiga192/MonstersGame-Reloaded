import assert from 'node:assert/strict';
import { test, afterEach } from 'node:test';
import { CFG, HOUR, MIN } from '../src/config.ts';
import { openDb, type DB } from '../src/db.ts';
import { alertsFor } from '../src/game/alerts.ts';
import * as auth from '../src/game/auth.ts';
import * as clan from '../src/game/clan.ts';
import * as eco from '../src/game/economy.ts';
import { sendMail, systemMail } from '../src/game/mail.ts';
import { listNotifications, markRead, newerThan, notify, unreadCount } from '../src/game/notify.ts';
import { awardXp } from '../src/game/player.ts';
import * as raid from '../src/game/raid.ts';
import * as shrine from '../src/game/shrine.ts';
import { createApp } from '../src/node-app.ts';
import { seeded } from '../src/rng.ts';
import { applySettings } from '../src/settings.ts';

const T0 = Date.UTC(2027, 0, 13, 12, 0, 0);
const one = (db: DB, sql: string, ...a: any[]) => db.prepare(sql).get(...a) as any;
const mk = (db: DB, name: string, race: 'vampire' | 'werewolf' = 'vampire', level = 10) => {
  const id = auth.register(db, { name, password: 'secret12', race }, T0);
  db.prepare('UPDATE players SET level = ?, gold = 5000, hp = 200, max_hp = 200, hp_at = ? WHERE id = ?').run(level, T0, id);
  return id;
};
afterEach(() => { applySettings(openDb()); });

test('notifications are for humans only, links stay inside the game, text is cut to size, and only the last 100 are kept', () => {
  const db = openDb(); const me = mk(db, 'Human'); const bot = auth.registerBot(db, 'Botty', 'werewolf', T0);
  notify(db, bot, 'x', 'to a bot', '', '#/raid', T0); notify(db, 99999, 'x', 'to nobody', '', '#/raid', T0);
  assert.equal(one(db, 'SELECT COUNT(*) n FROM notifications').n, 0);
  notify(db, me, 'raid', 'T'.repeat(500), 'B'.repeat(900), 'javascript:alert(1)', T0);
  notify(db, me, 'raid', 'ok', '', '#/town/temple', T0);
  notify(db, me, 'raid', 'bad link', '', 'https://evil.example/#/x', T0); notify(db, me, 'raid', 'bad link 2', '', '#/<script>', T0);
  const l = listNotifications(db, me);
  assert.equal(l[3].title.length, 120); assert.equal(l[3].body.length, 300);
  assert.deepEqual(l.map((n) => n.link).reverse(), ['', '#/town/temple', '', '']);
  for (let i = 0; i < 150; i++) notify(db, me, 'spam', `n${i}`, '', '#/mail', T0 + i);
  assert.equal(one(db, 'SELECT COUNT(*) n FROM notifications WHERE player_id = ?', me).n, 100);
  assert.equal(listNotifications(db, me, 1000).length, 100); assert.equal(listNotifications(db, me, 1)[0].title, 'n149', 'newest first');
});

test('unread counting, marking read (all or some), never somebody else\'s, and "newer than" for the poll', () => {
  const db = openDb(); const a = mk(db, 'Alice'), b = mk(db, 'Bob');
  for (let i = 0; i < 5; i++) { notify(db, a, 'x', `a${i}`, '', '#/mail', T0); notify(db, b, 'x', `b${i}`, '', '#/mail', T0); }
  assert.equal(unreadCount(db, a), 5);
  const ids = listNotifications(db, a).map((n) => n.id), others = listNotifications(db, b).map((n) => n.id);
  markRead(db, a, { ids: [ids[0], ids[1], others[0], 'x', null, 1.5, -3] });
  assert.equal(unreadCount(db, a), 3); assert.equal(unreadCount(db, b), 5, 'Bob\'s were not touched');
  assert.throws(() => markRead(db, a, {}), /Say which/); assert.throws(() => markRead(db, a, { ids: 'all' }), /Say which/);
  assert.deepEqual(newerThan(db, a, ids[2]).map((n) => n.id), ids.slice(0, 2).reverse(), 'oldest first');
  assert.equal(newerThan(db, a, NaN).length, 5); assert.equal(newerThan(db, a, -5).length, 5);
  markRead(db, a, { all: true }); assert.equal(unreadCount(db, a), 0); assert.equal(unreadCount(db, b), 5);
});

test('events that reach the bell: raided (also when you win), level up, system mail, mail from a player, kicked, war, shrine', () => {
  const db = openDb(), rng = seeded(3);
  const victim = mk(db, 'Victim'), raider = mk(db, 'Raider', 'werewolf');
  db.prepare('UPDATE players SET str = 5000, def = 5000, agi = 5000, sta = 5000, hp = 900, max_hp = 900 WHERE id = ?').run(raider);
  raid.searchOpponent(db, raider, T0, rng, {}); raid.attack(db, raider, victim, T0, rng);
  let n = listNotifications(db, victim)[0];
  assert.equal(n.kind, 'raid'); assert.match(n.title, /Raider raided you/); assert.match(n.body, /took \d+ gold/); assert.equal(n.link, '#/messages');
  assert.equal(listNotifications(db, raider).length, 0, 'the attacker sees the result right away, no bell');
  // level up
  awardXp(db, victim, 100000, T0 + 1);
  n = listNotifications(db, victim)[0]; assert.equal(n.kind, 'level'); assert.match(n.title, /You reached level/); assert.equal(n.link, '#/skills');
  // system mail (arena, market, announcements ...) shows up as a notification with the right link
  systemMail(db, victim, 'Blood Temple: item sold', 'You received 90 gold.', T0 + 2, { kind: 'market', link: '#/town/temple' });
  n = listNotifications(db, victim)[0]; assert.deepEqual([n.kind, n.title, n.link], ['market', 'Blood Temple: item sold', '#/town/temple']);
  // mail written by a player
  sendMail(db, raider, 'Victim', 'Revenge?', 'Come back when you dare.', T0 + 3);
  n = listNotifications(db, victim)[0]; assert.equal(n.kind, 'mail'); assert.match(n.title, /Mail from Raider/); assert.equal(n.body, 'Revenge?');
});

test('clan events: removed from a clan, war declared (both clans are told, the one who declared is not), war over', () => {
  const db = openDb();
  const lead = mk(db, 'Lead'), m1 = mk(db, 'Member1'), m2 = mk(db, 'Member2'), m3 = mk(db, 'Member3'), m4 = mk(db, 'Member4');
  const elead = mk(db, 'EnemyLead', 'werewolf'), e1 = mk(db, 'Enemy1', 'werewolf');
  const c = clan.createClan(db, lead, 'Reds', T0), ec = clan.createClan(db, elead, 'Blues', T0);
  for (const m of [m1, m2, m3, m4]) clan.joinClan(db, m, c, T0);
  clan.joinClan(db, e1, ec, T0);
  clan.declareWar(db, lead, ec, T0 + 1);
  const titles = (id: number) => listNotifications(db, id).map((n) => n.title);
  assert.ok(titles(e1).some((t) => /Reds declared war on your clan/.test(t)), 'the enemy is told'); assert.ok(titles(elead).some((t) => /declared war/.test(t)));
  assert.ok(titles(m1).some((t) => /at war with Blues/.test(t)), 'own members are told'); assert.equal(titles(lead).length, 0, 'the leader who declared it is not');
  assert.equal(listNotifications(db, e1)[0].link, '#/clan/war');
  clan.capitulate(db, lead, T0 + 2);
  assert.ok(titles(e1).includes('The clan war is over') && titles(m1).includes('The clan war is over'));
  clan.kickMember(db, lead, m2, T0 + 3);
  assert.match(listNotifications(db, m2)[0].title, /removed from Reds/);
});

test('the shrine running out of blood is announced once it happens', () => {
  const db = openDb(), rng = seeded(4); const id = mk(db, 'Priest');
  shrine.buyShrine(db, id, T0); shrine.setRoutine(db, id, ['work:2'], T0, rng);
  db.prepare('UPDATE players SET blood = ? WHERE id = ?').run(2 * CFG.shrineBloodPerHour, id);
  shrine.start(db, id, T0, rng); shrine.settle(db, id, T0 + 3 * HOUR, rng);
  assert.equal(listNotifications(db, id)[0].kind, 'shrine'); assert.match(listNotifications(db, id)[0].title, /ran out of blood/);
});

test('the alert bar: finished hunt and shift, skill points, unread mail, a guardian reward, an empty shrine - and they disappear when dealt with', () => {
  const db = openDb(), rng = seeded(4); const id = mk(db, 'Busy'); const other = mk(db, 'Other', 'werewolf');
  const keys = () => alertsFor(db, id, T0 + 5 * HOUR).map((a) => a.key).sort();
  db.prepare('UPDATE players SET level = 1 WHERE id = ?').run(id);
  assert.deepEqual(keys(), ['skills'], 'a fresh level 1 character: one skill point');
  eco.startHunt(db, id, 2, T0); assert.ok(keys().includes('hunt'), 'the hunt is over by now');
  assert.ok(!alertsFor(db, id, T0 + 5 * MIN).some((a) => a.key === 'hunt'), 'not while it is still running');
  eco.collectHunt(db, id, T0 + 5 * HOUR, rng); assert.ok(!keys().includes('hunt'));
  eco.startWork(db, id, 1, T0 + 6 * HOUR); assert.ok(alertsFor(db, id, T0 + 8 * HOUR).some((a) => a.key === 'work' && a.link === '#/town/graveyard'));
  sendMail(db, other, 'Busy', 'hi', 'there', T0); assert.ok(alertsFor(db, id, T0 + 8 * HOUR).some((a) => a.key === 'mail' && /1 unread mail$/.test(a.text)));
  db.prepare("INSERT INTO dungeon (player_id, week, reached_at, pending) VALUES (?, 0, 0, '[]')").run(id);
  assert.ok(alertsFor(db, id, T0 + 8 * HOUR).some((a) => a.key === 'reward'));
  db.prepare('UPDATE players SET level = 10 WHERE id = ?').run(id); shrine.buyShrine(db, id, T0 + 9 * HOUR); db.prepare("UPDATE shrine SET status = 'starved' WHERE player_id = ?").run(id);
  assert.ok(alertsFor(db, id, T0 + 8 * HOUR).some((a) => a.key === 'shrine' && a.tone === 'warn'));
  for (const a of alertsFor(db, id, T0 + 8 * HOUR)) assert.match(a.link, /^#\/[a-z\/]+$/, 'links stay inside the game');
});

// ---------------------------------------------------------------- the API
const H = { 'content-type': 'application/json' };
async function api() {
  const db = openDb();
  const app = createApp({ db, now: () => T0, rng: seeded(5), security: { limits: false } });
  const post = (path: string, body: unknown, h: Record<string, string> = {}) => app.request(path, { method: 'POST', headers: { ...H, ...h }, body: JSON.stringify(body) });
  const reg = async (name: string) => {
    const id = ((await (await post('/api/register', { name, password: 'secret12', race: 'vampire' })).json()) as any).id as number;
    const token = ((await (await post('/api/login', { name, password: 'secret12' })).json()) as any).token as string;
    return { id, h: { authorization: `Bearer ${token}` } };
  };
  return { db, app, post, reg };
}

test('API: list, poll, mark read; the page can see new items since its last one and the count in /api/me', async () => {
  const { db, app, post, reg } = await api();
  const a = await reg('Alice'), b = await reg('Bob');
  assert.equal((await app.request('/api/notifications')).status, 401); assert.equal((await app.request('/api/notifications/poll')).status, 401);
  notify(db, a.id, 'raid', 'one', 'x', '#/messages', T0); notify(db, a.id, 'raid', 'two', 'y', '#/messages', T0); notify(db, b.id, 'raid', 'Bobs', 'z', '#/messages', T0);
  const list = await (await app.request('/api/notifications', { headers: a.h })).json() as any;
  assert.deepEqual(list.items.map((n: any) => n.title), ['two', 'one']); assert.equal(list.unread, 2);
  const first = list.items[1].id;
  const poll = await (await app.request(`/api/notifications/poll?after=${first}`, { headers: a.h })).json() as any;
  assert.deepEqual(poll.items.map((n: any) => n.title), ['two']); assert.equal(poll.unread, 2); assert.ok(Array.isArray(poll.alerts));
  const me = await (await app.request('/api/me', { headers: a.h })).json() as any; assert.equal(me.unreadNotifications, 2);
  assert.equal((await post('/api/notifications/read', { ids: [first, list.items[0].id, ...(await (await app.request('/api/notifications', { headers: b.h })).json() as any).items.map((n: any) => n.id)] }, a.h)).status, 200);
  assert.equal(((await (await app.request('/api/notifications', { headers: a.h })).json()) as any).unread, 0);
  assert.equal(((await (await app.request('/api/notifications', { headers: b.h })).json()) as any).unread, 1, 'Bob\'s notification was not marked by Alice');
  assert.equal(((await (await post('/api/notifications/read', { all: true }, b.h)).json()) as any).unread, 0);
});

test('API: hostile input to the notification routes is refused or ignored cleanly', async () => {
  const { app, post, reg } = await api(); const a = await reg('Fuzzy');
  for (const body of [{}, { ids: null }, { ids: 'all' }, { ids: [{}] }, { ids: Array(5000).fill(1) }, { all: 'yes' }, 'text', [1], { ids: ['1; DROP TABLE players'] }]) {
    const r = await post('/api/notifications/read', body, a.h); assert.ok(r.status < 500, `${JSON.stringify(body).slice(0, 40)} -> ${r.status}`);
  }
  for (const q of ['?after=abc', '?after=-1', '?after=1e999', '?after=' + 'x'.repeat(500), '?limit=-5', '?limit=99999999']) {
    assert.ok((await app.request(`/api/notifications/poll${q}`, { headers: a.h })).status < 500, q); assert.ok((await app.request(`/api/notifications${q}`, { headers: a.h })).status < 500, q);
  }
});
