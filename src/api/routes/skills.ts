/** The skill board. */
import type { Api } from '../context.ts';
import { tx } from '../../db/core.ts';
import * as skills from '../../game/character/skills.ts';
import { boardForClient } from '../../data/skill-board.ts';

export function skillRoutes(api: Api) {
  const { app, db, now, me, act } = api;
  app.get('/api/skills/board', (c) => c.json(boardForClient())); // the same for everybody
  app.get('/api/skills', (c) => {
    const id = me(c);
    return c.json(tx(db, () => skills.skillState(db, id, now())));
  });
  app.post(
    '/api/skills/allocate',
    act((id, b) => {
      skills.allocate(db, id, b.node, now());
      return skills.skillState(db, id, now());
    }),
  );
  app.post(
    '/api/skills/refund',
    act((id, b) => {
      skills.refund(db, id, b.node, now());
      return skills.skillState(db, id, now());
    }),
  );
  app.post(
    '/api/skills/respec',
    act((id) => {
      skills.respec(db, id, now());
      return skills.skillState(db, id, now());
    }),
  );
}
