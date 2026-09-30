import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CFG, DAY_MS, HOUR, ITEM_BY_KEY, MIN } from '../src/config.ts';
import { openDb, type DB } from '../src/db.ts';
import { ensureBots, tickBots } from '../src/bots/runner.ts';
import * as auth from '../src/game/auth.ts';
import * as eco from '../src/game/economy.ts';
import { systemMail, unreadCount } from '../src/game/mail.ts';
import { loadPlayer } from '../src/game/player.ts';
import * as temple from '../src/game/temple.ts';
import { seeded, type Rng } from '../src/rng.ts';

const T0 = Date.UTC(2027, 0, 15, 12, 0, 0);
const one = (db: DB, sql: string, ...a: any[]) => db.prepare(sql).get(...a) as any;
const give = (db: DB, id: number, key: string, hardening = 0, boughtAt = T0) =>
  Number(db.prepare('INSERT INTO inventory (player_id, item_key, bought_at, hardening) VALUES (?,?,?,?)').run(id, key, boughtAt, hardening).lastInsertRowid);
const price = (key: string) => ITEM_BY_KEY.get(key)!.price;

/** One bot with a fixed persona, level and gold, plus a helper that plays it many sessions in a row. */
function scene(persona = 'worker', gold = 0, level = 45, seed = 7) {
  const db = openDb(), rng: Rng = seeded(seed);
  ensureBots(db, 1, T0, rng);
  const id = one(db, 'SELECT player_id id FROM bots').id as number;
  db.prepare('UPDATE bots SET persona = ?, tz = 12, sessions_left = 99').run(persona); // tz 12 = local afternoon, awake
  db.prepare('INSERT INTO dungeon (player_id, week, reached_at, cooldown_until) VALUES (?, 0, 0, 9000000000000000)').run(id); // keep this scenario out of the dungeon (its loot would change what the bot buys)
  db.prepare('UPDATE players SET gold = ?, level = ?, hp = max_hp, hp_at = ?, str = 30, def = 30, agi = 30, sta = 30, dex = 30 WHERE id = ?').run(gold, level, T0, id);
  let t = T0;
  const play = (sessions: number, gapMin = 40) => { for (let i = 0; i < sessions; i++) { db.prepare('UPDATE bots SET next_at = ?').run(t - MIN); db.prepare('UPDATE players SET hp = max_hp, hp_at = ? WHERE id = ?').run(t, id); tickBots(db, t, rng, { humans: false }); t += gapMin * MIN; } };
  return { db, rng, id, play, now: () => t };
}
const listings = (db: DB, seller: number, status = 'open') => db.prepare('SELECT * FROM temple_listings WHERE seller_id = ? AND status = ?').all(seller, status) as any[];

test('a bot lists gear it does not wear at a price that beats the shop buy-back but stays below replacement cost', () => {
  const { db, id, play } = scene();
  const best = give(db, id, 'itm_Blade_5');                // the weapon it wears
  const spare = give(db, id, 'itm_Blade_3', 2);            // outgrown, hardened +2
  play(25);
  // the bot earns gold too and may buy new armour and list what it outgrew, so look at the specific items
  const open = listings(db, id);
  const spareListing = open.filter((l) => l.item_key === 'itm_Blade_3');
  assert.equal(spareListing.length, 1, 'the spare blade was listed once');
  assert.equal(open.some((l) => l.item_key === 'itm_Blade_5'), false, 'the worn blade was not listed');
  assert.equal(spareListing[0].hardening, 2, 'hardening travels with the item');
  const shop = price('itm_Blade_3');
  assert.ok(spareListing[0].price > Math.floor(shop / 2), `price ${spareListing[0].price} must beat the shop buy-back ${Math.floor(shop / 2)}`);
  const replacement = shop + CFG.hardenCost(shop, 0) + CFG.hardenCost(shop, 1);
  assert.ok(spareListing[0].price <= replacement, `price ${spareListing[0].price} is at most the replacement cost ${replacement}`);
  // (row ids are reused by SQLite after a delete, so check by item type instead of by id)
  assert.equal(one(db, "SELECT COUNT(*) n FROM inventory WHERE player_id = ? AND item_key = 'itm_Blade_5'", id).n, 1, 'the worn weapon is never listed');
  assert.equal(one(db, "SELECT COUNT(*) n FROM inventory WHERE player_id = ? AND item_key = 'itm_Blade_3'", id).n, 0, 'the spare is in escrow');
  void best; void spare;
});

test('cheap junk goes to the shop, potions and worn items are never listed, listing cap is respected', () => {
  const { db, id, play } = scene();
  give(db, id, 'itm_Blade_9');                              // worn
  give(db, id, 'itm_Blade_1');                              // worth 30g: junk
  const potion = give(db, id, 'potion_heal');
  for (const k of ['itm_Blade_2', 'itm_Blade_3', 'itm_Blade_4', 'itm_Blade_5', 'itm_Blade_6']) give(db, id, k); // 5 spares
  const gold0 = loadPlayer(db, id, T0).gold;
  play(60);
  assert.ok(loadPlayer(db, id, T0).gold > gold0, 'junk sold to the shop for gold');
  assert.equal(one(db, 'SELECT COUNT(*) n FROM inventory WHERE item_key = ? AND player_id = ?', 'itm_Blade_1', id).n, 0);
  assert.ok(listings(db, id).length <= 3, 'never more than 3 open listings');
  assert.equal(one(db, "SELECT COUNT(*) n FROM inventory WHERE player_id = ? AND item_key = 'potion_heal'", id).n, 1, 'potion kept');
  void potion;
  assert.equal(listings(db, id).some((l) => l.item_key === 'potion_heal'), false);
  assert.equal(one(db, 'SELECT COUNT(*) n FROM inventory WHERE item_key = ? AND player_id = ?', 'itm_Blade_9', id).n, 1, 'worn weapon kept');
});

test('a bot buys a real bargain from a human, the seller gets paid minus the fee and is notified', () => {
  const { db, id, play } = scene('worker', 3000, 30);
  give(db, id, 'itm_Blade_2');                              // weak weapon: any better blade is an upgrade
  const human = auth.register(db, { name: 'HumanSeller', password: 'secret12', race: 'werewolf' }, T0);
  db.prepare('UPDATE players SET level = 30, gold = 100 WHERE id = ?').run(human);
  const item = give(db, human, 'itm_Blade_5');
  const ask = Math.round(price('itm_Blade_5') * 0.6);      // a clear discount
  temple.listItem(db, human, item, ask, T0);
  play(60);
  assert.equal(listings(db, human, 'sold').length, 1, 'the bot bought it');
  assert.equal(one(db, 'SELECT buyer_id b FROM temple_listings').b, id);
  assert.equal(loadPlayer(db, human, T0).gold, 100 + ask - Math.floor(ask * CFG.templeFee), 'seller paid minus the 5 % temple fee');
  assert.equal(unreadCount(db, human), 1, 'the human is told about the sale');
});

test('a bot does not buy overpriced items, non-upgrades, its own listings, or things above its level', () => {
  const { db, id, play } = scene('worker', 9000, 30);
  give(db, id, 'itm_Blade_8');                              // already wears a strong weapon
  const human = auth.register(db, { name: 'HumanSeller', password: 'secret12', race: 'werewolf' }, T0);
  db.prepare('UPDATE players SET level = 60, gold = 100 WHERE id = ?').run(human);
  const a = give(db, human, 'itm_Blade_3');                 // a downgrade for the bot, even though cheap
  const b = give(db, human, 'itm_Blade_12');                // an upgrade, but requires level 45 (> 30)
  const c = give(db, human, 'itm_Blade_9');                 // an upgrade within level but priced ABOVE the shop
  temple.listItem(db, human, a, 10, T0);
  temple.listItem(db, human, b, 10, T0);
  temple.listItem(db, human, c, Math.round(price('itm_Blade_9') * 1.5), T0);
  play(60);
  assert.equal(listings(db, human, 'sold').length, 0, 'nothing was bought');
  assert.equal(listings(db, human, 'open').length, 3);
  assert.equal(one(db, 'SELECT COUNT(*) n FROM temple_listings WHERE buyer_id = seller_id').n, 0);
});

test('stale listings are repriced 15 % lower, or dumped on the shop when already at the floor', () => {
  const { db, id, play, rng } = scene();
  give(db, id, 'itm_Blade_9');                              // worn
  const old = give(db, id, 'itm_Blade_4');
  const shop = price('itm_Blade_4');
  temple.listItem(db, id, old, shop, T0 - 40 * HOUR);      // asked full shop price, 40 h ago
  assert.equal(listings(db, id).length, 1);
  play(40);
  const now = listings(db, id).filter((l) => l.item_key === 'itm_Blade_4'); // (the bot may also list other gear it outgrew meanwhile)
  assert.equal(now.length, 1);
  assert.ok(now[0].price < shop, `repriced below ${shop}, got ${now[0].price}`);
  assert.ok(now[0].price >= Math.floor(shop / 2) + 1, 'never below the shop buy-back');
  // eventually a listing at the floor is given up and sold to the shop
  db.prepare('UPDATE temple_listings SET price = ?, created_at = ? WHERE status = ?').run(Math.floor(shop / 2) + 1, T0 - 40 * HOUR, 'open');
  const g = loadPlayer(db, id, T0).gold;
  play(60);
  assert.equal(listings(db, id).filter((l) => l.price <= Math.floor(shop / 2) + 1 && l.item_key === 'itm_Blade_4' && l.created_at < T0).length, 0, 'the floor-priced listing is gone');
  // the item went to the shop (not back on the market, not still in the bag). Gold alone cannot prove it: the bot spends it.
  assert.equal(listings(db, id).some((l) => l.item_key === 'itm_Blade_4'), false, 'not relisted');
  assert.equal(one(db, "SELECT COUNT(*) n FROM inventory WHERE player_id = ? AND item_key = 'itm_Blade_4'", id).n, 0, 'not kept');
  void g; void rng;
});

test('unused gear older than 3 days is sold to the shop even when listing slots are full', () => {
  const { db, id, play } = scene();
  give(db, id, 'itm_Blade_9');
  for (let i = 0; i < 3; i++) db.prepare("INSERT INTO temple_listings (seller_id, item_key, hardening, price, created_at, expires_at) VALUES (?,?,?,?,?,?)").run(id, 'itm_Blade_5', 0, 9999, T0, T0 + 7 * DAY_MS); // 3 slots taken
  const old = give(db, id, 'itm_Blade_4', 0, T0 - 4 * DAY_MS);
  play(60);
  assert.equal(one(db, "SELECT COUNT(*) n FROM inventory WHERE player_id = ? AND item_key = 'itm_Blade_4'", id).n, 0, 'sold to the shop');
  void old;
});

test('system mail addressed to a bot is dropped; humans still receive it', () => {
  const db = openDb();
  ensureBots(db, 1, T0, seeded(1));
  const bot = one(db, 'SELECT player_id id FROM bots').id as number;
  const human = auth.register(db, { name: 'Human', password: 'secret12', race: 'vampire' }, T0);
  systemMail(db, bot, 'x', 'y', T0); systemMail(db, human, 'x', 'y', T0);
  assert.equal(one(db, 'SELECT COUNT(*) n FROM mail WHERE to_id = ?', bot).n, 0);
  assert.equal(one(db, 'SELECT COUNT(*) n FROM mail WHERE to_id = ?', human).n, 1);
});

test('market trades conserve gold: buyer pays, seller receives price minus the fee, nothing else moves', () => {
  const db = openDb();
  const a = auth.register(db, { name: 'Seller', password: 'secret12', race: 'vampire' }, T0), b = auth.register(db, { name: 'Buyer', password: 'secret12', race: 'werewolf' }, T0);
  db.prepare('UPDATE players SET level = 30, gold = 5000').run();
  const inv = give(db, a, 'itm_Blade_5', 3);
  const total = () => (one(db, 'SELECT SUM(gold) n FROM players').n as number);
  const before = total();
  const { id } = temple.listItem(db, a, inv, 700, T0);
  temple.buyListing(db, b, id, T0);
  assert.equal(before - total(), Math.floor(700 * CFG.templeFee), 'only the temple fee leaves the economy');
  assert.equal(one(db, 'SELECT hardening h FROM inventory WHERE player_id = ?', b).h, 3);
  void eco;
});
