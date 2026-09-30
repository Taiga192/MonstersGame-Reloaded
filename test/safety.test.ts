import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CFG, HOUR, MIN } from '../src/config.ts';
import { openDb, tx, type DB } from '../src/db.ts';
import { createApp } from '../src/node-app.ts';
import { GameError } from '../src/errors.ts';
import * as auth from '../src/game/auth.ts';
import * as eco from '../src/game/economy.ts';
import { awardXp, loadPlayer } from '../src/game/player.ts';
import * as raid from '../src/game/raid.ts';
import * as temple from '../src/game/temple.ts';
import { seeded, type Rng } from '../src/rng.ts';

const T0 = 1_800_000_000_000;
const code = (fn: () => unknown) => { try { fn(); } catch (e) { return (e as GameError).code; } return 'none'; };
const one = (db: DB, sql: string, ...a: any[]) => db.prepare(sql).get(...a) as any;

/** A strong vampire and some werewolf targets, all healthy. */
function arena(targets = 1) {
  const db = openDb();
  const a = auth.register(db, { name: 'Attacker', password: 'secret12', race: 'vampire' }, T0);
  db.prepare('UPDATE players SET str = 200, def = 200, agi = 200, sta = 200, max_hp = 300, hp = 300, hp_at = ? WHERE id = ?').run(T0, a);
  const ds = Array.from({ length: targets }, (_, i) => {
    const d = auth.register(db, { name: `Target${i}`, password: 'secret12', race: 'werewolf' }, T0);
    db.prepare('UPDATE players SET gold = 1000 WHERE id = ?').run(d);
    return d;
  });
  return { db, a, ds };
}
const findAny = (db: DB, a: number, t: number, rng: Rng) => { for (let i = 0; i < 60; i++) { const r = raid.searchOpponent(db, a, t, rng); if (r.found) return r.target; } return null; };

// ---------------------------------------------------------------- hunting keeps you safe
test('while hunting you cannot be found by a raid search', () => {
  const { db, a, ds } = arena();
  const rng = seeded(1);
  assert.ok(findAny(db, a, T0, rng), 'normally the target is findable');
  db.prepare('UPDATE players SET found_target = NULL').run();
  eco.startHunt(db, ds[0], 3, T0);
  assert.equal(findAny(db, a, T0 + MIN, rng), null, 'a hunting target is never found');
  assert.equal(findAny(db, a, T0 + 29 * MIN, rng), null, 'still safe until the last minute of the hunt');
});

test('a target found BEFORE going hunting cannot be attacked once the hunt has started', () => {
  const { db, a, ds } = arena();
  const rng = seeded(2);
  const t = findAny(db, a, T0, rng)!;
  assert.equal(t.id, ds[0]);
  eco.startHunt(db, ds[0], 2, T0 + MIN); // the target heads out after we found them
  assert.equal(code(() => raid.attack(db, a, ds[0], T0 + 2 * MIN, rng)), 'target_busy');
  assert.equal(one(db, 'SELECT COUNT(*) n FROM battles').n, 0, 'no fight took place');
  assert.equal(loadPlayer(db, ds[0], T0).gold, 1000, 'nothing was stolen');
});

test('hunting protection ends with the hunt: cancelled or finished hunters can be raided again', () => {
  const { db, a, ds } = arena();
  const rng = seeded(3);
  eco.startHunt(db, ds[0], 6, T0);
  eco.cancelHunt(db, ds[0], T0 + 5 * MIN, rng);
  assert.ok(findAny(db, a, T0 + 6 * MIN, rng), 'after cancelling, the hunter is exposed again');

  const b = arena();
  eco.startHunt(b.db, b.ds[0], 1, T0); // a single 10 minute portion, never collected
  assert.equal(findAny(b.db, b.a, T0 + 5 * MIN, seeded(4)), null, 'safe while the timer runs');
  assert.ok(findAny(b.db, b.a, T0 + 11 * MIN, seeded(4)), 'once the time is up the character is no longer away, collected or not');
});

// ---------------------------------------------------------------- raid cooldown
test('the raid cooldown is exactly 10 minutes', () => {
  assert.equal(CFG.attackCooldown, 10 * MIN);
  const { db, a } = arena(3);
  const rng = seeded(5);
  const first = findAny(db, a, T0, rng)!;
  tx(db, () => raid.attack(db, a, first.id, T0, rng));
  assert.equal(code(() => raid.searchOpponent(db, a, T0 + 5 * MIN, seeded(6))), 'cooldown');
  assert.equal(code(() => raid.searchOpponent(db, a, T0 + 10 * MIN - 1000, seeded(6))), 'cooldown', 'still blocked one second before');
  db.prepare('UPDATE players SET hp = max_hp, hp_at = ? WHERE id = ?').run(T0 + 10 * MIN, a);
  assert.notEqual(code(() => raid.searchOpponent(db, a, T0 + 10 * MIN, seeded(6))), 'cooldown', 'allowed again after exactly 10 minutes');
  const second = findAny(db, a, T0 + 10 * MIN, seeded(7));
  assert.ok(second && second.id !== first.id, 'a second raid is possible (the first target is protected for an hour)');
  assert.ok(tx(db, () => raid.attack(db, a, second.id, T0 + 10 * MIN, seeded(7))).battleId > 0);
});

test('the API reports the 10 minute raid cooldown', async () => {
  const db = openDb();
  const app = createApp({ db, now: () => T0, rng: seeded(1) });
  const post = (path: string, b: unknown, token?: string) => app.request(path, { method: 'POST', body: JSON.stringify(b), headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) } });
  await post('/api/register', { name: 'Vlad', password: 'secret12', race: 'vampire' });
  const { token } = await (await post('/api/login', { name: 'Vlad', password: 'secret12' })).json() as { token: string };
  db.prepare('UPDATE players SET last_attack_at = ?').run(T0 - MIN);
  const me = await (await app.request('/api/me', { headers: { authorization: `Bearer ${token}` } })).json() as any;
  assert.equal(me.attackReadyAt, T0 - MIN + 10 * MIN);
  assert.equal(me.vitality_hp, 0); assert.equal(me.vitalityRoom, 15);
});

// ---------------------------------------------------------------- vitality potion cap
function rich() {
  const db = openDb();
  const id = auth.register(db, { name: 'Vital', password: 'secret12', race: 'vampire' }, T0);
  db.prepare('UPDATE players SET gold = 1000000, level = 50 WHERE id = ?').run(id);
  return { db, id };
}
const potions = (db: DB, id: number) => (db.prepare("SELECT id FROM inventory WHERE player_id = ? AND item_key = 'potion_maxhp' ORDER BY id").all(id) as { id: number }[]).map((r) => r.id);

test('vitality potions: +10 max HP each, at most +150 in total (15 potions)', () => {
  const { db, id } = rich();
  const start = loadPlayer(db, id, T0).max_hp;
  for (let i = 0; i < 15; i++) { eco.buyItem(db, id, 'potion_maxhp', T0); eco.usePotion(db, id, potions(db, id)[0], T0); }
  const p = loadPlayer(db, id, T0);
  assert.equal(p.max_hp, start + 150);
  assert.equal(p.vitality_hp, 150);
  // the 16th cannot be bought...
  const gold = p.gold;
  assert.equal(code(() => eco.buyItem(db, id, 'potion_maxhp', T0)), 'vitality_cap');
  assert.equal(loadPlayer(db, id, T0).gold, gold, 'no gold was taken');
  // ...and one that somehow is in the bag cannot be used, and is not consumed
  db.prepare("INSERT INTO inventory (player_id, item_key, bought_at) VALUES (?, 'potion_maxhp', ?)").run(id, T0);
  assert.equal(code(() => eco.usePotion(db, id, potions(db, id)[0], T0)), 'vitality_cap');
  assert.equal(potions(db, id).length, 1, 'the potion is still in the bag');
  assert.equal(loadPlayer(db, id, T0).max_hp, start + 150, 'max HP did not change');
});

test('vitality potions heal by the amount gained, and the cap only concerns potions, not level-ups', () => {
  const { db, id } = rich();
  db.prepare('UPDATE players SET hp = 40 WHERE id = ?').run(id);
  const before = loadPlayer(db, id, T0);
  eco.buyItem(db, id, 'potion_maxhp', T0); eco.usePotion(db, id, potions(db, id)[0], T0);
  const after = loadPlayer(db, id, T0);
  assert.equal(after.max_hp, before.max_hp + 10); assert.equal(Math.round(after.hp), Math.round(before.hp) + 10);
  const lv = after.level;
  awardXp(db, id, 500, T0);
  const grown = loadPlayer(db, id, T0);
  assert.ok(grown.level > lv && grown.max_hp > after.max_hp, 'level-ups still raise max HP');
  assert.equal(grown.vitality_hp, 10, 'and do not count against the potion cap');
});

test('you cannot buy potions you could never use: stock in the bag counts against the cap', () => {
  const { db, id } = rich();
  for (let i = 0; i < 15; i++) eco.buyItem(db, id, 'potion_maxhp', T0); // 15 in the bag, none used
  assert.equal(code(() => eco.buyItem(db, id, 'potion_maxhp', T0)), 'vitality_cap');
  eco.usePotion(db, id, potions(db, id)[0], T0);                       // 14 bag + 1 used = still full
  assert.equal(code(() => eco.buyItem(db, id, 'potion_maxhp', T0)), 'vitality_cap');
  eco.sellItem(db, id, potions(db, id)[0], T0);                        // back to 13 + 1 = room for one
  eco.buyItem(db, id, 'potion_maxhp', T0);
  assert.equal(code(() => eco.buyItem(db, id, 'potion_maxhp', T0)), 'vitality_cap');
  eco.buyItem(db, id, 'potion_heal', T0);                              // other potions are not affected
});

test('the Blood Temple refuses vitality potions you could never use, but other items are fine', () => {
  const { db, id } = rich();
  const seller = auth.register(db, { name: 'Seller', password: 'secret12', race: 'werewolf' }, T0);
  db.prepare('UPDATE players SET gold = 0, level = 50 WHERE id = ?').run(seller);
  const add = (key: string) => Number(db.prepare('INSERT INTO inventory (player_id, item_key, bought_at) VALUES (?,?,?)').run(seller, key, T0).lastInsertRowid);
  const vit = temple.listItem(db, seller, add('potion_maxhp'), 100, T0).id;
  const heal = temple.listItem(db, seller, add('potion_heal'), 100, T0).id;
  for (let i = 0; i < 15; i++) { eco.buyItem(db, id, 'potion_maxhp', T0); eco.usePotion(db, id, potions(db, id)[0], T0); }
  assert.equal(code(() => temple.buyListing(db, id, vit, T0)), 'vitality_cap');
  assert.equal(one(db, "SELECT status s FROM temple_listings WHERE id = ?", vit).s, 'open', 'the listing stays for others');
  temple.buyListing(db, id, heal, T0); // a normal potion is fine
});
