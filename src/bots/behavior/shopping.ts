import type { DB } from '../../db/core.ts';
import { CFG, ITEMS, MAIN_STATS, SENTINELS, type ItemDef, type Stat } from '../../core/config.ts';
import { randInt } from '../../core/rng.ts';
import { accomplishmentStatus, activateSet, getSets, saveSet } from '../../game/character/accomplishments.ts';
import { discounted } from '../../game/character/mods.ts';
import * as eco from '../../game/world/economy.ts';
import { effectiveBonus, loadPlayer, ownedItems, type Player } from '../../game/character/player.ts';
import { type Persona } from '../personas.ts';
import { attempt, ok, pickWeighted, type Ctx } from '../context.ts';
import { questTurn, skillTurn } from './progression.ts';
import { shrineSetup } from './shrine.ts';
import { marketBuy, marketSell } from './market.ts';

export function maintain(ctx: Ctx, id: number, persona: Persona, note: (a: string) => void) {
  const { db, now, rng } = ctx;
  let p = loadPlayer(db, id, now);
  // heal when badly hurt (potion if we have one, buy one if we can afford it)
  if (p.hp < p.max_hp * 0.5) {
    let potion = ownedItems(db, id).find((o) => o.def.potion === 'heal');
    if (!potion && p.gold >= 120) {
      ok(() => eco.buyItem(db, id, 'potion_heal', now));
      potion = ownedItems(db, id).find((o) => o.def.potion === 'heal');
    }
    if (potion && ok(() => eco.usePotion(db, id, potion!.id, now))) note('potion');
    p = loadPlayer(db, id, now);
  }
  if (rng() < persona.trade) {
    marketBuy(ctx, loadPlayer(db, id, now), persona, note);
    p = loadPlayer(db, id, now);
  } // player offers are cheaper than the shop
  spend(ctx, p, persona, note);
  shrineSetup(ctx, loadPlayer(db, id, now), persona, note);
  skillTurn(ctx, id, persona, note);
  questTurn(ctx, id, note);
  if (rng() < persona.trade) marketSell(ctx, id, persona, note);
  tuneAccomplishments(ctx, id, note);
  p = loadPlayer(db, id, now);
  if (p.level >= CFG.ancestralMinLevel && p.gold >= CFG.ancestralFee(p.ancestral_wins) * 1.5 && now - p.ancestral_at >= CFG.ancestralCooldown) {
    const r = attempt(() => eco.ancestralChallenge(db, id, now, rng));
    if (r) note(r.won ? 'ancestral win' : 'ancestral loss');
  }
}

/** potions are consumed and shrine parts are installed, neither is gear that is worn or sold as surplus */
export const NOT_GEAR = new Set<string>(['potion', 'component']);
export const catKey = (d: ItemDef) => (d.slot === 'ring' ? `ring:${d.ringKind}` : `${d.slot}:${MAIN_STATS.find((s) => d.bonus[s]) ?? d.key}`);
export const itemValue = (d: ItemDef, persona: Persona, hardening = 0) =>
  Object.values(effectiveBonus(d, hardening)).reduce((a, b) => a + (b ?? 0), 0) +
  (d.goldBonus ?? 0) * persona.goldRing +
  (d.huntBonus && d.huntBonus < 1000 ? d.huntBonus * persona.huntRing : 0);

/** Value of the best usable item we own in each gear category (hardening included). */
export function bestValues(db: DB, p: Player, persona: Persona) {
  const best = new Map<string, number>();
  for (const o of ownedItems(db, p.id))
    if (o.def.minLevel <= p.level && !NOT_GEAR.has(o.def.slot))
      best.set(catKey(o.def), Math.max(best.get(catKey(o.def)) ?? 0, itemValue(o.def, persona, o.hardening)));
  return best;
}
/** Would this persona ever want this item? (amulets are only worth it for perfection-seeking hunters) */
export const wanted = (def: ItemDef, persona: Persona) => !NOT_GEAR.has(def.slot) && (def.slot !== 'amulet' || amuletWanted(def, persona));
/** amulet of mights (stat amulets) are for everybody; the Amulet of Perfection only pays off for dedicated hunters; the healing amulet has no effect worth buying */
export function amuletWanted(def: ItemDef, persona: Persona) {
  return def.key === 'amulet_perfection' ? persona.hunt >= 0.8 : Object.keys(def.bonus).length > 0;
}
/** What it would cost to get this item from the shop plus paying for its hardening levels: the ceiling for any fair market price. */
export const replacementCost = (def: ItemDef, hardening: number) =>
  def.price + Array.from({ length: hardening }, (_, l) => CFG.hardenCost(def.price, l)).reduce((a, b) => a + b, 0);

export function spend(ctx: Ctx, p0: Player, persona: Persona, note: (a: string) => void) {
  const { db, now, rng } = ctx;
  let p = p0;
  let budget = p.gold - 40 - Math.floor(p.gold * persona.save); // keep enough for a potion
  if (budget <= 0) return;

  // gear: buy the biggest upgrade we can afford. When a much bigger one is within ~10 days of income but not yet affordable,
  // save for it instead of spending everything on training (what a sensible player does; gear is far cheaper per point than training)
  const best = bestValues(db, p, persona);
  const cands: { def: ItemDef; gain: number }[] = [];
  for (const def of ITEMS) {
    if (NOT_GEAR.has(def.slot) || (def.slot === 'amulet' && !amuletWanted(def, persona)) || def.minLevel > p.level) continue;
    const gain = itemValue(def, persona) - (best.get(catKey(def)) ?? 0);
    if (gain > 0) cands.push({ def, gain });
  }
  const byGain = (a: { gain: number }, b: { gain: number }) => b.gain - a.gain;
  const goal = cands.filter((c) => c.def.price <= Math.max(600, p.level * 700)).sort(byGain)[0];
  const affordable = cands.filter((c) => c.def.price <= budget * 0.9).sort(byGain)[0];
  const pick = affordable && (!goal || affordable.gain >= goal.gain * 0.6) ? affordable : null;
  if (pick && ok(() => eco.buyItem(db, p.id, pick.def.key, now))) {
    budget -= pick.def.price;
    note(`buy ${pick.def.name}`);
  } else if (goal && !pick) {
    note(`saving for ${goal.def.name}`);
    budget = Math.floor(budget * 0.35);
  } // most of it is put aside, the rest still trains

  // sentinel: buy the best affordable one; upgrade (dismiss refunds the full price) when a clearly better one is affordable
  if (p.level >= CFG.sentinelMinLevel) {
    const owned = db.prepare('SELECT id, sentinel_key FROM sentinels WHERE player_id = ?').get(p.id) as { id: number; sentinel_key: string } | undefined;
    const cur = owned ? SENTINELS.find((s) => s.key === owned.sentinel_key) : undefined;
    const funds = budget + (cur?.price ?? 0);
    const better = SENTINELS.filter(
      (s) => Math.max(CFG.sentinelMinLevel, s.minLevel) <= p.level && s.price <= funds * 0.6 && (!cur || s.price > cur.price * 1.5),
    ).sort((a, b) => b.price - a.price)[0];
    if (better) {
      if (owned) ok(() => eco.dismissSentinel(db, p.id));
      if (ok(() => eco.buySentinel(db, p.id, better.key, now))) {
        note(`sentinel ${better.name}`);
        budget = funds - better.price;
      } else if (owned) ok(() => eco.buySentinel(db, p.id, owned.sentinel_key, now)); // could not upgrade: take the old one back
    }
    const s = db.prepare('SELECT t_atk, t_def, t_sta FROM sentinels WHERE player_id = ?').get(p.id) as
      { t_atk: number; t_def: number; t_sta: number } | undefined;
    if (s)
      for (let i = 0; i < 6; i++) {
        const attr = (['atk', 'def', 'sta'] as const)[randInt(rng, 0, 2)];
        const cost = CFG.sentinelTrainCost(s[`t_${attr}`]);
        if (budget < cost * 3) break; // sentinel points are cheap early, expensive later
        if (attempt(() => eco.trainSentinel(db, p.id, attr, now)) === undefined) break;
        s[`t_${attr}`]++;
        budget -= cost;
      }
  }

  // weapon hardening with spare gold
  const blade = ownedItems(db, p.id)
    .filter((o) => o.def.slot === 'weapon' && o.def.minLevel <= p.level)
    .sort((a, b) => b.def.minLevel - a.def.minLevel)[0];
  if (
    blade &&
    blade.hardening < CFG.hardenMax &&
    budget > CFG.hardenCost(blade.def.price, blade.hardening) * 3 &&
    attempt(() => eco.hardenWeapon(db, p.id, blade.id, now))
  )
    budget -= CFG.hardenCost(blade.def.price, blade.hardening);

  // hideout: cheapest next level when clearly affordable
  const h = db.prepare('SELECT * FROM hideouts WHERE player_id = ?').get(p.id) as Record<string, number>;
  const comp = Object.keys(CFG.hideoutMax)
    .filter((c) => h[c] < CFG.hideoutMax[c])
    .sort((a, b) => CFG.hideoutCost(a, h[a] + 1) - CFG.hideoutCost(b, h[b] + 1))[0];
  if (comp && budget > CFG.hideoutCost(comp, h[comp] + 1) * 4 && rng() < 0.4 && attempt(() => eco.upgradeHideout(db, p.id, comp, now))) {
    budget -= CFG.hideoutCost(comp, h[comp] + 1);
    note(`hideout ${comp}`);
  }

  // attribute training with what is left, following the persona's stat weights
  p = loadPlayer(db, p.id, now);
  for (let i = 0; i < 25; i++) {
    const stat = pickWeighted(rng, persona.stats) as Stat;
    const cost = discounted(CFG.trainCost(p[stat]), p, 'trainDiscount');
    if (budget < cost) break;
    if (attempt(() => eco.trainStat(db, p.id, stat, now)) === undefined) break;
    p = { ...p, [stat]: p[stat] + 1 };
    budget -= cost;
    if (i === 0) note('train');
  }
}

/** Put the five best earned accomplishments into set 1 and activate it (only when it changed). */
export function tuneAccomplishments(ctx: Ctx, id: number, note: (a: string) => void) {
  const { db } = ctx;
  const best = accomplishmentStatus(db, id)
    .filter((a) => a.tier > 0)
    .sort((a, b) => b.tier - a.tier)
    .slice(0, 5)
    .map((a) => a.key);
  if (!best.length) return;
  const cur = getSets(db, id)[0];
  if (cur.active && best.length === cur.keys.length && best.every((k) => cur.keys.includes(k))) return;
  attempt(() => {
    saveSet(db, id, 0, best);
    activateSet(db, id, 0);
    note('achievements');
  });
}
