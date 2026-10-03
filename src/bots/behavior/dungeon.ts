import { MIN } from '../../core/config.ts';
import * as dungeon from '../../game/world/dungeon.ts';
import { loadPlayer } from '../../game/character/player.ts';
import { type Persona } from '../personas.ts';
import { attempt, ok, type Ctx } from '../context.ts';

export const bestOption = (opts: { value: number }[]) => opts.reduce((bi, o, i) => (o.value > opts[bi].value ? i : bi), 0);
export const AFTER_WAIT = 20_000; // a bot looks again shortly after the wait between fights is over

/**
 * Keep delving: one fight whenever the wait between fights is over. Returns when this bot should look again, or null when it is
 * no longer inside (it died). Dying costs nothing but the re-entry cooldown, so fighting on is always right.
 */
export function dungeonContinue(ctx: Ctx, id: number, note: (a: string) => void): number | null {
  const { db, now, rng } = ctx;
  const st = dungeon.dungeonState(db, id, now);
  if (!st.active) return null;
  if (st.pending) ok(() => dungeon.chooseReward(db, id, bestOption(st.pending!), now));
  if (now < st.readyAt) return st.readyAt + AFTER_WAIT;
  const r = attempt(() => dungeon.fight(db, id, now, rng));
  if (!r) return now + 2 * MIN;
  if (r.died) {
    note(`dungeon: died on ${r.depth}`);
    return null;
  }
  if (r.checkpoint) note(`dungeon checkpoint ${r.checkpoint}`);
  if (r.choice) ok(() => dungeon.chooseReward(db, id, bestOption(r.choice!), now));
  return (r.readyAt ?? now) + AFTER_WAIT;
}

/**
 * A dungeon visit: claim a waiting guardian reward, sell loot to the relic dealer, enter and fight the first monster.
 * Returns when the bot should look again (it stays inside until it dies), or null when it did not go in.
 */
export function dungeonTurn(ctx: Ctx, id: number, persona: Persona, note: (a: string) => void): number | null {
  const { db, now, rng } = ctx;
  if (rng() > persona.dungeon) return null;
  const st = dungeon.dungeonState(db, id, now);
  if (st.pending && ok(() => dungeon.chooseReward(db, id, bestOption(st.pending!), now))) note('guardian reward');
  const gold = loadPlayer(db, id, now).gold;
  if (st.loot.length && (st.lootValue >= 150 || st.loot.length >= 4 || gold < 100)) {
    const r = attempt(() => dungeon.sellLoot(db, id, 'all', now));
    if (r) note(`sold loot +${r.gold}g`);
  }
  if (!st.canEnter || !ok(() => dungeon.enterDungeon(db, id, now))) return null;
  note('dungeon: entered');
  return dungeonContinue(ctx, id, note);
}
