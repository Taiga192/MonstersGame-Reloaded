import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { backupDatabase } from '../src/backup.ts';
import { CFG, DAY_MS, HOUR } from '../src/config.ts';
import { DatabaseSync } from 'node:sqlite';
import { initSchema } from '../src/db-core.ts';
import { openDb } from '../src/db.ts';
import * as auth from '../src/game/auth.ts';
import { createApp } from '../src/node-app.ts';
import { originMatcher } from '../src/security.ts';
import { seeded } from '../src/rng.ts';

const T0 = 1_800_000_000_000;
const json = (b: unknown) => JSON.stringify(b);
const JSONH = { 'content-type': 'application/json' };
const reg = (name: string) => ({ method: 'POST', headers: JSONH, body: json({ name, password: 'secret12', race: 'vampire' }) });

// Backups and the real server process are Node-server features that write real files, so these tests always use node:sqlite,
// whichever backend `npm run test:wasm` picks for the rest of the suite (WebAssembly SQLite has its own virtual filesystem and
// cannot write to the host disk; the browser build has no backups).
const nodeDb = () => { const raw = new DatabaseSync(':memory:'); initSchema(raw); return raw; };
const readCopy = (file: string) => new DatabaseSync(file, { readOnly: true });

// ---------------------------------------------------------------- CORS
test('CORS origin patterns: exact, subdomain wildcard, anything; spoofed look-alikes never match', () => {
  const m = originMatcher(['https://*.itch.zone', 'https://me.github.io', '  ']);
  for (const ok of ['https://html.itch.zone', 'https://a.b.itch.zone', 'https://ME.itch.zone', 'https://me.github.io']) assert.equal(m(ok), true, ok);
  for (const bad of ['https://itch.zone', 'https://evilitch.zone', 'https://html.itch.zone.evil.com', 'http://html.itch.zone', 'https://html.itch.zone:8080', 'https://x.github.io', 'https://me.github.io.evil.com', 'null', '', 'https://.itch.zone', 'https://html-itch.zone']) assert.equal(m(bad), false, bad);
  assert.equal(originMatcher(['*'])('https://anything.example'), true);
  assert.equal(originMatcher([])('https://html.itch.zone'), false, 'nothing configured = nothing allowed');
  assert.equal(originMatcher(['https://a.com'])('https://a.com.evil.com'), false);
  assert.equal(originMatcher(['https://a.com'])('https://a.com/'), false, 'origins have no trailing slash');
});

test('CORS: allowed origins get headers and can preflight; others and same-origin-only servers get none', async () => {
  const app = createApp({ db: openDb(), now: () => T0, rng: seeded(1), security: { corsOrigins: ['https://*.itch.zone'], limits: false } });
  const ok = await app.request('/api/catalog', { headers: { origin: 'https://html.itch.zone' } });
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get('access-control-allow-origin'), 'https://html.itch.zone', 'echoes the exact origin, never "*"');
  assert.match(ok.headers.get('vary') ?? '', /Origin/i);
  const bad = await app.request('/api/catalog', { headers: { origin: 'https://evil.example' } });
  assert.equal(bad.headers.get('access-control-allow-origin'), null, 'the browser will block the answer for other sites');
  const none = await app.request('/api/catalog');
  assert.equal(none.headers.get('access-control-allow-origin'), null);

  const pre = await app.request('/api/login', { method: 'OPTIONS', headers: { origin: 'https://html.itch.zone', 'access-control-request-method': 'POST', 'access-control-request-headers': 'authorization,content-type' } });
  assert.ok(pre.status === 204 || pre.status === 200);
  assert.equal(pre.headers.get('access-control-allow-origin'), 'https://html.itch.zone');
  assert.match(pre.headers.get('access-control-allow-headers') ?? '', /authorization/i);
  assert.match(pre.headers.get('access-control-allow-headers') ?? '', /content-type/i);
  assert.match(pre.headers.get('access-control-allow-methods') ?? '', /POST/);
  const badPre = await app.request('/api/login', { method: 'OPTIONS', headers: { origin: 'https://evil.example', 'access-control-request-method': 'POST' } });
  assert.equal(badPre.headers.get('access-control-allow-origin'), null);

  const closed = createApp({ db: openDb(), now: () => T0, rng: seeded(1), security: { limits: false } });
  assert.equal((await closed.request('/api/catalog', { headers: { origin: 'https://html.itch.zone' } })).headers.get('access-control-allow-origin'), null, 'no CORS configured = same origin only');
});

// ---------------------------------------------------------------- rate limits
const limited = (limits: object, trustProxy = true, now = () => T0) =>
  createApp({ db: openDb(), now, rng: seeded(1), security: { trustProxy, corsOrigins: ['https://game.example'], limits: { register: { windowMs: HOUR, max: 2 }, login: { windowMs: 10 * 60_000, max: 3 }, api: { windowMs: 60_000, max: 5 }, ...limits } as any } });

test('rate limit: registrations per address per hour, separate per address, resets after the window', async () => {
  let t = T0;
  const app = limited({}, true, () => t);
  const from = (ip: string, name: string) => app.request('/api/register', { ...reg(name), headers: { ...JSONH, 'x-forwarded-for': ip, origin: 'https://game.example' } });
  assert.equal((await from('1.1.1.1', 'Anna')).status, 201);
  assert.equal((await from('1.1.1.1', 'Bella')).status, 201);
  const blocked = await from('1.1.1.1', 'Cora');
  assert.equal(blocked.status, 429);
  assert.equal(((await blocked.json()) as any).error, 'rate_limited');
  assert.ok(Number(blocked.headers.get('retry-after')) > 3000, 'tells the client when to come back');
  assert.equal(blocked.headers.get('access-control-allow-origin'), 'https://game.example', 'even the 429 carries CORS headers, so the browser can show the message');
  assert.equal((await from('2.2.2.2', 'Dora')).status, 201, 'another address is not affected');
  t += HOUR + 1;
  assert.equal((await from('1.1.1.1', 'Cora')).status, 201, 'the window has passed');
});

test('rate limit: login guessing is slowed down even with the right password; CORS preflights are free', async () => {
  const app = limited({}, true);
  await app.request('/api/register', { ...reg('Victim'), headers: { ...JSONH, 'x-forwarded-for': '9.9.9.9' } });
  const login = (pw: string) => app.request('/api/login', { method: 'POST', headers: { ...JSONH, 'x-forwarded-for': '5.5.5.5' }, body: json({ name: 'Victim', password: pw }) });
  assert.equal((await login('wrong1')).status, 401);
  assert.equal((await login('wrong2')).status, 401);
  assert.equal((await login('secret12')).status, 200);
  assert.equal((await login('secret12')).status, 429, 'the fourth attempt within 10 minutes is refused');
  for (let i = 0; i < 20; i++) assert.notEqual((await app.request('/api/login', { method: 'OPTIONS', headers: { 'x-forwarded-for': '5.5.5.5', origin: 'https://game.example', 'access-control-request-method': 'POST' } })).status, 429);
});

test('rate limit: general API budget per minute', async () => {
  const app = limited({}, true);
  const hit = () => app.request('/api/catalog', { headers: { 'x-forwarded-for': '7.7.7.7' } });
  for (let i = 0; i < 5; i++) assert.equal((await hit()).status, 200);
  assert.equal((await hit()).status, 429);
  assert.equal((await app.request('/api/catalog', { headers: { 'x-forwarded-for': '8.8.8.8' } })).status, 200);
});

test('rate limit: behind a proxy the LAST forwarded address counts, so a client cannot dodge the limit by faking one', async () => {
  const app = limited({});
  const from = (xff: string, name: string) => app.request('/api/register', { ...reg(name), headers: { ...JSONH, 'x-forwarded-for': xff } });
  assert.equal((await from('fake-1, 4.4.4.4', 'Ann1')).status, 201);
  assert.equal((await from('fake-2, 4.4.4.4', 'Ann2')).status, 201);
  assert.equal((await from('fake-3, 4.4.4.4', 'Ann3')).status, 429, 'same real address (the one our proxy appended)');
  // without trusting a proxy the header is ignored entirely
  const direct = limited({}, false);
  const d = (xff: string, name: string) => direct.request('/api/register', { ...reg(name), headers: { ...JSONH, 'x-forwarded-for': xff } });
  assert.equal((await d('a', 'Bob1')).status, 201); assert.equal((await d('b', 'Bob2')).status, 201);
  assert.equal((await d('c', 'Bob3')).status, 429, 'spoofed X-Forwarded-For does not help when no proxy is trusted');
});

test('oversized requests are refused, normal ones pass', async () => {
  const app = createApp({ db: openDb(), now: () => T0, rng: seeded(1), security: { limits: false } });
  const big = await app.request('/api/register', { method: 'POST', headers: JSONH, body: json({ name: 'x'.repeat(300_000), password: 'secret12', race: 'vampire' }) });
  assert.equal(big.status, 413);
  assert.equal(((await big.json()) as any).error, 'too_large');
  assert.equal((await app.request('/api/register', reg('Normal'))).status, 201);
});

// ---------------------------------------------------------------- sessions
test('sessions: logout really ends the session on the server, and tokens expire after 90 days', async () => {
  let t = T0;
  const db = openDb();
  const app = createApp({ db, now: () => t, rng: seeded(1) });
  const call = (path: string, token?: string, method = 'GET') => app.request(path, { method, headers: { ...JSONH, ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: method === 'POST' ? '{}' : undefined });
  await app.request('/api/register', reg('Sess'));
  const login = async () => ((await (await app.request('/api/login', { method: 'POST', headers: JSONH, body: json({ name: 'Sess', password: 'secret12' }) })).json()) as any).token as string;

  const a = await login();
  assert.equal((await call('/api/me', a)).status, 200);
  assert.equal((await call('/api/logout', a, 'POST')).status, 200);
  assert.equal((await call('/api/me', a)).status, 401, 'a copied token is dead after logout');
  assert.equal((await call('/api/logout', undefined, 'POST')).status, 200, 'logging out twice / without a token is harmless');

  const b = await login();
  t += CFG.sessionMaxAge - HOUR;
  assert.equal((await call('/api/me', b)).status, 200, 'still valid just before 90 days');
  t += 2 * HOUR;
  const expired = await call('/api/me', b);
  assert.equal(expired.status, 401);
  assert.match(((await expired.json()) as any).message, /expired/i);
  assert.equal((db.prepare('SELECT COUNT(*) n FROM sessions WHERE token = ?').get(createHash('sha256').update(b).digest('hex')) as { n: number }).n, 0, 'expired tokens are deleted');
  assert.equal(CFG.sessionMaxAge, 90 * DAY_MS);
});

test('a production server exposes no test tools: /api/dev is absent without a dev clock', async () => {
  const app = createApp({ db: openDb(), now: () => T0, rng: seeded(1) }); // (server.ts passes a dev clock only outside NODE_ENV=production)
  assert.equal((await app.request('/api/dev')).status, 404);
  assert.equal((await app.request('/api/dev/grant', { method: 'POST', headers: JSONH, body: '{"gold":1000000}' })).status, 404);
});

// ---------------------------------------------------------------- backups
test('backups: a consistent, openable copy of the live database; old ones are pruned', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mg-backup-'));
  try {
    const db = nodeDb();
    auth.register(db, { name: 'Precious', password: 'secret12', race: 'vampire' }, T0);
    const files = [0, 1, 2, 3, 4].map((i) => backupDatabase(db, dir, 3, T0 + i * HOUR));
    const left = readdirSync(dir).sort();
    assert.equal(left.length, 3, 'only the newest 3 are kept');
    assert.deepEqual(left, files.slice(2).map((f) => f.split('/').pop()!), 'the oldest ones were deleted');
    const copy = readCopy(join(dir, left.at(-1)!));
    assert.equal((copy.prepare("SELECT name FROM players WHERE name = 'Precious'").get() as any).name, 'Precious', 'the backup contains the data and opens as a normal game database');
    copy.close();
    assert.equal(db.isTransaction, false);
    assert.equal(backupDatabase(db, dir, 0, T0 + 9 * HOUR) !== '', true);
    assert.equal(readdirSync(dir).filter((f) => f.endsWith('.db')).length, 1, 'keep is never below 1'); // (opening a copy above made SQLite add -wal/-shm side files, which are not backups)
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------- the real server process
test('the real server: production mode, CORS from the environment, graceful shutdown leaves a final backup', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mg-server-'));
  const port = 3300 + Math.floor(Math.random() * 400);
  const child = spawn('node', ['src/server.ts'], { env: { ...process.env, NODE_ENV: 'production', PORT: String(port), DB_PATH: join(dir, 'game.db'), BOTS: '5', CORS_ORIGINS: 'https://*.itch.zone', BACKUP_DIR: join(dir, 'b'), BACKUP_EVERY_HOURS: '6' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  child.stdout.on('data', (d) => (log += d)); child.stderr.on('data', (d) => (log += d));
  try {
    for (let i = 0; i < 300 && !/API on/.test(log); i++) await new Promise((r) => setTimeout(r, 100));
    assert.match(log, /API on/, log);
    assert.match(log, /CORS for https:\/\/\*\.itch\.zone/);
    const base = `http://localhost:${port}`;
    const ok = await fetch(`${base}/api/catalog`, { headers: { origin: 'https://html.itch.zone' } });
    assert.equal(ok.headers.get('access-control-allow-origin'), 'https://html.itch.zone');
    assert.equal((await fetch(`${base}/api/catalog`, { headers: { origin: 'https://evil.example' } })).headers.get('access-control-allow-origin'), null);
    assert.equal((await fetch(`${base}/api/dev`)).status, 404, 'no test tools in production');
    assert.equal((await fetch(`${base}/api/register`, reg('Real'))).status, 201);
    assert.equal(existsSync(join(dir, 'b')), false, 'no backup yet');
    child.kill('SIGTERM');
    const code = await new Promise<number | null>((r) => child.on('exit', r));
    assert.equal(code, 0, 'clean exit\n' + log);
    assert.match(log, /shutting down/); assert.match(log, /\[backup\] final/);
    const backups = readdirSync(join(dir, 'b'));
    assert.equal(backups.length, 1);
    const copy = readCopy(join(dir, 'b', backups[0]));
    assert.equal((copy.prepare("SELECT COUNT(*) n FROM players WHERE name = 'Real'").get() as any).n, 1, 'the final backup contains the player registered just before shutdown');
    assert.equal((copy.prepare('SELECT COUNT(*) n FROM bots').get() as any).n, 5);
    copy.close();
  } finally { child.kill('SIGKILL'); rmSync(dir, { recursive: true, force: true }); }
});
