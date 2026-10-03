import assert from 'node:assert/strict';
import { test, afterEach } from 'node:test';
import { CFG, DAY_MS, HOUR, MIN } from '../src/config.ts';
import { openDb, type DB } from '../src/db.ts';
import { GameError } from '../src/errors.ts';
import * as auth from '../src/game/auth.ts';
import { gatherBlood } from '../src/game/blood.ts';
import * as dungeon from '../src/game/dungeon.ts';
import * as eco from '../src/game/economy.ts';
import { equipmentLoadout, loadPlayer } from '../src/game/player.ts';
import * as temple from '../src/game/temple.ts';
import * as raid from '../src/game/raid.ts';
import * as shrine from '../src/game/shrine.ts';
import { createApp } from '../src/node-app.ts';
import { seeded } from '../src/rng.ts';
import { applySettings } from '../src/settings.ts';

const T0 = Date.UTC(2027, 0, 13, 6, 0, 0); // a Wednesday morning, UTC
const code = (fn: () => unknown) => { try { fn(); } catch (e) { return (e as GameError).code; } return 'none'; };
const one = (db: DB, sql: string, ...a: any[]) => db.prepare(sql).get(...a) as any;
const mk = (race: 'vampire' | 'werewolf' = 'vampire', name = 'Shrine') => {
  const db = openDb();
  const id = auth.register(db, { name, password: 'secret12', race }, T0);
  db.prepare('UPDATE players SET level = 12, gold = 10000, blood = 60, str = 30, def = 30, agi = 30, sta = 30, dex = 30, hp = 200, max_hp = 200, hp_at = ? WHERE id = ?').run(T0, id);
  return { db, id, rng: seeded(7) };
};
/** a character that owns a shrine with the given routine, running from T0 */
function running(steps: string[], opts: { blood?: number; rng?: ReturnType<typeof seeded> } = {}) {
  const w = mk(); const rng = opts.rng ?? w.rng;
  shrine.buyShrine(w.db, w.id, T0);
  if (opts.blood != null) w.db.prepare('UPDATE players SET blood = ? WHERE id = ?').run(opts.blood, w.id);
  shrine.setRoutine(w.db, w.id, steps, T0, rng);
  shrine.start(w.db, w.id, T0, rng);
  return { ...w, rng };
}
afterEach(() => { applySettings(openDb()); }); // back to config.ts

// ---------------------------------------------------------------- buying
test('the shrine unlocks at level 10, costs gold, and you can only own one', () => {
  const { db, id } = mk();
  db.prepare('UPDATE players SET level = 9 WHERE id = ?').run(id);
  assert.equal(code(() => shrine.buyShrine(db, id, T0)), 'level_too_low');
  db.prepare('UPDATE players SET level = 10, gold = 100 WHERE id = ?').run(id);
  assert.equal(code(() => shrine.buyShrine(db, id, T0)), 'no_gold');
  db.prepare('UPDATE players SET gold = 5000 WHERE id = ?').run(id);
  shrine.buyShrine(db, id, T0);
  assert.equal(loadPlayer(db, id, T0).gold, 5000 - CFG.shrinePrice);
  assert.equal(code(() => shrine.buyShrine(db, id, T0)), 'owned');
  assert.equal(shrine.shrineState(db, id, T0).status, 'off');
});

test('you cannot buy it while hunting (one thing at a time)', () => {
  const { db, id } = mk();
  eco.startHunt(db, id, 2, T0);
  assert.equal(code(() => shrine.buyShrine(db, id, T0)), 'hunting');
});

// ---------------------------------------------------------------- blood
test('animal blood is gathered by every manual activity: hunting, work, raids, dungeon fights', () => {
  const { db, id, rng } = mk();
  db.prepare('UPDATE players SET blood = 0 WHERE id = ?').run(id);
  const blood = () => one(db, 'SELECT blood b FROM players WHERE id = ?', id).b as number; // (not loadPlayer: that would move the regeneration clock into the future)
  eco.startHunt(db, id, 3, T0); eco.collectHunt(db, id, T0 + HOUR, rng);
  assert.equal(blood(), 3 * CFG.bloodPerHuntPortion);
  eco.startWork(db, id, 2, T0 + 2 * HOUR); eco.collectWork(db, id, T0 + 5 * HOUR);
  assert.equal(blood(), 3 + 2 * CFG.bloodPerWorkHour);
  eco.startWork(db, id, 5, T0 + 6 * HOUR); eco.cancelWork(db, id, T0 + 6 * HOUR + 150 * MIN); // 2.5 h worked: whole hours count
  assert.equal(blood(), 5 + 2 * CFG.bloodPerWorkHour);
  const before = blood();
  const enemy = auth.register(db, { name: 'Enemy', password: 'secret12', race: 'werewolf' }, T0);
  db.prepare('UPDATE players SET level = 12, hp = 200, max_hp = 200, hp_at = ? WHERE id = ?').run(T0 + 7 * HOUR, enemy);
  db.prepare('UPDATE players SET found_target = ?, found_at = ? WHERE id = ?').run(enemy, T0 + 7 * HOUR, id);
  raid.attack(db, id, enemy, T0 + 7 * HOUR, rng);
  assert.equal(blood(), before + CFG.bloodPerRaid);
  dungeon.enterDungeon(db, id, T0 + 8 * HOUR);
  const b2 = blood(); dungeon.fight(db, id, T0 + 8 * HOUR, rng);
  assert.equal(blood(), b2 + CFG.bloodPerDungeonFight);
});

test('the tank has a size: blood beyond it is lost', () => {
  const { db, id } = mk();
  gatherBlood(db, id, 'hunt', 1000);
  assert.equal(loadPlayer(db, id, T0).blood, CFG.shrineTank);
});

// ---------------------------------------------------------------- routine
test('a routine has 1-3 steps, written as hunt:portions or work:hours, within the same limits as by hand', () => {
  const { db, id, rng } = mk();
  assert.equal(code(() => shrine.setRoutine(db, id, ['hunt:6'], T0, rng)), 'no_shrine');
  shrine.buyShrine(db, id, T0);
  for (const bad of [[], ['hunt:6', 'work:2', 'hunt:1', 'work:1'], ['sing:3'], ['hunt:0'], ['hunt:19'], ['work:0'], ['work:49'], ['hunt'], ['hunt:6;drop'], [5], [null], 'hunt:6', { 0: 'hunt:6' }, ['hunt:-3'], ['hunt:1e3'], ['HUNT:6']]) {
    assert.notEqual(code(() => shrine.setRoutine(db, id, bad as any, T0, rng)), 'none', JSON.stringify(bad));
  }
  shrine.setRoutine(db, id, ['hunt:6', 'work:4'], T0, rng);
  assert.deepEqual(shrine.shrineState(db, id, T0).routine, ['hunt:6', 'work:4']);
  assert.equal(shrine.shrineState(db, id, T0).slots, 3);
});

test('starting needs a routine, blood for the first step and a free character', () => {
  const { db, id, rng } = mk();
  shrine.buyShrine(db, id, T0);
  assert.equal(code(() => shrine.start(db, id, T0, rng)), 'no_routine');
  shrine.setRoutine(db, id, ['work:10'], T0, rng);
  const need = 10 * CFG.shrineBloodPerHour; // 10 hours of fuel
  db.prepare('UPDATE players SET blood = ? WHERE id = ?').run(need - 1, id);
  assert.equal(code(() => shrine.start(db, id, T0, rng)), 'no_blood');
  db.prepare('UPDATE players SET blood = ? WHERE id = ?').run(need, id);
  eco.startHunt(db, id, 1, T0);
  assert.equal(code(() => shrine.start(db, id, T0, rng)), 'hunting');
  eco.cancelHunt(db, id, T0, rng);
  shrine.start(db, id, T0, rng);
  assert.equal(loadPlayer(db, id, T0).blood, 0, 'the fuel is taken when the step starts');
  assert.equal(code(() => shrine.start(db, id, T0, rng)), 'already_running');
});

// ---------------------------------------------------------------- running
test('a step pays when it finishes, not before; the shrine pays 60 % of a manual hunt and burns blood', () => {
  const { db, id, rng } = running(['hunt:6']); // one hour
  assert.equal(loadPlayer(db, id, T0).blood, 60 - CFG.shrineBloodPerHour, 'one hour costs the fuel of one hour');
  const g0 = loadPlayer(db, id, T0).gold;
  shrine.settle(db, id, T0 + 59 * MIN, rng);
  assert.equal(loadPlayer(db, id, T0).gold, g0, 'nothing before the hour is over');
  assert.equal(shrine.shrineState(db, id, T0 + 59 * MIN).current!.endsAt, T0 + HOUR);
  shrine.settle(db, id, T0 + HOUR, rng);
  assert.ok(loadPlayer(db, id, T0).gold > g0, 'paid');
  assert.equal(one(db, "SELECT value v FROM counters WHERE player_id = ? AND key = 'hunt_portions'", id).v > 0, true, 'counts for achievements');
  shrine.settle(db, id, T0 + HOUR, rng); // asking again changes nothing
  const again = loadPlayer(db, id, T0).gold;
  shrine.settle(db, id, T0 + HOUR, rng);
  assert.equal(loadPlayer(db, id, T0).gold, again);
  assert.equal(one(db, 'SELECT COUNT(*) n FROM players WHERE hunt_started IS NOT NULL').n, 0, 'automation never sets the busy flags');
});

test('automated pay is the efficiency times the manual pay (same dice)', () => {
  const pay = (eff: number) => {
    CFG.shrineMaxEfficiency = 1; CFG.shrineBaseEfficiency = eff; // (the cap is tested separately)
    const { db, id, rng } = running(['hunt:6'], { rng: seeded(99) });
    const before = loadPlayer(db, id, T0); shrine.settle(db, id, T0 + HOUR, rng);
    const after = loadPlayer(db, id, T0 + HOUR);
    return { gold: after.gold - before.gold, xp: after.xp + (after.level - before.level) * 1000 - before.xp };
  };
  const full = pay(1), part = pay(0.6);
  assert.ok(full.gold > 0);
  assert.ok(Math.abs(part.gold - Math.round(full.gold * 0.6)) <= 1, `gold ${part.gold} vs ${full.gold} * 0.6`);
});

test('work pays the wage times the efficiency', () => {
  const { db, id, rng } = running(['work:4']);
  const g0 = loadPlayer(db, id, T0).gold;
  shrine.settle(db, id, T0 + 4 * HOUR, rng);
  const wage = Math.floor(4 * CFG.workWagePerHour(12) * CFG.shrineBaseEfficiency);
  assert.equal(loadPlayer(db, id, T0).gold - g0, wage);
  assert.equal(one(db, "SELECT value v FROM counters WHERE player_id = ? AND key = 'work_hours'", id).v, 4);
});

test('coming back after days: the routine repeats until the blood is gone, the daily hunting cap holds, and it stops "starved"', () => {
  const { db, id, rng } = running(['hunt:18', 'work:6'], { blood: 27 * CFG.shrineBloodPerHour }); // 3 h hunt + 6 h work = 9 h per cycle: fuel for exactly three cycles
  shrine.settle(db, id, T0 + 5 * DAY_MS, rng);
  const s = shrine.shrineState(db, id, T0 + 5 * DAY_MS);
  assert.equal(s.status, 'starved');
  // the fourth cycle cannot be paid for: the shrine stops after three
  assert.equal(one(db, "SELECT value v FROM counters WHERE player_id = ? AND key = 'work_hours'", id).v, 18);
  assert.equal(one(db, "SELECT value v FROM counters WHERE player_id = ? AND key = 'hunt_portions'", id).v > 0, true);
  const hunted = one(db, "SELECT value v FROM counters WHERE player_id = ? AND key = 'hunt_portions'", id).v as number;
  assert.ok(hunted <= 4 * 18, `at most the hunting budget of the days it ran over: ${hunted}`);
  assert.ok(loadPlayer(db, id, T0).blood >= 0 && loadPlayer(db, id, T0).blood < 1e-6, 'no negative fuel: exactly empty');
  assert.equal(code(() => shrine.start(db, id, T0 + 5 * DAY_MS, rng)), 'no_blood', 'cannot restart without blood');
});

test('the daily hunting cap is shared with manual hunting', () => {
  const { db, id, rng } = running(['hunt:18'], { blood: 60 }); // the whole 3 h budget in one step, on day one
  shrine.settle(db, id, T0 + 4 * HOUR, rng);
  const used = loadPlayer(db, id, T0).hunt_used;
  assert.equal(used, 3 * HOUR, 'the whole day is used up');
  shrine.pause(db, id, T0 + 4 * HOUR, rng);
  assert.equal(code(() => eco.startHunt(db, id, 1, T0 + 4 * HOUR)), 'no_hunt_time', 'by hand there is nothing left today either');
});

// ---------------------------------------------------------------- pausing
test('pausing pays the finished part of the step pro rata and gives the unused blood back', () => {
  const cost = 2 * CFG.shrineBloodPerHour; // 2 h of fuel, charged at the start
  const { db, id, rng } = running(['hunt:12']);
  const blood0 = loadPlayer(db, id, T0).blood; // 56
  const g0 = loadPlayer(db, id, T0).gold;
  shrine.pause(db, id, T0 + 55 * MIN, rng); // 5 whole portions done
  assert.equal(shrine.shrineState(db, id, T0).status, 'paused');
  assert.ok(loadPlayer(db, id, T0).gold > g0, 'the 5 finished portions were paid');
  assert.equal(one(db, "SELECT value v FROM counters WHERE player_id = ? AND key = 'hunt_portions'", id).v <= 5, true);
  const refunded = loadPlayer(db, id, T0).blood - blood0;
  assert.ok(Math.abs(refunded - cost * (1 - 5 / 12)) < 1e-6, `refund ${refunded}`);
  assert.equal(loadPlayer(db, id, T0).hunt_used, 5 * CFG.huntPortion, 'only the portions that happened count against today');
  // resuming starts that step again from its beginning
  shrine.start(db, id, T0 + 2 * HOUR, rng);
  assert.equal(shrine.shrineState(db, id, T0 + 2 * HOUR).current!.step, 'hunt:12');
});

test('pausing a work step pays whole minutes', () => {
  const { db, id, rng } = running(['work:8']);
  const g0 = loadPlayer(db, id, T0).gold;
  shrine.pause(db, id, T0 + 90 * MIN + 30_000, rng); // 1 h 30 min and a bit
  assert.equal(loadPlayer(db, id, T0).gold - g0, Math.floor(1.5 * CFG.workWagePerHour(12) * CFG.shrineBaseEfficiency));
});

test('doing something by hand stops the shrine: one thing at a time', () => {
  const { db, id, rng } = running(['work:8']);
  // a hunt started by hand while the shrine is "running" (e.g. a client that skipped the API hook): settle notices and stops it
  eco.startHunt(db, id, 2, T0 + HOUR);
  shrine.settle(db, id, T0 + HOUR + MIN, rng);
  assert.equal(shrine.shrineState(db, id, T0).status, 'paused');
  assert.equal(code(() => shrine.start(db, id, T0 + HOUR + 5 * MIN, rng)), 'hunting', 'and it cannot start while you are busy');
});

// ---------------------------------------------------------------- raids
test('an automated player has no protection but loses at most 3 % of their gold; everybody else loses the normal 5-10 %', () => {
  const lost = (automated: boolean, seed: number) => {
    const w = mk('vampire', 'Victim');
    const foe = auth.register(w.db, { name: 'Raider', password: 'secret12', race: 'werewolf' }, T0);
    w.db.prepare('UPDATE players SET level = 12, str = 5000, def = 5000, agi = 5000, sta = 5000, dex = 5000, hp = 900, max_hp = 900, hp_at = ? WHERE id = ?').run(T0, foe);
    w.db.prepare('UPDATE players SET gold = 100000, str = 5, def = 5, agi = 5, sta = 5, dex = 5 WHERE id = ?').run(w.id);
    if (automated) { shrine.buyShrine(w.db, w.id, T0); w.db.prepare('UPDATE players SET gold = 100000 WHERE id = ?').run(w.id); shrine.setRoutine(w.db, w.id, ['work:8'], T0, w.rng); shrine.start(w.db, w.id, T0, w.rng); }
    const s = raid.searchOpponent(w.db, foe, T0 + MIN, seeded(seed), {});
    assert.equal(s.found, true, 'an automated player can be found (no busy flags)');
    const r = raid.attack(w.db, foe, w.id, T0 + MIN, seeded(seed));
    return r.gold;
  };
  for (let seed = 1; seed <= 5; seed++) {
    assert.ok(lost(true, seed) <= 3000 * 1.0 + 1, 'at most 3 %: ' + lost(true, seed));
    assert.ok(lost(false, seed) >= 5000, 'normal: at least 5 %');
  }
});

test('a paused or starved shrine is not "automated": no cap, like any player', () => {
  const { db, id, rng } = running(['work:4']);
  assert.equal(db.prepare("SELECT 1 FROM shrine WHERE player_id = ? AND status = 'running'").get(id) !== undefined, true);
  shrine.pause(db, id, T0 + MIN, rng);
  assert.equal(db.prepare("SELECT 1 FROM shrine WHERE player_id = ? AND status = 'running'").get(id), undefined);
});

// ---------------------------------------------------------------- API
const H = { 'content-type': 'application/json' };
async function api() {
  const db = openDb(); let t = T0;
  const app = createApp({ db, now: () => t, rng: seeded(5), security: { limits: false } });
  const post = (path: string, body: unknown, h: Record<string, string> = {}) => app.request(path, { method: 'POST', headers: { ...H, ...h }, body: JSON.stringify(body) });
  const reg = async (name: string) => {
    const id = (await (await post('/api/register', { name, password: 'secret12', race: 'vampire' })).json() as any).id as number;
    const token = (await (await post('/api/login', { name, password: 'secret12' })).json() as any).token as string;
    db.prepare('UPDATE players SET level = 12, gold = 10000, blood = 60, hp = 200, max_hp = 200, hp_at = ? WHERE id = ?').run(t, id);
    return { id, h: { authorization: `Bearer ${token}` } };
  };
  return { db, app, post, reg, advance: (ms: number) => { t += ms; }, now: () => t };
}

test('API: buy, set a routine, start, come back later: everything is paid when you ask for anything', async () => {
  const { app, post, reg, advance, db } = await api();
  const me = await reg('Idler');
  assert.equal((await app.request('/api/shrine')).status, 401);
  assert.equal((await post('/api/shrine/buy', {}, me.h)).status, 200);
  assert.equal((await post('/api/shrine/routine', { steps: ['hunt:6', 'work:4'] }, me.h)).status, 200);
  assert.equal((await post('/api/shrine/start', {}, me.h)).status, 200);
  let st = await (await app.request('/api/shrine', { headers: me.h })).json() as any;
  assert.equal(st.status, 'running'); assert.equal(st.current.step, 'hunt:6');
  const g0 = (db.prepare('SELECT gold g FROM players WHERE id = ?').get(me.id) as any).g;
  advance(2 * HOUR);
  const profile = await (await app.request('/api/me', { headers: me.h })).json() as any; // any request settles first
  assert.ok(profile.gold > g0, 'the hunt step was paid');
  assert.equal(profile.shrine, 'running'); assert.equal(profile.bloodMax, 60);
  advance(70 * HOUR);
  st = await (await app.request('/api/shrine', { headers: me.h })).json() as any;
  assert.equal(st.status, 'starved'); assert.ok(st.blood < 5);
});

test('API: starting a hunt, a raid search or a dungeon run by hand pauses the shrine first; shopping and mail do not', async () => {
  const { app, post, reg, db } = await api();
  const me = await reg('Hybrid');
  await post('/api/shrine/buy', {}, me.h); await post('/api/shrine/routine', { steps: ['work:8'] }, me.h); await post('/api/shrine/start', {}, me.h);
  const status = () => (db.prepare('SELECT status s FROM shrine WHERE player_id = ?').get(me.id) as any).s;
  assert.equal((await post('/api/store/buy', { key: 'potion_heal' }, me.h)).status, 200);
  assert.equal(status(), 'running', 'buying a potion does not stop it');
  assert.equal((await post('/api/mail/send', { to: 'Nobody', subject: 'x', body: 'y' }, me.h)).status < 500, true);
  assert.equal(status(), 'running');
  assert.equal((await post('/api/hunt/start', { portions: 1 }, me.h)).status, 200);
  assert.equal(status(), 'paused', 'hunting by hand stops the automation');
});

test('API: the routine endpoint survives hostile input', async () => {
  const { post, reg } = await api();
  const me = await reg('Fuzzy');
  await post('/api/shrine/buy', {}, me.h);
  for (const body of [{}, { steps: null }, { steps: 'x' }, { steps: [[1]] }, { steps: [{}] }, { steps: ['hunt:6', 7] }, { steps: Array(50).fill('hunt:1') }, { steps: ['hunt:9'.repeat(500)] }, { steps: ['__proto__:1'] }]) {
    const r = await post('/api/shrine/routine', body, me.h);
    assert.ok(r.status >= 400 && r.status < 500, `${JSON.stringify(body).slice(0, 50)} -> ${r.status}`);
  }
});

test('admin settings change the shrine: slots, efficiency, price', async () => {
  const { app, post, reg, db } = await api();
  const me = await reg('Boss'); db.prepare('UPDATE players SET is_admin = 1').run();
  await post('/api/admin/setting', { key: 'shrineSlots', value: 5 }, me.h);
  await post('/api/admin/setting', { key: 'shrinePrice', value: 99 }, me.h);
  await post('/api/admin/setting', { key: 'shrineBaseEfficiency', value: 0.7 }, me.h);
  const st0 = await (await app.request('/api/shrine', { headers: me.h })).json() as any;
  assert.equal(st0.slots, 5); assert.equal(st0.price, 99); assert.equal(st0.efficiency, 0.7);
});

// ---------------------------------------------------------------- parts (chalice, altar, idol)
const part = (db: DB, id: number, key: string) => Number(db.prepare('INSERT INTO inventory (player_id, item_key, bought_at) VALUES (?,?,?)').run(id, key, T0).lastInsertRowid);
const owned = (db: DB, id: number) => (db.prepare('SELECT item_key k FROM inventory WHERE player_id = ?').all(id) as { k: string }[]).map((r) => r.k).sort();

test('efficiency: 60 % to start, +2.5 % for every installed tier, never above 75 %', () => {
  const { db, id, rng } = mk(); shrine.buyShrine(db, id, T0);
  const eff = () => Math.round(shrine.shrineEfficiency(db, id) * 1000) / 1000;
  assert.equal(eff(), 0.6);
  for (const [k, e] of [['shrine_chalice_1', 0.625], ['shrine_altar_1', 0.65], ['shrine_idol_1', 0.675], ['shrine_chalice_2', 0.7], ['shrine_altar_2', 0.725], ['shrine_idol_2', 0.75]] as const) {
    shrine.installPart(db, id, part(db, id, k), T0, rng);
    assert.equal(eff(), e, k);
  }
  assert.equal(shrine.shrineState(db, id, T0).upgrades, 6);
  CFG.shrineBaseEfficiency = 0.9; // even a (mis)configured base cannot beat the cap
  assert.equal(eff(), 0.75);
});

test('parts do what they say: chalice = tank, altar = routine steps, idol II = more blood', () => {
  const { db, id, rng } = mk(); shrine.buyShrine(db, id, T0);
  assert.equal(shrine.shrineState(db, id, T0).tank, 60); assert.equal(shrine.shrineState(db, id, T0).slots, 3);
  shrine.installPart(db, id, part(db, id, 'shrine_chalice_1'), T0, rng); assert.equal(shrine.shrineState(db, id, T0).tank, 120);
  shrine.installPart(db, id, part(db, id, 'shrine_chalice_2'), T0, rng); assert.equal(shrine.shrineState(db, id, T0).tank, 180);
  shrine.installPart(db, id, part(db, id, 'shrine_altar_1'), T0, rng); assert.equal(shrine.shrineState(db, id, T0).slots, 4);
  shrine.installPart(db, id, part(db, id, 'shrine_altar_2'), T0, rng); assert.equal(shrine.shrineState(db, id, T0).slots, 5);
  shrine.setRoutine(db, id, ['hunt:1', 'work:1', 'hunt:1', 'work:1', 'hunt:1'], T0, rng);
  db.prepare('UPDATE players SET blood = 0 WHERE id = ?').run(id);
  gatherBlood(db, id, 'hunt', 10); assert.equal(loadPlayer(db, id, T0).blood, 10);
  shrine.installPart(db, id, part(db, id, 'shrine_idol_1'), T0, rng);
  db.prepare('UPDATE players SET blood = 0 WHERE id = ?').run(id);
  gatherBlood(db, id, 'hunt', 10); assert.equal(loadPlayer(db, id, T0).blood, 10, 'the first idol does not change blood');
  shrine.installPart(db, id, part(db, id, 'shrine_idol_2'), T0, rng);
  db.prepare('UPDATE players SET blood = 0 WHERE id = ?').run(id);
  gatherBlood(db, id, 'hunt', 10); assert.equal(loadPlayer(db, id, T0).blood, 15, 'the second idol: +50 %');
});

test('installing: better replaces worse (the old part returns to the bag), equal or worse is refused, foreign or non-parts are refused', () => {
  const { db, id, rng } = mk();
  assert.equal(code(() => shrine.installPart(db, id, 1, T0, rng)), 'no_shrine');
  shrine.buyShrine(db, id, T0);
  const sword = part(db, id, 'itm_Blade_1'), one1 = part(db, id, 'shrine_altar_1');
  assert.equal(code(() => shrine.installPart(db, id, sword, T0, rng)), 'not_a_part');
  for (const bad of [undefined, null, 'x', 1.5, -1, 99999, [1], {}]) assert.equal(code(() => shrine.installPart(db, id, bad, T0, rng)), 'not_a_part', String(bad));
  shrine.installPart(db, id, one1, T0, rng);
  assert.equal(code(() => shrine.installPart(db, id, part(db, id, 'shrine_altar_1'), T0, rng)), 'not_better');
  const two = part(db, id, 'shrine_altar_2');
  shrine.installPart(db, id, two, T0, rng);
  assert.deepEqual(owned(db, id), ['itm_Blade_1', 'shrine_altar_1', 'shrine_altar_1'].sort(), 'the tier 1 altar is back in the bag, the two installed ones are gone');
  // somebody else's part cannot be installed
  const other = auth.register(db, { name: 'Other', password: 'secret12', race: 'werewolf' }, T0);
  const theirs = part(db, other, 'shrine_idol_1');
  assert.equal(code(() => shrine.installPart(db, id, theirs, T0, rng)), 'not_a_part');
});

test('removing a part: it goes back to the bag, the tank shrinks (blood above it is lost), extra steps are cut', () => {
  const { db, id, rng } = mk(); shrine.buyShrine(db, id, T0);
  shrine.installPart(db, id, part(db, id, 'shrine_chalice_2'), T0, rng);
  shrine.installPart(db, id, part(db, id, 'shrine_altar_2'), T0, rng);
  shrine.setRoutine(db, id, ['hunt:1', 'work:1', 'hunt:1', 'work:1', 'hunt:1'], T0, rng);
  db.prepare('UPDATE players SET blood = 150 WHERE id = ?').run(id);
  shrine.removePart(db, id, 'chalice', T0, rng); shrine.removePart(db, id, 'altar', T0, rng);
  assert.equal(loadPlayer(db, id, T0).blood, 60);
  assert.equal(shrine.shrineState(db, id, T0).routine.length, 3);
  assert.deepEqual(owned(db, id), ['shrine_altar_2', 'shrine_chalice_2']);
  assert.equal(code(() => shrine.removePart(db, id, 'chalice', T0, rng)), 'not_installed');
  assert.equal(code(() => shrine.removePart(db, id, 'toString', T0, rng)), 'bad_part');
});

test('changing parts pauses a running shrine and pays the step in progress pro rata', () => {
  const { db, id, rng } = running(['work:6']);
  const g0 = loadPlayer(db, id, T0).gold;
  shrine.installPart(db, id, part(db, id, 'shrine_altar_1'), T0 + 2 * HOUR, rng);
  assert.equal(shrine.shrineState(db, id, T0).status, 'paused');
  assert.ok(loadPlayer(db, id, T0).gold > g0);
});

test('the shop sells tier 1 to everybody; tier 2 can only be found or traded', () => {
  const { db, id } = mk();
  eco.buyItem(db, id, 'shrine_idol_1', T0);
  assert.equal(code(() => eco.buyItem(db, id, 'shrine_idol_2', T0)), 'not_for_sale');
  assert.equal(code(() => eco.buyItem(db, id, 'shrine_chalice_2', T0)), 'not_for_sale');
  // ...but tier 2 can be listed in the Blood Temple and bought there
  const second = auth.register(db, { name: 'Buyer', password: 'secret12', race: 'vampire' }, T0);
  db.prepare('UPDATE players SET level = 12, gold = 20000 WHERE id = ?').run(second);
  temple.listItem(db, id, part(db, id, 'shrine_idol_2'), 5000, T0);
  const l = db.prepare("SELECT id FROM temple_listings WHERE status = 'open'").get() as { id: number };
  temple.buyListing(db, second, l.id, T0);
  assert.deepEqual(owned(db, second), ['shrine_idol_2']);
});

test('parts are not worn: they never count as equipment', () => {
  const { db, id } = mk();
  part(db, id, 'shrine_chalice_1'); part(db, id, 'shrine_altar_2');
  assert.deepEqual(equipmentLoadout(db, loadPlayer(db, id, T0)).equipped, []);
});

test('finding parts: large towns while hunting (2 %), dungeon guardians (30 %), always tier 2 and always in the bag', () => {
  const { db, id } = mk();
  const failChance = CFG.huntFailChance;
  CFG.componentDropLargeTown = 1; CFG.huntFailChance = () => 0; // every portion succeeds; only large towns drop
  const rng = seeded(11);
  const p = loadPlayer(db, id, T0);
  const r = eco.resolveHunt(db, p, 18, rng, T0);
  const towns = r.events.filter((e) => e.place === 'large_town').length;
  assert.ok(towns > 0, 'the seed hits at least one large town');
  assert.equal(r.found.length, towns);
  for (const k of owned(db, id)) assert.match(k, /^shrine_(chalice|altar|idol)_2$/);
  assert.equal(owned(db, id).length, towns);
  CFG.componentDropLargeTown = 0;
  const before = owned(db, id).length;
  eco.resolveHunt(db, p, 18, seeded(12), T0);
  assert.equal(owned(db, id).length, before, 'chance 0: nothing is found');
  CFG.huntFailChance = failChance;
});

test('guardians can drop a part', () => {
  const w = mk(); CFG.componentDropGuardian = 1;
  w.db.prepare('UPDATE players SET str = 100000, def = 100000, agi = 100000, sta = 100000, max_hp = 200, hp = 200 WHERE id = ?').run(w.id);
  const saved = CFG.dungeonFightCooldown; CFG.dungeonFightCooldown = 0;
  try {
    dungeon.enterDungeon(w.db, w.id, T0);
    let found: string | null = null;
    for (let i = 0; i < 10; i++) { const r = dungeon.fight(w.db, w.id, T0 + (i + 1) * 1000, w.rng); if (r.component) found = r.component; if (r.choice) dungeon.chooseReward(w.db, w.id, 0, T0 + (i + 1) * 1000 + 1); }
    assert.ok(found, 'the level 10 guardian dropped a part');
    assert.equal(owned(w.db, w.id).filter((k) => k.startsWith('shrine_')).length, 1);
  } finally { CFG.dungeonFightCooldown = saved; }
});

// ---------------------------------------------------------------- automated dungeon runs
function delver(steps: string[], opts: { strong?: boolean } = {}) {
  const w = mk(); const rng = w.rng;
  w.db.prepare('UPDATE players SET str = ?, def = ?, agi = ?, sta = ?, max_hp = 200, hp = 200 WHERE id = ?').run(...Array(4).fill(opts.strong === false ? 1 : 100000), w.id);
  shrine.buyShrine(w.db, w.id, T0);
  shrine.installPart(w.db, w.id, part(w.db, w.id, 'shrine_idol_1'), T0, rng);
  shrine.setRoutine(w.db, w.id, steps, T0, rng);
  shrine.start(w.db, w.id, T0, rng);
  return { ...w, rng };
}
const dg = (db: DB, id: number) => db.prepare('SELECT * FROM dungeon WHERE player_id = ?').get(id) as any;

test('dungeon steps need the Idol of the Hunt; removing the idol drops them from the routine', () => {
  const { db, id, rng } = mk(); shrine.buyShrine(db, id, T0);
  assert.equal(code(() => shrine.setRoutine(db, id, ['dungeon:10'], T0, rng)), 'needs_idol');
  assert.equal(shrine.shrineState(db, id, T0).dungeonUnlocked, false);
  shrine.installPart(db, id, part(db, id, 'shrine_idol_1'), T0, rng);
  assert.equal(shrine.shrineState(db, id, T0).dungeonUnlocked, true);
  shrine.setRoutine(db, id, ['dungeon:10', 'work:2'], T0, rng);
  for (const bad of ['dungeon:0', 'dungeon:101', 'dungeon:x', 'dungeon:']) assert.notEqual(code(() => shrine.setRoutine(db, id, [bad], T0, rng)), 'none', bad);
  shrine.removePart(db, id, 'idol', T0, rng);
  assert.deepEqual(shrine.shrineState(db, id, T0).routine, ['work:2']);
  shrine.setRoutine(db, id, ['work:2'], T0, rng);
  shrine.installPart(db, id, part(db, id, 'shrine_idol_1'), T0, rng);
  shrine.setRoutine(db, id, ['dungeon:5'], T0, rng);
  shrine.removePart(db, id, 'idol', T0, rng);
  assert.deepEqual(shrine.shrineState(db, id, T0).routine, []);
  assert.equal(shrine.shrineState(db, id, T0).status, 'off', 'nothing left to run');
});

test('an automated run plays the whole run when its time has passed: levels, XP and loot at the shrine efficiency, then the daily cooldown', () => {
  CFG.dungeonFightCooldown = 2 * MIN;
  const { db, id, rng } = delver(['dungeon:10']);
  const d0 = dg(db, id); assert.equal(d0, undefined, 'nothing happens before the time is up');
  shrine.settle(db, id, T0 + 19 * MIN, rng);
  assert.equal(dg(db, id), undefined, 'still on its way');
  const xp0 = loadPlayer(db, id, T0).xp + loadPlayer(db, id, T0).level * 1000;
  shrine.settle(db, id, T0 + 20 * MIN, rng);
  const d = dg(db, id);
  assert.equal(d.depth, 11); assert.equal(d.kills, 10); assert.equal(d.runs, 1); assert.equal(d.active, 0);
  assert.equal(d.best_ever, 10);
  assert.ok(d.cooldown_until >= T0 + 20 * MIN + CFG.dungeonCooldown - 1, 'once a day, exactly like by hand');
  assert.equal(code(() => dungeon.enterDungeon(db, id, T0 + 21 * MIN)), 'cooldown');
  assert.ok(loadPlayer(db, id, T0 + 20 * MIN).xp + loadPlayer(db, id, T0).level * 1000 > xp0, 'XP was paid');
  assert.ok(one(db, 'SELECT COUNT(*) n FROM dungeon_loot WHERE player_id = ?', id).n >= 1, 'the level 10 guardian reward was taken automatically');
  assert.equal(one(db, "SELECT value v FROM counters WHERE player_id = ? AND key = 'dungeon_levels'", id).v, 10, 'counts for achievements');
  assert.equal(one(db, 'SELECT COUNT(*) n FROM players WHERE dungeon_until IS NOT NULL').n, 0, 'never "inside": automation sets no busy flags');
});

test('automated dungeon rewards are the efficiency share of the manual ones', () => {
  CFG.dungeonFightCooldown = 2 * MIN;
  const xpFor = (eff: number) => {
    CFG.shrineMaxEfficiency = 1; CFG.shrineBaseEfficiency = eff;
    const { db, id, rng } = delver(['dungeon:6']);
    shrine.settle(db, id, T0 + 12 * MIN, rng);
    return dg(db, id).xp_week as number;
  };
  const full = xpFor(1), part6 = xpFor(0.6);
  assert.ok(full > 0 && Math.abs(part6 - full * 0.6) <= 6, `${part6} vs ${full} * 0.6`);
});

test('dungeon runs are all or nothing: pausing before the end cancels the run and gives all the blood back', () => {
  CFG.dungeonFightCooldown = 2 * MIN;
  const { db, id, rng } = delver(['dungeon:10']);
  const blood = loadPlayer(db, id, T0).blood;
  shrine.pause(db, id, T0 + 15 * MIN, rng);
  assert.equal(dg(db, id), undefined, 'no run happened, so today\'s run is not used up');
  assert.ok(Math.abs(loadPlayer(db, id, T0).blood - (blood + 20 / 60 * CFG.shrineBloodPerHour)) < 1e-6, 'all blood back');
  assert.equal(dungeon.enterDungeon(db, id, T0 + 16 * MIN).depth, 1, 'and you can still go by hand');
});

test('a weak character dies early; the run still counts for the day', () => {
  CFG.dungeonFightCooldown = 2 * MIN;
  const { db, id, rng } = delver(['dungeon:20'], { strong: false });
  shrine.settle(db, id, T0 + 40 * MIN, rng);
  const d = dg(db, id);
  assert.equal(d.deaths, 1); assert.equal(d.runs, 1); assert.equal(d.depth, 1, 'died on level 1: the level is still to be beaten');
  assert.ok(d.cooldown_until > T0 + CFG.dungeonCooldown - HOUR);
});

test('once a day: a routine that comes back to the dungeon step within 24 hours does not run it again', () => {
  CFG.dungeonFightCooldown = 2 * MIN;
  const { db, id, rng } = delver(['dungeon:5', 'work:1'], { strong: true });
  db.prepare('UPDATE players SET blood = 60 WHERE id = ?').run(id);
  shrine.settle(db, id, T0 + 20 * HOUR, rng); // many cycles of (10 min dungeon + 1 h work)
  assert.equal(dg(db, id).runs, 1, 'one run in 20 hours');
  shrine.pause(db, id, T0 + 20 * HOUR, rng);
  CFG.shrineTank = 200; db.prepare('UPDATE players SET blood = 100 WHERE id = ?').run(id);
  shrine.start(db, id, T0 + 20 * HOUR, rng);
  shrine.settle(db, id, T0 + 60 * HOUR, rng);
  assert.ok(dg(db, id).runs >= 2 && dg(db, id).runs <= 3, `a new run after the day is over: ${dg(db, id).runs}`);
});

test('checkpoints are reached by automated runs too', () => {
  CFG.dungeonFightCooldown = 2 * MIN;
  const { db, id, rng } = delver(['dungeon:30']);
  db.prepare("INSERT OR REPLACE INTO dungeon (player_id, week, reached_at, depth) VALUES (?, ?, ?, 20)").run(id, dungeon.weekOf(T0), T0);
  shrine.settle(db, id, T0 + 60 * MIN, rng);
  const d = dg(db, id);
  assert.equal(d.depth, 50); assert.equal(d.checkpoint, 50, 'standing on level 50 saves it (25 passed on the way)');
});

test('a run by hand blocks the automated one (it is simply skipped)', () => {
  CFG.dungeonFightCooldown = 2 * MIN;
  const { db, id, rng } = delver(['dungeon:5']);
  shrine.pause(db, id, T0 + MIN, rng);
  dungeon.enterDungeon(db, id, T0 + 2 * MIN);
  assert.equal(code(() => shrine.start(db, id, T0 + 3 * MIN, rng)), 'in_dungeon');
  assert.equal(dg(db, id).runs, 1, 'only the manual run');
});
