import type { DB } from '../db/core.ts';
import { CFG, DAY_MS, HOUR } from '../core/config.ts';
import { GameError } from '../core/errors.ts';
import { type Rng } from '../core/rng.ts';
import { type Player } from '../game/character/player.ts';

/**
 * The bot "brain": one call = one play session. Bots use the very same game services as players, so they can never
 * do anything a human could not (no cheating, no rule drift). Invalid attempts are just refused by the rules (GameError).
 */
export interface Ctx {
  db: DB;
  now: number;
  rng: Rng;
  /** may bots raid real (human) players? */ humans: boolean;
  humanRaidChance: number;
}
export interface BotRow {
  player_id: number;
  persona: string;
  tz: number;
  sessions_left: number;
}
export interface SessionResult {
  nextAt: number;
  sessionsLeft: number;
  actions: string[];
}

/** Run a game action; rule violations (GameError) are expected and mean "not possible right now". */
export function attempt<T>(fn: () => T): T | undefined {
  try {
    return fn();
  } catch (e) {
    if (e instanceof GameError) return undefined;
    throw e;
  }
}
/** Same, for actions that return nothing: true when the rules allowed it. */
export function ok(fn: () => unknown): boolean {
  try {
    fn();
    return true;
  } catch (e) {
    if (e instanceof GameError) return false;
    throw e;
  }
}
export const pickWeighted = <K extends string>(rng: Rng, w: Record<K, number>): K => {
  const keys = Object.keys(w) as K[];
  let x = rng() * keys.reduce((s, k) => s + w[k], 0);
  for (const k of keys) {
    x -= w[k];
    if (x < 0) return k;
  }
  return keys[keys.length - 1];
};
export const localHour = (now: number, tz: number) => (((Math.floor(now / HOUR) + tz) % 24) + 24) % 24;
export const isNight = (now: number, tz: number) => {
  const h = localHour(now, tz);
  return h >= 1 && h < 7;
};
export const huntLeft = (p: Player, now: number) => CFG.huntBudget - (p.hunt_day === Math.floor(now / DAY_MS) ? p.hunt_used : 0);
