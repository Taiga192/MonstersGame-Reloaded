import { ANCESTRAL, CFG, HOUR, MIN, ITEM_BY_KEY, MAIN_STATS, SENTINEL_BY_KEY, type Stat } from '../../core/config.ts';
import type { DB } from '../../db/core.ts';
import { assert } from '../../core/errors.ts';
import { randInt, type Rng } from '../../core/rng.ts';
import { accomplishmentBonus } from '../character/accomplishments.ts';
import { simulate } from '../combat/combat.ts';
import { bump } from '../character/counters.ts';
import { gatherBlood } from './blood.ts';
import { discounted, factor, modsOf } from '../character/mods.ts';
import { maybeFindComponent } from './components.ts';
import {
  assertFree,
  awardXp,
  battleStats,
  equipmentLoadout,
  isHunting,
  vitalityRoom,
  isWorking,
  loadPlayer,
  ownedItems,
  setHp,
  type Player,
} from '../character/player.ts';

const DAY = 24 * HOUR;

// ---------------- training ----------------
export function trainStat(db: DB, id: number, stat: Stat, now: number) {
  assert(MAIN_STATS.includes(stat), 'bad_stat', 'Unknown attribute');
  const p = loadPlayer(db, id, now);
  assertFree(p, now);
  const cost = discounted(CFG.trainCost(p[stat]), p, 'trainDiscount');
  assert(p.gold >= cost, 'no_gold', `Need ${cost} gold`);
  db.prepare(`UPDATE players SET gold = gold - ?, ${stat} = ${stat} + 1 WHERE id = ?`).run(cost, id);
  bump(db, id, 'train_points');
  return { stat, value: p[stat] + 1, cost };
}

// ---------------- store / inventory ----------------
export function buyItem(db: DB, id: number, key: string, now: number) {
  const item = ITEM_BY_KEY.get(key);
  assert(item, 'bad_item', 'Unknown item', 404);
  assert(!item.noShop, 'not_for_sale', 'The shop does not sell this: you can only find it or buy it from another player');
  const p = loadPlayer(db, id, now);
  assertFree(p, now);
  assert(p.level >= item.minLevel, 'level_too_low', `Requires level ${item.minLevel}`);
  const price = discounted(item.price, p, 'shopDiscount');
  assert(p.gold >= price, 'no_gold', `Need ${price} gold`);
  assert(
    item.potion !== 'maxhp' || vitalityRoom(db, p) > 0,
    'vitality_cap',
    `You cannot use any more Vitality Potions (maximum +${CFG.vitalityCap} max HP in total, counting the ones in your bag)`,
  );
  db.prepare('UPDATE players SET gold = gold - ? WHERE id = ?').run(price, id);
  db.prepare('INSERT INTO inventory (player_id, item_key, bought_at) VALUES (?,?,?)').run(id, key, now);
  bump(db, id, 'items_bought');
}

export function sellItem(db: DB, id: number, inventoryId: number, now: number) {
  const row = db.prepare('SELECT item_key FROM inventory WHERE id = ? AND player_id = ?').get(inventoryId, id) as { item_key: string } | undefined;
  assert(row, 'not_owned', 'You do not own that item', 404);
  const price = Math.floor((ITEM_BY_KEY.get(row.item_key)!.price / 2) * factor(loadPlayer(db, id, now), 'sellBonus')); // items sell at 50 % (plus the skill board's bonus)
  db.prepare('DELETE FROM inventory WHERE id = ?').run(inventoryId);
  db.prepare('UPDATE players SET gold = gold + ? WHERE id = ?').run(price, id);
  bump(db, id, 'items_sold');
  return { price };
}

export function usePotion(db: DB, id: number, inventoryId: number, now: number) {
  const p = loadPlayer(db, id, now);
  const own = ownedItems(db, id).find((o) => o.id === inventoryId);
  assert(own?.def.potion, 'not_potion', 'That is not a potion');
  if (own.def.potion === 'heal') setHp(db, id, p.max_hp, now);
  else if (own.def.potion === 'maxhp') {
    const room = CFG.vitalityCap - p.vitality_hp;
    assert(room > 0, 'vitality_cap', `You have already gained the maximum of +${CFG.vitalityCap} max HP from Vitality Potions`);
    const gain = Math.min(CFG.vitalityGain, room);
    db.prepare('UPDATE players SET vitality_hp = vitality_hp + ? WHERE id = ?').run(gain, id);
    setHp(db, id, p.hp + gain, now, p.max_hp + gain);
  } else db.prepare('UPDATE players SET potion_stat_until = ? WHERE id = ?').run(now + HOUR, id);
  db.prepare('DELETE FROM inventory WHERE id = ?').run(inventoryId);
  bump(db, id, 'potions_used');
}

// ---------------- weapon hardening ----------------
/** Gold sink: each level adds Strength to that weapon and costs more. (Paid in gold; the original used blood crystals.) */
export function hardenWeapon(db: DB, id: number, inventoryId: number, now: number) {
  const p = loadPlayer(db, id, now);
  assertFree(p, now);
  const row = db.prepare('SELECT item_key, hardening FROM inventory WHERE id = ? AND player_id = ?').get(inventoryId, id) as
    { item_key: string; hardening: number } | undefined;
  assert(row, 'not_owned', 'You do not own that item', 404);
  const def = ITEM_BY_KEY.get(row.item_key)!;
  assert(def.slot === 'weapon', 'not_weapon', 'Only weapons can be hardened');
  assert(row.hardening < CFG.hardenMax, 'maxed', `Already hardened to +${CFG.hardenMax}`);
  const cost = discounted(CFG.hardenCost(def.price, row.hardening), p, 'hardenDiscount');
  assert(p.gold >= cost, 'no_gold', `Need ${cost} gold`);
  db.prepare('UPDATE players SET gold = gold - ? WHERE id = ?').run(cost, id);
  db.prepare('UPDATE inventory SET hardening = hardening + 1 WHERE id = ?').run(inventoryId);
  bump(db, id, 'hardenings');
  return { hardening: row.hardening + 1, cost };
}

// ---------------- sentinels ----------------
export function buySentinel(db: DB, id: number, key: string, now: number) {
  const def = SENTINEL_BY_KEY.get(key);
  assert(def, 'bad_sentinel', 'Unknown sentinel', 404);
  const p = loadPlayer(db, id, now);
  assertFree(p, now);
  assert(p.level >= CFG.sentinelMinLevel && p.level >= def.minLevel, 'level_too_low', `Requires level ${Math.max(CFG.sentinelMinLevel, def.minLevel)}`);
  assert(!db.prepare('SELECT 1 FROM sentinels WHERE player_id = ?').get(id), 'has_sentinel', 'Dismiss your current sentinel first');
  assert(p.gold >= def.price, 'no_gold', `Need ${def.price} gold`);
  db.prepare('UPDATE players SET gold = gold - ? WHERE id = ?').run(def.price, id);
  db.prepare('INSERT INTO sentinels (player_id, sentinel_key, active) VALUES (?,?,1)').run(id, key);
}

export function trainSentinel(db: DB, id: number, attr: 'atk' | 'def' | 'sta', now: number) {
  assert(['atk', 'def', 'sta'].includes(attr), 'bad_stat', 'Unknown sentinel attribute');
  const s = db.prepare('SELECT * FROM sentinels WHERE player_id = ?').get(id) as { id: number; t_atk: number; t_def: number; t_sta: number } | undefined;
  assert(s, 'no_sentinel', 'You have no sentinel');
  const p = loadPlayer(db, id, now);
  const cost = CFG.sentinelTrainCost(s[`t_${attr}`]);
  assert(p.gold >= cost, 'no_gold', `Need ${cost} gold`);
  db.prepare('UPDATE players SET gold = gold - ? WHERE id = ?').run(cost, id);
  db.prepare(`UPDATE sentinels SET t_${attr} = t_${attr} + 1, spent = spent + ? WHERE id = ?`).run(cost, s.id);
  return { cost };
}

/** Dismiss: purchase price is refunded in full (sentinels work as gold banks); training is lost. */
export function dismissSentinel(db: DB, id: number) {
  const s = db.prepare('SELECT id, sentinel_key FROM sentinels WHERE player_id = ?').get(id) as { id: number; sentinel_key: string } | undefined;
  assert(s, 'no_sentinel', 'You have no sentinel');
  const refund = SENTINEL_BY_KEY.get(s.sentinel_key)!.price;
  db.prepare('DELETE FROM sentinels WHERE id = ?').run(s.id);
  db.prepare('UPDATE players SET gold = gold + ? WHERE id = ?').run(refund, id);
  return { refund };
}

// ---------------- hideout ----------------
export function upgradeHideout(db: DB, id: number, comp: string, now: number) {
  assert(typeof comp === 'string' && Object.hasOwn(CFG.hideoutMax, comp), 'bad_component', 'Unknown hideout component'); // (`in` would also accept inherited names like "constructor")
  const p = loadPlayer(db, id, now);
  assertFree(p, now);
  const h = db.prepare('SELECT * FROM hideouts WHERE player_id = ?').get(id) as Record<string, number>;
  const next = h[comp] + 1;
  assert(next <= CFG.hideoutMax[comp], 'maxed', 'Already at maximum level');
  const cost = CFG.hideoutCost(comp, next);
  assert(p.gold >= cost, 'no_gold', `Need ${cost} gold`);
  db.prepare('UPDATE players SET gold = gold - ? WHERE id = ?').run(cost, id);
  db.prepare(`UPDATE hideouts SET ${comp} = ? WHERE player_id = ?`).run(next, id);
  return { comp, level: next, cost };
}

// ---------------- hunts (manhunt) ----------------
// A hunt is N x 10 minutes of real time. It locks the character (like graveyard work). Time is
// reserved from the daily budget at the start; cancelling keeps completed portions and refunds the rest.

export function startHunt(db: DB, id: number, portions: number, now: number) {
  const maxPortions = CFG.huntBudget / CFG.huntPortion;
  assert(Number.isInteger(portions) && portions >= 1 && portions <= maxPortions, 'bad_amount', `Portions must be 1-${maxPortions}`);
  const p = loadPlayer(db, id, now);
  assertFree(p, now);
  assert(!p.hunt_started, 'hunt_uncollected', 'Collect the spoils of your last hunt first');
  assert(!p.work_started, 'work_uncollected', 'Collect your graveyard wages first');
  const today = Math.floor(now / DAY);
  const used = p.hunt_day === today ? p.hunt_used : 0;
  const budget = CFG.huntBudget;
  const cost = portions * CFG.huntPortion;
  assert(used + cost <= budget, 'no_hunt_time', `Only ${Math.floor((budget - used) / 60000)} min of hunting left today`);
  db.prepare('UPDATE players SET hunt_day = ?, hunt_used = ?, hunt_started = ?, hunt_until = ?, hunt_portions = ? WHERE id = ?').run(
    today,
    used + cost,
    now,
    now + cost,
    portions,
    id,
  );
  return { until: now + cost };
}

export interface HuntEvent {
  place: string;
  xp: number;
  gold: number;
  failed: boolean;
}

export function resolveHunt(db: DB, p: Player, portions: number, rng: Rng, now: number) {
  const lo = equipmentLoadout(db, p);
  const rewardMult = 1 + lo.huntBonus / 100 + accomplishmentBonus(db, p.id).huntReward; // hunt rings + accomplishments
  const events: HuntEvent[] = [];
  const m = modsOf(p);
  const fail = Math.max(0.02, CFG.huntFailChance(p.dex) + (m.huntFail ?? 0));
  const shift = m.huntTown ?? 0; // towns instead of villages: the village chance gives way, mostly to small towns
  const places = CFG.huntPlaces.map((pl) => ({
    ...pl,
    chance: Math.max(0, pl.chance + (pl.key === 'village' ? -shift : pl.key === 'small_town' ? shift * 0.7 : shift * 0.3)),
  }));
  let xp = 0,
    gold = 0,
    largeTowns = 0;
  const found: string[] = []; // shrine parts found in large towns
  for (let i = 0; i < portions; i++) {
    if (!lo.perfection && rng() < fail) {
      events.push({ place: 'nothing', xp: 0, gold: 0, failed: true });
      continue;
    }
    let roll = rng();
    const place = places.find((pl) => (roll -= pl.chance) < 0) ?? places[0];
    const mult = (1 + place.bonus) * rewardMult;
    const g = Math.round(
      randInt(rng, CFG.huntVillage.gold[0], CFG.huntVillage.gold[1]) *
        mult *
        CFG.huntGoldLevelScale(p.level) *
        CFG.rateGold *
        (1 + (m.huntGold ?? 0) + (m.gold ?? 0)),
    );
    const x = Math.round(CFG.huntVillage.xp * mult * (1 + (m.huntXp ?? 0)));
    events.push({ place: place.key, xp: x, gold: g, failed: false });
    if (place.key === 'large_town') {
      largeTowns++;
      const part = maybeFindComponent(db, p.id, CFG.componentDropLargeTown, now, rng);
      if (part) found.push(part.name);
    }
    xp += x;
    gold += g;
  }
  bump(db, p.id, 'hunt_portions', events.filter((e) => !e.failed).length);
  bump(db, p.id, 'large_towns', largeTowns);
  return { events, xp, gold, found };
}

function finishHunt(db: DB, id: number, p: Player, portions: number, now: number, rng: Rng) {
  const r = resolveHunt(db, p, portions, rng, now);
  db.prepare('UPDATE players SET gold = gold + ?, hunt_started = NULL, hunt_until = NULL, hunt_portions = NULL WHERE id = ?').run(r.gold, id);
  const lv = awardXp(db, id, r.xp, now);
  gatherBlood(db, id, 'hunt', portions); // animals on the way
  bump(db, id, 'hunt_gold', r.gold);
  bump(db, id, 'gold_earned', r.gold);
  return { ...r, xp: lv.xpGained, levelsGained: lv.levelsGained };
}

export function collectHunt(db: DB, id: number, now: number, rng: Rng) {
  const p = loadPlayer(db, id, now);
  assert(p.hunt_started && p.hunt_until != null && p.hunt_portions != null, 'not_hunting', 'You are not hunting');
  assert(!isHunting(p, now), 'still_hunting', 'Your hunt is not over yet');
  return finishHunt(db, id, p, p.hunt_portions!, now, rng);
}

/** Give up early: completed 10-minute portions pay out, the unused time goes back into today's budget. */
export function cancelHunt(db: DB, id: number, now: number, rng: Rng) {
  const p = loadPlayer(db, id, now);
  assert(p.hunt_started && p.hunt_portions != null, 'not_hunting', 'You are not hunting');
  const done = Math.min(p.hunt_portions!, Math.floor((now - p.hunt_started!) / CFG.huntPortion));
  const refund = (p.hunt_portions! - done) * CFG.huntPortion;
  if (p.hunt_day === Math.floor(now / DAY)) db.prepare('UPDATE players SET hunt_used = MAX(0, hunt_used - ?) WHERE id = ?').run(refund, id);
  return { ...finishHunt(db, id, p, done, now, rng), portionsCompleted: done, cancelled: true };
}

// ---------------- victim link ----------------
export function bite(db: DB, linkOwnerId: number, visitorKey: string, now: number, rng: Rng) {
  const owner = db.prepare('SELECT id FROM players WHERE id = ?').get(linkOwnerId);
  assert(owner, 'not_found', 'Unknown victim link', 404);
  const day = Math.floor(now / DAY);
  const today = (db.prepare('SELECT COUNT(*) n FROM bites WHERE link_player = ? AND day = ?').get(linkOwnerId, day) as { n: number }).n;
  assert(today < CFG.biteDailyCap, 'bite_limit', 'This victim has been bitten enough for today', 429); // a hard ceiling, whoever the visitors are
  const r = db.prepare('INSERT OR IGNORE INTO bites (link_player, visitor, day) VALUES (?,?,?)').run(linkOwnerId, String(visitorKey).slice(0, 64), day);
  assert(Number(r.changes) > 0, 'already_bitten', 'You already bit this victim today');
  const amount = Math.max(1, Math.round(randInt(rng, CFG.biteGoldMin, CFG.biteGoldMax) * CFG.rateGold));
  db.prepare('UPDATE players SET gold = gold + ? WHERE id = ?').run(amount, linkOwnerId);
  bump(db, linkOwnerId, 'bites_received');
  return { amount };
}

// ---------------- graveyard work ----------------
// One shift of up to 48 h. Locks the character (no hunting, raiding, shopping...). Cancelling pays the time worked.
export function startWork(db: DB, id: number, hours: number, now: number) {
  assert(Number.isInteger(hours) && hours >= 1 && hours <= CFG.workMaxHours, 'bad_amount', `Work 1-${CFG.workMaxHours} hours`);
  const p = loadPlayer(db, id, now);
  assertFree(p, now);
  assert(!p.work_started, 'work_uncollected', 'Collect your previous shift first');
  assert(!p.hunt_started, 'hunt_uncollected', 'Collect the spoils of your hunt first');
  db.prepare('UPDATE players SET work_started = ?, work_until = ?, work_hours = ? WHERE id = ?').run(now, now + hours * HOUR, hours, id);
}

/** What `hours` of graveyard work pay a character (hours may be fractional: a shift cut short). */
export const wagesFor = (db: DB, p: Player, hours: number, share = 1) =>
  Math.floor(
    hours * CFG.workWagePerHour(p.level) * (1 + accomplishmentBonus(db, p.id).workWage + (modsOf(p).workWage ?? 0)) * (1 + (modsOf(p).gold ?? 0)) * share,
  );

const clearWork = (db: DB, id: number, wages: number) =>
  db.prepare('UPDATE players SET gold = gold + ?, work_started = NULL, work_until = NULL, work_hours = NULL WHERE id = ?').run(wages, id);

export function collectWork(db: DB, id: number, now: number) {
  const p = loadPlayer(db, id, now);
  assert(p.work_started && p.work_until != null && p.work_hours != null, 'not_working', 'You are not working');
  assert(!isWorking(p, now), 'still_working', 'Your shift is not over yet');
  const wages = wagesFor(db, p, p.work_hours!);
  bump(db, id, 'work_hours', p.work_hours!);
  bump(db, id, 'work_gold', wages);
  clearWork(db, id, wages);
  gatherBlood(db, id, 'work', p.work_hours!);
  bump(db, id, 'gold_earned', wages);
  return { wages, cancelled: false };
}

/** Quit early: paid pro rata for the time actually worked (to the minute). */
export function cancelWork(db: DB, id: number, now: number) {
  const p = loadPlayer(db, id, now);
  assert(p.work_started && p.work_hours != null && isWorking(p, now), 'not_working', 'You are not working');
  const worked = Math.min(now - p.work_started!, p.work_hours! * HOUR);
  const wages = wagesFor(db, p, Math.floor(worked / MIN) / 60);
  bump(db, id, 'work_hours', Math.floor(worked / HOUR));
  bump(db, id, 'work_gold', wages);
  clearWork(db, id, wages);
  gatherBlood(db, id, 'work', Math.floor(worked / HOUR));
  bump(db, id, 'gold_earned', wages);
  return { wages, cancelled: true, minutesWorked: Math.floor(worked / MIN) };
}

// ---------------- ancestral site ----------------
export function ancestralChallenge(db: DB, id: number, now: number, rng: Rng) {
  const p = loadPlayer(db, id, now);
  assertFree(p, now);
  assert(p.level >= CFG.ancestralMinLevel, 'level_too_low', `Requires level ${CFG.ancestralMinLevel}`);
  assert(now - p.ancestral_at >= CFG.ancestralCooldown, 'cooldown', 'The ancestors rest; return in 24 hours');
  const fee = discounted(CFG.ancestralFee(p.ancestral_wins), p, 'ancestralFee');
  assert(p.gold >= fee, 'no_gold', `The challenge costs ${fee} gold`);
  assert(p.hp >= CFG.hpProtectThreshold, 'too_weak', 'You are too weak');
  db.prepare('UPDATE players SET gold = gold - ?, ancestral_at = ? WHERE id = ?').run(fee, now, id);

  const mine = battleStats(db, p, { ancestral: true });
  const scale = 1 + 0.03 * p.ancestral_wins; // [ASSUMED] the ancestor grows with each victory
  const ancestor = Object.fromEntries(MAIN_STATS.map((s) => [s, Math.round(mine[s] * scale)])) as typeof mine;
  const res = simulate({ name: p.name, stats: mine, hp: p.hp, maxHp: p.max_hp }, { name: 'Ancestor', stats: ancestor, hp: p.max_hp, maxHp: p.max_hp }, rng);
  setHp(db, id, res.hpA, now);
  if (res.winner !== 'a') return { won: false, fee };

  db.prepare('UPDATE players SET ancestral_wins = ancestral_wins + 1 WHERE id = ?').run(id);
  bump(db, id, 'ancestral_wins');
  const slots = CFG.ancestralSlots(p.level);
  const known = db.prepare('SELECT skill_key FROM ancestral_skills WHERE player_id = ?').all(id) as { skill_key: string }[];
  let learned: string;
  if (known.length < slots) {
    const pool = ANCESTRAL[p.race].filter((a) => !known.some((k) => k.skill_key === a.key));
    learned = pool[Math.floor(rng() * pool.length)].key;
    db.prepare('INSERT INTO ancestral_skills (player_id, skill_key) VALUES (?,?)').run(id, learned);
  } else {
    learned = known[Math.floor(rng() * known.length)].skill_key;
    db.prepare('UPDATE ancestral_skills SET level = level + 1 WHERE player_id = ? AND skill_key = ?').run(id, learned);
  }
  return { won: true, fee, skill: learned };
}
