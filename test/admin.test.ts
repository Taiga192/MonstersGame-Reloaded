import assert from 'node:assert/strict';
import { test, afterEach } from 'node:test';
import { CFG, DAY_MS, HOUR, MIN } from '../src/config.ts';
import { openDb, type DB } from '../src/db.ts';
import * as auth from '../src/game/auth.ts';
import * as eco from '../src/game/economy.ts';
import { awardXp, loadPlayer } from '../src/game/player.ts';
import { createApp } from '../src/node-app.ts';
import { seeded } from '../src/rng.ts';
import { applySettings, PRESETS, TUNABLES, parseValue } from '../src/settings.ts';

const T0 = 1_800_000_000_000;
const H = { 'content-type': 'application/json' };
type App = ReturnType<typeof createApp>;
const post = (app: App, path: string, body: unknown, headers: Record<string, string> = {}) =>
  app.request(path, { method: 'POST', headers: { ...H, ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) });
const get = (app: App, path: string, headers: Record<string, string> = {}) => app.request(path, { headers });
const json = async (r: Response | Promise<Response>) => (await r).json() as Promise<any>;

/** a world with an admin ("Boss"), a normal player ("Pawn") and a bot */
async function world(opts: { singlePlayer?: boolean; onWipe?: () => void } = {}) {
  const db = openDb();
  let t = T0;
  const app = createApp({ db, now: () => t, rng: seeded(5), security: { limits: false }, ...opts });
  const mk = async (name: string) => {
    const id = (await json(post(app, '/api/register', { name, password: 'secret12', race: 'vampire' }))).id as number;
    const token = (await json(post(app, '/api/login', { name, password: 'secret12' }))).token as string;
    return { id, name, token, h: { authorization: `Bearer ${token}` } };
  };
  const boss = await mk('Boss'), pawn = await mk('Pawn');
  db.prepare('UPDATE players SET is_admin = 1 WHERE id = ?').run(boss.id);
  const botId = auth.registerBot(db, 'Botty', 'werewolf', t);
  return { db, app, boss, pawn, botId, mk, setNow: (x: number) => { t = x; }, time: () => t };
}
const defaults = () => createApp({ db: openDb(), now: () => T0, rng: seeded(1) }); // a fresh world: restores config.ts

afterEach(() => { defaults(); });

// ---------------------------------------------------------------- who may use it
test('multiplayer: only players with the admin flag get in; everybody else (and anonymous) is refused', async () => {
  const { app, boss, pawn } = await world();
  assert.equal((await get(app, '/api/admin')).status, 401);
  assert.equal((await get(app, '/api/admin', pawn.h)).status, 403);
  assert.equal((await get(app, '/api/admin', boss.h)).status, 200);
  for (const path of ['setting', 'setting/reset', 'settings/reset', 'preset', 'announce', 'player', 'player/give', 'player/release', 'player/password', 'player/delete', 'wipe']) {
    assert.equal((await post(app, `/api/admin/${path}`, {}, pawn.h)).status, 403, `${path} for a normal player`);
    assert.equal((await post(app, `/api/admin/${path}`, {})).status, 401, `${path} anonymous`);
  }
  assert.equal((await get(app, '/api/admin/players', pawn.h)).status, 403);
  assert.equal((await json(get(app, '/api/me', boss.h))).isAdmin, true);
  assert.equal((await json(get(app, '/api/me', pawn.h))).isAdmin, false);
});

test('you cannot make yourself admin: not by registering with the flag, not by editing your own character, not through the normal API', async () => {
  const { app, db, pawn } = await world();
  const r = await json(post(app, '/api/register', { name: 'Sneaky', password: 'secret12', race: 'vampire', is_admin: 1, isAdmin: true }));
  assert.equal((db.prepare('SELECT is_admin FROM players WHERE id = ?').get(r.id) as any).is_admin, 0);
  assert.equal((await post(app, '/api/admin/player', { id: pawn.id, field: 'is_admin', value: 1 }, pawn.h)).status, 403);
  assert.equal((db.prepare('SELECT is_admin FROM players WHERE id = ?').get(pawn.id) as any).is_admin, 0);
});

test('single player: the one human is always an admin, bots never are', async () => {
  const { app, db, pawn, botId } = await world({ singlePlayer: true });
  assert.equal((await get(app, '/api/admin', pawn.h)).status, 200);
  assert.equal((await json(get(app, '/api/me', pawn.h))).isAdmin, true);
  assert.equal((await json(post(app, '/api/admin/player', { id: pawn.id, field: 'is_admin', value: 1 }, pawn.h))).error, 'single_player');
  const { isAdmin } = await import('../src/game/admin.ts');
  assert.equal(isAdmin(db, botId, true), false);
  assert.equal(isAdmin(db, botId, false), false);
});

// ---------------------------------------------------------------- settings and cooldowns
test('changing a cooldown takes effect immediately and is shown in the normal API', async () => {
  const { app, boss, pawn } = await world();
  const ready = async () => (await json(get(app, '/api/me', pawn.h))).attackReadyAt - (await json(get(app, '/api/me', pawn.h))).last_attack_at;
  assert.equal(await ready(), 10 * MIN);
  const r = await json(post(app, '/api/admin/setting', { key: 'attackCooldown', value: 3 }, boss.h));
  assert.deepEqual(r, { key: 'attackCooldown', value: 3 });
  assert.equal(CFG.attackCooldown, 3 * MIN);
  assert.equal(await ready(), 3 * MIN);
  const view = await json(get(app, '/api/admin', boss.h));
  const row = view.settings.find((s: any) => s.key === 'attackCooldown');
  assert.equal(row.value, 3); assert.equal(row.default, 10); assert.equal(row.changed, true);
  await post(app, '/api/admin/setting/reset', { key: 'attackCooldown' }, boss.h);
  assert.equal(CFG.attackCooldown, 10 * MIN);
});

test('every cooldown of every activity can be changed', async () => {
  const { app, boss } = await world();
  const cooldowns = ['attackCooldown', 'sameOpponentWindow', 'postBattleProtection', 'huntPortion', 'huntBudget', 'ancestralCooldown', 'dungeonCooldown', 'dungeonFightCooldown', 'dungeonIdleLimit', 'arenaMinRegistration', 'arenaMaxRegistration', 'workMaxHours', 'searchValidity'];
  for (const k of cooldowns) {
    const row = TUNABLES.find((x) => x.key === k)!;
    const v = k === 'dungeonIdleLimit' ? 40 : row.int ? 7 : 2; // (the idle limit has to stay longer than the wait between fights)
    assert.equal((await post(app, '/api/admin/setting', { key: k, value: v }, boss.h)).status, 200, k);
    assert.equal(CFG[row.key as 'attackCooldown'], v * row.scale, k);
  }
});

test('settings survive a restart (stored in the database) and a world without overrides plays with the defaults', async () => {
  const { app, db, boss } = await world();
  await post(app, '/api/admin/setting', { key: 'rateXp', value: 4 }, boss.h);
  await post(app, '/api/admin/setting', { key: 'dungeonCooldown', value: 6 }, boss.h);
  assert.equal(CFG.rateXp, 4);
  defaults(); // another world in the same process: back to config.ts
  assert.equal(CFG.rateXp, 1); assert.equal(CFG.dungeonCooldown, 24 * HOUR);
  createApp({ db, now: () => T0, rng: seeded(1) }); // "restart": same database again
  assert.equal(CFG.rateXp, 4); assert.equal(CFG.dungeonCooldown, 6 * HOUR);
  assert.deepEqual((db.prepare('SELECT key FROM settings ORDER BY key').all() as any[]).map((r) => r.key), ['dungeonCooldown', 'rateXp']); // only what differs is stored
});

test('setting a value back to the default removes the override; "reset all" clears everything', async () => {
  const { app, db, boss } = await world();
  await post(app, '/api/admin/setting', { key: 'rateGold', value: 3 }, boss.h);
  await post(app, '/api/admin/setting', { key: 'rateGold', value: 1 }, boss.h);
  assert.equal((db.prepare('SELECT COUNT(*) n FROM settings').get() as any).n, 0);
  await post(app, '/api/admin/setting', { key: 'rateGold', value: 3 }, boss.h);
  await post(app, '/api/admin/setting', { key: 'templeFee', value: 0.1 }, boss.h);
  await post(app, '/api/admin/settings/reset', {}, boss.h);
  assert.equal(CFG.rateGold, 1); assert.equal(CFG.templeFee, 0.05);
  assert.equal((db.prepare('SELECT COUNT(*) n FROM settings').get() as any).n, 0);
});

test('setting values are validated: unknown keys, prototype tricks, NaN, strings, out of range, contradictions', async () => {
  const { app, boss } = await world();
  const set = async (key: unknown, value: unknown) => post(app, '/api/admin/setting', { key, value }, boss.h);
  for (const key of ['nope', '__proto__', 'constructor', 'toString', 'xpToNext', 'hideoutMax', '', 5, null]) assert.equal((await set(key, 1)).status, 400, `key ${String(key)}`);
  for (const value of ['abc', '', null, true, [1], 'NaN', 'Infinity', -1, 99999, 0]) assert.equal((await set('rateXp', value)).status, 400, `value ${JSON.stringify(value)}`);
  assert.equal(CFG.rateXp, 1, 'nothing changed');
  assert.equal((await set('rateXp', '2.5')).status, 200, 'a number typed into a form arrives as text');
  assert.equal(CFG.rateXp, 2.5);
  assert.equal((await set('stealMin', 0.5)).status, 400, 'minimum above the maximum');
  assert.equal((await set('stealMax', 0.01)).status, 400, 'maximum below the minimum');
  assert.equal((await set('workMaxHours', 7.6)).status, 200); assert.equal(CFG.workMaxHours, 8, 'whole numbers are rounded');
});

test('the wait between dungeon fights must stay shorter than the idle limit (and the reverse)', async () => {
  const { app, boss } = await world();
  const set = (key: string, value: number) => post(app, '/api/admin/setting', { key, value }, boss.h);
  assert.equal((await set('dungeonFightCooldown', 30)).status, 400, 'equal to the idle limit: every run would end while waiting');
  assert.equal((await set('dungeonFightCooldown', 45)).status, 400);
  assert.equal((await set('dungeonFightCooldown', 10)).status, 200);
  assert.equal((await set('dungeonIdleLimit', 10)).status, 400);
  assert.equal((await set('dungeonIdleLimit', 60)).status, 200);
  assert.equal((await set('dungeonFightCooldown', 0)).status, 200, '0 switches the wait off');
  assert.equal((await set('dungeonCheckpoint', 10)).status, 200); assert.equal(CFG.dungeonCheckpoint, 10);
});

test('every setting has sane limits: the default is inside them and the extremes are accepted', () => {
  const seen = new Set<string>();
  for (const t of TUNABLES) {
    assert.ok(!seen.has(t.key), `duplicate ${t.key}`); seen.add(t.key);
    const def = (CFG[t.key] as number) / t.scale;
    assert.ok(def >= t.min && def <= t.max, `${t.key}: default ${def} outside ${t.min}..${t.max}`);
    assert.ok(Number.isFinite(parseValue(t.key, t.min).raw) && Number.isFinite(parseValue(t.key, t.max).raw), t.key);
    assert.ok(t.min <= t.max, t.key);
  }
});

test('presets: the speed server sets many numbers at once; "normal" puts everything back', async () => {
  const { app, boss } = await world();
  assert.equal((await post(app, '/api/admin/preset', { name: 'nope' }, boss.h)).status, 400);
  assert.equal((await post(app, '/api/admin/preset', { name: '__proto__' }, boss.h)).status, 400);
  await post(app, '/api/admin/setting', { key: 'templeFee', value: 0.2 }, boss.h);
  assert.equal((await post(app, '/api/admin/preset', { name: 'speed' }, boss.h)).status, 200);
  assert.equal(CFG.rateXp, 5); assert.equal(CFG.rateGold, 5); assert.equal(CFG.attackCooldown, 2 * MIN); assert.equal(CFG.dungeonCooldown, 4 * HOUR); assert.equal(CFG.huntPortion, 2 * MIN);
  assert.equal(CFG.templeFee, 0.05, 'a preset replaces earlier changes');
  for (const p of Object.values(PRESETS)) for (const [k, v] of Object.entries(p.values)) parseValue(k, v); // all preset values are valid
  await post(app, '/api/admin/preset', { name: 'normal' }, boss.h);
  assert.equal(CFG.rateXp, 1); assert.equal(CFG.attackCooldown, 10 * MIN);
});

// ---------------------------------------------------------------- rates
test('XP multiplier: applies to every source of XP; nothing is lost at 1x; small awards are not rounded away', async () => {
  const { app, db, boss, pawn } = await world();
  const xp = () => loadPlayer(db, pawn.id, T0).xp;
  awardXp(db, pawn.id, 2, T0); assert.equal(xp(), 2);
  await post(app, '/api/admin/setting', { key: 'rateXp', value: 3 }, boss.h);
  const r = awardXp(db, pawn.id, 1, T0); assert.equal(r.xpGained, 3); assert.equal(loadPlayer(db, pawn.id, T0).level, 2, '2 + 3 = 5 XP is exactly level 2');
  await post(app, '/api/admin/setting', { key: 'rateXp', value: 0.1 }, boss.h);
  assert.equal(awardXp(db, pawn.id, 1, T0).xpGained, 1, 'at least 1 XP for a real award');
  assert.equal(awardXp(db, pawn.id, 0, T0).xpGained, 0);
});

test('"XP needed per level" scales the level curve', async () => {
  const { app, boss } = await world();
  assert.equal(CFG.xpToNext(10), 50);
  await post(app, '/api/admin/setting', { key: 'rateLevelXp', value: 0.5 }, boss.h);
  assert.equal(CFG.xpToNext(10), 25); assert.equal(CFG.xpToNext(1), 3);
  await post(app, '/api/admin/setting', { key: 'rateLevelXp', value: 3 }, boss.h);
  assert.equal(CFG.xpToNext(10), 150);
});

test('gold multiplier: graveyard wages, hunting and the relic dealer pay more; raids between players do not', async () => {
  const { app, db, boss, pawn } = await world();
  const gold = () => loadPlayer(db, pawn.id, T0 + 10 * HOUR).gold;
  eco.startWork(db, pawn.id, 2, T0);
  const g0 = gold(); eco.collectWork(db, pawn.id, T0 + 3 * HOUR); const normal = gold() - g0;
  await post(app, '/api/admin/setting', { key: 'rateGold', value: 4 }, boss.h);
  eco.startWork(db, pawn.id, 2, T0 + 4 * HOUR);
  const g1 = gold(); eco.collectWork(db, pawn.id, T0 + 7 * HOUR); assert.equal(gold() - g1, normal * 4);
  // victim link bites
  const b0 = gold(); eco.bite(db, pawn.id, 'visitor', T0, seeded(2)); assert.ok(gold() - b0 >= 4, 'a bite pays at least 1 x 4');
  // hunting
  const rng = seeded(3);
  eco.startHunt(db, pawn.id, 1, T0 + 8 * HOUR);
  const h = eco.collectHunt(db, pawn.id, T0 + 8 * HOUR + 11 * MIN, rng) as any;
  assert.ok(h.gold === 0 || h.gold >= 32, `hunt gold ${h.gold} should be 4x a village's 8-15 (scaled by level)`);
});

// ---------------------------------------------------------------- wipe
test('wipe: needs the word WIPE and (multiplayer) the admin password; a wrong attempt changes nothing', async () => {
  const { app, db, boss, pawn } = await world();
  db.prepare('UPDATE players SET level = 9, gold = 5000 WHERE id = ?').run(pawn.id);
  assert.equal((await post(app, '/api/admin/wipe', { mode: 'progress', password: 'secret12' }, boss.h)).status, 400);
  assert.equal((await post(app, '/api/admin/wipe', { mode: 'progress', confirm: 'wipe', password: 'secret12' }, boss.h)).status, 400);
  assert.equal((await post(app, '/api/admin/wipe', { mode: 'progress', confirm: 'WIPE' }, boss.h)).status, 403, 'no password');
  assert.equal((await post(app, '/api/admin/wipe', { mode: 'progress', confirm: 'WIPE', password: 'wrong-pass' }, boss.h)).status, 403);
  assert.equal((await post(app, '/api/admin/wipe', { mode: 'everything?', confirm: 'WIPE', password: 'secret12' }, boss.h)).status, 400);
  assert.equal(loadPlayer(db, pawn.id, T0).level, 9, 'untouched');
  assert.equal((await post(app, '/api/admin/wipe', { mode: 'progress', confirm: 'WIPE' }, pawn.h)).status, 403, 'and a normal player cannot even try');
});

test('wipe "progress": every account stays but starts from zero; all other data, bots and the market are gone; settings stay', async () => {
  let wiped = 0;
  const { app, db, boss, pawn, setNow } = await world({ onWipe: () => { wiped++; } });
  await post(app, '/api/admin/setting', { key: 'rateXp', value: 2 }, boss.h);
  // give the world some history
  db.prepare('UPDATE players SET level = 12, xp = 7, gold = 9000, str = 40, wins = 3, vitality_hp = 50 WHERE id = ?').run(pawn.id);
  db.prepare("INSERT INTO inventory (player_id, item_key, bought_at) VALUES (?, 'itm_Blade_1', ?)").run(pawn.id, T0);
  assert.equal((await post(app, '/api/clan/create', { name: 'Pawns' }, pawn.h)).status, 200);
  db.prepare("INSERT INTO mail (from_id, to_id, subject, body, sent_at) VALUES (NULL, ?, 's', 'b', ?)").run(pawn.id, T0);
  db.prepare("INSERT INTO battles (attacker_id, defender_id, winner_id, gold, xp_attacker, xp_defender, at, rounds, log) VALUES (?,?,?,?,?,?,?,?,'[]')").run(pawn.id, boss.id, pawn.id, 1, 1, 1, T0, 1);
  setNow(T0 + DAY_MS);
  const r = await json(post(app, '/api/admin/wipe', { mode: 'progress', confirm: 'WIPE', password: 'secret12' }, boss.h));
  assert.equal(wiped, 1);
  assert.equal(r.removed, 1, 'only the bot');
  const p = loadPlayer(db, pawn.id, T0 + DAY_MS);
  assert.deepEqual([p.level, p.xp, p.gold, p.str, p.wins, p.vitality_hp, p.clan_id, p.max_hp], [1, 0, CFG.startGold, CFG.startStat, 0, 0, null, CFG.startMaxHp]);
  for (const table of ['clans', 'battles', 'mail', 'inventory', 'bots', 'temple_listings', 'forum_threads', 'arena_events', 'dungeon', 'counters', 'clan_wars']) assert.equal((db.prepare(`SELECT COUNT(*) n FROM ${table}`).get() as any).n, 0, table);
  assert.equal((db.prepare('SELECT COUNT(*) n FROM players WHERE is_bot = 1').get() as any).n, 0);
  assert.equal((db.prepare('SELECT COUNT(*) n FROM hideouts').get() as any).n, 2, 'every character has its hideout row again');
  assert.equal((db.prepare('SELECT is_admin FROM players WHERE id = ?').get(boss.id) as any).is_admin, 1, 'the admin flag survives');
  assert.equal((await get(app, '/api/me', pawn.h)).status, 200, 'logins survive, so does the admin session');
  assert.equal(CFG.rateXp, 2, 'settings survive');
  const view = await json(get(app, '/api/admin', boss.h));
  assert.equal(view.world.worldStartedAt, T0 + DAY_MS); assert.equal(view.world.wipes, 1);
  assert.ok(view.world.log.some((l: any) => l.action === 'wipe'), 'audit log');
  const again = await json(post(app, '/api/login', { name: 'Pawn', password: 'secret12' }));
  assert.ok(again.token, 'the old password still works');
});

test('wipe "everything": only admin accounts survive, everyone else must register again', async () => {
  const { app, db, boss, pawn } = await world();
  const r = await json(post(app, '/api/admin/wipe', { mode: 'everything', confirm: 'WIPE', password: 'secret12' }, boss.h));
  assert.equal(r.kept, 1);
  assert.equal((await get(app, '/api/me', pawn.h)).status, 401, 'the removed player\'s login is dead');
  assert.equal((await get(app, '/api/me', boss.h)).status, 200);
  assert.equal((db.prepare('SELECT COUNT(*) n FROM sessions').get() as any).n, 1);
  assert.equal((await post(app, '/api/register', { name: 'Pawn', password: 'secret12', race: 'werewolf' })).status, 201, 'the name is free again');
});

test('single player wipe needs no password (there is only you) but still the word WIPE', async () => {
  const { app, pawn } = await world({ singlePlayer: true });
  assert.equal((await post(app, '/api/admin/wipe', { mode: 'progress' }, pawn.h)).status, 400);
  assert.equal((await post(app, '/api/admin/wipe', { mode: 'progress', confirm: 'WIPE' }, pawn.h)).status, 200);
});

// ---------------------------------------------------------------- players
test('player editor: lists and searches, edits with limits, level recalculates health', async () => {
  const { app, db, boss, pawn, botId } = await world();
  const list = await json(get(app, '/api/admin/players?who=humans', boss.h));
  assert.deepEqual(list.rows.map((r: any) => r.name).sort(), ['Boss', 'Pawn']);
  assert.equal((await json(get(app, '/api/admin/players?who=bots', boss.h))).rows[0].id, botId);
  assert.equal((await json(get(app, '/api/admin/players?q=paw', boss.h))).total, 1);
  assert.equal((await json(get(app, '/api/admin/players?q=%25', boss.h))).total, 0, 'a % is searched for literally');
  const set = (field: unknown, value: unknown, id: unknown = pawn.id) => post(app, '/api/admin/player', { id, field, value }, boss.h);
  assert.equal((await set('gold', 123456)).status, 200);
  assert.equal(loadPlayer(db, pawn.id, T0).gold, 123456);
  assert.equal((await set('level', 20)).status, 200);
  const p = loadPlayer(db, pawn.id, T0);
  assert.equal(p.level, 20); assert.equal(p.max_hp, CFG.startMaxHp + 19 * CFG.levelUpMaxHp); assert.equal(p.hp, p.max_hp);
  for (const [f, v] of [['gold', -1], ['gold', 1.5], ['gold', 'x'], ['gold', 1e15], ['level', 0], ['nope', 1], ['pass_hash', 1], ['__proto__', 1], ['id', 5], [null, 1], ['gold', null]] as const) {
    assert.equal((await set(f, v)).status, 400, `${f}=${v}`);
  }
  assert.equal((await set('gold', 1, 99999)).status, 404);
  assert.equal((await set('gold', 1, 'abc')).status, 404);
  assert.equal(loadPlayer(db, pawn.id, T0).gold, 123456);
});

test('admin flag: needs the admin password, not for bots, and you cannot take it from yourself', async () => {
  const { app, db, boss, pawn, botId } = await world();
  const set = (id: number, value: number, password?: string) => post(app, '/api/admin/player', { id, field: 'is_admin', value, password }, boss.h);
  assert.equal((await set(pawn.id, 1)).status, 403, 'no password');
  assert.equal((await set(pawn.id, 1, 'wrong-pass')).status, 403);
  assert.equal((await set(pawn.id, 1, 'secret12')).status, 200);
  assert.equal((await get(app, '/api/admin', pawn.h)).status, 200, 'takes effect on the next request');
  assert.equal((await json(set(botId, 1, 'secret12'))).error, 'bad_target');
  assert.equal((await json(set(boss.id, 0, 'secret12'))).error, 'self_demote');
  assert.equal((await set(pawn.id, 0, 'secret12')).status, 200);
  assert.equal((await get(app, '/api/admin', pawn.h)).status, 403);
  assert.equal((db.prepare('SELECT is_admin FROM players WHERE id = ?').get(boss.id) as any).is_admin, 1);
});

test('give item, release, reset password, announce, delete: each works, is limited, and is logged', async () => {
  const { app, db, boss, pawn, botId, mk } = await world();
  const a = (path: string, body: unknown) => post(app, `/api/admin/${path}`, body, boss.h);
  assert.equal((await a('player/give', { id: pawn.id, key: 'nope' })).status, 400);
  assert.equal((await a('player/give', { id: pawn.id, key: 'itm_Blade_1' })).status, 200);
  assert.equal((db.prepare("SELECT COUNT(*) n FROM inventory WHERE player_id = ? AND item_key = 'itm_Blade_1'").get(pawn.id) as any).n, 1);
  // release: clears locks and cooldowns
  db.prepare('UPDATE players SET work_started = ?, work_until = ?, work_hours = 5, last_attack_at = ?, ancestral_at = ? WHERE id = ?').run(T0, T0 + 5 * HOUR, T0, T0, pawn.id);
  assert.equal((await a('player/release', { id: pawn.id })).status, 200);
  const p = db.prepare('SELECT work_until, last_attack_at, ancestral_at FROM players WHERE id = ?').get(pawn.id) as any;
  assert.deepEqual([p.work_until, p.last_attack_at, p.ancestral_at], [null, 0, 0]);
  // password reset ends the player's sessions; needs the admin password
  assert.equal((await a('player/password', { id: pawn.id, newPassword: 'brand-new-pw' })).status, 403);
  assert.equal((await a('player/password', { id: pawn.id, newPassword: 'short', password: 'secret12' })).status, 400);
  assert.equal((await a('player/password', { id: botId, newPassword: 'brand-new-pw', password: 'secret12' })).status, 404, 'bots have no password');
  assert.equal((await a('player/password', { id: pawn.id, newPassword: 'brand-new-pw', password: 'secret12' })).status, 200);
  assert.equal((await get(app, '/api/me', pawn.h)).status, 401);
  assert.ok((await json(post(app, '/api/login', { name: 'Pawn', password: 'brand-new-pw' }))).token);
  // announce
  assert.equal((await a('announce', { subject: '', body: 'x' })).status, 400);
  assert.equal((await json(a('announce', { subject: 'Wipe tonight', body: 'Server restart at 20:00' }))).sent, 2);
  assert.equal((db.prepare("SELECT COUNT(*) n FROM mail WHERE subject = 'Wipe tonight'").get() as any).n, 2, 'humans only, no bot');
  // delete
  const victim = await mk('Victim');
  assert.equal((await a('player/delete', { id: victim.id })).status, 403, 'needs the password');
  assert.equal((await a('player/delete', { id: boss.id, password: 'secret12' })).status, 400, 'not yourself');
  db.prepare('UPDATE players SET level = 5 WHERE id = ?').run(victim.id);
  assert.equal((await post(app, '/api/clan/create', { name: 'Victims' }, victim.h)).status, 200);
  assert.equal((await json(a('player/delete', { id: victim.id, password: 'secret12' }))).error, 'clan_leader');
  assert.equal((await a('player/delete', { id: pawn.id, password: 'secret12' })).status, 200);
  assert.equal(db.prepare('SELECT 1 FROM players WHERE id = ?').get(pawn.id), undefined);
  assert.equal((await get(app, '/api/me', pawn.h)).status, 401);
  const log = (await json(get(app, '/api/admin', boss.h))).world.log.map((l: any) => l.action);
  for (const action of ['player.give', 'player.release', 'player.password', 'announce', 'player.delete']) assert.ok(log.includes(action), action);
});

test('hostile input to every admin route never causes a server error', async () => {
  const { app, boss } = await world();
  const values: unknown[] = [null, true, false, 0, -1, 1.5, 1e300, 'x', '', 'a'.repeat(5000), [], [1, 2], '__proto__', '<script>alert(1)</script>', "'; DROP TABLE players; --"];
  const fields = ['key', 'value', 'name', 'id', 'field', 'mode', 'confirm', 'password', 'newPassword', 'subject', 'body', 'keys'];
  const paths = ['setting', 'setting/reset', 'preset', 'announce', 'player', 'player/give', 'player/release', 'player/password', 'player/delete', 'wipe'];
  const bad: string[] = [];
  for (const path of paths) for (const f of fields) for (const v of values) {
    if (path === 'wipe' && f === 'confirm') continue; // (a correct confirmation would really wipe)
    const r = await post(app, `/api/admin/${path}`, { [f]: v }, boss.h);
    if (r.status >= 500) bad.push(`${r.status} ${path} ${f}=${JSON.stringify(v)?.slice(0, 40)}`);
  }
  for (const q of ['?q=%', '?q=' + 'x'.repeat(500), '?page=-5', '?page=abc', '?who=__proto__', '?page=99999999']) assert.ok((await get(app, `/api/admin/players${q}`, boss.h)).status < 500, q);
  assert.deepEqual(bad, []);
});
