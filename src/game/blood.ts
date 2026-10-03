/**
 * Animal blood: gathered "on the way" by every manual action (hunting, graveyard work, raids, dungeon fights) and burned as fuel
 * by the shrine (shrine.ts). Kept in its own small file so the game rules can call it without importing the shrine.
 * The installed shrine parts are read here too, because they change the tank size and how much blood you gather.
 */
import { CFG, type ComponentKind } from '../config.ts';
import type { DB } from '../db-core.ts';
import { modsOf } from './mods.ts';

const mods = (db: DB, id: number) => modsOf(db.prepare('SELECT skill_mods FROM players WHERE id = ?').get(id) as { skill_mods: string });

export type BloodSource = 'hunt' | 'work' | 'raid' | 'dungeon';

/** Installed shrine parts: kind -> tier. */
export function installedParts(db: DB, playerId: number): Partial<Record<ComponentKind, number>> {
  const rows = db.prepare('SELECT kind, tier FROM shrine_components WHERE player_id = ?').all(playerId) as { kind: ComponentKind; tier: number }[];
  return Object.fromEntries(rows.map((r) => [r.kind, r.tier]));
}
/** How many upgrades (installed tiers) the shrine has: each one adds CFG.shrineEfficiencyPerUpgrade. */
export const upgradeCount = (db: DB, playerId: number) => Object.values(installedParts(db, playerId)).reduce((a, b) => a + (b ?? 0), 0);

/** How much blood the shrine can hold (Blood Chalice adds to it). */
export const tankSize = (db: DB, playerId: number) => CFG.shrineTank + CFG.shrineTankPerTier * (installedParts(db, playerId).chalice ?? 0) + (mods(db, playerId).shrineTank ?? 0);
/** How many steps a routine may have (Bone Altar adds to it). */
export const routineSlots = (db: DB, playerId: number) => CFG.shrineSlots + CFG.shrineSlotsPerTier * (installedParts(db, playerId).altar ?? 0);

export function gatherBlood(db: DB, playerId: number, source: BloodSource, units = 1) {
  const per = { hunt: CFG.bloodPerHuntPortion, work: CFG.bloodPerWorkHour, raid: CFG.bloodPerRaid, dungeon: CFG.bloodPerDungeonFight }[source];
  const bonus = (installedParts(db, playerId).idol ?? 0) >= 2 ? 1 + CFG.shrineBloodBonus : 1; // Idol of the Hunt II
  const amount = per * units * bonus * (1 + (mods(db, playerId).bloodGather ?? 0)); // Idol II and the skill board
  if (!(amount > 0)) return;
  db.prepare('UPDATE players SET blood = MIN(?, blood + ?) WHERE id = ?').run(tankSize(db, playerId), amount, playerId);
}

/** True while this player's shrine is running: they are away, doing something automated, and have no protection from raids. */
export function isAutomated(db: DB, playerId: number): boolean {
  return !!db.prepare("SELECT 1 FROM shrine WHERE player_id = ? AND status = 'running'").get(playerId);
}
