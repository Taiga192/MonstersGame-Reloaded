import { DAY_MS, HOUR, ITEM_BY_KEY } from '../../core/config.ts';
import * as eco from '../../game/world/economy.ts';
import { equipmentLoadout, loadPlayer, ownedItems, type Player } from '../../game/character/player.ts';
import * as temple from '../../game/world/temple.ts';
import { type Persona } from '../personas.ts';
import { ok, type Ctx } from '../context.ts';
import { NOT_GEAR, bestValues, catKey, itemValue, replacementCost, wanted } from './shopping.ts';

export const MAX_BOT_LISTINGS = 3;

/** Buy the best upgrade on offer, but only at a clear discount to what the same item would cost otherwise. */
export function marketBuy(ctx: Ctx, p: Player, persona: Persona, note: (a: string) => void) {
  const { db, now } = ctx;
  const budget = p.gold - 40 - Math.floor(p.gold * persona.save);
  if (budget <= 0) return;
  const best = bestValues(db, p, persona);
  let pick: { id: number; score: number; name: string } | null = null;
  for (const l of temple.browse(db, p.id, now) as { id: number; seller_id: number; item_key: string; hardening: number; price: number }[]) {
    const def = ITEM_BY_KEY.get(l.item_key);
    if (!def || l.seller_id === p.id || !wanted(def, persona) || def.minLevel > p.level || l.price > budget) continue;
    if (l.price > replacementCost(def, l.hardening) * 0.92) continue; // not a bargain
    const gain = itemValue(def, persona, l.hardening) - (best.get(catKey(def)) ?? 0);
    if (gain <= 0) continue;
    const score = gain / l.price;
    if (!pick || score > pick.score) pick = { id: l.id, score, name: def.name };
  }
  if (pick && ok(() => temple.buyListing(db, p.id, pick!.id, now))) note(`temple buy ${pick.name}`);
}

/** List gear we no longer wear at a competitive price; cheap junk goes to the shop; stale listings are repriced. */
export function marketSell(ctx: Ctx, id: number, persona: Persona, note: (a: string) => void) {
  const { db, now, rng } = ctx;
  const p = loadPlayer(db, id, now);
  const wearing = new Set(equipmentLoadout(db, p).equipped);
  const surplus = ownedItems(db, id).filter((o) => !NOT_GEAR.has(o.def.slot) && !wearing.has(o.id) && !(o.def.minLevel > p.level && rng() < 0.7));
  let open = (db.prepare("SELECT COUNT(*) n FROM temple_listings WHERE seller_id = ? AND status = 'open'").get(id) as { n: number }).n;

  // reprice: a listing nobody bought for 36 h is withdrawn and offered again 15 % cheaper; one that is already at the floor
  // (the shop's buy-back price) is simply sold to the shop, because clearly nobody wants it
  const stale = db
    .prepare("SELECT id, item_key, hardening, price FROM temple_listings WHERE seller_id = ? AND status = 'open' AND created_at < ?")
    .all(id, now - 36 * HOUR) as { id: number; item_key: string; hardening: number; price: number }[];
  for (const l of stale) {
    if (rng() > 0.5) continue;
    const floor = Math.floor(ITEM_BY_KEY.get(l.item_key)!.price / 2) + 1;
    if (!ok(() => temple.cancelListing(db, id, l.id, now))) continue;
    const back = db
      .prepare('SELECT id FROM inventory WHERE player_id = ? AND item_key = ? AND hardening = ? ORDER BY id DESC LIMIT 1')
      .get(id, l.item_key, l.hardening) as { id: number } | undefined;
    if (!back) continue;
    if (l.price <= floor * 1.05) {
      if (ok(() => eco.sellItem(db, id, back.id, now))) note('sold unwanted item to the shop');
    } else if (ok(() => temple.listItem(db, id, back.id, Math.max(floor, Math.round(l.price * 0.85)), now))) note('repriced a listing');
  }
  // gear that has sat unused for 3 days is not coming back into use: clear it out
  for (const o of surplus) if (now - o.boughtAt > 3 * DAY_MS && ok(() => eco.sellItem(db, id, o.id, now))) note('cleared old gear');

  for (const o of ownedItems(db, id)
    .filter((x) => surplus.some((sx) => sx.id === x.id))
    .slice(0, 2)) {
    // (re-read: some may have just been sold)
    if (o.def.price < 80) {
      if (ok(() => eco.sellItem(db, id, o.id, now))) note('sold junk to the shop');
      continue;
    }
    if (open >= MAX_BOT_LISTINGS) break;
    const price = Math.max(Math.floor(o.def.price / 2) + 1, Math.round(replacementCost(o.def, o.hardening) * (0.55 + rng() * 0.4))); // always beats the shop's 50 % buy-back
    if (ok(() => temple.listItem(db, id, o.id, price, now))) {
      open++;
      note(`listed ${o.def.name} for ${price}`);
    }
  }
}
