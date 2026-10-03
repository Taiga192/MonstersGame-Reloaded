/**
 * The shrine (NOT in the original game): an idle layer for the PvE side. A routine of hunting and work steps runs while the player
 * is away and pays a share (the efficiency, 60 % to start) of what the same time would pay by hand. It burns animal blood, which
 * the player gathers by playing (see blood.ts); the tank size is also the cap on unattended time.
 *
 * Nothing runs in the background: like hunts and shifts, the server works out what happened when the player (or anybody who needs
 * the numbers) comes back, replaying the routine step by step with the normal game rules. The same caps apply as for manual play
 * (3 hours of hunting a day ...). Automation never sets the "busy" flags, so an automated player can be raided (the loss is
 * capped, see CFG.shrineRaidLossCap). Any manual activity pauses the shrine first: one thing at a time.
 */
import { CFG, HOUR, MIN, DAY_MS, ITEM_BY_KEY, type ComponentKind } from '../config.ts';
import type { DB } from '../db-core.ts';
import { assert } from '../errors.ts';
import type { Rng } from '../rng.ts';
import { installedParts, routineSlots, tankSize, upgradeCount } from './blood.ts';
import { delveAuto, MIN_FIGHT_MS } from './dungeon.ts';
import { bump } from './counters.ts';
import { modsOf } from './mods.ts';
import { notify } from './notify.ts';
import { resolveHunt, wagesFor } from './economy.ts';
import { assertFree, awardXp, isBusy, loadPlayer, type Player } from './player.ts';

export type ShrineStatus = 'off' | 'running' | 'paused' | 'starved';
export interface Step { kind: 'hunt' | 'work' | 'dungeon'; amount: number } // hunt: portions, work: hours, dungeon: fights of one run
interface Row { player_id: number; level: number; status: ShrineStatus; routine: string; step: number; step_at: number; bought_at: number }

const getRow = (db: DB, id: number) => db.prepare('SELECT * FROM shrine WHERE player_id = ?').get(id) as Row | undefined;
export const stepText = (s: Step) => `${s.kind}:${s.amount}`;
const stepMs = (s: Step) => (s.kind === 'hunt' ? s.amount * CFG.huntPortion : s.kind === 'work' ? s.amount * HOUR : s.amount * Math.max(CFG.dungeonFightCooldown, MIN_FIGHT_MS));
/** Fuel one step burns: the configured cost per hour, less what the skill board saves (Acolyte). */
const fuelPerHour = (db: DB, id: number) => CFG.shrineBloodPerHour * (1 - (modsOf(db.prepare('SELECT skill_mods FROM players WHERE id = ?').get(id) as { skill_mods: string }).shrineFuel ?? 0));
const bloodFor = (db: DB, id: number, s: Step) => (stepMs(s) / HOUR) * fuelPerHour(db, id);
const routineOf = (r: Row): Step[] => (JSON.parse(r.routine) as string[]).map((t) => { const [kind, amount] = t.split(':'); return { kind: kind as Step['kind'], amount: Number(amount) }; });

/** What share of a manual hour an automated hour pays: the base plus 2.5 % per installed part tier, never above CFG.shrineMaxEfficiency. */
export function shrineEfficiency(db: DB, id: number): number {
  return Math.min(CFG.shrineMaxEfficiency, CFG.shrineBaseEfficiency + CFG.shrineEfficiencyPerUpgrade * upgradeCount(db, id));
}

/** One routine step typed as text ("hunt:6", "work:4"); anything else is refused. */
export function parseStep(text: unknown): Step {
  const m = typeof text === 'string' ? /^(hunt|work|dungeon):(\d{1,3})$/.exec(text) : null;
  assert(m, 'bad_step', 'A step looks like "hunt:6" (portions), "work:4" (hours) or "dungeon:30" (fights)');
  const kind = m[1] as Step['kind'], amount = Number(m[2]);
  const max = kind === 'hunt' ? Math.floor(CFG.huntBudget / CFG.huntPortion) : kind === 'work' ? CFG.workMaxHours : 100;
  assert(amount >= 1 && amount <= max, 'bad_amount', kind === 'hunt' ? `Hunt 1-${max} portions` : kind === 'work' ? `Work 1-${max} hours` : `A dungeon run of 1-${max} fights`);
  return { kind, amount };
}

// ---------------------------------------------------------------- buying and setting up
export function buyShrine(db: DB, id: number, now: number) {
  const p = loadPlayer(db, id, now);
  assert(p.level >= CFG.shrineLevel, 'level_too_low', `The shrine unlocks at level ${CFG.shrineLevel}`);
  assert(!getRow(db, id), 'owned', 'You already own a shrine');
  assertFree(p, now);
  assert(p.gold >= CFG.shrinePrice, 'no_gold', `The shrine costs ${CFG.shrinePrice} gold`);
  db.prepare('UPDATE players SET gold = gold - ? WHERE id = ?').run(CFG.shrinePrice, id);
  db.prepare('INSERT INTO shrine (player_id, bought_at) VALUES (?,?)').run(id, now);
}

/** Replace the routine. A running shrine is paused first (the step in progress is paid pro rata). */
export function setRoutine(db: DB, id: number, steps: unknown, now: number, rng: Rng) {
  const s = getRow(db, id);
  assert(s, 'no_shrine', 'You do not own a shrine');
  const slots = routineSlots(db, id);
  assert(Array.isArray(steps) && steps.length >= 1 && steps.length <= slots, 'bad_routine', `A routine has 1-${slots} steps`);
  const parsed = steps.map(parseStep);
  assert(!parsed.some((x) => x.kind === 'dungeon') || (installedParts(db, id).idol ?? 0) >= 1, 'needs_idol', 'Dungeon runs need the Idol of the Hunt in your shrine');
  pause(db, id, now, rng);
  db.prepare("UPDATE shrine SET routine = ?, step = 0, status = CASE WHEN status = 'running' THEN 'paused' ELSE status END WHERE player_id = ?").run(JSON.stringify(parsed.map(stepText)), id);
}

/** Start (or resume) the routine from its current step. Needs fuel for that step and a free character. */
export function start(db: DB, id: number, now: number, rng: Rng) {
  settle(db, id, now, rng);
  const s = getRow(db, id);
  assert(s, 'no_shrine', 'You do not own a shrine');
  assert(s.status !== 'running', 'already_running', 'The shrine is already running');
  const steps = routineOf(s);
  assert(steps.length > 0, 'no_routine', 'Set up a routine first');
  const p = loadPlayer(db, id, now);
  assertFree(p, now);
  assert(!p.hunt_started && !p.work_started, 'uncollected', 'Collect your hunt or wages first');
  const step = steps[s.step % steps.length];
  assert(charge(db, id, step), 'no_blood', `The shrine needs ${Math.ceil(bloodFor(db, id, step) * 10) / 10} blood for this step. Play (hunt, work, raid, delve) to gather more`);
  db.prepare("UPDATE shrine SET status = 'running', step = ?, step_at = ? WHERE player_id = ?").run(s.step % steps.length, now, id);
}

// ---------------------------------------------------------------- parts
const partKey = (kind: ComponentKind, tier: number) => `shrine_${kind}_${tier}`;
const give = (db: DB, id: number, key: string, now: number) => db.prepare('INSERT INTO inventory (player_id, item_key, bought_at) VALUES (?,?,?)').run(id, key, now);

/** Fit the shrine to its parts after one was installed or removed: blood above the new tank is lost, steps above the new slots are cut. */
function refit(db: DB, id: number) {
  db.prepare('UPDATE players SET blood = MIN(blood, ?) WHERE id = ?').run(tankSize(db, id), id);
  const s = getRow(db, id)!;
  const hasIdol = (installedParts(db, id).idol ?? 0) >= 1;
  const steps = (JSON.parse(s.routine) as string[]).filter((t) => hasIdol || !t.startsWith('dungeon:')), slots = routineSlots(db, id);
  db.prepare("UPDATE shrine SET routine = ?, step = 0, status = CASE WHEN ? = 0 AND status != 'off' THEN 'off' ELSE status END WHERE player_id = ?").run(JSON.stringify(steps.slice(0, slots)), Math.min(steps.length, 1), id);
}

/** Install a part from the bag. A better tier replaces a worse one of the same kind (the old part goes back into the bag). */
export function installPart(db: DB, id: number, inventoryId: unknown, now: number, rng: Rng) {
  assert(getRow(db, id), 'no_shrine', 'You do not own a shrine');
  const row = Number.isInteger(inventoryId) ? (db.prepare('SELECT item_key FROM inventory WHERE id = ? AND player_id = ?').get(inventoryId as number, id) as { item_key: string } | undefined) : undefined;
  const def = row && ITEM_BY_KEY.get(row.item_key);
  assert(def?.component, 'not_a_part', 'That is not a shrine part');
  const { kind, tier } = def.component;
  const have = installedParts(db, id)[kind] ?? 0;
  assert(tier > have, 'not_better', 'A part of this kind with the same or a better tier is already installed');
  pause(db, id, now, rng); // the shrine changes: stop it first (the step in progress is paid)
  db.prepare('DELETE FROM inventory WHERE id = ?').run(inventoryId as number);
  if (have) give(db, id, partKey(kind, have), now);
  db.prepare('INSERT INTO shrine_components (player_id, kind, tier) VALUES (?,?,?) ON CONFLICT(player_id, kind) DO UPDATE SET tier = excluded.tier').run(id, kind, tier);
  refit(db, id);
}

/** Take a part out again (it goes back into the bag, e.g. to sell it). */
export function removePart(db: DB, id: number, kind: unknown, now: number, rng: Rng) {
  assert(getRow(db, id), 'no_shrine', 'You do not own a shrine');
  const k = typeof kind === 'string' && (['chalice', 'altar', 'idol'] as string[]).includes(kind) ? (kind as ComponentKind) : undefined;
  assert(k, 'bad_part', 'Unknown part');
  const have = installedParts(db, id)[k];
  assert(have, 'not_installed', 'That part is not installed');
  pause(db, id, now, rng);
  db.prepare('DELETE FROM shrine_components WHERE player_id = ? AND kind = ?').run(id, k);
  give(db, id, partKey(k, have), now);
  refit(db, id);
}

// ---------------------------------------------------------------- running
function charge(db: DB, id: number, step: Step): boolean {
  const need = bloodFor(db, id, step);
  const have = (db.prepare('SELECT blood FROM players WHERE id = ?').get(id) as { blood: number }).blood;
  if (have + 1e-9 < need) return false;
  db.prepare('UPDATE players SET blood = MAX(0, blood - ?) WHERE id = ?').run(need, id);
  return true;
}
const refund = (db: DB, id: number, blood: number) => { if (blood > 0) db.prepare('UPDATE players SET blood = MIN(?, blood + ?) WHERE id = ?').run(tankSize(db, id), blood, id); };

/** Per-day hunting time already used, seeded from what the character has used today by hand. */
type Budget = Map<number, number>;
const budgetOf = (p: Player): Budget => new Map(p.hunt_day ? [[p.hunt_day, p.hunt_used]] : []);
function saveBudget(db: DB, id: number, b: Budget) {
  if (!b.size) return;
  const day = Math.max(...b.keys());
  db.prepare('UPDATE players SET hunt_day = ?, hunt_used = ? WHERE id = ?').run(day, b.get(day)!, id);
}

/** Pay `units` of a step (portions of a hunt, or hours of work, possibly fractional) that finished at virtual time `at`. */
function pay(db: DB, id: number, step: Step, units: number, at: number, budget: Budget, now: number, rng: Rng) {
  if (units <= 0) return;
  const p = loadPlayer(db, id, now);
  const eff = shrineEfficiency(db, id);
  if (step.kind === 'hunt') {
    const day = Math.floor(at / DAY_MS), used = budget.get(day) ?? 0;
    const portions = Math.min(Math.floor(units), Math.max(0, Math.floor((CFG.huntBudget - used) / CFG.huntPortion))); // the daily cap is the same as by hand
    if (portions <= 0) return;
    budget.set(day, used + portions * CFG.huntPortion);
    const r = resolveHunt(db, p, portions, rng, now);
    const gold = Math.round(r.gold * eff);
    db.prepare('UPDATE players SET gold = gold + ? WHERE id = ?').run(gold, id);
    bump(db, id, 'hunt_gold', gold); bump(db, id, 'gold_earned', gold);
    awardXp(db, id, Math.round(r.xp * eff), now);
  } else if (step.kind === 'dungeon') {
    // all or nothing: a run is only played when its whole time has passed (a paused one is simply cancelled)
    if (units >= step.amount && (installedParts(db, id).idol ?? 0) >= 1) delveAuto(db, id, at - stepMs(step), step.amount, eff, now, rng);
  } else {
    const wages = wagesFor(db, p, units, eff);
    db.prepare('UPDATE players SET gold = gold + ? WHERE id = ?').run(wages, id);
    bump(db, id, 'work_hours', Math.floor(units)); bump(db, id, 'work_gold', wages); bump(db, id, 'gold_earned', wages);
  }
}

/**
 * Play the routine forward to `now`: every step that has finished is paid (at its own finishing time, so the daily hunting cap
 * counts per day), the next one is started if there is blood for it, otherwise the shrine stops ("starved"). Cheap when nothing
 * is running. Call it inside a transaction.
 */
export function settle(db: DB, id: number, now: number, rng: Rng) {
  const s = getRow(db, id);
  if (!s || s.status !== 'running') return;
  const p0 = loadPlayer(db, id, now);
  if (isBusy(p0, now)) { pause(db, id, now, rng); return; } // doing something by hand: the shrine stands still
  const steps = routineOf(s);
  if (!steps.length) { db.prepare("UPDATE shrine SET status = 'off' WHERE player_id = ?").run(id); return; }
  const budget = budgetOf(p0);
  let idx = s.step, at = s.step_at, status: ShrineStatus = 'running';
  for (let guard = 0; guard < 600; guard++) {
    const step = steps[idx % steps.length];
    const end = at + stepMs(step);
    if (end > now) break; // still in progress
    pay(db, id, step, step.amount, end, budget, now, rng);
    bump(db, id, 'shrine_steps');
    idx = (idx + 1) % steps.length; at = end;
    if (!charge(db, id, steps[idx])) { status = 'starved'; break; }
  }
  saveBudget(db, id, budget);
  db.prepare('UPDATE shrine SET status = ?, step = ?, step_at = ? WHERE player_id = ?').run(status, idx, at, id);
  if (status === 'starved') notify(db, id, 'shrine', 'The shrine ran out of blood', 'Hunt, work, raid or delve to gather more, then start it again.', '#/shrine', now);
}

/**
 * Stop a running shrine because the player wants to do something by hand: finished steps are paid first, the step in progress
 * is paid pro rata (whole portions, whole minutes) and the unused blood of it comes back.
 */
export function pause(db: DB, id: number, now: number, rng: Rng) {
  let s = getRow(db, id);
  if (!s || s.status !== 'running') return;
  const p0 = loadPlayer(db, id, now);
  const busy = isBusy(p0, now); // (a manual activity is already running: nothing to pay, just stop the shrine)
  if (!busy) settle(db, id, now, rng);
  s = getRow(db, id)!;
  if (s.status !== 'running') return; // settling already stopped it (no blood left)
  const step = routineOf(s)[s.step];
  const elapsed = Math.max(0, now - s.step_at), dur = stepMs(step);
  const budget = budgetOf(loadPlayer(db, id, now));
  const done = step.kind === 'hunt' ? Math.min(step.amount, Math.floor(elapsed / CFG.huntPortion)) : step.kind === 'work' ? Math.floor(Math.min(elapsed, dur) / MIN) / 60 : 0; // a dungeon run is all or nothing
  if (!busy) pay(db, id, step, done, now, budget, now, rng);
  saveBudget(db, id, budget);
  const doneMs = step.kind === 'hunt' ? done * CFG.huntPortion : step.kind === 'work' ? done * HOUR : 0;
  refund(db, id, bloodFor(db, id, step) * (1 - Math.min(1, doneMs / dur)));
  db.prepare("UPDATE shrine SET status = 'paused', step_at = ? WHERE player_id = ?").run(now, id);
}

// ---------------------------------------------------------------- what the page shows
export function shrineState(db: DB, id: number, now: number) {
  const p = loadPlayer(db, id, now);
  const s = getRow(db, id);
  const base = { unlockLevel: CFG.shrineLevel, price: CFG.shrinePrice, unlocked: p.level >= CFG.shrineLevel, owned: !!s, dungeonUnlocked: (installedParts(db, id).idol ?? 0) >= 1, blood: Math.floor(p.blood * 10) / 10, tank: tankSize(db, id),
    bloodPerHour: Math.round(fuelPerHour(db, id) * 1000) / 1000, slots: routineSlots(db, id), efficiency: shrineEfficiency(db, id), baseEfficiency: CFG.shrineBaseEfficiency, maxEfficiency: CFG.shrineMaxEfficiency,
    parts: installedParts(db, id), upgrades: upgradeCount(db, id), bag: (db.prepare('SELECT id, item_key FROM inventory WHERE player_id = ? ORDER BY id').all(id) as { id: number; item_key: string }[]).filter((r) => ITEM_BY_KEY.get(r.item_key)?.component).map((r) => ({ id: r.id, key: r.item_key })) };
  if (!s) return { ...base, status: 'none' as const, routine: [] as string[], current: null, hoursOfFuel: 0 };
  const steps = routineOf(s);
  const cur = s.status === 'running' && steps.length ? steps[s.step % steps.length] : null;
  return {
    ...base, status: s.status, routine: steps.map(stepText), step: s.step,
    current: cur ? { index: s.step, step: stepText(cur), startedAt: s.step_at, endsAt: s.step_at + stepMs(cur) } : null,
    hoursOfFuel: Math.floor((p.blood / Math.max(0.0001, fuelPerHour(db, id))) * 10) / 10,
  };
}
