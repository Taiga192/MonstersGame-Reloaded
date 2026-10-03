import { CFG } from '../../core/config.ts';
import { randInt } from '../../core/rng.ts';
import * as arena from '../../game/combat/arena.ts';
import { loadPlayer } from '../../game/character/player.ts';
import { type Persona } from '../personas.ts';
import { ok, type Ctx } from '../context.ts';

export function arenaTurn(ctx: Ctx, id: number, persona: Persona, note: (a: string) => void) {
  const { db, now, rng } = ctx;
  const p = loadPlayer(db, id, now);
  if (p.level < CFG.arenaMinLevel || p.gold < 150 || rng() > persona.arena * 0.35) return;
  if (arena.arenaStatus(db, id, now).current) return;
  const mySkill = arena.skillAverage(p);
  const events = arena
    .listEvents(db, id, now)
    .filter(
      (e: any) =>
        e.status === 'open' && !e.joined && e.deadline > now && e.fee <= p.gold * 0.1 && Math.abs(mySkill - e.base_skill) <= (e.base_skill * e.deviation) / 100,
    );
  if (events.length && rng() < 0.75) {
    const e = events[randInt(rng, 0, events.length - 1)] as { id: number };
    if (ok(() => arena.joinEvent(db, id, e.id, now))) note('joined arena event');
    return;
  }
  const open = (db.prepare("SELECT COUNT(*) n FROM arena_events WHERE status = 'open'").get() as { n: number }).n;
  if (open >= 6 || rng() > 0.3) return;
  const kind = rng() < 0.55 ? 'duel' : 'tournament';
  const fee = Math.min(Math.floor((p.gold * 0.05) / 10) * 10, 500);
  if (
    ok(() =>
      arena.createEvent(
        db,
        id,
        {
          kind,
          size: kind === 'duel' ? 2 : rng() < 0.7 ? 4 : 8,
          deviation: 25,
          fee,
          withEq: rng() < 0.5,
          withSen: rng() < 0.5,
          withAnc: rng() < 0.3,
          registrationMinutes: randInt(rng, 240, 720),
        },
        now,
      ),
    )
  )
    note('created arena event');
}
