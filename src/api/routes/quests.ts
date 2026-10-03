/** Weekly quests. */
import type { Api } from '../context.ts';
import { tx } from '../../db/core.ts';
import * as quests from '../../game/world/quests.ts';

export function questRoutes(api: Api) {
  const { app, db, now, me, act } = api;
  app.get('/api/quests', (c) => {
    const id = me(c);
    return c.json(tx(db, () => quests.questState(db, id, now())));
  });
  app.post(
    '/api/quests/claim',
    act((id, b) => quests.claim(db, id, b.quest, b.choice, now())),
  );
}
