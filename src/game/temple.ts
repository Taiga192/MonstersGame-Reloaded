import { CFG, DAY_MS, ITEM_BY_KEY } from '../config.ts';
import type { DB } from '../db-core.ts';
import { assert } from '../errors.ts';
import { modsOf } from './mods.ts';
import { systemMail } from './mail.ts';
import { bump } from './counters.ts';
import { assertFree, loadPlayer, vitalityRoom } from './player.ts';

// Blood Temple: player-to-player market. Blood crystals do not exist in this game, so trading is item-for-gold.
// The temple keeps CFG.templeFee of every sale. Hardening travels with the weapon.

/** Return unsold, expired listings to their sellers. Called before every read/write. */
export function expireListings(db: DB, now: number) {
  const rows = db.prepare("SELECT * FROM temple_listings WHERE status = 'open' AND expires_at <= ?").all(now) as any[];
  for (const l of rows) {
    db.prepare('INSERT INTO inventory (player_id, item_key, bought_at, hardening) VALUES (?,?,?,?)').run(l.seller_id, l.item_key, now, l.hardening);
    db.prepare("UPDATE temple_listings SET status = 'expired' WHERE id = ?").run(l.id);
    systemMail(db, l.seller_id, 'Blood Temple: listing expired', `Your listing of ${ITEM_BY_KEY.get(l.item_key)?.name} expired and the item was returned to your inventory.`, now, { kind: 'market', link: '#/town/temple' });
  }
}

export function listItem(db: DB, playerId: number, inventoryId: number, price: number, now: number) {
  expireListings(db, now);
  assertFree(loadPlayer(db, playerId, now), now);
  const row = db.prepare('SELECT item_key, hardening FROM inventory WHERE id = ? AND player_id = ?').get(inventoryId, playerId) as { item_key: string; hardening: number } | undefined;
  assert(row, 'not_owned', 'You do not own that item', 404);
  assert(Number.isInteger(price) && price >= 1 && price <= 100_000_000, 'bad_price', 'Price must be a whole number of gold, 1 to 100,000,000');
  const open = (db.prepare("SELECT COUNT(*) n FROM temple_listings WHERE seller_id = ? AND status = 'open'").get(playerId) as { n: number }).n;
  assert(open < CFG.templeMaxListings, 'too_many', `You can have at most ${CFG.templeMaxListings} open listings`);
  db.prepare('DELETE FROM inventory WHERE id = ?').run(inventoryId);
  const id = Number(db.prepare('INSERT INTO temple_listings (seller_id, item_key, hardening, price, created_at, expires_at) VALUES (?,?,?,?,?,?)')
    .run(playerId, row.item_key, row.hardening, price, now, now + CFG.templeListingDays * DAY_MS).lastInsertRowid);
  return { id };
}

export function cancelListing(db: DB, playerId: number, listingId: number, now: number) {
  expireListings(db, now);
  const l = db.prepare("SELECT * FROM temple_listings WHERE id = ? AND seller_id = ? AND status = 'open'").get(listingId, playerId) as any;
  assert(l, 'not_found', 'Listing not found', 404);
  db.prepare('INSERT INTO inventory (player_id, item_key, bought_at, hardening) VALUES (?,?,?,?)').run(playerId, l.item_key, now, l.hardening);
  db.prepare("UPDATE temple_listings SET status = 'cancelled' WHERE id = ?").run(listingId);
}

export function buyListing(db: DB, playerId: number, listingId: number, now: number) {
  expireListings(db, now);
  const p = loadPlayer(db, playerId, now);
  assertFree(p, now);
  const l = db.prepare("SELECT * FROM temple_listings WHERE id = ? AND status = 'open'").get(listingId) as any;
  assert(l, 'not_found', 'That listing is gone', 404);
  assert(l.seller_id !== playerId, 'own_listing', 'You cannot buy your own listing');
  const item = ITEM_BY_KEY.get(l.item_key)!;
  assert(p.level >= item.minLevel, 'level_too_low', `Requires level ${item.minLevel}`);
  assert(p.gold >= l.price, 'no_gold', `Need ${l.price} gold`);
  assert(item.potion !== 'maxhp' || vitalityRoom(db, p) > 0, 'vitality_cap', `You cannot use any more Vitality Potions (maximum +${CFG.vitalityCap} max HP in total)`);
  const seller = db.prepare('SELECT skill_mods FROM players WHERE id = ?').get(l.seller_id) as { skill_mods: string };
  const fee = Math.floor(l.price * CFG.templeFee * (1 - (modsOf(seller).templeFeeCut ?? 0))), proceeds = l.price - fee; // (the seller's skill board can lower the fee)
  db.prepare('UPDATE players SET gold = gold - ? WHERE id = ?').run(l.price, playerId);
  db.prepare('UPDATE players SET gold = gold + ? WHERE id = ?').run(proceeds, l.seller_id);
  db.prepare('INSERT INTO inventory (player_id, item_key, bought_at, hardening) VALUES (?,?,?,?)').run(playerId, l.item_key, now, l.hardening);
  db.prepare("UPDATE temple_listings SET status = 'sold', buyer_id = ?, sold_at = ? WHERE id = ?").run(playerId, now, listingId);
  systemMail(db, l.seller_id, 'Blood Temple: item sold', `${p.name} bought your ${item.name}${l.hardening ? ` (+${l.hardening})` : ''} for ${l.price} gold. After the temple fee (${fee}) you received ${proceeds} gold.`, now, { kind: 'market', link: '#/town/temple' });
  bump(db, playerId, 'temple_buys'); bump(db, l.seller_id, 'temple_sales');
  return { paid: l.price, item: item.name };
}

export function browse(db: DB, playerId: number, now: number) {
  expireListings(db, now);
  const rows = db.prepare(
    `SELECT l.id, l.seller_id, p.name AS seller, l.item_key, l.hardening, l.price, l.expires_at
       FROM temple_listings l JOIN players p ON p.id = l.seller_id WHERE l.status = 'open' ORDER BY l.price`,
  ).all() as any[];
  return rows.map((r) => ({ ...r, mine: r.seller_id === playerId }));
}
