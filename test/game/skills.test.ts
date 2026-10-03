import assert from 'node:assert/strict';
import { test, afterEach } from 'node:test';
import { CFG, HOUR, ITEM_BY_KEY, MIN } from '../../src/core/config.ts';
import { openDb, type DB } from '../../src/db/node.ts';
import { GameError } from '../../src/core/errors.ts';
import * as auth from '../../src/game/character/auth.ts';
import { gatherBlood, tankSize } from '../../src/game/world/blood.ts';
import * as dungeon from '../../src/game/world/dungeon.ts';
import * as eco from '../../src/game/world/economy.ts';
import { attackCooldownOf, awardXp, battleStats, loadPlayer } from '../../src/game/character/player.ts';
import * as raid from '../../src/game/combat/raid.ts';
import * as shrine from '../../src/game/world/shrine.ts';
import * as sk from '../../src/game/character/skills.ts';
import * as temple from '../../src/game/world/temple.ts';
import { createApp } from '../../src/server/create-app.ts';
import { seeded } from '../../src/core/rng.ts';
import { applySettings } from '../../src/core/settings.ts';
import {
  aggregate,
  boardForClient,
  isConnected,
  MODS,
  NODES,
  NODE_BY_ID,
  nodeCost,
  ORIGINS,
  REGIONS,
  nodeText,
  type Mods,
} from '../../src/data/skill-board.ts';

const T0 = Date.UTC(2027, 0, 13, 12, 0, 0);
const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    return (e as GameError).code;
  }
  return 'none';
};
const one = (db: DB, sql: string, ...a: any[]) => db.prepare(sql).get(...a) as any;
const mk = (level = 40, name = 'Skiller', race: 'vampire' | 'werewolf' = 'vampire') => {
  const db = openDb();
  const id = auth.register(db, { name, password: 'secret12', race }, T0);
  db.prepare(
    'UPDATE players SET level = ?, gold = 100000, str = 40, def = 40, agi = 40, sta = 40, dex = 40, hp = 300, max_hp = 300, hp_at = ?, blood = 30 WHERE id = ?',
  ).run(level, T0, id);
  return { db, id, rng: seeded(5) };
};
/** give a character a set of modifiers directly (the effect tests do not care how they were earned) */
const withMods = (db: DB, id: number, m: Mods) => db.prepare('UPDATE players SET skill_mods = ? WHERE id = ?').run(JSON.stringify(m), id);
afterEach(() => {
  applySettings(openDb());
});

// ---------------------------------------------------------------- the board itself
test('the board is a connected graph of 250+ nodes with unique ids, symmetric links, seven start nodes and a keystone with a drawback in every region', () => {
  assert.ok(NODES.length >= 250, String(NODES.length));
  assert.equal(new Set(NODES.map((n) => n.id)).size, NODES.length, 'unique ids');
  assert.equal(ORIGINS.length, 7);
  assert.equal(REGIONS.length, 7);
  for (const n of NODES) {
    for (const l of n.links) assert.ok(NODE_BY_ID.get(l)!.links.includes(n.id), `${n.id} <-> ${l} is one-way`);
    assert.ok(n.links.length >= 1, `${n.id} is isolated`);
    assert.ok(!n.links.includes(n.id), 'no self links');
    assert.ok(Object.keys(n.mods).length >= 1, `${n.id} does nothing`);
    for (const k of Object.keys(n.mods)) assert.ok(k in MODS, `${n.id}: unknown modifier ${k}`);
    assert.ok(nodeText(n).length >= 1);
  }
  assert.ok(isConnected(new Set(NODES.map((n) => n.id)), ORIGINS[0]), 'every node can be reached from every start node');
  for (const r of REGIONS) {
    const key = NODES.find((n) => n.id === `${r.key}.key`)!;
    assert.equal(key.kind, 'keystone');
    assert.ok(
      Object.values(key.mods).some((v) => v! < 0),
      `${key.name} has no drawback`,
    );
    assert.ok(
      Object.values(key.mods).some((v) => v! > 0),
      `${key.name} has no bonus`,
    );
  }
});

test('the nodes do not overlap on the board and notables are worth more than small nodes', () => {
  for (let i = 0; i < NODES.length; i++)
    for (let j = i + 1; j < NODES.length; j++) assert.ok(Math.hypot(NODES[i].x - NODES[j].x, NODES[i].y - NODES[j].y) >= 40, `${NODES[i].id} / ${NODES[j].id}`);
  const power = (m: Mods) => Object.values(m).reduce((a, v) => a + Math.abs(v!), 0);
  const avg = (kind: string) => {
    const xs = NODES.filter((n) => n.kind === kind);
    return xs.reduce((a, n) => a + power(n.mods), 0) / xs.length;
  };
  assert.ok(avg('notable') > 2 * avg('small'), 'notables are the big upgrades');
});

test('summing nodes: caps keep chances sane, unknown ids are ignored, a path must stay in one piece', () => {
  const all = aggregate(NODES.map((n) => n.id));
  for (const [k, v] of Object.entries(all)) {
    const cap = MODS[k as keyof typeof MODS].cap;
    if (cap) assert.ok(v! >= cap[0] && v! <= cap[1], k);
  }
  assert.deepEqual(aggregate(['nope', '__proto__', 'hunter.start']), { huntGold: 0.02, dex: 3 });
  assert.equal(isConnected(new Set(['hunter.start', 'hunter.a1']), 'hunter.start'), true);
  assert.equal(isConnected(new Set(['hunter.start', 'hunter.a2']), 'hunter.start'), false, 'a2 does not touch the start');
  assert.equal(isConnected(new Set(), undefined), true);
  assert.equal(isConnected(new Set(['hunter.a1']), 'hunter.start'), false);
  const c = boardForClient();
  assert.equal(c.nodes.length, NODES.length);
  assert.ok(c.nodes.every((n) => n.text.length));
});

// ---------------------------------------------------------------- spending points
test('1 point per level; the first point is a start node (the class); then only nodes that touch what you have', () => {
  const { db, id } = mk(3);
  assert.equal(sk.skillState(db, id, T0).total, 3);
  assert.equal(
    code(() => sk.allocate(db, id, 'hunter.a1', T0)),
    'not_a_start',
    'cannot begin in the middle',
  );
  sk.allocate(db, id, 'hunter.start', T0);
  assert.equal(sk.skillState(db, id, T0).title, 'Lone Hunter');
  assert.equal(
    code(() => sk.allocate(db, id, 'hunter.start', T0)),
    'taken',
  );
  assert.equal(
    code(() => sk.allocate(db, id, 'hunter.a2', T0)),
    'not_connected',
  );
  assert.equal(
    code(() => sk.allocate(db, id, 'warrior.start', T0)),
    'not_connected',
    'another start node is not free either',
  );
  sk.allocate(db, id, 'hunter.a1', T0);
  sk.allocate(db, id, 'hunter.a2', T0);
  assert.equal(
    code(() => sk.allocate(db, id, 'hunter.a3', T0)),
    'no_points',
  );
  assert.equal(sk.skillState(db, id, T0).free, 0);
  // the points grow with the level; a3 is a notable (the middle nodes cost 2)
  db.prepare('UPDATE players SET level = 4 WHERE id = ?').run(id);
  let s = sk.skillState(db, id, T0);
  assert.equal(s.free, 1);
  assert.equal(s.reachable.includes('hunter.a3'), true, 'it touches the build ...');
  assert.equal(s.available.includes('hunter.a3'), false, '... but one point is not enough');
  assert.equal(
    code(() => sk.allocate(db, id, 'hunter.a3', T0)),
    'no_points',
  );
  db.prepare('UPDATE players SET level = 5 WHERE id = ?').run(id);
  assert.equal(sk.skillState(db, id, T0).available.includes('hunter.a3'), true);
});

test('costs: start nodes and small nodes 1 point, notables 2, keystones 3; nobody can take half of the board', () => {
  const byKind = (k: string) => NODES.filter((n) => n.kind === k).map((n) => nodeCost(n.kind));
  assert.ok(
    byKind('origin').every((c) => c === 1) &&
      byKind('small').every((c) => c === 1) &&
      byKind('hub').every((c) => c === 1) &&
      byKind('bridge').every((c) => c === 1),
  );
  assert.ok(byKind('notable').every((c) => c === 2));
  assert.ok(byKind('keystone').every((c) => c === 3));
  const whole = sk.pointsFor(NODES.map((n) => n.id));
  assert.ok(whole >= 400, `the whole board costs ${whole} points`);
  assert.ok(100 / whole < 0.25, 'a level 100 character can afford less than a quarter of it');
  // spending: a notable needs 2 free points, a keystone 3; taking one back returns its cost
  const { db, id } = mk(60);
  const path = ['hunter.start', 'hunter.a1', 'hunter.a2', 'hunter.a3']; // start 1 + 1 + 1 + notable 2
  for (const n of path) sk.allocate(db, id, n, T0);
  assert.equal(sk.skillState(db, id, T0).used, 5);
  assert.equal(sk.skillState(db, id, T0).free, 55);
  assert.equal(sk.skillState(db, id, T0).nodes, 4);
  sk.refund(db, id, 'hunter.a3', T0);
  assert.equal(sk.skillState(db, id, T0).used, 3, 'the notable gives its 2 points back');
  // a keystone costs 3: with 2 points left it is refused
  const w = mk(60, 'Keystoner');
  const route = ['hunter.start', ...[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((i) => `hunter.a${i}`)];
  for (const n of route) sk.allocate(w.db, w.id, n, T0);
  const cost = sk.pointsFor(route); // 1 + 7 smalls + 3 notables x 2 = 14
  assert.equal(sk.skillState(w.db, w.id, T0).used, cost);
  w.db.prepare('UPDATE players SET level = ? WHERE id = ?').run(cost + 2, w.id);
  assert.equal(
    code(() => sk.allocate(w.db, w.id, 'hunter.key', T0)),
    'no_points',
    '2 left, the keystone costs 3',
  );
  w.db.prepare('UPDATE players SET level = ? WHERE id = ?').run(cost + 3, w.id);
  sk.allocate(w.db, w.id, 'hunter.key', T0);
  assert.equal(sk.skillState(w.db, w.id, T0).free, 0);
});

test('you can reach other regions through the hubs and bridges', () => {
  const { db, id } = mk(10);
  sk.allocate(db, id, 'hunter.start', T0);
  assert.ok(sk.skillState(db, id, T0).available.includes('hub.6'), 'the hub next to the start node');
  sk.allocate(db, id, 'hub.6', T0);
  sk.allocate(db, id, 'acolyte.start', T0);
  assert.equal(sk.skillState(db, id, T0).start, 'hunter.start', 'the class is still the first one');
  assert.ok(sk.skillState(db, id, T0).available.includes('acolyte.a1'));
});

test('hostile node ids are refused, nothing is spent', () => {
  const { db, id } = mk(5);
  for (const bad of [undefined, null, 5, {}, [], '', '__proto__', 'constructor', 'hunter.a99', 'HUNTER.START', 'hunter.start '.repeat(50)])
    assert.equal(
      code(() => sk.allocate(db, id, bad, T0)),
      'bad_node',
      String(bad),
    );
  assert.equal(sk.skillState(db, id, T0).used, 0);
});

test('taking a node back costs gold, only at the end of a branch, and the points come back', () => {
  const { db, id } = mk(10);
  for (const n of ['hunter.start', 'hunter.a1', 'hunter.a2', 'hunter.a3']) sk.allocate(db, id, n, T0);
  assert.equal(
    code(() => sk.refund(db, id, 'hunter.a1', T0)),
    'would_split',
    'a2 and a3 would hang in the air',
  );
  assert.equal(
    code(() => sk.refund(db, id, 'hunter.start', T0)),
    'would_split',
  );
  assert.equal(
    code(() => sk.refund(db, id, 'hunter.b1', T0)),
    'not_taken',
  );
  const gold = loadPlayer(db, id, T0).gold;
  sk.refund(db, id, 'hunter.a3', T0);
  assert.equal(loadPlayer(db, id, T0).gold, gold - CFG.skillRefundCostPerLevel * 10);
  assert.equal(sk.skillState(db, id, T0).free, 7);
  db.prepare('UPDATE players SET gold = 5 WHERE id = ?').run(id);
  assert.equal(
    code(() => sk.refund(db, id, 'hunter.a2', T0)),
    'no_gold',
  );
  db.prepare('UPDATE players SET gold = 100000 WHERE id = ?').run(id);
  sk.refund(db, id, 'hunter.a2', T0);
  sk.refund(db, id, 'hunter.a1', T0);
  sk.refund(db, id, 'hunter.start', T0);
  assert.equal(sk.skillState(db, id, T0).start, null, 'no class any more');
  sk.allocate(db, id, 'warrior.start', T0); // a new class is possible
});

test('a full reset costs gold (free when nothing is taken) and returns every point', () => {
  const { db, id } = mk(12);
  assert.equal(
    code(() => sk.respec(db, id, T0)),
    'none',
    'nothing to reset, nothing paid',
  );
  assert.equal(loadPlayer(db, id, T0).gold, 100000);
  for (const n of ['warrior.start', 'warrior.a1', 'warrior.a2', 'warrior.a3', 'warrior.b1']) sk.allocate(db, id, n, T0);
  db.prepare('UPDATE players SET gold = 100 WHERE id = ?').run(id);
  assert.equal(
    code(() => sk.respec(db, id, T0)),
    'no_gold',
  );
  db.prepare('UPDATE players SET gold = 100000 WHERE id = ?').run(id);
  sk.respec(db, id, T0);
  assert.equal(loadPlayer(db, id, T0).gold, 100000 - CFG.skillRespecCostPerLevel * 12);
  const s = sk.skillState(db, id, T0);
  assert.equal(s.free, 12);
  assert.deepEqual(s.mods, {});
  assert.equal(s.start, null);
});

test('the health a node adds changes max HP when taken and when given back', () => {
  const { db, id } = mk(10);
  sk.allocate(db, id, 'warrior.start', T0); // +10 max health, +3 strength
  assert.equal(loadPlayer(db, id, T0).max_hp, 310);
  assert.equal(loadPlayer(db, id, T0).hp, 310, 'the new health comes filled (like a Vitality Potion)');
  sk.refund(db, id, 'warrior.start', T0);
  assert.equal(loadPlayer(db, id, T0).max_hp, 300);
  assert.equal(loadPlayer(db, id, T0).hp, 300, 'and never above the new maximum');
  sk.allocate(db, id, 'warrior.start', T0);
  sk.allocate(db, id, 'warrior.c1', T0);
  assert.equal(loadPlayer(db, id, T0).max_hp, 320);
  sk.respec(db, id, T0);
  assert.equal(loadPlayer(db, id, T0).max_hp, 300);
});

test('lowering the level (admin) resets a board that no longer fits, for free', async () => {
  const { reconcile } = sk;
  const { db, id } = mk(5);
  for (const n of ['hunter.start', 'hunter.a1', 'hunter.a2']) sk.allocate(db, id, n, T0);
  db.prepare('UPDATE players SET level = 2 WHERE id = ?').run(id);
  const gold = loadPlayer(db, id, T0).gold;
  reconcile(db, id, T0);
  assert.equal(sk.skillState(db, id, T0).used, 0);
  assert.equal(loadPlayer(db, id, T0).gold, gold);
});

// ---------------------------------------------------------------- the effects
test('attributes: flat first, then percentages (own and all), never below 1; the arena can switch the board off with the equipment', () => {
  const { db, id } = mk();
  const base = battleStats(db, loadPlayer(db, id, T0), { ancestral: false });
  withMods(db, id, { str: 10, strPct: 0.1, allPct: 0.05, def: -100 });
  const s = battleStats(db, loadPlayer(db, id, T0), { ancestral: false });
  assert.equal(s.str, Math.round((base.str + 10) * (1 + 0.1 + 0.05)));
  assert.equal(s.agi, Math.round(base.agi * (1 + 0.05)));
  assert.equal(s.def, 1);
  const off = battleStats(db, loadPlayer(db, id, T0), { ancestral: false, equipment: false });
  assert.equal(off.str, base.str, 'no board bonus when the equipment is switched off');
});

test('health regeneration', () => {
  const { db, id } = mk();
  db.prepare('UPDATE players SET hp = 100 WHERE id = ?').run(id);
  const hp = (m: Mods) => {
    withMods(db, id, m);
    db.prepare('UPDATE players SET hp = 100, hp_at = ? WHERE id = ?').run(T0, id);
    return loadPlayer(db, id, T0 + 5 * HOUR).hp;
  };
  assert.equal(hp({}), 100 + 5 * CFG.hpRegenPerHour);
  assert.equal(hp({ hpRegen: 0.5 }), 100 + 5 * CFG.hpRegenPerHour * 1.5);
  assert.equal(hp({ hpRegen: -2 }), 100, 'never negative');
});

test('hunting: gold, XP, failures and towns', () => {
  const { db, id } = mk();
  db.prepare('UPDATE players SET dex = 5 WHERE id = ?').run(id); // (a low Dexterity: the failure chance is above its 2 % floor)
  const run = (m: Mods, seed = 21, portions = 60) => {
    withMods(db, id, m);
    return eco.resolveHunt(db, loadPlayer(db, id, T0), portions, seeded(seed), T0);
  };
  const base = run({});
  assert.ok(base.gold > 0 && base.xp > 0);
  const rich = run({ huntGold: 0.2, gold: 0.1 });
  assert.ok(Math.abs(rich.gold / base.gold - 1.3) < 0.04, `gold x${rich.gold / base.gold}`);
  const wise = run({ huntXp: 0.5 });
  assert.ok(wise.xp > base.xp * 1.3, 'XP');
  const fails = (r: ReturnType<typeof run>) => r.events.filter((e) => e.failed).length;
  const lucky = run({ huntFail: -0.12 }, 21, 400),
    plain = run({}, 21, 400),
    unlucky = run({ huntFail: 0.3 }, 21, 400);
  assert.ok(fails(lucky) < fails(plain) && fails(plain) < fails(unlucky), `fails ${fails(lucky)} < ${fails(plain)} < ${fails(unlucky)}`);
  const towns = (r: ReturnType<typeof run>) => r.events.filter((e) => e.place !== 'village' && !e.failed).length / r.events.filter((e) => !e.failed).length;
  assert.ok(towns(run({ huntTown: 0.2 }, 21, 600)) > towns(run({}, 21, 600)) + 0.1, 'more towns');
});

test('graveyard wages and the all-gold modifier (also for the shrine), all XP', () => {
  const { db, id } = mk();
  const wage = (m: Mods, h = 10) => {
    withMods(db, id, m);
    return eco.wagesFor(db, loadPlayer(db, id, T0), h);
  };
  assert.equal(wage({}), Math.floor(10 * CFG.workWagePerHour(40)));
  assert.equal(wage({ workWage: 0.5 }), Math.floor(10 * CFG.workWagePerHour(40) * 1.5));
  assert.equal(wage({ workWage: 0.5, gold: 0.2 }), Math.floor(10 * CFG.workWagePerHour(40) * 1.5 * 1.2));
  // really paid when collected by hand
  withMods(db, id, { workWage: 1 });
  eco.startWork(db, id, 4, T0);
  const g0 = loadPlayer(db, id, T0).gold;
  eco.collectWork(db, id, T0 + 4 * HOUR);
  assert.equal(loadPlayer(db, id, T0).gold - g0, Math.floor(4 * CFG.workWagePerHour(40) * 2));
  withMods(db, id, {});
  assert.equal(awardXp(db, id, 10, T0).xpGained, 10);
  withMods(db, id, { xp: 0.5 });
  assert.equal(awardXp(db, id, 10, T0).xpGained, 15);
  withMods(db, id, { xp: -0.9 });
  assert.equal(awardXp(db, id, 10, T0).xpGained, 1, 'a real award never rounds down to nothing');
});

test('raids: the attacker steals more, the defender loses less, the cooldown is shorter', () => {
  const stolen = (atk: Mods, def: Mods, seed: number) => {
    const w = mk(30, 'Attacker');
    const foe = auth.register(w.db, { name: 'Defender', password: 'secret12', race: 'werewolf' }, T0);
    w.db
      .prepare('UPDATE players SET level = 30, gold = 100000, str = 1, def = 1, agi = 1, sta = 1, dex = 1, hp = 300, max_hp = 300, hp_at = ? WHERE id = ?')
      .run(T0, foe);
    w.db.prepare('UPDATE players SET str = 3000, def = 3000, agi = 3000, sta = 3000 WHERE id = ?').run(w.id);
    withMods(w.db, w.id, atk);
    withMods(w.db, foe, def);
    raid.searchOpponent(w.db, w.id, T0, seeded(seed), {});
    return raid.attack(w.db, w.id, foe, T0, seeded(seed)).gold;
  };
  const base = stolen({}, {}, 4);
  assert.ok(base >= 5000);
  assert.ok(Math.abs(stolen({ raidGold: 0.5 }, {}, 4) / base - 1.5) < 0.01);
  assert.ok(Math.abs(stolen({}, { raidShield: 0.4 }, 4) / base - 0.6) < 0.01);
  assert.ok(Math.abs(stolen({}, { raidShield: -0.5 }, 4) / base - 1.5) < 0.01, 'a negative shield (Lone Wolf) means more is lost');
  const w = mk();
  withMods(w.db, w.id, { raidCooldown: 0.5 });
  assert.equal(attackCooldownOf(loadPlayer(w.db, w.id, T0)), CFG.attackCooldown / 2);
  w.db.prepare('UPDATE players SET last_attack_at = ? WHERE id = ?').run(T0, w.id);
  assert.equal(
    code(() => raid.assertCanAttack(loadPlayer(w.db, w.id, T0 + 4 * MIN), T0 + 4 * MIN)),
    'cooldown',
  );
  assert.equal(
    code(() => raid.assertCanAttack(loadPlayer(w.db, w.id, T0 + 5 * MIN), T0 + 5 * MIN)),
    'none',
    'ready after half the time',
  );
});

test('the dungeon: XP, drops, loot value, dungeon health, selling loot', () => {
  const fightOnce = (m: Mods, seed: number) => {
    const w = mk(40, 'Delver2');
    w.db.prepare('UPDATE players SET str = 100000, def = 100000, agi = 100000, sta = 100000 WHERE id = ?').run(w.id);
    withMods(w.db, w.id, m);
    const saved = CFG.dungeonFightCooldown;
    CFG.dungeonFightCooldown = 0;
    const e = dungeon.enterDungeon(w.db, w.id, T0);
    let xp = 0,
      drops = 0,
      value = 0;
    for (let i = 0; i < 30; i++) {
      const r = dungeon.fight(w.db, w.id, T0 + (i + 1) * 1000, seeded(seed + i));
      xp += r.xp;
      if (r.drop) {
        drops++;
        value += r.drop.value;
      }
      if (r.choice) dungeon.chooseReward(w.db, w.id, 0, T0 + (i + 1) * 1000 + 1);
    }
    CFG.dungeonFightCooldown = saved;
    return { xp, drops, value, hp: e.hp, db: w.db, id: w.id };
  };
  const base = fightOnce({}, 100),
    more = fightOnce({ dungeonXp: 0.5, dungeonLoot: 0.5, dungeonDrop: 0.25, dungeonHp: 0.5 }, 100);
  assert.ok(Math.abs(more.xp / base.xp - 1.5) < 0.05, `XP x${more.xp / base.xp}`);
  assert.ok(more.drops > base.drops, 'more drops');
  assert.ok(more.value / more.drops > (base.value / base.drops) * 1.3, 'worth more each');
  assert.equal(more.hp, Math.round(300 * 1.5));
  assert.equal(base.hp, 300);
  // selling to the dealer pays the all-gold bonus
  const w = mk();
  withMods(w.db, w.id, {});
  w.db.prepare("INSERT INTO dungeon_loot (player_id, name, value, depth, found_at) VALUES (?, 'Bone', 1000, 5, ?)").run(w.id, T0);
  withMods(w.db, w.id, { gold: 0.25 });
  assert.equal(dungeon.sellLoot(w.db, w.id, 'all', T0).gold, 1250);
});

test('prices: shop discount, sell bonus, training, hardening, Blood Temple fee, Ancestral Site', () => {
  const { db, id } = mk();
  const gold = () => one(db, 'SELECT gold g FROM players WHERE id = ?', id).g as number;
  let g = gold();
  eco.buyItem(db, id, 'itm_Blade_3', T0);
  const full = g - gold();
  withMods(db, id, { shopDiscount: 0.2 });
  g = gold();
  eco.buyItem(db, id, 'itm_Blade_3', T0);
  assert.equal(g - gold(), Math.round(full * 0.8));
  const inv = one(db, 'SELECT id FROM inventory WHERE player_id = ? LIMIT 1', id).id;
  withMods(db, id, {});
  let s = eco.sellItem(db, id, inv, T0).price;
  eco.buyItem(db, id, 'itm_Blade_3', T0);
  withMods(db, id, { sellBonus: 0.5 });
  assert.equal(eco.sellItem(db, id, one(db, 'SELECT id FROM inventory WHERE player_id = ? LIMIT 1', id).id, T0).price, Math.floor(s * 1.5));
  withMods(db, id, {});
  g = gold();
  eco.trainStat(db, id, 'str', T0);
  const train = g - gold();
  withMods(db, id, { trainDiscount: 0.25 });
  g = gold();
  eco.trainStat(db, id, 'str', T0);
  assert.equal(train, CFG.trainCost(40));
  assert.equal(g - gold(), Math.round(CFG.trainCost(41) * 0.75));
  withMods(db, id, {});
  eco.buyItem(db, id, 'itm_Blade_3', T0);
  const w = one(db, 'SELECT id FROM inventory WHERE player_id = ? LIMIT 1', id).id,
    bladePrice = ITEM_BY_KEY.get('itm_Blade_3')!.price;
  g = gold();
  eco.hardenWeapon(db, id, w, T0);
  assert.equal(g - gold(), CFG.hardenCost(bladePrice, 0));
  withMods(db, id, { hardenDiscount: 0.5 });
  g = gold();
  eco.hardenWeapon(db, id, w, T0);
  assert.equal(g - gold(), Math.round(CFG.hardenCost(bladePrice, 1) * 0.5), 'the second level at half price');
  // temple: the seller's modifier lowers the fee
  const buyer = auth.register(db, { name: 'Buyer', password: 'secret12', race: 'vampire' }, T0);
  db.prepare('UPDATE players SET level = 40, gold = 100000 WHERE id = ?').run(buyer);
  const sellerGold = () => gold();
  withMods(db, id, { templeFeeCut: 0.4 });
  const item = one(db, 'SELECT id FROM inventory WHERE player_id = ? LIMIT 1', id).id;
  temple.listItem(db, id, item, 10000, T0);
  const before = sellerGold();
  temple.buyListing(db, buyer, one(db, "SELECT id FROM temple_listings WHERE status = 'open'").id as number, T0);
  assert.equal(sellerGold() - before, 10000 - Math.floor(10000 * CFG.templeFee * 0.6));
  // ancestral: the fee is lower
  db.prepare('UPDATE players SET level = 40, ancestral_at = 0, ancestral_wins = 4, hp = 300 WHERE id = ?').run(id);
  withMods(db, id, { ancestralFee: 0.5 });
  g = gold();
  eco.ancestralChallenge(db, id, T0, seeded(1));
  assert.equal(g - gold(), Math.round(CFG.ancestralFee(4) * 0.5));
});

test('shrine: blood gathered, tank size, fuel burned', () => {
  const { db, id, rng } = mk();
  db.prepare('UPDATE players SET blood = 0 WHERE id = ?').run(id);
  withMods(db, id, { bloodGather: 0.5, shrineTank: 40 });
  gatherBlood(db, id, 'hunt', 10);
  assert.equal(loadPlayer(db, id, T0).blood, 15);
  assert.equal(tankSize(db, id), CFG.shrineTank + 40);
  gatherBlood(db, id, 'hunt', 1000);
  assert.equal(loadPlayer(db, id, T0).blood, CFG.shrineTank + 40);
  shrine.buyShrine(db, id, T0);
  shrine.setRoutine(db, id, ['work:10'], T0, rng);
  withMods(db, id, { shrineFuel: 0.5 });
  db.prepare('UPDATE players SET blood = 10 WHERE id = ?').run(id);
  shrine.start(db, id, T0, rng);
  assert.equal(one(db, 'SELECT blood b FROM players WHERE id = ?', id).b, 10 - 10 * CFG.shrineBloodPerHour * 0.5, 'half the fuel');
  assert.equal(shrine.shrineState(db, id, T0).bloodPerHour, CFG.shrineBloodPerHour * 0.5);
});

// ---------------------------------------------------------------- the API
const H = { 'content-type': 'application/json' };
async function api() {
  const db = openDb();
  const app = createApp({ db, now: () => T0, rng: seeded(5), security: { limits: false } });
  const post = (path: string, body: unknown, h: Record<string, string> = {}) =>
    app.request(path, { method: 'POST', headers: { ...H, ...h }, body: JSON.stringify(body) });
  const id = ((await (await post('/api/register', { name: 'Apier', password: 'secret12', race: 'vampire' })).json()) as any).id as number;
  const token = ((await (await post('/api/login', { name: 'Apier', password: 'secret12' })).json()) as any).token as string;
  db.prepare('UPDATE players SET level = 8, gold = 100000 WHERE id = ?').run(id);
  return { db, app, post, id, h: { authorization: `Bearer ${token}` } };
}

test("API: the board is public, the character's part needs a login, allocate / refund / respec work and /api/me shows the effect", async () => {
  const { app, post, h } = await api();
  const board = (await (await app.request('/api/skills/board')).json()) as any;
  assert.equal(board.nodes.length, NODES.length);
  assert.equal(board.regions.length, 7);
  assert.equal((await app.request('/api/skills')).status, 401);
  assert.equal((await post('/api/skills/allocate', { node: 'warrior.start' })).status, 401);
  assert.equal((await post('/api/skills/allocate', { node: 'warrior.a1' }, h)).status, 400);
  const s = (await (await post('/api/skills/allocate', { node: 'warrior.start' }, h)).json()) as any;
  assert.equal(s.used, 1);
  assert.equal(s.free, 7);
  assert.equal(s.title, 'Blood Knight');
  assert.ok(s.available.includes('warrior.a1'));
  const me = (await (await app.request('/api/me', { headers: h })).json()) as any;
  assert.equal(me.skillPoints, 7);
  assert.equal(me.skillMods.str, 3);
  assert.equal(me.max_hp, 110);
  assert.equal((await post('/api/skills/refund', { node: 'warrior.start' }, h)).status, 200);
  assert.equal((await post('/api/skills/respec', {}, h)).status, 200);
});

test('API: hostile input to the skill routes never causes a server error', async () => {
  const { post, h } = await api();
  for (const path of ['allocate', 'refund'])
    for (const body of [
      {},
      { node: null },
      { node: 5 },
      { node: ['hunter.start'] },
      { node: '__proto__' },
      { node: 'x'.repeat(5000) },
      { node: { a: 1 } },
      'text',
      [1],
    ]) {
      const r = await post(`/api/skills/${path}`, body, h);
      assert.ok(r.status >= 400 && r.status < 500, `${path} ${JSON.stringify(body).slice(0, 40)} -> ${r.status}`);
    }
});
