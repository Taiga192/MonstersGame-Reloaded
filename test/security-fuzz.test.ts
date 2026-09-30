import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { openDb, type DB } from '../src/db.ts';
import * as arena from '../src/game/arena.ts';
import { registerBot } from '../src/game/auth.ts';
import * as clan from '../src/game/clan.ts';
import * as eco from '../src/game/economy.ts';
import * as forum from '../src/game/forum.ts';
import * as mail from '../src/game/mail.ts';
import * as dungeon from '../src/game/dungeon.ts';
import * as temple from '../src/game/temple.ts';
import { createApp } from '../src/node-app.ts';
import { seeded } from '../src/rng.ts';

const T0 = 1_800_000_000_000;
const sha = (t: string) => createHash('sha256').update(t).digest('hex');

/** A small but complete world, so handlers find real objects to hit (items, clan, forum, market, arena, mail, dungeon). */
function world() {
  const db = openDb();
  const human = (name: string, race: 'vampire' | 'werewolf', token: string) => {
    const id = registerBot(db, name, race, T0); // cheap account without password hashing...
    db.prepare('UPDATE players SET is_bot = 0, level = 30, gold = 1000000, str = 60, def = 60, agi = 60, sta = 60, dex = 60, max_hp = 250, hp = 250, hp_at = ? WHERE id = ?').run(T0, id);
    db.prepare('INSERT INTO sessions (token, player_id, created_at) VALUES (?,?,?)').run(sha(token), id, T0); // ...with a hand-made session
    return id;
  };
  const a = human('Fuzz_A', 'vampire', 'tokA'), b = human('Fuzz_B', 'werewolf', 'tokB'), c = human('Fuzz_C', 'vampire', 'tokC');
  eco.buyItem(db, a, 'itm_Blade_3', T0); eco.buyItem(db, a, 'potion_heal', T0); eco.buyItem(db, a, 'potion_maxhp', T0); eco.buySentinel(db, a, 'sen_1', T0);
  const inv = Number((db.prepare('SELECT id FROM inventory WHERE player_id = ? LIMIT 1').get(a) as any).id);
  eco.buyItem(db, a, 'itm_Plate_2', T0);
  const spare = Number((db.prepare("SELECT id FROM inventory WHERE player_id = ? AND item_key = 'itm_Plate_2'").get(a) as any).id);
  temple.listItem(db, a, spare, 500, T0);
  const cid = clan.createClan(db, a, 'Fuzz Court', T0); clan.joinClan(db, c, cid, T0);
  forum.createThread(db, a, 'Hello', 'first post', T0);
  mail.sendMail(db, b, 'Fuzz_A', 'Hi', 'a message', T0);
  arena.createEvent(db, a, { kind: 'duel', deviation: 60, fee: 10, registrationMinutes: 60 }, T0);
  dungeon.dungeonState(db, a, T0);
  db.prepare("INSERT INTO battles (attacker_id, defender_id, winner_id, gold, xp_attacker, xp_defender, at, rounds, log) VALUES (?,?,?,?,?,?,?,?,?)").run(a, b, a, 1, 1, 1, T0, 1, '[]');
  void inv;
  const app = createApp({ db, now: () => T0, rng: seeded(11) }); // production-like: no dev tools
  return { db, app, a, b, c };
}

// every field name any handler reads
const FIELDS = ['name', 'password', 'race', 'referrerId', 'code', 'stat', 'key', 'inventoryId', 'price', 'attr', 'component', 'portions', 'hours', 'clanId', 'message', 'playerId', 'amount', 'accept',
  'open', 'perms', 'title', 'body', 'threadId', 'flag', 'value', 'postId', 'to', 'subject', 'mailId', 'kind', 'size', 'deviation', 'fee', 'withEq', 'withSen', 'withAnc', 'registrationMinutes',
  'eventId', 'listingId', 'lootId', 'index', 'slot', 'keys', 'targetId', 'current', 'next', 'action', 'count', 'gold'];

const HOSTILE: unknown[] = [
  null, true, false, 0, -1, 1, 2, 3, 7, 1e308, -1e308, 2 ** 53, 0.5, -0.0,
  '', ' ', 'a', '1', '-1', '1e999', 'NaN', 'null', 'undefined', 'true', '__proto__', 'constructor', 'toString',
  "' OR 1=1 --", "'; DROP TABLE players; --", '1; DELETE FROM players', '" OR ""="', "%' UNION SELECT token FROM sessions --", '`; SELECT 1',
  '<script>alert(1)</script>', '"><img src=x onerror=alert(1)>', '../../etc/passwd', '\u0000', '‮ RTL', '😀'.repeat(60), 'x'.repeat(4999),
  [], [1, 2, 3], ['a', 'b'], [null], ['__proto__'], Array(50).fill('str'),
  {}, { a: { b: 1 } }, [[1]], [{}], { __proto__: { admin: 1 } },
];

const hostileBodies = (): unknown[] => [
  {}, { x: 1 },
  ...HOSTILE.map((v) => Object.fromEntries(FIELDS.map((f) => [f, v]))), // every field the same hostile value at once (type confusion)
  ...HOSTILE.map((v, i) => ({ [FIELDS[i % FIELDS.length]]: v })),          // one hostile field at a time
  Object.fromEntries(FIELDS.map((f, i) => [f, i % 2 ? 1 : 'a'])),         // mixed numbers and strings
  JSON.parse('{"__proto__": {"polluted": true}, "name": "x"}'),
];

test('FUZZ: every POST route survives hostile input without a server error, leaked transaction or damaged database', async () => {
  const { app } = world();
  const routes = [...new Set(app.routes.filter((r) => r.method === 'POST' && r.path.startsWith('/api/')).map((r) => r.path))];
  assert.ok(routes.length >= 40, `found only ${routes.length} POST routes: is the route table being read correctly?`);
  let requests = 0; const problems: string[] = []; const statuses: Record<number, number> = {};
  for (const path of routes) {
    const w = world(); // a fresh world per route: one route's side effects cannot hide another's crash
    const tables = (w.db.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE type = 'table'").get() as any).n;
    for (const body of hostileBodies()) {
      const url = path.replace(':id', '1');
      const res = await w.app.request(url, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer tokA', 'x-forwarded-for': "1.2.3.4'; DROP TABLE players; --" }, body: JSON.stringify(body) });
      requests++; statuses[res.status] = (statuses[res.status] ?? 0) + 1;
      if (res.status >= 500) problems.push(`${res.status} ${path} <- ${JSON.stringify(body)?.slice(0, 120)}`);
      if (w.db.isTransaction) problems.push(`transaction left open after ${path}`);
      await res.text();
    }
    const raw = w.db as DB;
    const check = (raw.prepare('PRAGMA integrity_check').get() as any);
    assert.equal(Object.values(check)[0], 'ok', `${path}: database integrity`);
    assert.equal(raw.prepare('PRAGMA foreign_key_check').all().length, 0, `${path}: foreign keys intact`);
    assert.equal((raw.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE type = 'table'").get() as any).n, tables, `${path}: no table was dropped`);
    assert.equal((raw.prepare('SELECT COUNT(*) n FROM players WHERE gold < 0 OR hp < 0 OR level < 1 OR xp < 0').get() as any).n, 0, `${path}: no negative values`);
    assert.equal((raw.prepare("SELECT COUNT(*) n FROM players WHERE typeof(gold) != 'integer' OR typeof(level) != 'integer' OR typeof(str) != 'integer'").get() as any).n, 0, `${path}: numeric columns hold integers`);
    assert.equal((raw.prepare('SELECT COUNT(*) n FROM players').get() as any).n >= 3 || path === '/api/register', true, `${path}: players were not deleted`);
  }
  assert.deepEqual(problems, [], `${problems.length} problems in ${requests} requests:\n${problems.slice(0, 15).join('\n')}`);
  assert.ok(requests > 3000, `${requests} hostile requests sent`);
  // the fuzzing must really run as a LOGGED-IN player and reach the handlers: if the session did not work, everything would be a 401 and prove nothing
  console.log(`# fuzz responses: ${JSON.stringify(statuses)}`);
  assert.ok((statuses[401] ?? 0) < requests * 0.05, `too many 401s (${statuses[401]}): the fuzz is not authenticated`);
  assert.ok((statuses[200] ?? 0) >= 30, `only ${statuses[200] ?? 0} requests were accepted: handlers were barely exercised`);
  assert.ok((statuses[400] ?? 0) > requests * 0.5, 'most hostile input is rejected as a clean 400');
});

test('FUZZ: GET routes and public endpoints survive hostile paths and query strings', async () => {
  const { app } = world();
  const routes = [...new Set(app.routes.filter((r) => r.method === 'GET' && r.path.startsWith('/api/')).map((r) => r.path))];
  const ids = ['abc', '-1', '0', '1', '1e400', '99999999999999999999', '%00', "1'%20OR%201=1", '..%2f..%2fetc%2fpasswd', '0x10', '%20', '%F0%9F%98%80', 'NaN', '__proto__', '1.5'];
  const qs = ['page', 'size', 'type', 'race', 'kind', 'box'];
  const problems: string[] = []; let n = 0;
  const withQuery = (id: string) => `?${qs.map((k) => `${k}=${id}`).join('&')}`;
  for (const path of routes) {
    // (a) hostile path ids, (b) VALID ids with hostile query values, (c) both hostile
    const combos: [string, string][] = [...ids.map((id): [string, string] => [id, '']), ...ids.map((id): [string, string] => ['1', withQuery(id)]), ...ids.map((id): [string, string] => [id, withQuery(id)]), ['1', '']];
    for (const [id, q] of combos) {
      const url = path.replace(':id', id);
      for (const headers of [{ authorization: 'Bearer tokA' }, {} as Record<string, string>]) {
        const res = await app.request(url + q, { headers });
        n++;
        if (res.status >= 500) problems.push(`${res.status} GET ${url}${q.slice(0, 60)} ${headers.authorization ? '(logged in)' : '(anonymous)'}`);
        await res.text();
      }
    }
  }
  // public POST with hostile ids
  for (const id of ids) { const res = await app.request(`/api/bite/${id}`, { method: 'POST' }); n++; if (res.status >= 500) problems.push(`${res.status} POST /api/bite/${id}`); await res.text(); }
  // hostile Authorization headers
  for (const h of ['', 'Bearer', 'Bearer ', 'Bearer ' + 'x'.repeat(10_000), 'Basic YWJjOmRlZg==', "Bearer ' OR 1=1 --", 'Bearer \u0000', 'bearer tokA']) {
    try { const res = await app.request('/api/me', { headers: { authorization: h } }); n++; if (res.status >= 500) problems.push(`${res.status} Authorization: ${h.slice(0, 40)}`); await res.text(); } catch { /* the runtime itself refused the header: also fine */ }
  }
  assert.deepEqual(problems, [], `${problems.length} problems in ${n} requests:\n${problems.slice(0, 15).join('\n')}`);
});
