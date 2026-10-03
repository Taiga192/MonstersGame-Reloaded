/** The arena: duels, tournaments, rankings. */
import type { Api } from '../context.ts';
import { tx } from '../../db/core.ts';
import * as arena from '../../game/combat/arena.ts';

export function arenaRoutes(api: Api) {
  const { app, db, now, rng, me, act } = api;
  const arenaTick = () => tx(db, () => arena.tick(db, now(), rng));
  app.get('/api/arena', (c) => {
    const id = me(c);
    arenaTick();
    return c.json({ status: arena.arenaStatus(db, id, now()), events: arena.listEvents(db, id, now()) });
  });
  app.get('/api/arena/event/:id', (c) => {
    me(c);
    arenaTick();
    return c.json(arena.eventDetail(db, Number(c.req.param('id'))));
  });
  app.get('/api/arena/match/:id', (c) => {
    me(c);
    return c.json(arena.matchLog(db, Number(c.req.param('id'))));
  });
  app.get('/api/arena/ranking', (c) => {
    me(c);
    return c.json(arena.ranking(db, c.req.query('kind') === 'alltime' ? 'alltime' : 'season', now()));
  });
  app.post(
    '/api/arena/create',
    act((id, b) => arena.createEvent(db, id, b as any, now())),
  );
  app.post(
    '/api/arena/join',
    act((id, b) => arena.joinEvent(db, id, b.eventId, now())),
  );
  app.post(
    '/api/arena/leave',
    act((id, b) => arena.leaveEvent(db, id, b.eventId)),
  );
  app.post(
    '/api/arena/cancel',
    act((id, b) => arena.cancelEvent(db, id, b.eventId, now())),
  );
}
