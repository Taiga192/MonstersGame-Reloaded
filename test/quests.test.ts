import assert from 'node:assert/strict';
import { test, afterEach } from 'node:test';
import { CFG, DAY_MS } from '../src/config.ts';
import { openDb, type DB } from '../src/db.ts';
import { GameError } from '../src/errors.ts';
import * as auth from '../src/game/auth.ts';
import { bump } from '../src/game/counters.ts';
import { loadPlayer } from '../src/game/player.ts';
import * as quests from '../src/game/quests.ts';
import { createApp } from '../src/node-app.ts';
import { FAMILIES, QUESTS, TIERS, rewardsFor, targetFor, weeklySet } from '../src/quests.ts';
import { seeded } from '../src/rng.ts';
import { applySettings } from '../src/settings.ts';

const T0 = Date.UTC(2027, 0, 13, 12, 0, 0); // a Wednesday
const MONDAY = Date.UTC(2027, 0, 18, 0, 5, 0);
const code = (fn: () => unknown) => { try { fn(); } catch (e) { return (e as GameError).code; } return 'none'; };
const one = (db: DB, sql: string, ...a: any[]) => db.prepare(sql).get(...a) as any;
const mk = (level = 30, name = 'Quester') => {
  const db = openDb();
  const id = auth.register(db, { name, password: 'secret12', race: 'vampire' }, T0);
  db.prepare('UPDATE players SET level = ?, gold = 1000, hp = 300, max_hp = 300, hp_at = ? WHERE id = ?').run(level, T0, id);
  return { db, id };
};
afterEach(() => { applySettings(openDb()); });

// ---------------------------------------------------------------- the pool and the draw
test('the pool has 100+ quests: 35 families x 3 difficulties, unique, sensible targets that grow with the difficulty', () => {
  assert.ok(QUESTS.length >= 100, String(QUESTS.length));
  assert.equal(new Set(QUESTS.map((q) => q.id)).size, QUESTS.length);
  assert.equal(new Set(QUESTS.map((q) => q.title)).size, QUESTS.length, 'every quest has its own name');
  for (const fam of FAMILIES) {
    const qs = QUESTS.filter((q) => q.family === fam.key);
    assert.deepEqual(qs.map((q) => q.tier), TIERS);
    for (const level of [1, 10, 50, 100, 200]) {
      const t = qs.map((q) => targetFor(q, level));
      assert.ok(t.every((n) => Number.isInteger(n) && n >= 1), `${fam.key} L${level}: ${t}`);
      assert.ok(t[0] <= t[1] && t[1] <= t[2] && t[0] < t[2], `${fam.key} L${level} does not grow: ${t}`);
    }
    assert.ok(fam.text(5).length > 8);
  }
  assert.ok(QUESTS.every((q) => ['blood', 'potions', 'loot'].includes(q.special)));
});

test('each week: 10 different things, 4 easy / 4 normal / 2 hard, at least 6 a new character can do, few that depend on luck', () => {
  for (let week = 2900; week < 3100; week++) {
    const set = weeklySet(week, 12345);
    assert.equal(set.length, 10);
    assert.equal(new Set(set.map((q) => q.family)).size, 10, 'never two quests about the same thing');
    assert.deepEqual(TIERS.map((t) => set.filter((q) => q.tier === t).length), [4, 4, 2]);
    assert.ok(set.filter((q) => q.minLevel <= 3 && !q.conditional).length >= 6, `week ${week}: open to a beginner`);
    assert.ok(set.filter((q) => q.conditional).length <= 3, 'conditional');
    const cats = new Map<string, number>(); for (const q of set) cats.set(q.category, (cats.get(q.category) ?? 0) + 1);
    assert.ok(Math.max(...cats.values()) <= 3, 'category spread');
  }
});

test('the draw is the same for the same week and seed, different every week, and over time every quest family gets its turn', () => {
  const ids = (w: number, s = 1) => weeklySet(w, s).map((q) => q.id).join();
  assert.equal(ids(3000), ids(3000));
  assert.notEqual(ids(3000), ids(3001)); assert.notEqual(ids(3000, 1), ids(3000, 2), 'another world, another draw');
  let same = 0, overlap = 0;
  for (let w = 3000; w < 3100; w++) { if (ids(w) === ids(w + 1)) same++; overlap += weeklySet(w, 1).filter((q) => weeklySet(w + 1, 1).some((x) => x.id === q.id)).length; }
  assert.equal(same, 0); assert.ok(overlap / 100 < 3, `consecutive weeks share ${overlap / 100} quests on average`);
  const seen = new Set<string>(); for (let w = 3000; w < 3200; w++) for (const q of weeklySet(w, 1)) seen.add(q.family);
  assert.equal(seen.size, FAMILIES.length, 'every family appears');
  assert.equal(weeklySet(3000, 1, 6).length, 6, 'the count is a setting'); assert.equal(weeklySet(3000, 1, 20).length, 20);
});

test('rewards grow with the level and the difficulty, and the three options are really three', () => {
  const q = (tier: string) => QUESTS.find((x) => x.family === 'raids_won' && x.tier === tier)!;
  const r = (tier: string, level: number) => rewardsFor(q(tier), level, CFG.xpToNext(level));
  assert.ok(r('easy', 10).gold < r('normal', 10).gold && r('normal', 10).gold < r('hard', 10).gold);
  assert.ok(r('normal', 10).gold < r('normal', 50).gold && r('normal', 50).gold < r('normal', 100).gold);
  assert.ok(r('normal', 10).xp < r('normal', 50).xp && r('normal', 50).xp < r('normal', 100).xp);
  assert.equal(r('normal', 50).gold, 4 * 50 + 20); assert.equal(r('normal', 50).xp, Math.round(CFG.xpToNext(50) * 0.06));
  assert.equal(r('easy', 1).xp, 1, 'never zero');
  assert.equal(rewardsFor(QUESTS.find((x) => x.family === 'hunt_portions' && x.tier === 'hard')!, 20, 100).special.kind, 'blood');
  assert.equal(r('hard', 20).special.kind, 'potions');
  const loot = rewardsFor(QUESTS.find((x) => x.family === 'dungeon_levels' && x.tier === 'normal')!, 20, 100);
  assert.equal(loot.special.kind, 'loot'); assert.equal(loot.special.amount, Math.round(loot.gold * 1.4));
  CFG.questRewardScale = 2; assert.equal(r('normal', 50).gold, 2 * (4 * 50 + 20));
});

// ---------------------------------------------------------------- progress and claiming
const firstOf = (db: DB, id: number, pick: (q: quests.QuestView) => boolean = () => true) => quests.questState(db, id, T0).quests.find((q) => !q.locked && pick(q))!;
const finish = (db: DB, id: number, q: quests.QuestView) => bump(db, id, QUESTS.find((x) => x.id === q.id)!.counter, q.target);

test('progress counts from the start of the week, not from before; it is capped at the target', () => {
  const { db, id } = mk();
  const q0 = firstOf(db, id); const counter = QUESTS.find((x) => x.id === q0.id)!.counter;
  assert.equal(q0.progress, 0); assert.equal(q0.done, false);
  bump(db, id, counter, 1);
  assert.equal(quests.questState(db, id, T0).quests.find((q) => q.id === q0.id)!.progress, 1);
  bump(db, id, counter, 10_000_000);
  const done = quests.questState(db, id, T0).quests.find((q) => q.id === q0.id)!;
  assert.equal(done.progress, done.target); assert.equal(done.done, true);
  // what a character did BEFORE the week started does not count
  const w = mk(30, 'Early'); bump(w.db, w.id, 'hunt_portions', 500); bump(w.db, w.id, 'raids_won', 500);
  quests.ensureWeek(w.db, T0); // the snapshot is taken now, after the old progress
  for (const q of quests.questState(w.db, w.id, T0).quests) assert.equal(q.progress, 0, q.id);
});

test('a new week resets everything, unclaimed rewards are gone, humans are told (bots and the very first week are not)', () => {
  const { db, id } = mk();
  const bot = auth.registerBot(db, 'Botty', 'werewolf', T0);
  const q = firstOf(db, id); finish(db, id, q);
  assert.equal(one(db, "SELECT COUNT(*) n FROM notifications WHERE kind = 'quests'").n, 0, 'no notification for the first week of a world');
  quests.claim(db, id, q.id, 'gold', T0); // claimed in week 1
  const week1 = quests.questState(db, id, T0);
  const next = quests.questState(db, id, MONDAY);
  assert.equal(next.week, week1.week + 1);
  assert.ok(next.quests.every((x) => x.progress === 0 && !x.claimed && !x.done), 'a clean slate');
  assert.notDeepEqual(next.quests.map((x) => x.id), week1.quests.map((x) => x.id));
  assert.equal(one(db, "SELECT COUNT(*) n FROM notifications WHERE kind = 'quests' AND player_id = ?", id).n, 1);
  assert.equal(one(db, "SELECT COUNT(*) n FROM notifications WHERE player_id = ?", bot).n, 0);
  assert.equal(one(db, 'SELECT COUNT(*) n FROM quest_state').n, 10, 'only this week is kept');
  // counters earned after Monday count in the new week
  const q2 = next.quests.find((x) => !x.locked)!; bump(db, id, QUESTS.find((x) => x.id === q2.id)!.counter, 1);
  assert.equal(quests.questState(db, id, MONDAY).quests.find((x) => x.id === q2.id)!.progress, 1);
});

test('the targets a character gets depend on its level when it first looks at the week, and stay fixed for that week', () => {
  const a = mk(5, 'Low'), b = mk(80, 'High');
  const ta = quests.questState(a.db, a.id, T0).quests, tb = quests.questState(b.db, b.id, T0).quests;
  assert.deepEqual(ta.map((q) => q.id), tb.map((q) => q.id), 'the same quests for everybody');
  const scaled = ['hunt_gold', 'work_gold', 'gold_stolen', 'dungeon_gold', 'clan_donated', 'gold_earned', 'xp_gained'];
  for (const q of ta) if (scaled.includes(q.id.split('.')[0])) assert.ok(tb.find((x) => x.id === q.id)!.target > q.target, `${q.id} should be bigger for a high level`);
  a.db.prepare('UPDATE players SET level = 90 WHERE id = ?').run(a.id);
  assert.deepEqual(quests.questState(a.db, a.id, T0).quests.map((q) => q.target), ta.map((q) => q.target), 'fixed for the week');
});

test('claiming: only finished, unlocked, unclaimed quests; the three rewards do what they say', () => {
  const { db, id } = mk(30);
  const get = () => quests.questState(db, id, T0).quests;
  const q = get()[0];
  assert.equal(code(() => quests.claim(db, id, q.id, 'gold', T0)), 'not_done');
  assert.equal(code(() => quests.claim(db, id, 'nope', 'gold', T0)), 'bad_quest');
  assert.equal(code(() => quests.claim(db, id, '__proto__', 'gold', T0)), 'bad_quest');
  assert.equal(code(() => quests.claim(db, id, q.id, 'diamonds', T0)), 'bad_choice');
  assert.equal(code(() => quests.claim(db, id, QUESTS.find((x) => !get().some((y) => y.id === x.id))!.id, 'gold', T0)), 'not_this_week');
  finish(db, id, q);
  const gold0 = loadPlayer(db, id, T0).gold;
  const r = quests.claim(db, id, q.id, 'gold', T0);
  assert.equal(loadPlayer(db, id, T0).gold, gold0 + q.rewards.gold); assert.match(r.text, /gold/);
  assert.equal(code(() => quests.claim(db, id, q.id, 'xp', T0)), 'claimed', 'one reward per quest');
  assert.equal(get().find((x) => x.id === q.id)!.claimed, 'gold');
  // XP
  const q2 = get().find((x) => !x.claimed && !x.locked)!; finish(db, id, q2);
  const xp0 = loadPlayer(db, id, T0).xp; quests.claim(db, id, q2.id, 'xp', T0);
  assert.ok(loadPlayer(db, id, T0).xp > xp0 || loadPlayer(db, id, T0).level > 30);
  // each special kind
  const kinds = new Map<string, quests.QuestView>();
  for (const x of get()) { const k = QUESTS.find((y) => y.id === x.id)!.special; if (!x.claimed && !x.locked && !kinds.has(k)) kinds.set(k, x); }
  for (const [kind, x] of kinds) {
    finish(db, id, x);
    const inv0 = one(db, 'SELECT COUNT(*) n FROM inventory WHERE player_id = ?', id).n, loot0 = one(db, 'SELECT COUNT(*) n FROM dungeon_loot WHERE player_id = ?', id).n;
    db.prepare('UPDATE players SET blood = 0 WHERE id = ?').run(id);
    quests.claim(db, id, x.id, 'special', T0);
    if (kind === 'blood') assert.equal(one(db, 'SELECT blood b FROM players WHERE id = ?', id).b, Math.min(CFG.shrineTank, x.rewards.special.amount));
    if (kind === 'potions') assert.equal(one(db, 'SELECT COUNT(*) n FROM inventory WHERE player_id = ? AND item_key = ?', id, 'potion_heal').n, x.rewards.special.amount + 0 * inv0);
    if (kind === 'loot') assert.equal(one(db, 'SELECT value v FROM dungeon_loot WHERE player_id = ? ORDER BY id DESC LIMIT 1', id).v, x.rewards.special.amount, String(loot0));
  }
});

test('locked quests (level too low) can be seen and planned but not claimed', () => {
  const { db, id } = mk(1, 'Newbie');
  // find a week that offers a quest this level cannot do yet
  let found: quests.QuestView | undefined; let when = T0;
  for (let w = 0; w < 80 && !found; w++) { when = T0 + w * 7 * DAY_MS; found = quests.questState(db, id, when).quests.find((q) => q.locked); }
  assert.ok(found, 'some week has a gated quest');
  bump(db, id, QUESTS.find((x) => x.id === found!.id)!.counter, 100000);
  assert.equal(code(() => quests.claim(db, id, found!.id, 'gold', when)), 'locked');
});

test('a character level-up from an XP reward is applied (and counted in the same way as any other XP)', () => {
  const { db, id } = mk(1, 'Climber');
  const q = quests.questState(db, id, T0).quests.find((x) => !x.locked)!; finish(db, id, q);
  db.prepare('UPDATE players SET xp = ? WHERE id = ?').run(CFG.xpToNext(1) - 1, id);
  const r = quests.claim(db, id, q.id, 'xp', T0);
  assert.equal(loadPlayer(db, id, T0).level, 2); assert.match(r.text, /level up/);
});

// ---------------------------------------------------------------- the API
const H = { 'content-type': 'application/json' };
async function api() {
  const db = openDb(); let t = T0;
  const app = createApp({ db, now: () => t, rng: seeded(5), security: { limits: false } });
  const post = (path: string, body: unknown, h: Record<string, string> = {}) => app.request(path, { method: 'POST', headers: { ...H, ...h }, body: JSON.stringify(body) });
  const id = ((await (await post('/api/register', { name: 'Apier', password: 'secret12', race: 'vampire' })).json()) as any).id as number;
  const token = ((await (await post('/api/login', { name: 'Apier', password: 'secret12' })).json()) as any).token as string;
  db.prepare('UPDATE players SET level = 20 WHERE id = ?').run(id);
  return { db, app, post, id, h: { authorization: `Bearer ${token}` }, advance: (ms: number) => { t += ms; } };
}

test('API: the quest list needs a login, claiming works, /api/me shows an alert for finished quests', async () => {
  const { app, post, db, id, h } = await api();
  assert.equal((await app.request('/api/quests')).status, 401);
  const list = await (await app.request('/api/quests', { headers: h })).json() as any;
  assert.equal(list.quests.length, 10); assert.ok(list.endsAt > T0);
  const q = list.quests.find((x: any) => !x.locked);
  assert.equal((await post('/api/quests/claim', { quest: q.id, choice: 'gold' }, h)).status, 400, 'not finished');
  bump(db, id, QUESTS.find((x) => x.id === q.id)!.counter, q.target);
  const me = await (await app.request('/api/me', { headers: h })).json() as any;
  assert.ok(me.alerts.some((a: any) => a.key === 'quests'), 'the alert bar will show it');
  const gold0 = me.gold;
  const r = await (await post('/api/quests/claim', { quest: q.id, choice: 'gold' }, h)).json() as any;
  assert.equal(r.choice, 'gold');
  assert.equal(((await (await app.request('/api/me', { headers: h })).json()) as any).gold, gold0 + q.rewards.gold);
  assert.ok(!((await (await app.request('/api/me', { headers: h })).json()) as any).alerts.some((a: any) => a.key === 'quests'), 'the alert is gone');
});

test('API: hostile input to the quest routes is refused cleanly', async () => {
  const { post, h } = await api();
  for (const body of [{}, { quest: null }, { quest: 5, choice: 'gold' }, { quest: ['a'], choice: 'xp' }, { quest: 'hunt_portions.easy', choice: null }, { quest: 'x'.repeat(5000), choice: 'gold' }, { quest: '__proto__', choice: 'special' }, 'text', [1]]) {
    const r = await post('/api/quests/claim', body, h);
    assert.ok(r.status >= 400 && r.status < 500, `${JSON.stringify(body).slice(0, 40)} -> ${r.status}`);
  }
});

test('API: the number of quests and their rewards are settings', async () => {
  const { app, post, db, id, h } = await api();
  db.prepare('UPDATE players SET is_admin = 1 WHERE id = ?').run(id);
  await post('/api/admin/setting', { key: 'questsPerWeek', value: 6 }, h);
  assert.equal((((await (await app.request('/api/quests', { headers: h })).json()) as any).quests as any[]).length, 6);
});
