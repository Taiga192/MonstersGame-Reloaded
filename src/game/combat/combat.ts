import { CFG } from '../../core/config.ts';
import { randRange, type Rng } from '../../core/rng.ts';
import type { Stats } from '../character/player.ts';

export interface Combatant {
  name: string;
  stats: Stats;
  hp: number;
  maxHp: number;
}
export interface RoundLog {
  round: number;
  attacker: string;
  hit: boolean;
  damage: number;
  targetHp: number;
}
export interface CombatResult {
  winner: 'a' | 'b';
  hpA: number;
  hpB: number;
  rounds: number;
  log: RoundLog[];
}

// [ASSUMED] formulas consistent with the manual: AGI -> hit chance, DEF -> block/evade,
// STR -> damage, STA -> damage mitigation.
export const hitChance = (agi: number, def: number) => Math.min(0.95, Math.max(0.05, agi / (agi + def)));
// Scale-free: damage depends on the STR/STA ratio and on the victim's max HP, so a fight lasts
// ~CFG.hitsToKill hits at parity regardless of level, and stat *ratios* decide who wins.
export const damage = (str: number, sta: number, roll: number, targetMaxHp: number) =>
  Math.max(1, Math.round((targetMaxHp / CFG.hitsToKill) * roll * ((2 * str) / (str + sta))));

const MAX_ROUNDS = 400;

/** Alternating-turn combat; side A strikes first. Ends when someone drops below the loss threshold (10 HP). */
export function simulate(a: Combatant, b: Combatant, rng: Rng): CombatResult {
  let hpA = a.hp,
    hpB = b.hp;
  const log: RoundLog[] = [];
  let round = 0;
  while (hpA >= CFG.hpLossThreshold && hpB >= CFG.hpLossThreshold && round < MAX_ROUNDS) {
    round++;
    const aTurn = round % 2 === 1;
    const att = aTurn ? a : b,
      def = aTurn ? b : a;
    const hit = rng() < hitChance(att.stats.agi, def.stats.def);
    const dmg = hit ? damage(att.stats.str, def.stats.sta, randRange(rng, 0.75, 1.25), def.maxHp) : 0;
    if (aTurn) hpB -= dmg;
    else hpA -= dmg;
    log.push({ round, attacker: att.name, hit, damage: dmg, targetHp: Math.max(0, aTurn ? hpB : hpA) });
  }
  const winner = hpA >= CFG.hpLossThreshold && (hpB < CFG.hpLossThreshold || hpA >= hpB) ? 'a' : 'b';
  // Loser stays alive with at least 1 HP.
  return { winner, hpA: Math.max(1, hpA), hpB: Math.max(1, hpB), rounds: round, log };
}
