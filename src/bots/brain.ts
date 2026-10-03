import { CFG, DAY_MS, HOUR, ITEM_BY_KEY, ITEMS, MAIN_STATS, MIN, SENTINELS, type ItemDef, type Stat } from '../config.ts';
import type { DB } from '../db-core.ts';
import { GameError } from '../errors.ts';
import { randInt, type Rng } from '../rng.ts';
import { accomplishmentStatus, activateSet, getSets, saveSet } from '../game/accomplishments.ts';
import * as arena from '../game/arena.ts';
import * as clan from '../game/clan.ts';
import * as dungeon from '../game/dungeon.ts';
import * as shrine from '../game/shrine.ts';
import * as skills from '../game/skills.ts';
import * as questsApi from '../game/quests.ts';
import { NODE_BY_ID, NODES } from '../skills.ts';
import { discounted } from '../game/mods.ts';
import * as eco from '../game/economy.ts';
import * as forum from '../game/forum.ts';
import { attackCooldownOf, battleStats, effectiveBonus, equipmentLoadout, isBusy, isHunting, isWorking, loadPlayer, ownedItems, type Player, isInDungeon } from '../game/player.ts';
import { attack, searchOpponent } from '../game/raid.ts';
import * as temple from '../game/temple.ts';
import { warAttack, warOf } from '../game/war.ts';
import { clanName } from './names.ts';
import { PERSONAS, type Persona } from './personas.ts';

/**
 * The bot "brain": one call = one play session. Bots use the very same game services as players, so they can never
 * do anything a human could not (no cheating, no rule drift). Invalid attempts are just refused by the rules (GameError).
 */
export interface Ctx { db: DB; now: number; rng: Rng; /** may bots raid real (human) players? */ humans: boolean; humanRaidChance: number }
export interface BotRow { player_id: number; persona: string; tz: number; sessions_left: number }
export interface SessionResult { nextAt: number; sessionsLeft: number; actions: string[] }

/** Run a game action; rule violations (GameError) are expected and mean "not possible right now". */
function attempt<T>(fn: () => T): T | undefined {
  try { return fn(); } catch (e) { if (e instanceof GameError) return undefined; throw e; }
}
/** Same, for actions that return nothing: true when the rules allowed it. */
function ok(fn: () => unknown): boolean {
  try { fn(); return true; } catch (e) { if (e instanceof GameError) return false; throw e; }
}
const pickWeighted = <K extends string>(rng: Rng, w: Record<K, number>): K => {
  const keys = Object.keys(w) as K[]; let x = rng() * keys.reduce((s, k) => s + w[k], 0);
  for (const k of keys) { x -= w[k]; if (x < 0) return k; }
  return keys[keys.length - 1];
};
const localHour = (now: number, tz: number) => (((Math.floor(now / HOUR) + tz) % 24) + 24) % 24;
const isNight = (now: number, tz: number) => { const h = localHour(now, tz); return h >= 1 && h < 7; };
const huntLeft = (p: Player, now: number) => CFG.huntBudget - (p.hunt_day === Math.floor(now / DAY_MS) ? p.hunt_used : 0);

export function runSession(ctx: Ctx, bot: BotRow): SessionResult {
  const { db, now, rng } = ctx;
  const persona = PERSONAS[bot.persona] ?? PERSONAS.balanced;
  const id = bot.player_id;
  const actions: string[] = [];
  const note = (a: string) => actions.push(a);

  questsApi.ensureWeek(db, now); // a new quest week starts before anything counts in it

  // 1) collect anything that finished while the bot was away
  let p = loadPlayer(db, id, now);
  if (p.hunt_started && !isHunting(p, now)) { const r = attempt(() => eco.collectHunt(db, id, now, rng)); if (r) note(`hunt +${r.xp}xp +${r.gold}g`); }
  if (p.work_started && !isWorking(p, now)) { const r = attempt(() => eco.collectWork(db, id, now)); if (r) note(`work +${r.wages}g`); }
  shrine.settle(db, id, now, rng); // what the shrine did while the bot was away
  shrine.pause(db, id, now, rng);  // now the bot plays by hand
  p = loadPlayer(db, id, now);
  if (isInDungeon(p, now)) { // a run in progress: one fight whenever the wait between fights is over; nothing else is possible while inside
    const next = dungeonContinue(ctx, id, note);
    if (next != null) return { nextAt: next, sessionsLeft: bot.sessions_left, actions };
    p = loadPlayer(db, id, now);
  }
  if (isBusy(p, now)) return { nextAt: Math.max(p.hunt_until ?? 0, p.work_until ?? 0) + randInt(rng, 1, 8) * MIN, sessionsLeft: bot.sessions_left, actions };

  // 2) maintenance and spending, then social life
  maintain(ctx, id, persona, note);
  social(ctx, id, persona, note);
  arenaTurn(ctx, id, persona, note);
  const inside = isNight(now, bot.tz) ? null : dungeonTurn(ctx, id, persona, note); // (nobody starts a dungeon run at 3 am: the bots sleep)
  if (inside != null) return { nextAt: inside, sessionsLeft: bot.sessions_left, actions }; // entered the dungeon: stays there until the run ends

  // 3) the main activity of this session
  let sessionsLeft = bot.sessions_left - 1;
  raid(ctx, id, persona, note);
  p = loadPlayer(db, id, now);
  const goAway = sessionsLeft <= 0 || (isNight(now, bot.tz) && rng() < 0.7);
  let started = false, shrineAwayFor = 0;
  if (!isBusy(p, now)) {
    if (goAway && shrineAway(ctx, id, persona, note)) { shrineAwayFor = randInt(rng, 240, 600); started = true; }
    else if (goAway) started = longActivity(ctx, p, persona, isNight(now, bot.tz), note);
    else if (persona.hunt > 0.5 && huntLeft(p, now) >= 30 * MIN && rng() < persona.hunt * 0.45) started = ok(() => eco.startHunt(db, id, randInt(rng, 2, 4), now)) && (note('short hunt'), true);
  }
  if (goAway) sessionsLeft = randInt(rng, persona.sessions[0], persona.sessions[1]);

  // 4) schedule the next session
  p = loadPlayer(db, id, now);
  let nextAt: number;
  if (shrineAwayFor) nextAt = now + shrineAwayFor * MIN * persona.tempo; // the shrine works, the bot is away
  else if (isBusy(p, now)) nextAt = Math.max(p.hunt_until ?? 0, p.work_until ?? 0) + randInt(rng, 1, 8) * MIN;
  else if (goAway && !started) nextAt = now + (isNight(now, bot.tz) ? randInt(rng, 300, 540) : randInt(rng, 60, 240)) * MIN * persona.tempo; // logged out: sleeping at night, otherwise a few hours
  else nextAt = now + randInt(rng, 16, 40) * MIN * persona.tempo;
  return { nextAt, sessionsLeft, actions };
}

// ---------------------------------------------------------------- weekly quests
/** Now and then look at the weekly quests and take the reward of every finished one (gold, XP or the special reward). */
function questTurn(ctx: Ctx, id: number, note: (a: string) => void) {
  const { db, now, rng } = ctx;
  if (rng() > 0.25) return;
  for (const q of questsApi.questState(db, id, now).quests) {
    if (!q.done || q.claimed || q.locked) continue;
    const roll = rng(), choice = roll < 0.4 ? 'xp' : roll < 0.8 ? 'gold' : 'special';
    if (ok(() => questsApi.claim(db, id, q.id, choice, now))) note(`quest: ${q.title} (${choice})`);
  }
}

// ---------------------------------------------------------------- skill board
const KIND_VALUE: Record<string, number> = { small: 1, notable: 4, keystone: 6, origin: 0.6, hub: 0.5, bridge: 1 };
/**
 * Spend free skill points the way a player with a plan does: the first point picks the start node of the persona's favourite
 * region, then every point goes one step along the shortest path to the most valuable node still out of reach
 * (value = how much the persona likes its region, times what kind of node it is, divided by the distance).
 */
function skillTurn(ctx: Ctx, id: number, persona: Persona, note: (a: string) => void) {
  const { db, now } = ctx;
  if (skills.usedPoints(db, id) >= skills.pointsTotal(loadPlayer(db, id, now).level)) return;
  const weight = (region: string) => { const parts = region.split('+'); return parts.reduce((s, r) => s + (persona.skills.weights[r] ?? (r === 'hub' ? 0.2 : 0)), 0) / parts.length; };
  for (let spent = 0; spent < 15; spent++) {
    const st = skills.skillState(db, id, now);
    if (!st.free) return;
    let pick: string | undefined;
    if (!st.allocated.length) pick = `${Object.entries(persona.skills.weights).sort((a, b) => b[1] - a[1])[0][0]}.start`;
    else {
      // breadth first search outward from the build; remember the first step towards every node
      const taken = new Set(st.allocated), first = new Map<string, string>(), dist = new Map<string, number>();
      let frontier: string[] = [];
      for (const n of NODES) if (!taken.has(n.id) && n.links.some((l) => taken.has(l))) { first.set(n.id, n.id); dist.set(n.id, 1); frontier.push(n.id); }
      while (frontier.length) {
        const next: string[] = [];
        for (const f of frontier) for (const l of NODE_BY_ID.get(f)!.links) if (!taken.has(l) && !dist.has(l)) { dist.set(l, dist.get(f)! + 1); first.set(l, first.get(f)!); next.push(l); }
        frontier = next;
      }
      let best = 0;
      for (const [nid, d] of dist) {
        const n = NODE_BY_ID.get(nid)!;
        if (n.kind === 'keystone' && persona.skills.keystone !== n.region) continue; // keystones carry a drawback: only the persona that suits one takes it
        const value = (weight(n.region) * KIND_VALUE[n.kind]) / (d * d); // near things first, but a notable three steps away beats a small node next door
        if (value > best) { best = value; pick = first.get(nid); }
      }
    }
    if (!pick || !ok(() => skills.allocate(db, id, pick, now))) return; // (a notable or keystone next in line may cost more than the points left: wait for the next level)
    if (spent === 0) note('skill points');
  }
}

// ---------------------------------------------------------------- shrine
/** Buy the shrine once it is unlocked and affordable (with a cushion), buy and install the cheap tier I parts when there is spare gold, and give it a routine. */
function shrineSetup(ctx: Ctx, p: Player, persona: Persona, note: (a: string) => void) {
  const { db, now, rng } = ctx;
  if (persona.shrine <= 0 || p.level < CFG.shrineLevel) return;
  if (!db.prepare('SELECT 1 FROM shrine WHERE player_id = ?').get(p.id)) {
    if (p.gold < CFG.shrinePrice * 1.3 || rng() > persona.shrine * 0.6 || !ok(() => shrine.buyShrine(db, p.id, now))) return;
    note('bought the shrine');
    p = loadPlayer(db, p.id, now);
  }
  // parts: the idol first (it unlocks the dungeon), then chalice and altar; tier II parts that were found are installed as they come
  const have = shrine.shrineState(db, p.id, now).parts;
  for (const kind of ['idol', 'chalice', 'altar'] as const) {
    const inBag = ownedItems(db, p.id).filter((o) => o.def.component?.kind === kind).sort((a, b) => b.def.component!.tier - a.def.component!.tier)[0];
    if (!inBag && !have[kind] && loadPlayer(db, p.id, now).gold >= ITEM_BY_KEY.get(`shrine_${kind}_1`)!.price * 3 && rng() < persona.shrine) ok(() => eco.buyItem(db, p.id, `shrine_${kind}_1`, now));
  }
  for (const o of ownedItems(db, p.id).filter((x) => x.def.component).sort((a, b) => b.def.component!.tier - a.def.component!.tier)) if (ok(() => shrine.installPart(db, p.id, o.id, now, rng))) note(`installed ${o.def.name}`);
  const st = shrine.shrineState(db, p.id, now);
  const want = (persona.key === 'casual' || persona.key === 'worker') ? ['hunt:6', 'work:6'] : ['hunt:6', 'work:4'];
  if (st.dungeonUnlocked) want.splice(1, 0, 'dungeon:30'); // a dungeon run in the middle
  const routine = want.slice(0, st.slots);
  if (st.routine.join() !== routine.join() && st.status !== 'running') ok(() => shrine.setRoutine(db, p.id, routine, now, rng));
}
/** Going away: let the shrine work instead of a manual long activity (when it is owned, set up and has blood). */
function shrineAway(ctx: Ctx, id: number, persona: Persona, note: (a: string) => void): boolean {
  const { db, now, rng } = ctx;
  if (persona.shrine <= 0 || rng() > persona.shrine) return false;
  if (!ok(() => shrine.start(db, id, now, rng))) return false;
  note('shrine started');
  return true;
}

// ---------------------------------------------------------------- maintenance
function maintain(ctx: Ctx, id: number, persona: Persona, note: (a: string) => void) {
  const { db, now, rng } = ctx;
  let p = loadPlayer(db, id, now);
  // heal when badly hurt (potion if we have one, buy one if we can afford it)
  if (p.hp < p.max_hp * 0.5) {
    let potion = ownedItems(db, id).find((o) => o.def.potion === 'heal');
    if (!potion && p.gold >= 120) { ok(() => eco.buyItem(db, id, 'potion_heal', now)); potion = ownedItems(db, id).find((o) => o.def.potion === 'heal'); }
    if (potion && ok(() => eco.usePotion(db, id, potion!.id, now))) note('potion');
    p = loadPlayer(db, id, now);
  }
  if (rng() < persona.trade) { marketBuy(ctx, loadPlayer(db, id, now), persona, note); p = loadPlayer(db, id, now); } // player offers are cheaper than the shop
  spend(ctx, p, persona, note);
  shrineSetup(ctx, loadPlayer(db, id, now), persona, note);
  skillTurn(ctx, id, persona, note);
  questTurn(ctx, id, note);
  if (rng() < persona.trade) marketSell(ctx, id, persona, note);
  tuneAccomplishments(ctx, id, note);
  p = loadPlayer(db, id, now);
  if (p.level >= CFG.ancestralMinLevel && p.gold >= CFG.ancestralFee(p.ancestral_wins) * 1.5 && now - p.ancestral_at >= CFG.ancestralCooldown) {
    const r = attempt(() => eco.ancestralChallenge(db, id, now, rng)); if (r) note(r.won ? 'ancestral win' : 'ancestral loss');
  }
}

/** potions are consumed and shrine parts are installed, neither is gear that is worn or sold as surplus */
const NOT_GEAR = new Set<string>(['potion', 'component']);
const catKey = (d: ItemDef) => (d.slot === 'ring' ? `ring:${d.ringKind}` : `${d.slot}:${MAIN_STATS.find((s) => d.bonus[s]) ?? d.key}`);
const itemValue = (d: ItemDef, persona: Persona, hardening = 0) =>
  Object.values(effectiveBonus(d, hardening)).reduce((a, b) => a + (b ?? 0), 0) + (d.goldBonus ?? 0) * persona.goldRing + (d.huntBonus && d.huntBonus < 1000 ? d.huntBonus * persona.huntRing : 0);

/** Value of the best usable item we own in each gear category (hardening included). */
function bestValues(db: DB, p: Player, persona: Persona) {
  const best = new Map<string, number>();
  for (const o of ownedItems(db, p.id)) if (o.def.minLevel <= p.level && !NOT_GEAR.has(o.def.slot)) best.set(catKey(o.def), Math.max(best.get(catKey(o.def)) ?? 0, itemValue(o.def, persona, o.hardening)));
  return best;
}
/** Would this persona ever want this item? (amulets are only worth it for perfection-seeking hunters) */
const wanted = (def: ItemDef, persona: Persona) => !NOT_GEAR.has(def.slot) && (def.slot !== 'amulet' || amuletWanted(def, persona));
/** amulet of mights (stat amulets) are for everybody; the Amulet of Perfection only pays off for dedicated hunters; the healing amulet has no effect worth buying */
function amuletWanted(def: ItemDef, persona: Persona) { return def.key === 'amulet_perfection' ? persona.hunt >= 0.8 : Object.keys(def.bonus).length > 0; }
/** What it would cost to get this item from the shop plus paying for its hardening levels: the ceiling for any fair market price. */
const replacementCost = (def: ItemDef, hardening: number) => def.price + Array.from({ length: hardening }, (_, l) => CFG.hardenCost(def.price, l)).reduce((a, b) => a + b, 0);

function spend(ctx: Ctx, p0: Player, persona: Persona, note: (a: string) => void) {
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
  if (pick && ok(() => eco.buyItem(db, p.id, pick.def.key, now))) { budget -= pick.def.price; note(`buy ${pick.def.name}`); }
  else if (goal && !pick) { note(`saving for ${goal.def.name}`); budget = Math.floor(budget * 0.35); } // most of it is put aside, the rest still trains

  // sentinel: buy the best affordable one; upgrade (dismiss refunds the full price) when a clearly better one is affordable
  if (p.level >= CFG.sentinelMinLevel) {
    const owned = db.prepare('SELECT id, sentinel_key FROM sentinels WHERE player_id = ?').get(p.id) as { id: number; sentinel_key: string } | undefined;
    const cur = owned ? SENTINELS.find((s) => s.key === owned.sentinel_key) : undefined;
    const funds = budget + (cur?.price ?? 0);
    const better = SENTINELS.filter((s) => Math.max(CFG.sentinelMinLevel, s.minLevel) <= p.level && s.price <= funds * 0.6 && (!cur || s.price > cur.price * 1.5)).sort((a, b) => b.price - a.price)[0];
    if (better) {
      if (owned) ok(() => eco.dismissSentinel(db, p.id));
      if (ok(() => eco.buySentinel(db, p.id, better.key, now))) { note(`sentinel ${better.name}`); budget = funds - better.price; }
      else if (owned) ok(() => eco.buySentinel(db, p.id, owned.sentinel_key, now)); // could not upgrade: take the old one back
    }
    const s = db.prepare('SELECT t_atk, t_def, t_sta FROM sentinels WHERE player_id = ?').get(p.id) as { t_atk: number; t_def: number; t_sta: number } | undefined;
    if (s) for (let i = 0; i < 6; i++) {
      const attr = (['atk', 'def', 'sta'] as const)[randInt(rng, 0, 2)];
      const cost = CFG.sentinelTrainCost(s[`t_${attr}`]);
      if (budget < cost * 3) break; // sentinel points are cheap early, expensive later
      if (attempt(() => eco.trainSentinel(db, p.id, attr, now)) === undefined) break;
      s[`t_${attr}`]++; budget -= cost;
    }
  }

  // weapon hardening with spare gold
  const blade = ownedItems(db, p.id).filter((o) => o.def.slot === 'weapon' && o.def.minLevel <= p.level).sort((a, b) => b.def.minLevel - a.def.minLevel)[0];
  if (blade && blade.hardening < CFG.hardenMax && budget > CFG.hardenCost(blade.def.price, blade.hardening) * 3 && attempt(() => eco.hardenWeapon(db, p.id, blade.id, now))) budget -= CFG.hardenCost(blade.def.price, blade.hardening);

  // hideout: cheapest next level when clearly affordable
  const h = db.prepare('SELECT * FROM hideouts WHERE player_id = ?').get(p.id) as Record<string, number>;
  const comp = Object.keys(CFG.hideoutMax).filter((c) => h[c] < CFG.hideoutMax[c]).sort((a, b) => CFG.hideoutCost(a, h[a] + 1) - CFG.hideoutCost(b, h[b] + 1))[0];
  if (comp && budget > CFG.hideoutCost(comp, h[comp] + 1) * 4 && rng() < 0.4 && attempt(() => eco.upgradeHideout(db, p.id, comp, now))) { budget -= CFG.hideoutCost(comp, h[comp] + 1); note(`hideout ${comp}`); }

  // attribute training with what is left, following the persona's stat weights
  p = loadPlayer(db, p.id, now);
  for (let i = 0; i < 25; i++) {
    const stat = pickWeighted(rng, persona.stats) as Stat;
    const cost = discounted(CFG.trainCost(p[stat]), p, 'trainDiscount');
    if (budget < cost) break;
    if (attempt(() => eco.trainStat(db, p.id, stat, now)) === undefined) break;
    p = { ...p, [stat]: p[stat] + 1 }; budget -= cost;
    if (i === 0) note('train');
  }
}

/** Put the five best earned accomplishments into set 1 and activate it (only when it changed). */
function tuneAccomplishments(ctx: Ctx, id: number, note: (a: string) => void) {
  const { db } = ctx;
  const best = accomplishmentStatus(db, id).filter((a) => a.tier > 0).sort((a, b) => b.tier - a.tier).slice(0, 5).map((a) => a.key);
  if (!best.length) return;
  const cur = getSets(db, id)[0];
  if (cur.active && best.length === cur.keys.length && best.every((k) => cur.keys.includes(k))) return;
  attempt(() => { saveSet(db, id, 0, best); activateSet(db, id, 0); note('achievements'); });
}

// ---------------------------------------------------------------- raiding
const power = (s: { str: number; def: number; agi: number; sta: number }) => s.str + s.def + s.agi + s.sta;

function raid(ctx: Ctx, id: number, persona: Persona, note: (a: string) => void) {
  const { db, now, rng } = ctx;
  const p = loadPlayer(db, id, now);
  if (rng() > persona.raid || p.hp < CFG.hpProtectThreshold || p.hp < p.max_hp * 0.5 || now - p.last_attack_at < attackCooldownOf(p)) return;
  if (warOf(db, id) && rng() < 0.85) { const r = attempt(() => warAttack(db, id, now, rng)); if (r) note(`war ${r.winner === p.name ? 'win' : 'loss'} vs ${r.target.name}`); return; }
  const mine = power(battleStats(db, p, { ancestral: p.level >= CFG.ancestralMinLevel }));
  for (let i = 0; i < 3; i++) {
    const s = attempt(() => searchOpponent(db, id, now, rng, { botsOnly: !ctx.humans }));
    if (!s) return;
    if (!s.found) { if (s.reason === 'no_opponents') return; continue; }
    const t = loadPlayer(db, s.target.id, now);
    if (!t.is_bot && rng() > ctx.humanRaidChance) continue; // real players get left alone most of the time
    if (mine < power(battleStats(db, t, { ancestral: t.level >= CFG.ancestralMinLevel })) * persona.minPower) continue; // not worth the risk
    const r = attempt(() => attack(db, id, t.id, now, rng));
    if (r) note(`raid ${r.winner === p.name ? 'win' : 'loss'} vs ${t.name}`);
    return;
  }
}

// ---------------------------------------------------------------- hunting / working
/** The "away" activity: a long hunt while budget remains, otherwise a graveyard shift (long overnight). */
function longActivity(ctx: Ctx, p: Player, persona: Persona, night: boolean, note: (a: string) => void): boolean {
  const { db, now, rng } = ctx;
  const left = huntLeft(p, now);
  if (left >= 60 * MIN && rng() < persona.hunt) {
    const portions = Math.min(Math.floor(left / CFG.huntPortion), randInt(rng, 6, 18));
    if (ok(() => eco.startHunt(db, p.id, portions, now))) { note(`hunt ${portions}x10m`); return true; }
  }
  // Most "away" time is simply being logged out (and therefore attackable); graveyard shifts are for bots that need gold.
  if (rng() < persona.work * 0.45 || p.gold < 120) {
    const hours = persona.key === 'casual' && rng() < 0.3 ? randInt(rng, 24, 48) : night ? randInt(rng, 5, 10) : randInt(rng, 1, 5);
    if (ok(() => eco.startWork(db, p.id, hours, now))) { note(`work ${hours}h`); return true; }
  }
  return false;
}

// ---------------------------------------------------------------- clans
function clanNames(db: DB) { return new Set((db.prepare('SELECT name FROM clans').all() as { name: string }[]).map((c) => c.name.toLowerCase())); }

const WELCOME = ['Welcome to the clan! Be active, hit the enemy race and donate a little when you can.', 'New recruits: introduce yourselves here. Raid targets and war plans go in this section.', 'Rules: no idling, no leaving mid-war, respect each other. Let\'s climb the highscore!'];
const WAR_TALK = ['War is on. Everybody attack from the war room whenever your cooldown is ready!', 'They declared war on us. Show them what we are made of. Attack every time your cooldown is ready.', 'We took the fight to them. Keep hitting, every point counts.'];

function social(ctx: Ctx, id: number, persona: Persona, note: (a: string) => void) {
  const { db, now, rng } = ctx;
  const p = loadPlayer(db, id, now);
  if (p.level < CFG.clanMinLevel) return;

  if (!p.clan_id) {
    if (persona.social >= 0.7 && rng() < 0.4) {
      const cid = attempt(() => clan.createClan(db, id, clanName(rng, clanNames(db)), now));
      if (cid) {
        note('founded clan');
        if (rng() < 0.3) attempt(() => clan.setRecruiting(db, id, false, now));
        attempt(() => forum.createThread(db, id, 'Welcome', WELCOME[randInt(rng, 0, WELCOME.length - 1)], now));
      }
    } else if (rng() < 0.5) seekClan(ctx, p, note);
    return;
  }

  const c = db.prepare('SELECT * FROM clans WHERE id = ?').get(p.clan_id) as { id: number; leader_id: number; treasury: number; domicile_level: number; is_open: number } | undefined;
  if (!c) return;
  // donate only while the clan still needs money for its next domicile level (a treasury nobody can use is a gold black hole)
  const upkeep = CFG.clanUpgradeCost(c.domicile_level);
  if (p.gold > 1500 && c.treasury < upkeep && rng() < 0.15) { const amt = Math.min(Math.floor(p.gold * 0.1), upkeep - c.treasury); if (amt > 0 && ok(() => clan.donate(db, id, amt, now))) note(`donate ${amt}`); }
  if (c.leader_id !== id) return;
  leaderDuties(ctx, id, p, c, persona, note);
}

function seekClan(ctx: Ctx, p: Player, note: (a: string) => void) {
  const { db, now, rng } = ctx;
  const rows = db.prepare(
    `SELECT c.id, c.is_open, c.domicile_level, (SELECT COUNT(*) FROM players m WHERE m.clan_id = c.id) AS members
       FROM clans c WHERE c.race = ?`,
  ).all(p.race) as { id: number; is_open: number; domicile_level: number; members: number }[];
  const options = rows.filter((c) => c.members < CFG.clanBaseSlots + c.domicile_level * CFG.clanSlotsPerLevel && !clan.activeWarFor(db, c.id));
  if (!options.length) return;
  // clans with a few members attract more: weight by members + 1
  let x = rng() * options.reduce((s, c) => s + c.members + 1, 0), chosen = options[0];
  for (const c of options) { x -= c.members + 1; if (x < 0) { chosen = c; break; } }
  const done = chosen.is_open ? ok(() => clan.joinClan(db, p.id, chosen.id, now)) : ok(() => clan.applyToClan(db, p.id, chosen.id, 'Active player, looking for a clan!', now));
  if (done) note(chosen.is_open ? 'joined clan' : 'applied to clan');
}

function leaderDuties(ctx: Ctx, id: number, p: Player, c: { id: number; treasury: number; domicile_level: number }, persona: Persona, note: (a: string) => void) {
  const { db, now, rng } = ctx;
  // applications: accept most
  for (const a of (attempt(() => clan.listApplications(db, id, now)) ?? []) as { player_id: number }[]) {
    if (ok(() => clan.decideApplication(db, id, a.player_id, rng() < 0.9, now))) note('reviewed application');
  }
  const members = (db.prepare('SELECT COUNT(*) n FROM players WHERE clan_id = ?').get(c.id) as { n: number }).n;
  const cap = CFG.clanBaseSlots + c.domicile_level * CFG.clanSlotsPerLevel;
  // recruiting: pull a clanless bot of the same race in (an "invite" that was accepted)
  if (members < cap && rng() < 0.3 && !clan.activeWarFor(db, c.id)) {
    // candidates in a stable order, picked with the seeded generator (SQL RANDOM() would break reproducibility)
    const pool = db.prepare(
      `SELECT id FROM players WHERE is_bot = 1 AND clan_id IS NULL AND race = ? AND level >= ? AND id != ? ORDER BY id LIMIT 40`,
    ).all(p.race, CFG.clanMinLevel, id) as { id: number }[];
    const cand = pool.length ? pool[randInt(rng, 0, pool.length - 1)] : undefined;
    if (cand) {
      const open = (db.prepare('SELECT is_open FROM clans WHERE id = ?').get(c.id) as { is_open: number }).is_open;
      const done = open ? ok(() => clan.joinClan(db, cand.id, c.id, now))
        : ok(() => { clan.applyToClan(db, cand.id, c.id, 'Invited by the leader', now); clan.decideApplication(db, id, cand.id, true, now); });
      if (done) note('recruited a member');
    }
  }
  // a bigger domicile when the treasury allows it and we are nearly full
  if (members >= cap - 2 && c.treasury >= CFG.clanUpgradeCost(c.domicile_level) && ok(() => clan.upgradeDomicile(db, id, now))) note('domicile upgrade');

  const war = clan.activeWarFor(db, c.id);
  if (!war) {
    if (members >= CFG.warMinAttackers && persona.raid > 0.3 && rng() < 0.004) {
      const all = db.prepare(
        `SELECT c2.id FROM clans c2 WHERE c2.race != ? AND (SELECT COUNT(*) FROM players m WHERE m.clan_id = c2.id) >= ? ORDER BY c2.id`,
      ).all(p.race, CFG.warMinAttackers) as { id: number }[];
      const targets = all.map((t) => ({ t, k: rng() })).sort((a, b) => a.k - b.k).slice(0, 8).map((x) => x.t); // seeded shuffle
      for (const t of targets) {
        if (clan.activeWarFor(db, t.id)) continue;
        if (attempt(() => clan.declareWar(db, id, t.id, now)) !== undefined) {
          note('declared war');
          attempt(() => forum.createThread(db, id, 'WAR', WAR_TALK[randInt(rng, 0, WAR_TALK.length - 1)], now));
          break;
        }
      }
    }
    return;
  }
  // negotiating: accept a pending offer from the other side, or offer peace once the war has dragged on
  const age = now - war.started_at;
  if (war.peace_offer_by && war.peace_offer_by !== c.id && rng() < 0.6) { if (attempt(() => clan.offerPeace(db, id, now)) !== undefined) note('accepted peace'); return; }
  if (age > 36 * HOUR && rng() < 0.15 && attempt(() => clan.offerPeace(db, id, now)) !== undefined) note('offered peace');
}

// ---------------------------------------------------------------- arena
function arenaTurn(ctx: Ctx, id: number, persona: Persona, note: (a: string) => void) {
  const { db, now, rng } = ctx;
  const p = loadPlayer(db, id, now);
  if (p.level < CFG.arenaMinLevel || p.gold < 150 || rng() > persona.arena * 0.35) return;
  if (arena.arenaStatus(db, id, now).current) return;
  const mySkill = arena.skillAverage(p);
  const events = arena.listEvents(db, id, now).filter((e: any) => e.status === 'open' && !e.joined && e.deadline > now && e.fee <= p.gold * 0.1
    && Math.abs(mySkill - e.base_skill) <= (e.base_skill * e.deviation) / 100);
  if (events.length && rng() < 0.75) {
    const e = events[randInt(rng, 0, events.length - 1)] as { id: number };
    if (ok(() => arena.joinEvent(db, id, e.id, now))) note('joined arena event');
    return;
  }
  const open = (db.prepare("SELECT COUNT(*) n FROM arena_events WHERE status = 'open'").get() as { n: number }).n;
  if (open >= 6 || rng() > 0.3) return;
  const kind = rng() < 0.55 ? 'duel' : 'tournament';
  const fee = Math.min(Math.floor(p.gold * 0.05 / 10) * 10, 500);
  if (ok(() => arena.createEvent(db, id, { kind, size: kind === 'duel' ? 2 : rng() < 0.7 ? 4 : 8, deviation: 25, fee, withEq: rng() < 0.5, withSen: rng() < 0.5, withAnc: rng() < 0.3, registrationMinutes: randInt(rng, 240, 720) }, now))) note('created arena event');
}

// ---------------------------------------------------------------- Blood Temple (player market)
const MAX_BOT_LISTINGS = 3;

/** Buy the best upgrade on offer, but only at a clear discount to what the same item would cost otherwise. */
function marketBuy(ctx: Ctx, p: Player, persona: Persona, note: (a: string) => void) {
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
function marketSell(ctx: Ctx, id: number, persona: Persona, note: (a: string) => void) {
  const { db, now, rng } = ctx;
  const p = loadPlayer(db, id, now);
  const wearing = new Set(equipmentLoadout(db, p).equipped);
  const surplus = ownedItems(db, id).filter((o) => !NOT_GEAR.has(o.def.slot) && !wearing.has(o.id) && !(o.def.minLevel > p.level && rng() < 0.7));
  let open = (db.prepare("SELECT COUNT(*) n FROM temple_listings WHERE seller_id = ? AND status = 'open'").get(id) as { n: number }).n;

  // reprice: a listing nobody bought for 36 h is withdrawn and offered again 15 % cheaper; one that is already at the floor
  // (the shop's buy-back price) is simply sold to the shop, because clearly nobody wants it
  const stale = db.prepare("SELECT id, item_key, hardening, price FROM temple_listings WHERE seller_id = ? AND status = 'open' AND created_at < ?").all(id, now - 36 * HOUR) as { id: number; item_key: string; hardening: number; price: number }[];
  for (const l of stale) {
    if (rng() > 0.5) continue;
    const floor = Math.floor(ITEM_BY_KEY.get(l.item_key)!.price / 2) + 1;
    if (!ok(() => temple.cancelListing(db, id, l.id, now))) continue;
    const back = db.prepare('SELECT id FROM inventory WHERE player_id = ? AND item_key = ? AND hardening = ? ORDER BY id DESC LIMIT 1').get(id, l.item_key, l.hardening) as { id: number } | undefined;
    if (!back) continue;
    if (l.price <= floor * 1.05) { if (ok(() => eco.sellItem(db, id, back.id, now))) note('sold unwanted item to the shop'); }
    else if (ok(() => temple.listItem(db, id, back.id, Math.max(floor, Math.round(l.price * 0.85)), now))) note('repriced a listing');
  }
  // gear that has sat unused for 3 days is not coming back into use: clear it out
  for (const o of surplus) if (now - o.boughtAt > 3 * DAY_MS && ok(() => eco.sellItem(db, id, o.id, now))) note('cleared old gear');

  for (const o of ownedItems(db, id).filter((x) => surplus.some((sx) => sx.id === x.id)).slice(0, 2)) { // (re-read: some may have just been sold)
    if (o.def.price < 80) { if (ok(() => eco.sellItem(db, id, o.id, now))) note('sold junk to the shop'); continue; }
    if (open >= MAX_BOT_LISTINGS) break;
    const price = Math.max(Math.floor(o.def.price / 2) + 1, Math.round(replacementCost(o.def, o.hardening) * (0.55 + rng() * 0.4))); // always beats the shop's 50 % buy-back
    if (ok(() => temple.listItem(db, id, o.id, price, now))) { open++; note(`listed ${o.def.name} for ${price}`); }
  }
}

// ---------------------------------------------------------------- dungeon
const bestOption = (opts: { value: number }[]) => opts.reduce((bi, o, i) => (o.value > opts[bi].value ? i : bi), 0);
const AFTER_WAIT = 20_000; // a bot looks again shortly after the wait between fights is over

/**
 * Keep delving: one fight whenever the wait between fights is over. Returns when this bot should look again, or null when it is
 * no longer inside (it died). Dying costs nothing but the re-entry cooldown, so fighting on is always right.
 */
function dungeonContinue(ctx: Ctx, id: number, note: (a: string) => void): number | null {
  const { db, now, rng } = ctx;
  const st = dungeon.dungeonState(db, id, now);
  if (!st.active) return null;
  if (st.pending) ok(() => dungeon.chooseReward(db, id, bestOption(st.pending!), now));
  if (now < st.readyAt) return st.readyAt + AFTER_WAIT;
  const r = attempt(() => dungeon.fight(db, id, now, rng));
  if (!r) return now + 2 * MIN;
  if (r.died) { note(`dungeon: died on ${r.depth}`); return null; }
  if (r.checkpoint) note(`dungeon checkpoint ${r.checkpoint}`);
  if (r.choice) ok(() => dungeon.chooseReward(db, id, bestOption(r.choice!), now));
  return (r.readyAt ?? now) + AFTER_WAIT;
}

/**
 * A dungeon visit: claim a waiting guardian reward, sell loot to the relic dealer, enter and fight the first monster.
 * Returns when the bot should look again (it stays inside until it dies), or null when it did not go in.
 */
function dungeonTurn(ctx: Ctx, id: number, persona: Persona, note: (a: string) => void): number | null {
  const { db, now, rng } = ctx;
  if (rng() > persona.dungeon) return null;
  const st = dungeon.dungeonState(db, id, now);
  if (st.pending && ok(() => dungeon.chooseReward(db, id, bestOption(st.pending!), now))) note('guardian reward');
  const gold = loadPlayer(db, id, now).gold;
  if (st.loot.length && (st.lootValue >= 150 || st.loot.length >= 4 || gold < 100)) { const r = attempt(() => dungeon.sellLoot(db, id, 'all', now)); if (r) note(`sold loot +${r.gold}g`); }
  if (!st.canEnter || !ok(() => dungeon.enterDungeon(db, id, now))) return null;
  note('dungeon: entered');
  return dungeonContinue(ctx, id, note);
}
