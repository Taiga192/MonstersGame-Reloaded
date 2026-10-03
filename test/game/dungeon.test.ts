import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CFG, DAY_MS, HOUR, MIN } from '../../src/core/config.ts';
import { openDb, type DB } from '../../src/db/node.ts';
import { GameError } from '../../src/core/errors.ts';
import * as auth from '../../src/game/character/auth.ts';
import * as dungeon from '../../src/game/world/dungeon.ts';
import * as eco from '../../src/game/world/economy.ts';
import * as hs from '../../src/game/social/highscore.ts';
import { loadPlayer } from '../../src/game/character/player.ts';
import * as raid from '../../src/game/combat/raid.ts';
import { seeded, type Rng } from '../../src/core/rng.ts';
import { accomplishmentStatus } from '../../src/game/character/accomplishments.ts';

const T0 = Date.UTC(2027, 0, 13, 12, 0, 0); // a Wednesday, noon UTC
CFG.dungeonFightCooldown = 0; // most tests fight many times at the same moment; the wait between fights has its own tests at the end
const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    return (e as GameError).code;
  }
  return 'none';
};
const one = (db: DB, sql: string, ...a: any[]) => db.prepare(sql).get(...a) as any;
/** true when an ordinary action is NOT refused because of the dungeon (other refusals, e.g. no gold, do not matter here) */
const unlocked = (db: DB, id: number, t: number) => code(() => eco.trainStat(db, id, 'str', t)) !== 'in_dungeon';

/** A player with the given fighting stat (all four) and max HP. */
function hero(stat: number, race: 'vampire' | 'werewolf' = 'vampire', name = 'Delver') {
  const db = openDb();
  const id = auth.register(db, { name, password: 'secret12', race }, T0);
  db.prepare('UPDATE players SET str = ?, def = ?, agi = ?, sta = ?, dex = ?, max_hp = 200, hp = 200, hp_at = ?, gold = 0 WHERE id = ?').run(
    stat,
    stat,
    stat,
    stat,
    stat,
    T0,
    id,
  );
  return { db, id, rng: seeded(3) };
}
const strong = () => hero(100000); // never loses: isolates bookkeeping from combat luck
const weak = () => hero(1); // dies at once

test('weeks start on Monday 00:00 UTC', () => {
  const monday = Date.UTC(2027, 0, 11, 0, 0, 0),
    sundayNight = monday - 1;
  assert.equal(new Date(monday).getUTCDay(), 1);
  assert.equal(dungeon.weekStart(dungeon.weekOf(monday)), monday);
  assert.equal(dungeon.weekOf(monday), dungeon.weekOf(monday + 6 * DAY_MS + 23 * HOUR));
  assert.equal(dungeon.weekOf(monday) - dungeon.weekOf(sundayNight), 1);
});

test('monsters get stronger every level, guardians every 10th, and pay more XP than a village', () => {
  const power = (d: number) => {
    const s = dungeon.monsterAt(d).stats;
    return s.str + s.def + s.agi + s.sta;
  };
  for (let d = 1; d < 200; d++) if (d % 10 !== 0) assert.ok(power(d + 1) > power(d), `level ${d + 1} is stronger than ${d}`); // (a guardian is a spike; the level after it is only compared to the next ordinary ones)
  for (let d = 10; d <= 200; d += 10) assert.ok(power(d) > power(d - 1) && power(d) > power(d + 1), `guardian ${d} is a spike above both neighbours`);
  assert.ok(power(200) > power(100) && power(100) > power(50) && power(50) > power(10), 'the ladder keeps climbing');
  assert.equal(dungeon.monsterAt(10).guardian, true);
  assert.equal(dungeon.monsterAt(9).guardian, false);
  assert.ok(power(10) > power(9) * 1.2, 'a guardian is clearly stronger than the monster before it');
  const village = CFG.huntVillage.xp;
  for (const d of [1, 2, 5, 9, 25]) assert.ok(dungeon.monsterAt(d).xp > village, `level ${d} gives more than a village (${village})`);
  assert.ok(dungeon.monsterAt(10).xp >= dungeon.monsterAt(9).xp * 2, 'guardians pay much more');
  assert.notEqual(dungeon.monsterAt(1).name, dungeon.monsterAt(2).name);
  assert.equal(dungeon.monsterAt(10).name, 'Gorrak the Gatekeeper');
});

test('entering: full dungeon HP no matter how hurt you are, and it locks everything else', () => {
  const { db, id } = hero(20);
  db.prepare('UPDATE players SET hp = 12 WHERE id = ?').run(id); // badly hurt in real life
  const r = dungeon.enterDungeon(db, id, T0);
  assert.equal(r.hp, 200, 'dungeon HP is a full pool, independent of real HP');
  assert.equal(dungeon.dungeonState(db, id, T0).hp, 200);
  assert.equal(loadPlayer(db, id, T0).hp, 12 + 0, 'real HP is untouched');
  const p = loadPlayer(db, id, T0);
  assert.equal(
    code(() => eco.startHunt(db, id, 1, T0)),
    'in_dungeon',
  );
  assert.equal(
    code(() => eco.startWork(db, id, 1, T0)),
    'in_dungeon',
  );
  assert.equal(
    code(() => eco.trainStat(db, id, 'str', T0)),
    'in_dungeon',
  );
  assert.equal(
    code(() => raid.searchOpponent(db, id, T0 + MIN, seeded(1))),
    'in_dungeon',
    'cannot raid from inside',
  );
  assert.equal(
    code(() => dungeon.enterDungeon(db, id, T0)),
    'in_dungeon',
    'already inside',
  );
  void p;
});

test('you cannot enter while hunting or working', () => {
  const a = hero(20);
  eco.startHunt(a.db, a.id, 2, T0);
  assert.equal(
    code(() => dungeon.enterDungeon(a.db, a.id, T0 + MIN)),
    'hunting',
  );
  const b = hero(20, 'vampire', 'Grave');
  eco.startWork(b.db, b.id, 2, T0);
  assert.equal(
    code(() => dungeon.enterDungeon(b.db, b.id, T0 + MIN)),
    'working',
  );
});

test('while inside the dungeon you cannot be raided', () => {
  const db = openDb();
  const attacker = auth.register(db, { name: 'Raider', password: 'secret12', race: 'vampire' }, T0);
  const victim = auth.register(db, { name: 'Victim', password: 'secret12', race: 'werewolf' }, T0);
  const rng = seeded(4);
  const found = () => {
    for (let i = 0; i < 40; i++) if (raid.searchOpponent(db, attacker, T0, rng).found) return true;
    return false;
  };
  assert.equal(found(), true, 'normally the victim is findable');
  db.prepare('UPDATE players SET found_target = NULL').run();
  dungeon.enterDungeon(db, victim, T0);
  assert.equal(found(), false, 'inside the dungeon nobody can find the victim');
  assert.equal(
    code(() => raid.attack(db, attacker, victim, T0, rng)),
    'not_found',
  );
  dungeon.leaveDungeon(db, victim, T0 + MIN);
  assert.equal(found(), true, 'after leaving they can be raided again');
});

test('a win gives XP (more than a village), one level deeper, and HP is lost that does NOT regenerate', () => {
  const { db, id, rng } = hero(12);
  dungeon.enterDungeon(db, id, T0);
  const xp0 = loadPlayer(db, id, T0).xp;
  const r = dungeon.fight(db, id, T0 + MIN, rng);
  assert.equal(r.won, true);
  assert.equal(r.depth, 1);
  assert.equal(r.nextDepth, 2);
  assert.ok(r.xp > CFG.huntVillage.xp, 'more XP than a village');
  const p = loadPlayer(db, id, T0 + MIN);
  assert.equal(p.xp + (p.level - 1) * 0 >= xp0, true);
  const st = dungeon.dungeonState(db, id, T0 + MIN);
  assert.equal(st.depth, 2);
  assert.equal(st.kills, 1);
  assert.equal(st.hp, r.hpLeft);
  assert.ok(st.hp < 200 && r.hpLost > 0, 'the monster hurt us');
  const later = dungeon.dungeonState(db, id, T0 + 25 * MIN); // still inside (activity resets the idle clock)
  assert.equal(later.hp, st.hp, 'dungeon HP does not regenerate');
  assert.equal(loadPlayer(db, id, T0 + 25 * MIN).hp, 200, 'real HP is a different pool and untouched');
});

test('dying keeps XP and items, ends the run, saves the level, and needs a cooldown before re-entering', () => {
  const { db, id, rng } = hero(6);
  db.prepare("INSERT INTO dungeon_loot (player_id, name, value, depth, found_at) VALUES (?, 'Old Trinket', 50, 1, ?)").run(id, T0);
  dungeon.enterDungeon(db, id, T0);
  let t = T0,
    last: dungeon.DungeonFightResult | undefined,
    wins = 0;
  for (let i = 0; i < 60; i++) {
    t += MIN;
    last = dungeon.fight(db, id, t, rng);
    if (last.died) break;
    wins++;
  }
  assert.ok(last?.died, 'a weak character eventually dies (the dungeon is endless but ever harder)');
  assert.ok(wins >= 1, 'but it does get somewhere');
  const st = dungeon.dungeonState(db, id, t);
  assert.equal(st.active, false);
  assert.equal(st.depth, wins + 1, 'progress saved: the level it died on is next');
  assert.equal(st.deaths, 1);
  assert.equal(st.xpWeek > 0, true, 'XP earned before dying is kept');
  assert.equal(
    st.loot.some((l) => l.name === 'Old Trinket'),
    true,
    'items are kept',
  );
  assert.equal(st.canEnter, false);
  assert.equal(
    code(() => dungeon.enterDungeon(db, id, t + 5 * MIN)),
    'cooldown',
  );
  assert.equal(
    code(() => dungeon.fight(db, id, t + 6 * MIN, rng)),
    'not_in_dungeon',
  );
  // after the cooldown: full HP again, continuing at the saved level
  const again = dungeon.enterDungeon(db, id, t + CFG.dungeonCooldown);
  assert.equal(again.hp, loadPlayer(db, id, t).max_hp, 'full dungeon HP again (max HP may have grown from level-ups)');
  assert.equal(again.depth, wins + 1);
  assert.equal(loadPlayer(db, id, t).id, id);
  assert.equal(unlocked(db, id, t + CFG.dungeonCooldown), false, 'locked inside again');
});

test('leaving saves progress but also costs the cooldown, so it cannot be used to refill HP mid-run', () => {
  const { db, id, rng } = hero(15);
  dungeon.enterDungeon(db, id, T0);
  dungeon.fight(db, id, T0 + MIN, rng);
  dungeon.fight(db, id, T0 + 2 * MIN, rng);
  const depth = dungeon.dungeonState(db, id, T0 + 2 * MIN).depth;
  assert.equal(depth, 3);
  dungeon.leaveDungeon(db, id, T0 + 3 * MIN);
  assert.equal(
    code(() => dungeon.leaveDungeon(db, id, T0 + 4 * MIN)),
    'not_in_dungeon',
  );
  assert.equal(unlocked(db, id, T0 + 5 * MIN), true, 'free again right after leaving');
  assert.equal(
    code(() => dungeon.enterDungeon(db, id, T0 + 10 * MIN)),
    'cooldown',
  );
  assert.equal(dungeon.enterDungeon(db, id, T0 + 3 * MIN + CFG.dungeonCooldown).depth, depth, 'progress is kept');
});

test('exactly ONE run per day: 24 hours after leaving or dying, not a minute earlier', () => {
  assert.equal(CFG.dungeonCooldown, 24 * HOUR);
  // leaving
  const a = hero(20);
  dungeon.enterDungeon(a.db, a.id, T0);
  dungeon.fight(a.db, a.id, T0 + MIN, a.rng);
  dungeon.leaveDungeon(a.db, a.id, T0 + 2 * MIN);
  const readyAt = T0 + 2 * MIN + 24 * HOUR;
  for (const t of [T0 + 3 * MIN, T0 + 2 * HOUR, T0 + 12 * HOUR, readyAt - MIN])
    assert.equal(
      code(() => dungeon.enterDungeon(a.db, a.id, t)),
      'cooldown',
      `blocked at +${Math.round((t - T0) / MIN)} min`,
    );
  assert.equal(dungeon.dungeonState(a.db, a.id, readyAt - MIN).canEnter, false);
  assert.equal(dungeon.dungeonState(a.db, a.id, readyAt).canEnter, true);
  assert.equal(dungeon.enterDungeon(a.db, a.id, readyAt).depth, 2, 'the next day continues where you stopped');
  // dying
  const b = weak();
  dungeon.enterDungeon(b.db, b.id, T0);
  const died = dungeon.fight(b.db, b.id, T0 + MIN, b.rng);
  assert.equal(died.died, true);
  assert.equal(died.cooldownUntil, T0 + MIN + 24 * HOUR);
  assert.equal(
    code(() => dungeon.enterDungeon(b.db, b.id, T0 + 23 * HOUR)),
    'cooldown',
  );
  assert.equal(
    code(() => dungeon.enterDungeon(b.db, b.id, T0 + MIN + 24 * HOUR)),
    'none',
  );
  // a run cut short by the idle limit also costs the whole day (counted from the last action)
  const c = hero(20, 'vampire', 'Sleepy');
  dungeon.enterDungeon(c.db, c.id, T0);
  dungeon.fight(c.db, c.id, T0 + MIN, c.rng);
  const st = dungeon.dungeonState(c.db, c.id, T0 + 2 * HOUR);
  assert.equal(st.active, false);
  assert.equal(st.cooldownUntil, T0 + MIN + 24 * HOUR);
  // the daily run also survives the Monday wipe: the wipe resets depth, not the cooldown
  const d = hero(20, 'vampire', 'Monday');
  const sunday = Date.UTC(2027, 0, 17, 22, 0, 0);
  dungeon.enterDungeon(d.db, d.id, sunday);
  dungeon.leaveDungeon(d.db, d.id, sunday + MIN);
  const state = dungeon.dungeonState(d.db, d.id, Date.UTC(2027, 0, 18, 1, 0, 0)); // Monday 01:00, week wiped
  assert.equal(state.depth, 1);
  assert.equal(state.canEnter, false, 'still cooling down after the wipe');
});

test('an idle run ends by itself after 30 minutes: not a safe house, progress kept', () => {
  const { db, id, rng } = hero(15);
  dungeon.enterDungeon(db, id, T0);
  dungeon.fight(db, id, T0 + MIN, rng);
  assert.equal(loadPlayer(db, id, T0 + 20 * MIN).dungeon_until! > T0 + 20 * MIN, true, 'still inside after 20 idle minutes');
  const t = T0 + MIN + CFG.dungeonIdleLimit + MIN; // 31 minutes without acting
  assert.equal(unlocked(db, id, t), true, 'the lock is gone: normal actions work again');
  assert.equal(
    code(() => dungeon.fight(db, id, t, rng)),
    'not_in_dungeon',
  );
  const st = dungeon.dungeonState(db, id, t);
  assert.equal(st.active, false);
  assert.equal(st.depth, 2, 'progress kept');
  assert.equal(st.cooldownUntil, T0 + MIN + CFG.dungeonCooldown, 'the cooldown counts from the last action');
  // and an idle-expired player is raidable again
  const b = hero(15, 'werewolf', 'Other');
  void b;
});

test('every 10th level is a guardian: beating it offers 3 rewards, you must choose one, values are high', () => {
  const { db, id, rng } = strong();
  dungeon.enterDungeon(db, id, T0);
  let t = T0,
    last!: dungeon.DungeonFightResult;
  for (let i = 0; i < 10; i++) {
    t += MIN;
    last = dungeon.fight(db, id, t, rng);
  }
  assert.equal(last.depth, 10);
  assert.equal(last.monster.guardian, true);
  assert.equal(last.choice!.length, 3);
  assert.equal(new Set(last.choice!.map((o) => o.name)).size, 3, 'three different rewards');
  const base = CFG.dungeonLootValue(10);
  for (const o of last.choice!) assert.ok(o.value >= base * 4 * 0.99 && o.value <= base * 8 * 1.01, `reward ${o.value} in ${base * 4}-${base * 8}`);
  assert.equal(
    code(() => dungeon.fight(db, id, t + MIN, rng)),
    'choose_reward',
    'you must choose before going on',
  );
  assert.equal(
    code(() => dungeon.chooseReward(db, id, 7, t)),
    'bad_choice',
  );
  const picked = dungeon.chooseReward(db, id, 1, t + MIN);
  assert.equal(picked.name, last.choice![1].name);
  const st = dungeon.dungeonState(db, id, t + MIN);
  assert.equal(st.pending, null);
  assert.equal(
    st.loot.some((l) => l.name === picked.name && l.value === picked.value),
    true,
    'added to the loot',
  );
  assert.equal(st.loot.filter((l) => last.choice!.some((o) => o.name === l.name && l.milestone === 1)).length, 1, 'only the chosen one');
  assert.equal(
    code(() => dungeon.chooseReward(db, id, 0, t + 2 * MIN)),
    'no_choice',
  );
  dungeon.fight(db, id, t + 3 * MIN, rng); // going on works now
  assert.equal(dungeon.dungeonState(db, id, t + 3 * MIN).depth, 12);
});

test('drops: about 25 % of victories drop a valuable item, worth more the deeper it was found', () => {
  const { db, id, rng } = strong();
  dungeon.enterDungeon(db, id, T0);
  let t = T0,
    drops = 0,
    fights = 0;
  const byDepth: [number, number][] = [];
  for (let i = 0; i < 400; i++) {
    t += 1000;
    const r = dungeon.fight(db, id, t, rng);
    fights++;
    if (r.choice) dungeon.chooseReward(db, id, 0, t);
    if (r.drop) {
      drops++;
      byDepth.push([r.depth, r.drop.value]);
      assert.ok(r.drop.value >= CFG.dungeonLootValue(r.depth) * 0.79 && r.drop.value <= CFG.dungeonLootValue(r.depth) * 1.21);
    }
  }
  assert.ok(drops > 70 && drops < 130, `${drops}/${fights} drops (expected ~100)`);
  const avg = (a: [number, number][]) => a.reduce((s, x) => s + x[1], 0) / a.length;
  assert.ok(avg(byDepth.filter(([d]) => d > 300)) > avg(byDepth.filter(([d]) => d < 100)) * 3, 'deeper drops are worth much more');
});

test('loot is sold to the relic dealer in town for its value, not from inside the dungeon', () => {
  const { db, id, rng } = strong();
  dungeon.enterDungeon(db, id, T0);
  for (let i = 0; i < 40; i++) {
    const r = dungeon.fight(db, id, T0 + (i + 1) * 1000, rng);
    if (r.choice) dungeon.chooseReward(db, id, 0, T0 + (i + 1) * 1000);
  }
  const st = dungeon.dungeonState(db, id, T0 + 60_000);
  assert.ok(st.loot.length >= 3);
  assert.equal(
    code(() => dungeon.sellLoot(db, id, 'all', T0 + 60_000)),
    'in_dungeon',
  );
  dungeon.leaveDungeon(db, id, T0 + 60_000);
  const first = st.loot[0];
  const gold0 = loadPlayer(db, id, T0).gold; // (level-ups during the dive also paid gold, so compare deltas)
  const one1 = dungeon.sellLoot(db, id, first.id, T0 + 61_000);
  assert.equal(one1.gold, first.value);
  assert.equal(one1.count, 1);
  assert.equal(
    code(() => dungeon.sellLoot(db, id, first.id, T0 + 62_000)),
    'no_loot',
    'already sold',
  );
  const rest = dungeon.dungeonState(db, id, T0 + 62_000);
  const all = dungeon.sellLoot(db, id, 'all', T0 + 63_000);
  assert.equal(all.gold, rest.lootValue);
  assert.equal(all.count, rest.loot.length);
  assert.equal(loadPlayer(db, id, T0).gold - gold0, first.value + rest.lootValue);
  assert.equal(
    code(() => dungeon.sellLoot(db, id, 'all', T0 + 64_000)),
    'no_loot',
  );
  assert.equal(dungeon.dungeonState(db, id, T0 + 64_000).loot.length, 0);
});

test('weekly wipe: progress resets Monday, loot stays, an unclaimed guardian reward is auto-claimed, the run ends', () => {
  const { db, id, rng } = strong();
  const friday = Date.UTC(2027, 0, 15, 20, 0, 0);
  dungeon.enterDungeon(db, id, friday);
  let last!: dungeon.DungeonFightResult;
  for (let i = 0; i < 10; i++) last = dungeon.fight(db, id, friday + (i + 1) * 1000, rng);
  const before = dungeon.dungeonState(db, id, friday + 20_000);
  assert.equal(before.depth, 11);
  assert.ok(before.pending);
  assert.equal(before.active, true);
  const lootBefore = before.loot.length;
  const best = Math.max(...before.pending!.map((o) => o.value));
  const monday = Date.UTC(2027, 0, 18, 0, 5, 0);
  const after = dungeon.dungeonState(db, id, monday);
  assert.equal(after.depth, 1, 'progress reset');
  assert.equal(after.kills, 0);
  assert.equal(after.xpWeek, 0);
  assert.equal(after.active, false);
  assert.equal(after.pending, null);
  assert.equal(after.loot.length, lootBefore + 1, 'the unclaimed reward was claimed for you');
  assert.equal(Math.max(...after.loot.map((l) => l.value)), Math.max(best, ...before.loot.map((l) => l.value)), 'the most valuable option was taken');
  assert.equal(after.bestEver, 10, 'all-time best is remembered');
  assert.equal(one(db, 'SELECT depth d FROM dungeon_weekly WHERE player_id = ?', id).d, 10, 'last week is archived');
  assert.equal(loadPlayer(db, id, monday).dungeon_until, null, 'no longer inside');
  assert.equal(unlocked(db, id, monday), true);
  assert.equal(dungeon.enterDungeon(db, id, monday).depth, 1, 'starts again from level 1');
  void last;
});

test('the dungeon feeds the Delver accomplishment and the weekly dungeon highscore', () => {
  const db = openDb(),
    rng: Rng = seeded(9);
  const ids = ['Alpha', 'Bravo', 'Cindy', 'Dorian'].map((n) => auth.register(db, { name: n, password: 'secret12', race: 'vampire' }, T0));
  db.prepare('UPDATE players SET str = 100000, def = 100000, agi = 100000, sta = 100000, max_hp = 200, hp = 200').run();
  const dive = (id: number, levels: number, at: number) => {
    dungeon.enterDungeon(db, id, at);
    for (let i = 0; i < levels; i++) {
      const r = dungeon.fight(db, id, at + (i + 1) * 1000, rng);
      if (r.choice) dungeon.chooseReward(db, id, 0, at + (i + 1) * 1000);
    }
    dungeon.leaveDungeon(db, id, at + 999_000);
  };
  dive(ids[0], 12, T0);
  dive(ids[1], 20, T0);
  dive(ids[2], 12, T0 + HOUR); // Cindy ties Alpha but got there later
  // last week's diver must not appear
  const lastWeek = T0 - 7 * DAY_MS;
  dive(ids[3], 30, lastWeek);
  const r = hs.highscore(db, { type: 'dungeon' }, T0 + 2 * HOUR);
  assert.deepEqual(
    r.rows.map((x: any) => x.name),
    ['Bravo', 'Alpha', 'Cindy'],
    'deepest first, earlier arrival wins ties, old weeks are excluded',
  );
  assert.deepEqual(
    r.rows.map((x: any) => x.value),
    [20, 12, 12],
  );
  assert.equal(accomplishmentStatus(db, ids[1]).find((a) => a.key === 'delver')!.value, 20);
  assert.equal((hs.profile(db, ids[1], T0 + 2 * HOUR) as any).dungeon.week, 20);
  assert.equal((hs.profile(db, ids[3], T0 + 2 * HOUR) as any).dungeon.bestEver, 30);
  assert.equal((hs.profile(db, ids[3], T0 + 2 * HOUR) as any).dungeon.week, 0, 'last week does not count this week');
});

test('the weak die immediately, the strong go deep: depth grows with power', () => {
  const depthFor = (stat: number) => {
    const h = hero(stat, 'vampire', `Hero${stat}`);
    dungeon.enterDungeon(h.db, h.id, T0);
    let t = T0,
      n = 0;
    for (let i = 0; i < 500; i++) {
      t += 1000;
      const r = dungeon.fight(h.db, h.id, t, h.rng);
      if (r.choice) dungeon.chooseReward(h.db, h.id, 0, t);
      if (r.died) break;
      n++;
    }
    return n;
  };
  const d = [3, 10, 30, 80].map(depthFor);
  assert.ok(d[0] < d[1] && d[1] < d[2] && d[2] < d[3], `depths ${d.join(', ')}`);
  assert.ok(d[0] <= 6 && d[3] >= 15, `depths ${d.join(', ')}`);
});

test('dev tool: set the depth and clear the cooldown', async () => {
  const { devDungeon } = await import('../../src/api/dev-tools.ts');
  const { db, id } = hero(10);
  dungeon.enterDungeon(db, id, T0);
  dungeon.leaveDungeon(db, id, T0 + MIN);
  assert.equal(
    code(() => dungeon.enterDungeon(db, id, T0 + 2 * MIN)),
    'cooldown',
  );
  devDungeon(db, id, T0 + 2 * MIN, { depth: 40, clearCooldown: true });
  assert.equal(dungeon.enterDungeon(db, id, T0 + 2 * MIN).depth, 40);
});

// ---------------------------------------------------------------- wait between fights and checkpoints
const withFightWait = <T>(ms: number, fn: () => T): T => {
  const old = CFG.dungeonFightCooldown;
  CFG.dungeonFightCooldown = ms;
  try {
    return fn();
  } finally {
    CFG.dungeonFightCooldown = old;
  }
};

test('after beating a monster you wait 5 minutes for the next one; entering and dying are not delayed', () =>
  withFightWait(5 * MIN, () => {
    const { db, id, rng } = strong();
    dungeon.enterDungeon(db, id, T0);
    assert.equal(dungeon.dungeonState(db, id, T0).readyAt, 0, 'the first monster is right there');
    const r1 = dungeon.fight(db, id, T0, rng);
    assert.equal(r1.won, true);
    assert.equal(r1.readyAt, T0 + 5 * MIN);
    assert.equal(dungeon.dungeonState(db, id, T0 + MIN).readyAt, T0 + 5 * MIN, 'the page can show a countdown');
    assert.equal(
      code(() => dungeon.fight(db, id, T0 + MIN, rng)),
      'fight_cooldown',
    );
    assert.equal(
      code(() => dungeon.fight(db, id, T0 + 5 * MIN - 1, rng)),
      'fight_cooldown',
      'not a second early',
    );
    assert.equal(dungeon.fight(db, id, T0 + 5 * MIN, rng).won, true, 'exactly on time');
    assert.equal(dungeon.dungeonState(db, id, T0 + 5 * MIN).depth, 3);
    // the run keeps going as long as you come back within the idle limit
    let t = T0 + 5 * MIN;
    for (let i = 0; i < 4; i++) {
      t += 5 * MIN;
      assert.equal(dungeon.fight(db, id, t, rng).won, true);
    }
    assert.equal(dungeon.dungeonState(db, id, t).active, true);
    // a new run starts without waiting
    dungeon.leaveDungeon(db, id, t);
    const later = t + DAY_MS + MIN;
    dungeon.enterDungeon(db, id, later);
    assert.equal(dungeon.fight(db, id, later, rng).won, true);
  }));

test('dying needs no wait, and a character that is never fast enough still loses nothing', () =>
  withFightWait(5 * MIN, () => {
    const { db, id, rng } = weak();
    dungeon.enterDungeon(db, id, T0);
    const r = dungeon.fight(db, id, T0, rng);
    assert.equal(r.died, true);
    assert.equal(r.readyAt, null);
    assert.equal(dungeon.dungeonState(db, id, T0).active, false);
  }));

test('the wait can be switched off (0) and has to stay shorter than the idle limit', () => {
  const { db, id, rng } = strong();
  dungeon.enterDungeon(db, id, T0);
  for (let i = 0; i < 5; i++) assert.equal(dungeon.fight(db, id, T0, rng).won, true, 'no wait at 0');
});

test('checkpoints: standing on level 25 saves it for the next weeks; missing it means starting over', () => {
  const { db, id, rng } = strong();
  const wed = T0,
    nextMonday = Date.UTC(2027, 0, 18, 0, 5, 0),
    mondayAfter = nextMonday + 7 * DAY_MS,
    third = mondayAfter + 7 * DAY_MS;
  const dive = (at: number, levels: number) => {
    dungeon.enterDungeon(db, id, at);
    const cps: number[] = [];
    for (let i = 0; i < levels; i++) {
      const r = dungeon.fight(db, id, at + (i + 1) * 1000, rng);
      if (r.checkpoint) cps.push(r.checkpoint);
      if (r.choice) dungeon.chooseReward(db, id, 0, at + (i + 1) * 1000 + 1);
    }
    return cps;
  };
  // week 1: 23 levels cleared (standing on level 24): no checkpoint yet
  assert.deepEqual(dive(wed, 23), []);
  assert.equal(dungeon.dungeonState(db, id, wed + 30_000).checkpoint, 1);
  dungeon.leaveDungeon(db, id, wed + 30_000);
  assert.equal(dungeon.dungeonState(db, id, nextMonday).depth, 1, 'missed it: back to level 1');
  // week 2: reach it (24 more levels = standing on level 25)
  assert.deepEqual(dive(nextMonday + DAY_MS, 24), [25]);
  const s = dungeon.dungeonState(db, id, nextMonday + DAY_MS + 60_000);
  assert.equal(s.depth, 25);
  assert.equal(s.checkpoint, 25);
  assert.equal(s.nextCheckpoint, 50);
  dungeon.leaveDungeon(db, id, nextMonday + DAY_MS + 60_000);
  assert.equal(dungeon.dungeonState(db, id, mondayAfter).depth, 25, 'the new week starts on level 25');
  assert.equal(dungeon.dungeonState(db, id, mondayAfter).bestEver, 24);
  // week 3 is not played at all: the checkpoint is still there afterwards
  assert.equal(dungeon.dungeonState(db, id, third).depth, 25);
  assert.equal(dungeon.dungeonState(db, id, third + 7 * DAY_MS).depth, 25, 'an unplayed week does not lose it');
  // later: go on to 50
  const t4 = third + 7 * DAY_MS + DAY_MS;
  assert.deepEqual(dive(t4, 25), [50]);
  dungeon.leaveDungeon(db, id, t4 + 60_000);
  assert.equal(dungeon.dungeonState(db, id, t4 + 7 * DAY_MS).depth, 50);
});

test('checkpoints do not make the weekly ladder or the weekly archive show weeks that were not played', () => {
  const { db, id, rng } = strong();
  db.prepare('INSERT INTO dungeon (player_id, week, reached_at, depth, checkpoint) VALUES (?, ?, ?, 50, 50)').run(id, dungeon.weekOf(T0) - 1, T0 - 8 * DAY_MS);
  const s = dungeon.dungeonState(db, id, T0); // the roll over to this week happens here
  assert.equal(s.depth, 50);
  assert.equal(one(db, 'SELECT COUNT(*) n FROM dungeon_weekly').n, 0, 'nothing was played last week, so nothing is archived');
  assert.equal(hs.highscore(db, { type: 'dungeon', page: 1, size: 25 }, T0).rows.length, 0, 'standing on level 50 is not a score before you fight');
  dungeon.enterDungeon(db, id, T0);
  dungeon.fight(db, id, T0 + 1000, rng);
  const board = hs.highscore(db, { type: 'dungeon', page: 1, size: 25 }, T0 + 2000).rows;
  assert.equal(board.length, 1);
  assert.equal(board[0].value, 50, 'levels cleared counts from where you are');
});

test('the checkpoint distance is a setting', () => {
  const { db, id, rng } = strong();
  const old = CFG.dungeonCheckpoint;
  CFG.dungeonCheckpoint = 5;
  try {
    dungeon.enterDungeon(db, id, T0);
    const cps: number[] = [];
    for (let i = 0; i < 12; i++) {
      const r = dungeon.fight(db, id, T0 + (i + 1) * 1000, rng);
      if (r.checkpoint) cps.push(r.checkpoint);
      if (r.choice) dungeon.chooseReward(db, id, 0, T0 + (i + 1) * 1000 + 1);
    }
    assert.deepEqual(cps, [5, 10]);
  } finally {
    CFG.dungeonCheckpoint = old;
  }
});
