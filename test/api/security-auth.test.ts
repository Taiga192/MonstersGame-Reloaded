import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { CFG, HOUR, MIN } from '../../src/core/config.ts';
import { openDb, type DB } from '../../src/db/node.ts';
import * as auth from '../../src/game/character/auth.ts';
import { createApp } from '../../src/server/create-app.ts';
import { seeded } from '../../src/core/rng.ts';

const T0 = 1_800_000_000_000;
const H = { 'content-type': 'application/json' };
const sha = (t: string) => createHash('sha256').update(t).digest('hex');
type App = ReturnType<typeof createApp>;
const post = (app: App, path: string, body: unknown, headers: Record<string, string> = {}) =>
  app.request(path, { method: 'POST', headers: { ...H, ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) });
const reg = (app: App, name: string, password = 'secret12', extra: object = {}) => post(app, '/api/register', { name, password, race: 'vampire', ...extra });
const login = async (app: App, name: string, password = 'secret12') => post(app, '/api/login', { name, password });
const tokenOf = async (app: App, name: string, password = 'secret12') => ((await (await login(app, name, password)).json()) as any).token as string;
const newApp = (over: object = {}) => {
  const db = openDb();
  return { db, app: createApp({ db, now: () => T0, rng: seeded(1), ...over }) };
};

test('passwords must be 8-128 characters; names and types are validated instead of crashing the server', async () => {
  const { app } = newApp();
  assert.equal((await reg(app, 'Shorty', 'abcdefg')).status, 400, '7 characters is too short');
  assert.equal((await reg(app, 'Okayish', 'abcdefgh')).status, 201, '8 characters is fine');
  assert.equal((await reg(app, 'Longone', 'x'.repeat(129))).status, 400);
  assert.equal((await reg(app, 'Longest1', 'x'.repeat(128))).status, 201);
  // wrong TYPES: these used to reach the database layer and crash with a 500
  for (const bad of [{ name: ['Valid'] }, { password: ['secret12'] }, { race: 5 }, { name: null }, { password: 12345678 }, { name: true }]) {
    const r = await post(app, '/api/register', { name: 'Typo', password: 'secret12', race: 'vampire', ...bad });
    assert.ok(r.status === 400, `${JSON.stringify(bad)} -> ${r.status}`);
  }
  assert.equal(
    (await post(app, '/api/register', { name: { a: 1 }, password: 'secret12', race: 'vampire' })).status,
    400,
    'objects are rejected by the input firewall',
  );
});

test('names that could pass for the game or its staff are reserved (mail from the game shows as "System")', async () => {
  const { app } = newApp();
  for (const n of [
    'System',
    'SYSTEM',
    'system_2',
    'Admin',
    'Admin_01',
    'Administrator',
    'Moderator99',
    'GameMaster',
    'Support',
    'MonstersGame',
    'Staff-Team',
    'Official',
  ]) {
    const r = await reg(app, n);
    assert.equal(r.status, 400, n);
    assert.equal(((await r.json()) as any).error, 'reserved_name', n);
  }
  assert.equal((await reg(app, 'Modest')).status, 201, 'similar-looking ordinary names are fine');
  assert.equal(auth.isReservedName('Adm1n'), false, 'digits are not letters: only obvious variants are blocked');
});

test('login tokens are stored only as a SHA-256 hash: a leaked database or backup contains no usable login', async () => {
  const { db, app } = newApp();
  await reg(app, 'Hashed');
  const token = await tokenOf(app, 'Hashed');
  const rows = db.prepare('SELECT token FROM sessions').all() as { token: string }[];
  assert.equal(rows.length, 1);
  assert.notEqual(rows[0].token, token, 'the token itself is not in the database');
  assert.equal(rows[0].token, sha(token));
  assert.equal(rows[0].token.length, 64);
  assert.equal((await app.request('/api/me', { headers: { authorization: `Bearer ${token}` } })).status, 200);
  assert.equal(
    (await app.request('/api/me', { headers: { authorization: `Bearer ${rows[0].token}` } })).status,
    401,
    'the stored hash cannot be used as a login',
  );
  // tokens from before this change (raw, 48 hex) are dropped by the migration instead of lingering in the clear
  db.prepare('INSERT INTO sessions (token, player_id, created_at) VALUES (?,?,?)').run('a'.repeat(48), 1, T0);
  const { initSchema } = await import('../../src/db/core.ts');
  initSchema(db as DB);
  assert.equal((db.prepare('SELECT COUNT(*) n FROM sessions WHERE length(token) != 64').get() as any).n, 0);
});

test('login does the same expensive work for names that do not exist (no timing hint about which accounts exist)', async () => {
  const { app } = newApp();
  await reg(app, 'RealPerson');
  const time = async (name: string) => {
    const t = performance.now();
    await login(app, name, 'wrong-password-1');
    return performance.now() - t;
  };
  const med = (a: number[]) => [...a].sort((x, y) => x - y)[a.length >> 1];
  await time('RealPerson'); // warm up
  const known = med([await time('RealPerson'), await time('RealPerson'), await time('RealPerson')]);
  const unknown = med([await time('NoSuchPlayer1'), await time('NoSuchPlayer2'), await time('NoSuchPlayer3')]);
  assert.ok(
    unknown > known * 0.4,
    `unknown name answered in ${unknown.toFixed(1)} ms vs ${known.toFixed(1)} ms for a real one: too fast, the name would be revealed`,
  );
  const a = await login(app, 'NoSuchPlayer1', 'x'),
    b = await login(app, 'RealPerson', 'wrong-password-1');
  assert.equal(a.status, 401);
  assert.equal(b.status, 401);
  assert.deepEqual(await a.json(), await b.json(), 'identical answers');
});

test('account lockout: 10 failed logins lock ONE account from every address; others are unaffected; it expires; success resets the count', async () => {
  let t = T0;
  const { app } = newApp({ now: () => t });
  await reg(app, 'Target1');
  await reg(app, 'Bystander');
  for (let i = 0; i < CFG.loginLockThreshold; i++) assert.equal((await login(app, 'Target1', 'guess-' + i + 'xx')).status, 401);
  const locked = await login(app, 'Target1', 'secret12');
  assert.equal(locked.status, 429, 'even the RIGHT password is refused while locked');
  assert.equal(((await locked.json()) as any).error, 'account_locked');
  assert.equal((await login(app, 'target1', 'secret12')).status, 429, 'name case does not matter');
  assert.equal((await login(app, 'Bystander')).status, 200, 'other accounts are not affected');
  t += CFG.loginLockWindow + 1000;
  assert.equal((await login(app, 'Target1', 'secret12')).status, 200, 'the lock ends with the window');
  // a success resets the counter: 9 failures, success, 9 more failures do not lock
  for (let i = 0; i < 9; i++) await login(app, 'Bystander', 'wrongwrong' + i);
  assert.equal((await login(app, 'Bystander')).status, 200);
  for (let i = 0; i < 9; i++) await login(app, 'Bystander', 'wrongwrong' + i);
  assert.equal((await login(app, 'Bystander')).status, 200, 'not locked: the counter was reset by the successful login');
});

test('changing the password needs the current one, enforces the policy, and ends all OTHER sessions', async () => {
  const { app } = newApp();
  await reg(app, 'Changer');
  const laptop = await tokenOf(app, 'Changer'),
    phone = await tokenOf(app, 'Changer');
  const bearer = (t: string) => ({ authorization: `Bearer ${t}` });
  assert.equal((await post(app, '/api/password', { current: 'wrongwrong', next: 'brand-new-pass' }, bearer(laptop))).status, 403);
  assert.equal((await post(app, '/api/password', { current: 'secret12', next: 'short' }, bearer(laptop))).status, 400);
  assert.equal((await post(app, '/api/password', { current: 'secret12', next: 'brand-new-pass' })).status, 401, 'needs a login');
  assert.equal((await post(app, '/api/password', { current: 'secret12', next: 'brand-new-pass' }, bearer(laptop))).status, 200);
  assert.equal((await app.request('/api/me', { headers: bearer(laptop) })).status, 200, 'the session that changed it stays logged in');
  assert.equal((await app.request('/api/me', { headers: bearer(phone) })).status, 401, 'every other session is ended (a thief with an old token is out)');
  assert.equal((await login(app, 'Changer', 'secret12')).status, 401, 'the old password is dead');
  assert.equal((await login(app, 'Changer', 'brand-new-pass')).status, 200);
});

test('registration code: a private server only lets people in who know it', async () => {
  const { app } = newApp({ security: { limits: false, registrationCode: 'open-sesame-42' } });
  const cat = (await (await app.request('/api/catalog')).json()) as any;
  assert.equal(cat.registrationRequired, true);
  assert.equal((await reg(app, 'NoCode')).status, 403);
  assert.equal((await reg(app, 'WrongCode', 'secret12', { code: 'open-sesame-43' })).status, 403);
  assert.equal((await reg(app, 'ArrayCode', 'secret12', { code: ['open-sesame-42'] })).status, 403, 'wrong type is refused too');
  assert.equal((await reg(app, 'GoodCode', 'secret12', { code: 'open-sesame-42' })).status, 201);
  assert.equal((await login(app, 'GoodCode')).status, 200, 'logging in does not need the code');
  const open = newApp();
  assert.equal(((await (await open.app.request('/api/catalog')).json()) as any).registrationRequired, false);
  assert.equal(auth.secretMatches('a', 'b'), false);
  assert.equal(auth.secretMatches('same', 'same'), true);
  assert.equal(auth.secretMatches(undefined, 'x'), false);
});

test('all registrations and logins share one CPU budget across every address (password hashing is expensive)', async () => {
  const { app } = newApp({
    security: {
      trustProxy: true,
      limits: {
        register: { windowMs: HOUR, max: 999 },
        login: { windowMs: 10 * MIN, max: 999 },
        api: { windowMs: 60_000, max: 9999 },
        authGlobal: { windowMs: 60_000, max: 5 },
      },
    },
  });
  const from = (i: number) => post(app, '/api/login', { name: 'nobody', password: 'wrong-password' }, { 'x-forwarded-for': `10.0.0.${i}` });
  for (let i = 1; i <= 5; i++) assert.equal((await from(i)).status, 401, `attempt ${i}`);
  const r = await from(6); // a sixth address: each address is fine on its own, but the whole server is at its limit
  assert.equal(r.status, 429);
  assert.match(((await r.json()) as any).message, /busy/i);
});

test('expired sessions are purged, fresh ones stay', () => {
  const db = openDb();
  const id = auth.register(db, { name: 'Purge', password: 'secret12', race: 'vampire' }, T0);
  db.prepare('INSERT INTO sessions (token, player_id, created_at) VALUES (?,?,?)').run(sha('old'), id, T0 - CFG.sessionMaxAge - 1000);
  db.prepare('INSERT INTO sessions (token, player_id, created_at) VALUES (?,?,?)').run(sha('new'), id, T0 - 1000);
  assert.equal(auth.purgeExpiredSessions(db, T0), 1);
  assert.equal((db.prepare('SELECT COUNT(*) n FROM sessions').get() as any).n, 1);
});
