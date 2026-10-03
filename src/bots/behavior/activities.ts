import { CFG, MIN } from '../../core/config.ts';
import { randInt } from '../../core/rng.ts';
import * as eco from '../../game/world/economy.ts';
import { attackCooldownOf, battleStats, loadPlayer, type Player } from '../../game/character/player.ts';
import { attack, searchOpponent } from '../../game/combat/raid.ts';
import { warAttack, warOf } from '../../game/combat/war.ts';
import { type Persona } from '../personas.ts';
import { attempt, huntLeft, ok, type Ctx } from '../context.ts';

export const power = (s: { str: number; def: number; agi: number; sta: number }) => s.str + s.def + s.agi + s.sta;

export function raid(ctx: Ctx, id: number, persona: Persona, note: (a: string) => void) {
  const { db, now, rng } = ctx;
  const p = loadPlayer(db, id, now);
  if (rng() > persona.raid || p.hp < CFG.hpProtectThreshold || p.hp < p.max_hp * 0.5 || now - p.last_attack_at < attackCooldownOf(p)) return;
  if (warOf(db, id) && rng() < 0.85) {
    const r = attempt(() => warAttack(db, id, now, rng));
    if (r) note(`war ${r.winner === p.name ? 'win' : 'loss'} vs ${r.target.name}`);
    return;
  }
  const mine = power(battleStats(db, p, { ancestral: p.level >= CFG.ancestralMinLevel }));
  for (let i = 0; i < 3; i++) {
    const s = attempt(() => searchOpponent(db, id, now, rng, { botsOnly: !ctx.humans }));
    if (!s) return;
    if (!s.found) {
      if (s.reason === 'no_opponents') return;
      continue;
    }
    const t = loadPlayer(db, s.target.id, now);
    if (!t.is_bot && rng() > ctx.humanRaidChance) continue; // real players get left alone most of the time
    if (mine < power(battleStats(db, t, { ancestral: t.level >= CFG.ancestralMinLevel })) * persona.minPower) continue; // not worth the risk
    const r = attempt(() => attack(db, id, t.id, now, rng));
    if (r) note(`raid ${r.winner === p.name ? 'win' : 'loss'} vs ${t.name}`);
    return;
  }
}

/** The "away" activity: a long hunt while budget remains, otherwise a graveyard shift (long overnight). */
export function longActivity(ctx: Ctx, p: Player, persona: Persona, night: boolean, note: (a: string) => void): boolean {
  const { db, now, rng } = ctx;
  const left = huntLeft(p, now);
  if (left >= 60 * MIN && rng() < persona.hunt) {
    const portions = Math.min(Math.floor(left / CFG.huntPortion), randInt(rng, 6, 18));
    if (ok(() => eco.startHunt(db, p.id, portions, now))) {
      note(`hunt ${portions}x10m`);
      return true;
    }
  }
  // Most "away" time is simply being logged out (and therefore attackable); graveyard shifts are for bots that need gold.
  if (rng() < persona.work * 0.45 || p.gold < 120) {
    const hours = persona.key === 'casual' && rng() < 0.3 ? randInt(rng, 24, 48) : night ? randInt(rng, 5, 10) : randInt(rng, 1, 5);
    if (ok(() => eco.startWork(db, p.id, hours, now))) {
      note(`work ${hours}h`);
      return true;
    }
  }
  return false;
}
