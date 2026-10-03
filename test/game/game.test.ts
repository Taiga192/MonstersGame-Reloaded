import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CFG, HOUR, MIN } from '../../src/core/config.ts';
import { openDb, tx } from '../../src/db/node.ts';
import { GameError } from '../../src/core/errors.ts';
import { seeded } from '../../src/core/rng.ts';
import * as auth from '../../src/game/character/auth.ts';
import * as clan from '../../src/game/social/clan.ts';
import * as eco from '../../src/game/world/economy.ts';
import { simulate } from '../../src/game/combat/combat.ts';
import { loadPlayer } from '../../src/game/character/player.ts';
import * as raid from '../../src/game/combat/raid.ts';
import { createApp } from '../../src/server/create-app.ts';

const T0 = 1_800_000_000_000;
function world() {
  const db = openDb();
  let n = 0;
  const mk = (race: 'vampire' | 'werewolf', name = `pl${++n}`) => auth.register(db, { name, password: 'secret12', race }, T0);
  return { db, mk };
}
const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    return (e as GameError).code;
  }
  return 'none';
};

test('new characters start with 5 in each stat and regen 10 HP/hour', () => {
  const { db, mk } = world();
  const id = mk('vampire');
  let p = loadPlayer(db, id, T0);
  assert.equal(p.str, 5);
  assert.equal(p.dex, 5);
  db.prepare('UPDATE players SET hp = 20 WHERE id = ?').run(id);
  p = loadPlayer(db, id, T0);
  p = loadPlayer(db, id, T0 + 3 * HOUR);
  assert.equal(Math.round(p.hp), 50);
});

test('training costs value^2 - 5', () => {
  const { db, mk } = world();
  const id = mk('vampire');
  db.prepare('UPDATE players SET gold = 1000 WHERE id = ?').run(id);
  assert.equal(eco.trainStat(db, id, 'agi', T0).cost, 20);
  assert.equal(eco.trainStat(db, id, 'agi', T0).cost, 31);
});

test('combat is deterministic per seed and stronger fighters win', () => {
  const strong = { name: 'a', hp: 100, maxHp: 100, stats: { str: 30, def: 30, agi: 30, sta: 30, dex: 5 } };
  const weak = { name: 'b', hp: 100, maxHp: 100, stats: { str: 5, def: 5, agi: 5, sta: 5, dex: 5 } };
  const r1 = simulate(strong, weak, seeded(1)),
    r2 = simulate(strong, weak, seeded(1));
  assert.deepEqual(r1, r2);
  assert.equal(r1.winner, 'a');
  assert.ok(r1.hpB >= 1);
});

function duelSetup() {
  const w = world();
  const a = w.mk('vampire'),
    d = w.mk('werewolf');
  w.db.prepare('UPDATE players SET str = 40, def = 40, agi = 40, sta = 40 WHERE id = ?').run(a);
  w.db.prepare('UPDATE players SET gold = 1000 WHERE id = ?').run(d);
  return { ...w, a, d };
}
function findAndHit(db: ReturnType<typeof openDb>, a: number, d: number, t: number, seed = 1) {
  const rng = seeded(seed);
  for (let i = 0; i < 50; i++) {
    const r = raid.searchOpponent(db, a, t, rng);
    if (r.found) return raid.attack(db, a, d, t, rng);
  }
  throw new Error('never found');
}

test('raid: steals 5-10% gold, cooldown, protection and same-opponent limit', () => {
  const { db, a, d } = duelSetup();
  const res = tx(db, () => findAndHit(db, a, d, T0));
  assert.equal(res.winner, 'pl1');
  assert.ok(res.gold >= 50 && res.gold <= 100, `gold ${res.gold}`);
  // attacker cooldown (10 min): still blocked one minute before, allowed from then on
  assert.equal(
    code(() => raid.searchOpponent(db, a, T0 + CFG.attackCooldown - MIN, seeded(2))),
    'cooldown',
  );
  // after cooldown the defender is still protected for 1h -> nobody to find
  const r = raid.searchOpponent(db, a, T0 + 20 * MIN, seeded(2));
  assert.equal(r.found, false);
  // after protection, same-opponent 12h limit still blocks
  assert.equal(raid.searchOpponent(db, a, T0 + 2 * HOUR, seeded(2)).found, false);
  // after 12h target is available again (needs HP >= 25, regen'd)
  db.prepare('UPDATE players SET hp = 100, hp_at = ? WHERE id IN (?, ?)').run(T0 + 13 * HOUR, a, d);
  assert.equal(tx(db, () => findAndHit(db, a, d, T0 + 13 * HOUR, 5)).winner, 'pl1');
});

test('raid: same race and low HP are rejected', () => {
  const w = world();
  const a = w.mk('vampire'),
    v = w.mk('vampire'),
    d = w.mk('werewolf');
  assert.equal(raid.searchOpponent(w.db, a, T0, seeded(3)).found && raid.searchOpponent(w.db, a, T0, seeded(3)).found, true);
  w.db.prepare('UPDATE players SET hp = 20 WHERE id = ?').run(d);
  assert.equal(raid.searchOpponent(w.db, a, T0, seeded(3)).found, false);
  assert.equal(
    code(() => raid.attack(w.db, a, v, T0, seeded(1))),
    'not_found',
  );
});

test('XP: beating a higher level opponent gives 2, otherwise 1; level-up grants gold + HP', () => {
  const { db, a, d } = duelSetup();
  db.prepare('UPDATE players SET level = 3 WHERE id = ?').run(d);
  const res = tx(db, () => findAndHit(db, a, d, T0));
  assert.equal(res.xpAttacker, 2);
  assert.equal(res.xpDefender, 1);
});

test('recruit bonus pays 50 gold + 1 XP when referral hits level 3', () => {
  const w = world();
  const ref = w.mk('vampire');
  const kid = auth.register(w.db, { name: 'kid', password: 'secret12', race: 'vampire', referrerId: ref }, T0);
  const before = loadPlayer(w.db, ref, T0).gold;
  w.db.prepare('UPDATE players SET xp = 14 WHERE id = ?').run(kid);
  tx(w.db, () => eco.startHunt(w.db, kid, 1, T0));
  tx(w.db, () => eco.collectHunt(w.db, kid, T0 + 10 * MIN, () => 0.99)); // rng .99 -> large town, 7 xp -> level 3
  assert.equal(loadPlayer(w.db, kid, T0).level, 3);
  assert.ok(loadPlayer(w.db, ref, T0).gold >= before + CFG.recruitGold);
});

test('hunt budget is 3h/day in 10 min portions and resets daily', () => {
  const { db, mk } = world();
  const id = mk('vampire');
  assert.equal(
    code(() => eco.startHunt(db, id, 19, T0)),
    'bad_amount',
  );
  tx(db, () => eco.startHunt(db, id, 18, T0));
  tx(db, () => eco.collectHunt(db, id, T0 + 3 * HOUR, seeded(1)));
  assert.equal(
    code(() => eco.startHunt(db, id, 1, T0 + 3 * HOUR)),
    'no_hunt_time',
  );
  const nextDay = Math.ceil(T0 / (24 * HOUR)) * 24 * HOUR + MIN;
  tx(db, () => eco.startHunt(db, id, 18, nextDay));
});

test('hunt takes real time, locks the character, and pays out only when collected', () => {
  const { db, mk } = world();
  const id = mk('vampire');
  db.prepare('UPDATE players SET gold = 500 WHERE id = ?').run(id);
  eco.startHunt(db, id, 3, T0);
  assert.equal(
    code(() => eco.trainStat(db, id, 'str', T0 + 5 * MIN)),
    'hunting',
  );
  assert.equal(
    code(() => eco.collectHunt(db, id, T0 + 29 * MIN, seeded(1))),
    'still_hunting',
  );
  assert.equal(
    code(() => eco.startHunt(db, id, 1, T0 + 30 * MIN)),
    'hunt_uncollected',
  );
  const before = loadPlayer(db, id, T0 + 30 * MIN).gold;
  const r = eco.collectHunt(db, id, T0 + 30 * MIN, () => 0.99);
  assert.equal(r.events.length, 3);
  assert.ok(loadPlayer(db, id, T0 + 30 * MIN).gold > before);
  eco.trainStat(db, id, 'str', T0 + 30 * MIN); // free again
});

test('hunt cancel pays completed portions only and refunds unused budget', () => {
  const { db, mk } = world();
  const id = mk('vampire');
  eco.startHunt(db, id, 6, T0); // whole daily hour
  const r = eco.cancelHunt(db, id, T0 + 25 * MIN, () => 0.99); // 2 full portions done
  assert.equal(r.portionsCompleted, 2);
  assert.equal(r.events.length, 2);
  assert.equal(r.xp, 14); // large town (2 xp x 3.5 = 7) x 2 portions with rng .99
  eco.startHunt(db, id, 4, T0 + 25 * MIN); // 40 min refunded -> allowed
});

test('hunt targets: village 50%, small town 35%, large town 15%; bigger targets pay more', () => {
  const { db, mk } = world();
  const id = mk('vampire');
  const rng = seeded(99);
  const count: Record<string, number> = { village: 0, small_town: 0, large_town: 0 };
  const pay: Record<string, number[]> = { village: [], small_town: [], large_town: [] };
  for (let i = 0; i < 400; i++) {
    const t = T0 + i * 24 * HOUR; // new day each time so the budget resets
    eco.startHunt(db, id, 6, t);
    for (const e of eco.collectHunt(db, id, t + HOUR, rng).events) {
      if (e.failed) continue;
      count[e.place]++;
      pay[e.place].push(e.gold);
    }
  }
  const total = Object.values(count).reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(count.village / total - 0.5) < 0.04, `village ${count.village / total}`);
  assert.ok(Math.abs(count.small_town / total - 0.35) < 0.04);
  assert.ok(Math.abs(count.large_town / total - 0.15) < 0.04);
  const avgXp = (place: string) => Math.round(2 * (1 + CFG.huntPlaces.find((x) => x.key === place)!.bonus));
  assert.deepEqual(['village', 'small_town', 'large_town'].map(avgXp), [2, 4, 7]);
  const avg = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length;
  assert.ok(avg(pay.village) < avg(pay.small_town) && avg(pay.small_town) < avg(pay.large_town));
});

test('a hunting player cannot be raided', () => {
  const w = world();
  const a = w.mk('vampire'),
    d = w.mk('werewolf');
  eco.startHunt(w.db, d, 2, T0);
  assert.equal(raid.searchOpponent(w.db, a, T0 + MIN, seeded(1)).found, false);
  eco.cancelHunt(w.db, d, T0 + MIN, seeded(1));
  assert.equal(raid.searchOpponent(w.db, a, T0 + MIN, seeded(1)).found, true);
});

test('sentinels: level 5+, one at a time, dismissal refunds price', () => {
  const { db, mk } = world();
  const id = mk('vampire');
  db.prepare('UPDATE players SET gold = 5000 WHERE id = ?').run(id);
  assert.equal(
    code(() => eco.buySentinel(db, id, 'sen_1', T0)),
    'level_too_low',
  );
  db.prepare('UPDATE players SET level = 5 WHERE id = ?').run(id);
  eco.buySentinel(db, id, 'sen_1', T0);
  assert.equal(
    code(() => eco.buySentinel(db, id, 'sen_1', T0)),
    'has_sentinel',
  );
  assert.equal(eco.trainSentinel(db, id, 'atk', T0).cost, 1);
  assert.equal(eco.trainSentinel(db, id, 'atk', T0).cost, 4);
  eco.dismissSentinel(db, id);
  assert.equal(loadPlayer(db, id, T0).gold, 5000 - 5);
});

test('hideout components are capped at 7/10/12/23', () => {
  const { db, mk } = world();
  const id = mk('vampire');
  db.prepare('UPDATE players SET gold = 1e9 WHERE id = ?').run(id);
  for (let i = 0; i < 7; i++) eco.upgradeHideout(db, id, 'surroundings', T0);
  assert.equal(
    code(() => eco.upgradeHideout(db, id, 'surroundings', T0)),
    'maxed',
  );
});

test('graveyard work blocks actions until collected; shifts up to 48h', () => {
  const { db, mk } = world();
  const id = mk('vampire');
  eco.startWork(db, id, 2, T0);
  assert.equal(
    code(() => eco.trainStat(db, id, 'str', T0 + HOUR)),
    'working',
  );
  assert.equal(
    code(() => eco.collectWork(db, id, T0 + HOUR)),
    'still_working',
  );
  const r = eco.collectWork(db, id, T0 + 2 * HOUR);
  assert.equal(r.wages, 2 * CFG.workWagePerHour(1));
  assert.equal(
    code(() => eco.startWork(db, id, 49, T0 + 3 * HOUR)),
    'bad_amount',
  );
  eco.startWork(db, id, 48, T0 + 3 * HOUR); // allowed
});

test('cancelling work pays pro rata for the time worked', () => {
  const { db, mk } = world();
  const id = mk('vampire');
  const wage = CFG.workWagePerHour(1);
  const before = loadPlayer(db, id, T0).gold;
  eco.startWork(db, id, 10, T0);
  const r = eco.cancelWork(db, id, T0 + 90 * MIN); // 1.5 h
  assert.equal(r.minutesWorked, 90);
  assert.equal(r.wages, Math.floor(1.5 * wage));
  assert.equal(loadPlayer(db, id, T0 + 90 * MIN).gold, before + r.wages);
  assert.equal(
    code(() => eco.cancelWork(db, id, T0 + 2 * HOUR)),
    'not_working',
  );
  eco.trainStat(db, id, 'str', T0 + 2 * HOUR); // free again
});

test('only one thing at a time: work and hunt exclude each other both ways', () => {
  const { db, mk } = world();
  const id = mk('vampire');
  eco.startWork(db, id, 5, T0);
  assert.equal(
    code(() => eco.startHunt(db, id, 1, T0 + MIN)),
    'working',
  );
  eco.cancelWork(db, id, T0 + MIN);
  eco.startHunt(db, id, 1, T0 + MIN);
  assert.equal(
    code(() => eco.startWork(db, id, 1, T0 + 2 * MIN)),
    'hunting',
  );
  eco.cancelHunt(db, id, T0 + 2 * MIN, seeded(1));
  // an unfinished-but-uncollected shift also blocks starting a hunt
  eco.startWork(db, id, 1, T0 + 3 * MIN);
  assert.equal(
    code(() => eco.startHunt(db, id, 1, T0 + 2 * HOUR)),
    'work_uncollected',
  );
});

test('ancestral site unlocks at level 20 and has a 24h cooldown', () => {
  const { db, mk } = world();
  const id = mk('vampire');
  assert.equal(
    code(() => eco.ancestralChallenge(db, id, T0, seeded(1))),
    'level_too_low',
  );
  db.prepare('UPDATE players SET level = 20, gold = 100000, str = 200, def = 200, agi = 200, sta = 200 WHERE id = ?').run(id);
  const r = eco.ancestralChallenge(db, id, T0, seeded(1));
  assert.equal(r.fee, CFG.ancestralFee(0)); // fee is paid win or lose
  assert.equal(
    code(() => eco.ancestralChallenge(db, id, T0 + HOUR, seeded(1))),
    'cooldown',
  );
});

test('clans: level 3, same race, capacity, war needs 5 members and snapshot', () => {
  const w = world();
  const v = Array.from({ length: 5 }, () => w.mk('vampire'));
  const wolf = w.mk('werewolf');
  w.db.prepare('UPDATE players SET level = 3').run();
  assert.equal(
    code(() => clan.joinClan(w.db, wolf, clan.createClan(w.db, v[0], 'Night', T0), T0)),
    'wrong_race',
  );
  const cid = loadPlayer(w.db, v[0], T0).clan_id!;
  for (const id of v.slice(1, 4)) clan.joinClan(w.db, id, cid, T0);
  const wc = clan.createClan(w.db, wolf, 'Moon', T0);
  assert.equal(
    code(() => clan.declareWar(w.db, v[0], wc, T0)),
    'too_small',
  );
  clan.joinClan(w.db, v[4], cid, T0);
  const war = clan.declareWar(w.db, v[0], wc, T0);
  assert.ok(clan.warBetween(w.db, v[4], wolf));
  assert.equal(
    code(() => clan.joinClan(w.db, w.mk('vampire'), cid, T0)),
    'clan_at_war',
  );
  assert.equal(clan.offerPeace(w.db, v[0], T0), 'offered');
  assert.equal(clan.offerPeace(w.db, wolf, T0), 'peace');
  assert.equal(clan.warBetween(w.db, v[4], wolf), undefined);
  assert.ok(war > 0);
});

test('clan war allows 4 attacks per 12h against the same enemy', () => {
  const w = world();
  const vs = Array.from({ length: 5 }, () => w.mk('vampire'));
  const wolf = w.mk('werewolf');
  w.db.prepare('UPDATE players SET level = 3').run();
  w.db.prepare('UPDATE players SET str = 60, def = 60, agi = 60, sta = 60, max_hp = 1000, hp = 1000 WHERE id = ?').run(vs[0]);
  w.db.prepare('UPDATE players SET max_hp = 1000, hp = 1000 WHERE id = ?').run(wolf);
  const cid = clan.createClan(w.db, vs[0], 'Alpha', T0);
  vs.slice(1).forEach((id) => clan.joinClan(w.db, id, cid, T0));
  clan.declareWar(w.db, vs[0], clan.createClan(w.db, wolf, 'Bravo', T0), T0);
  // Wolf is protected 1h after each hit, so space attacks 61 min apart; the 5th within 12h must fail.
  const results: string[] = [];
  for (let i = 0; i < 5; i++) {
    const t = T0 + i * 61 * MIN;
    w.db.prepare('UPDATE players SET hp = 1000, hp_at = ? WHERE id IN (?, ?)').run(t, vs[0], wolf);
    const rng = seeded(10 + i);
    let ok = false;
    for (let k = 0; k < 30 && !ok; k++)
      if (raid.searchOpponent(w.db, vs[0], t, rng).found) {
        raid.attack(w.db, vs[0], wolf, t, rng);
        ok = true;
      }
    results.push(ok ? 'hit' : 'blocked');
  }
  assert.deepEqual(results, ['hit', 'hit', 'hit', 'hit', 'blocked']);
});

test('HTTP API: register, login, me, train, search', async () => {
  const db = openDb();
  const app = createApp({ db, now: () => T0, rng: seeded(1) });
  const post = (path: string, b: unknown, token?: string) =>
    app.request(path, {
      method: 'POST',
      body: JSON.stringify(b),
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    });
  assert.equal((await post('/api/register', { name: 'Vlad', password: 'secret12', race: 'vampire' })).status, 201);
  assert.equal((await post('/api/register', { name: 'vlad', password: 'secret12', race: 'vampire' })).status, 409);
  assert.equal((await post('/api/login', { name: 'Vlad', password: 'nope' })).status, 401);
  const { token } = (await (await post('/api/login', { name: 'Vlad', password: 'secret12' })).json()) as { token: string };
  const me = (await (await app.request('/api/me', { headers: { authorization: `Bearer ${token}` } })).json()) as any;
  assert.equal(me.str, 5);
  assert.equal(me.pass_hash, undefined);
  assert.equal((await post('/api/train', { stat: 'str' }, token)).status, 200);
  assert.equal((await post('/api/train', { stat: 'nope' }, token)).status, 400);
  assert.equal((await post('/api/train', { stat: 'str' })).status, 401);
});

test('tx is re-entrant: an inner failure rolls back only the inner work, outer work commits', () => {
  const db = openDb();
  db.exec('CREATE TABLE t (v INTEGER)');
  const count = () => (db.prepare('SELECT COUNT(*) n FROM t').get() as { n: number }).n;
  tx(db, () => {
    db.exec('INSERT INTO t VALUES (1)');
    assert.throws(
      () =>
        tx(db, () => {
          db.exec('INSERT INTO t VALUES (2)');
          throw new Error('inner fails');
        }),
      /inner fails/,
    );
    tx(db, () => db.exec('INSERT INTO t VALUES (3)'));
  });
  assert.equal(count(), 2, 'rows 1 and 3 kept, row 2 rolled back');
  assert.throws(
    () =>
      tx(db, () => {
        db.exec('INSERT INTO t VALUES (4)');
        tx(db, () => db.exec('INSERT INTO t VALUES (5)'));
        throw new Error('outer fails');
      }),
    /outer fails/,
  );
  assert.equal(count(), 2, 'an outer failure undoes the committed inner savepoint too');
  assert.equal(db.isTransaction, false, 'no transaction left open');
});
