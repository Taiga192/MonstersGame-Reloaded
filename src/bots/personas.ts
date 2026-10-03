import type { Stat } from '../config.ts';

/** A persona is just a set of tendencies. All of them play by exactly the same rules as human players. */
export interface Persona {
  key: string;
  /** relative share of the bot population */
  share: number;
  /** stat training preferences (weights) */
  stats: Record<Stat, number>;
  /** chance to go raiding when a raid is possible */
  raid: number;
  /** only attack when own power >= enemy power * minPower (lower = reckless) */
  minPower: number;
  /** preference for hunting / graveyard work as the "long" activity */
  hunt: number;
  work: number;
  /** >= 0.7 means: founds and leads a clan; lower = looks for a clan to join */
  social: number;
  /** interest in arena events */
  arena: number;
  /** fraction of gold kept unspent */
  save: number;
  /** multiplier on the gap between sessions (higher = plays less often) */
  tempo: number;
  /** sessions per online window before going away (work / hunt / sleep) */
  sessions: [number, number];
  /** chance per session to try the dungeon when the re-entry cooldown allows it */
  dungeon: number;
  /** how much this persona likes to let the shrine work while it is away (buys it when it can; 0 = never) */
  shrine: number;
  /** chance per session to look at the Blood Temple (sell surplus gear, buy upgrades) */
  trade: number;
  /** how much this persona values raid-gold and hunt rings when buying gear */
  goldRing: number;
  huntRing: number;
}

export const PERSONAS: Record<string, Persona> = {
  brawler: { key: 'brawler', shrine: 0.2, dungeon: 0.5, trade: 0.3, share: 25, stats: { str: 2, def: 1, agi: 2, sta: 1.5, dex: 0.5 }, raid: 0.9, minPower: 0.85, hunt: 0.3, work: 0.4, social: 0.4, arena: 0.5, save: 0.05, tempo: 0.9, sessions: [6, 12], goldRing: 300, huntRing: 0.05 },
  hunter: { key: 'hunter', shrine: 0.3, dungeon: 0.35, trade: 0.3, share: 25, stats: { str: 1, def: 1, agi: 1.5, sta: 1.5, dex: 2.5 }, raid: 0.25, minPower: 1.1, hunt: 0.95, work: 0.3, social: 0.4, arena: 0.15, save: 0.1, tempo: 1.3, sessions: [2, 4], goldRing: 60, huntRing: 0.6 },
  worker: { key: 'worker', shrine: 0.7, dungeon: 0.3, trade: 0.9, share: 15, stats: { str: 1, def: 1.5, agi: 1, sta: 2, dex: 1 }, raid: 0.2, minPower: 1.2, hunt: 0.35, work: 0.95, social: 0.35, arena: 0.1, save: 0.3, tempo: 1.5, sessions: [2, 3], goldRing: 100, huntRing: 0.1 },
  leader: { key: 'leader', shrine: 0.3, dungeon: 0.35, trade: 0.4, share: 10, stats: { str: 1.5, def: 1.5, agi: 1.5, sta: 1.5, dex: 1 }, raid: 0.6, minPower: 0.95, hunt: 0.5, work: 0.5, social: 1, arena: 0.4, save: 0.15, tempo: 1, sessions: [4, 8], goldRing: 200, huntRing: 0.2 },
  balanced: { key: 'balanced', shrine: 0.5, dungeon: 0.5, trade: 0.5, share: 20, stats: { str: 1.2, def: 1.2, agi: 1.3, sta: 1.2, dex: 1 }, raid: 0.55, minPower: 1, hunt: 0.6, work: 0.55, social: 0.5, arena: 0.3, save: 0.15, tempo: 1.2, sessions: [3, 6], goldRing: 150, huntRing: 0.3 },
  casual: { key: 'casual', shrine: 0.9, dungeon: 0.2, trade: 0.1, share: 5, stats: { str: 1, def: 1, agi: 1, sta: 1, dex: 1 }, raid: 0.3, minPower: 1.1, hunt: 0.5, work: 0.7, social: 0.3, arena: 0.05, save: 0.4, tempo: 2.5, sessions: [1, 2], goldRing: 100, huntRing: 0.2 },
};

export function personaForIndex(i: number): Persona {
  // deterministic spread across the population instead of random draws, so 100 bots always look like 25/25/15/10/20/5
  const total = Object.values(PERSONAS).reduce((s, p) => s + p.share, 0);
  let x = ((i * 37) % total) + 0.5, acc = 0; // 37 is coprime with 100, interleaves personas
  for (const p of Object.values(PERSONAS)) { acc += p.share; if (x < acc) return p; }
  return PERSONAS.balanced;
}
