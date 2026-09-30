import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { test } from 'node:test';
import { CFG, DAY_MS, HOUR } from '../src/config.ts';
import { GameError } from '../src/errors.ts';
import { openDb, type DB } from '../src/db.ts';
import * as auth from '../src/game/auth.ts';
import * as clan from '../src/game/clan.ts';
import * as eco from '../src/game/economy.ts';
import * as forum from '../src/game/forum.ts';
import { cleanBody } from '../src/game/validate.ts';
import { createApp } from '../src/node-app.ts';
import { seeded } from '../src/rng.ts';

const T0 = 1_800_000_000_000;
const H = { 'content-type': 'application/json' };
const code = (fn: () => unknown) => { try { fn(); } catch (e) { return (e as GameError).code; } return 'none'; };
type App = ReturnType<typeof createApp>;
const post = (app: App, path: string, body: unknown, headers: Record<string, string> = {}) => app.request(path, { method: 'POST', headers: { ...H, ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) });
const mk = async (app: App, name: string, race = 'vampire') => {
  const r = (await (await post(app, '/api/register', { name, password: 'secret12', race })).json()) as any;
  const token = ((await (await post(app, '/api/login', { name, password: 'secret12' })).json()) as any).token as string;
  return { id: r.id as number, token, auth: { authorization: `Bearer ${token}` } };
};

// ---------------------------------------------------------------- the victim-link gold exploit
test('EXPLOIT FIXED: a client cannot fake its identity to bite a victim link over and over for gold', async () => {
  const db = openDb();
  const app = createApp({ db, now: () => T0, rng: seeded(1), security: { limits: false } }); // no proxy trusted
  const owner = await mk(app, 'LinkOwner');
  const gold = () => (db.prepare('SELECT gold FROM players WHERE id = ?').get(owner.id) as any).gold as number;
  const g0 = gold();
  const bite = (xff?: string) => app.request(`/api/bite/${owner.id}`, { method: 'POST', headers: xff ? { 'x-forwarded-for': xff } : {} });
  assert.equal((await bite('1.1.1.1')).status, 200);
  for (let i = 2; i < 40; i++) assert.equal((await bite(`9.9.9.${i}`)).status, 400, 'spoofing X-Forwarded-For does not create new visitors when no proxy is trusted');
  assert.ok(gold() - g0 >= 1 && gold() - g0 <= 3, `one bite, 1-3 gold, got ${gold() - g0}`);
});

test('victim link behind a trusted proxy: visitors are told apart by the address the PROXY saw, and there is a hard daily ceiling', async () => {
  const db = openDb();
  const app = createApp({ db, now: () => T0, rng: seeded(2), security: { limits: false, trustProxy: true } });
  const owner = await mk(app, 'ProxyOwner');
  const bite = (xff: string) => app.request(`/api/bite/${owner.id}`, { method: 'POST', headers: { 'x-forwarded-for': xff } });
  assert.equal((await bite('evil-1, 7.7.7.7')).status, 200);
  assert.equal((await bite('evil-2, 7.7.7.7')).status, 400, 'only the LAST entry (added by our proxy) counts: same real visitor');
  const g0 = (db.prepare('SELECT gold FROM players WHERE id = ?').get(owner.id) as any).gold;
  let ok = 1; // (the first bite above)
  for (let i = 0; i < 60; i++) { const r = await bite(`8.8.${i >> 8}.${i & 255}`); if (r.status === 200) ok++; else assert.equal(((await r.json()) as any).error, 'bite_limit'); }
  assert.equal(ok, CFG.biteDailyCap, 'even an attacker with endless addresses stops at the daily ceiling');
  const gained = (db.prepare('SELECT gold FROM players WHERE id = ?').get(owner.id) as any).gold - g0;
  assert.ok(gained <= (CFG.biteDailyCap - 1) * CFG.biteGoldMax, `at most ${(CFG.biteDailyCap - 1) * CFG.biteGoldMax} gold, got ${gained}`);
  assert.equal((db.prepare('SELECT COUNT(*) n FROM bites WHERE visitor LIKE ?').get('%.%') as any).n, 0, 'no raw addresses are stored, only hashes');
});

// ---------------------------------------------------------------- who may read what
test('battle logs: only the two fighters can read them (everyone else gets 404, so ids cannot be probed)', async () => {
  const db = openDb();
  const app = createApp({ db, now: () => T0, rng: seeded(3) });
  const a = await mk(app, 'Fighter1'), b = await mk(app, 'Fighter2', 'werewolf'), c = await mk(app, 'Bystander');
  db.prepare("INSERT INTO battles (attacker_id, defender_id, winner_id, gold, xp_attacker, xp_defender, at, rounds, log) VALUES (?,?,?,?,?,?,?,?,?)").run(a.id, b.id, a.id, 5, 1, 1, T0, 3, '[]');
  const get = (t: typeof a) => app.request('/api/battles/1', { headers: t.auth });
  assert.equal((await get(a)).status, 200); assert.equal((await get(b)).status, 200);
  assert.equal((await get(c)).status, 404);
  assert.equal((await app.request('/api/battles/1')).status, 401, 'and a login is needed at all');
  assert.equal((await app.request('/api/battles/999', { headers: a.auth })).status, 404, 'a missing battle looks the same as a forbidden one');
});

test('war statistics: only people on that war\'s roster can read them', async () => {
  const db = openDb();
  const app = createApp({ db, now: () => T0, rng: seeded(4) });
  const member = await mk(app, 'WarMember'), outsider = await mk(app, 'Outsider2', 'werewolf');
  db.prepare("INSERT INTO clan_wars (aggressor_id, defender_id, started_at) VALUES (1, 2, ?)").run(T0);
  db.prepare('INSERT INTO clan_war_members (war_id, player_id, clan_id) VALUES (1, ?, 1)').run(member.id);
  assert.equal((await app.request('/api/clan/war/1/stats', { headers: member.auth })).status, 200);
  assert.equal((await app.request('/api/clan/war/1/stats', { headers: outsider.auth })).status, 404);
});

// ---------------------------------------------------------------- input firewall
test('input firewall: only flat JSON of plain values gets through, prototype tricks and oversize values are refused', async () => {
  const ok = cleanBody({ a: 1, b: 'x', c: true, d: null, e: ['x', 2, false] });
  assert.deepEqual(JSON.parse(JSON.stringify(ok)), { a: 1, b: 'x', c: true, d: null, e: ['x', 2, false] });
  assert.equal(Object.getPrototypeOf(ok), null, 'no prototype: b.constructor is simply undefined');
  const rejected: unknown[] = [null, 5, 'str', [], [1], { a: { b: 1 } }, { a: [[1]] }, { a: [{}] }, { a: 'x'.repeat(5001) }, { a: 1e999 }, { a: Array(51).fill(1) },
    { 'bad key': 1 }, { '1abc': 1 }, { constructor: 1 }, { prototype: 1 }, JSON.parse('{"__proto__": {"admin": true}}'), Object.fromEntries(Array.from({ length: 41 }, (_, i) => ['k' + i, 1])), { a: undefined, b: () => 1 }];
  for (const r of rejected) assert.equal(code(() => cleanBody(r)), 'bad_request', JSON.stringify(r)?.slice(0, 60));
  const app = createApp({ db: openDb(), now: () => T0, rng: seeded(5) });
  const tries: [string, string][] = [['[]', 'array body'], ['"text"', 'string body'], ['{"name":{"a":1},"password":"secret12","race":"vampire"}', 'nested value'], ['{"__proto__":{"x":1}}', '__proto__ key'], ['{"constructor":1}', 'constructor key'], [`{"name":"${'x'.repeat(6000)}"}`, 'huge string']];
  for (const [body, what] of tries) {
    const r = await post(app, '/api/register', body);
    assert.equal(r.status, 400, what);
    assert.equal(((await r.json()) as any).error, 'bad_request', what);
  }
  assert.equal((await post(app, '/api/register', 'not json at all')).status, 400, 'garbage is a clean 400, never a 500');
});

test('the hideout upgrade rejects inherited property names like "constructor" (own properties only)', () => {
  const db = openDb();
  const id = auth.register(db, { name: 'Builder', password: 'secret12', race: 'vampire' }, T0);
  db.prepare('UPDATE players SET gold = 1e9 WHERE id = ?').run(id);
  for (const bad of ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'valueOf', '', ['wall'], { wall: 1 }, 5, null, 'wall; DROP TABLE players']) {
    assert.equal(code(() => eco.upgradeHideout(db, id, bad as any, T0)), 'bad_component', JSON.stringify(bad));
  }
  assert.equal(code(() => eco.upgradeHideout(db, id, 'wall', T0)), 'none');
});

test('clan forum flooding is limited to 20 posts per hour per player', () => {
  const db = openDb();
  const id = auth.register(db, { name: 'Spammer', password: 'secret12', race: 'vampire' }, T0);
  db.prepare('UPDATE players SET level = 5 WHERE id = ?').run(id);
  clan.createClan(db, id, 'Spam Hall', T0);
  const t = forum.createThread(db, id, 'First', 'hello', T0).id; // post 1
  for (let i = 2; i <= CFG.forumPostsPerHour; i++) forum.reply(db, id, t, `post ${i}`, T0 + i);
  assert.equal(code(() => forum.reply(db, id, t, 'one too many', T0 + 100)), 'rate_limited');
  assert.equal(code(() => forum.createThread(db, id, 'Also blocked', 'x', T0 + 100)), 'rate_limited');
  assert.equal(code(() => forum.reply(db, id, t, 'an hour later', T0 + HOUR + 1000)), 'none');
});

// ---------------------------------------------------------------- what the browser is told
test('security headers: strict CSP (no inline or foreign scripts), no framing, no sniffing, API answers never cached', async () => {
  const app = createApp({ db: openDb(), now: () => T0, rng: seeded(6), security: { limits: false } });
  for (const path of ['/', '/api/catalog', '/app.js']) {
    const r = await app.request(path);
    const csp = r.headers.get('content-security-policy') ?? '';
    assert.match(csp, /default-src 'none'/, path);
    const script = /script-src ([^;]*)/.exec(csp)![1];
    assert.equal(script, "'self'", `${path}: scripts only from this site, got ${script}`);
    assert.doesNotMatch(script, /unsafe-inline|unsafe-eval|\*|https?:/);
    assert.match(csp, /frame-ancestors 'none'/); assert.match(csp, /object-src 'none'/); assert.match(csp, /base-uri 'none'/);
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff', path);
    assert.equal(r.headers.get('x-frame-options'), 'DENY', path);
    assert.equal(r.headers.get('referrer-policy'), 'no-referrer', path);
    assert.match(r.headers.get('strict-transport-security') ?? '', /max-age=\d{7,}/, path);
    assert.equal(r.headers.get('x-powered-by'), null);
  }
  assert.equal((await app.request('/api/catalog')).headers.get('cache-control'), 'no-store', 'personal API data must never be cached');
  assert.equal((await app.request('/api/catalog')).headers.get('cross-origin-resource-policy'), null, 'the API stays readable by allowed origins');
});

test('the frontend uses no inline scripts or event-handler attributes (which the CSP would block)', () => {
  const app = readFileSync('public/app.js', 'utf8'), html = readFileSync('public/index.html', 'utf8');
  const attr = /\son[a-z]+\s*=\s*["'`]/gi; // onclick="..." as an HTML attribute (not JS property assignment like el.onclick = fn)
  assert.deepEqual(app.match(attr) ?? [], [], 'app.js contains inline event-handler attributes');
  assert.deepEqual(html.match(attr) ?? [], []);
  assert.doesNotMatch(app, /javascript:/i);
  assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)[^>]*>/i, 'index.html has no inline <script> blocks');
  assert.doesNotMatch(app, /\beval\s*\(|new Function\s*\(/, 'no eval');
});

// ---------------------------------------------------------------- the network surface
test('by default the server only listens on the loopback interface (a proxy is the public face); HOST=0.0.0.0 opens it', async () => {
  const external = Object.values(networkInterfaces()).flat().find((i) => i && i.family === 'IPv4' && !i.internal)?.address;
  if (!external) return; // no non-loopback address on this machine: nothing to test
  const run = async (env: Record<string, string>) => {
    const port = 3800 + Math.floor(Math.random() * 300);
    const child = spawn('node', ['src/server.ts'], { env: { ...process.env, NODE_ENV: 'production', PORT: String(port), DB_PATH: ':memory:', BOTS: '0', BACKUP_EVERY_HOURS: '0', ...env }, stdio: ['ignore', 'pipe', 'ignore'] });
    let log = ''; child.stdout.on('data', (d) => (log += d));
    try {
      for (let i = 0; i < 100 && !/API on/.test(log); i++) await new Promise((r) => setTimeout(r, 100));
      const reach = async (host: string) => fetch(`http://${host}:${port}/api/catalog`, { signal: AbortSignal.timeout(2000) }).then((r) => r.ok, () => false);
      return { loopback: await reach('127.0.0.1'), external: await reach(external), log };
    } finally { child.kill('SIGKILL'); }
  };
  const secure = await run({});
  assert.equal(secure.loopback, true, secure.log); assert.equal(secure.external, false, 'not reachable on the network address by default');
  const open = await run({ HOST: '0.0.0.0' });
  assert.equal(open.loopback, true); assert.equal(open.external, true, 'reachable when explicitly opened');
});
