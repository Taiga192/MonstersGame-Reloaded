/** Accomplishments and their sets. */
import type { Api } from '../context.ts';
import * as acc from '../../game/character/accomplishments.ts';
import { assertFree, loadPlayer } from '../../game/character/player.ts';

export function accomplishmentRoutes(api: Api) {
  const { app, db, now, me, act } = api;
  app.get('/api/accomplishments', (c) => {
    const id = me(c);
    return c.json({ status: acc.accomplishmentStatus(db, id), sets: acc.getSets(db, id), bonus: acc.accomplishmentBonus(db, id) });
  });
  app.post(
    '/api/accomplishments/save',
    act((id, b) => {
      assertFree(loadPlayer(db, id, now()), now());
      acc.saveSet(db, id, b.slot, b.keys);
    }),
  );
  app.post(
    '/api/accomplishments/activate',
    act((id, b) => {
      assertFree(loadPlayer(db, id, now()), now());
      acc.activateSet(db, id, b.slot);
    }),
  );
}
