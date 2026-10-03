import { CFG, ITEM_BY_KEY } from '../../core/config.ts';
import * as shrine from '../../game/world/shrine.ts';
import * as eco from '../../game/world/economy.ts';
import { loadPlayer, ownedItems, type Player } from '../../game/character/player.ts';
import { type Persona } from '../personas.ts';
import { ok, type Ctx } from '../context.ts';

/** Buy the shrine once it is unlocked and affordable (with a cushion), buy and install the cheap tier I parts when there is spare gold, and give it a routine. */
export function shrineSetup(ctx: Ctx, p: Player, persona: Persona, note: (a: string) => void) {
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
    const inBag = ownedItems(db, p.id)
      .filter((o) => o.def.component?.kind === kind)
      .sort((a, b) => b.def.component!.tier - a.def.component!.tier)[0];
    if (!inBag && !have[kind] && loadPlayer(db, p.id, now).gold >= ITEM_BY_KEY.get(`shrine_${kind}_1`)!.price * 3 && rng() < persona.shrine)
      ok(() => eco.buyItem(db, p.id, `shrine_${kind}_1`, now));
  }
  for (const o of ownedItems(db, p.id)
    .filter((x) => x.def.component)
    .sort((a, b) => b.def.component!.tier - a.def.component!.tier))
    if (ok(() => shrine.installPart(db, p.id, o.id, now, rng))) note(`installed ${o.def.name}`);
  const st = shrine.shrineState(db, p.id, now);
  const want = persona.key === 'casual' || persona.key === 'worker' ? ['hunt:6', 'work:6'] : ['hunt:6', 'work:4'];
  if (st.dungeonUnlocked) want.splice(1, 0, 'dungeon:30'); // a dungeon run in the middle
  const routine = want.slice(0, st.slots);
  if (st.routine.join() !== routine.join() && st.status !== 'running') ok(() => shrine.setRoutine(db, p.id, routine, now, rng));
}
/** Going away: let the shrine work instead of a manual long activity (when it is owned, set up and has blood). */
export function shrineAway(ctx: Ctx, id: number, persona: Persona, note: (a: string) => void): boolean {
  const { db, now, rng } = ctx;
  if (persona.shrine <= 0 || rng() > persona.shrine) return false;
  if (!ok(() => shrine.start(db, id, now, rng))) return false;
  note('shrine started');
  return true;
}
