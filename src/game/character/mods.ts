/** Reading a character's skill board modifiers (kept as JSON on the player row, summed when the board changes). A leaf file. */
import type { Mods } from '../../data/skill-board.ts';

const cache = new Map<string, Mods>();
/** The modifiers of a character: `modsOf(player).huntGold` is 0.12 for "+12 % gold from hunts". Missing keys read as undefined. */
export function modsOf(p: { skill_mods: string }): Mods {
  let m = cache.get(p.skill_mods);
  if (!m) {
    try {
      m = JSON.parse(p.skill_mods) as Mods;
    } catch {
      m = {};
    }
    if (cache.size > 2000) cache.clear();
    cache.set(p.skill_mods, m);
  }
  return m;
}
/** `(1 + the modifier)`: the factor a percentage bonus multiplies with. */
export const factor = (p: { skill_mods: string }, key: keyof Mods) => 1 + (modsOf(p)[key] ?? 0);

/** A price after a percentage discount from the skill board (never below 1 gold). */
export const discounted = (price: number, p: { skill_mods: string }, key: 'shopDiscount' | 'trainDiscount' | 'hardenDiscount' | 'ancestralFee') =>
  Math.max(1, Math.round(price * (1 - (modsOf(p)[key] ?? 0))));
