/** Raids (searching for an opponent and attacking). */
import type { Api } from '../context.ts';
import * as raid from '../../game/combat/raid.ts';

export function raidRoutes(api: Api) {
  const { app, db, now, rng, act } = api;
  app.post(
    '/api/raid/search',
    act((id) => raid.searchOpponent(db, id, now(), rng)),
  );
  app.post(
    '/api/raid/attack',
    act((id, b) => raid.attack(db, id, b.targetId, now(), rng)),
  );
}
