/** The shrine: automation of hunting, work and dungeon runs. */
import type { Api } from '../context.ts';
import { tx } from '../../db/core.ts';
import * as shrine from '../../game/world/shrine.ts';

export function shrineRoutes(api: Api) {
  const { app, db, now, rng, me, act } = api;
  app.get('/api/shrine', (c) => {
    const id = me(c);
    return c.json(
      tx(db, () => {
        shrine.settle(db, id, now(), rng);
        return shrine.shrineState(db, id, now());
      }),
    );
  });
  app.post(
    '/api/shrine/buy',
    act((id) => shrine.buyShrine(db, id, now())),
  );
  app.post(
    '/api/shrine/routine',
    act((id, b) => shrine.setRoutine(db, id, b.steps, now(), rng)),
  );
  app.post(
    '/api/shrine/start',
    act((id) => shrine.start(db, id, now(), rng)),
  );
  app.post(
    '/api/shrine/install',
    act((id, b) => shrine.installPart(db, id, b.inventoryId, now(), rng)),
  );
  app.post(
    '/api/shrine/remove',
    act((id, b) => shrine.removePart(db, id, b.kind, now(), rng)),
  );
  app.post(
    '/api/shrine/pause',
    act((id) => shrine.pause(db, id, now(), rng)),
  );
}
