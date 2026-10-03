/** The dungeon. */
import type { Api } from '../context.ts';
import { tx } from '../../db/core.ts';
import * as dungeon from '../../game/world/dungeon.ts';

export function dungeonRoutes(api: Api) {
  const { app, db, now, rng, me, act } = api;
  app.get('/api/dungeon', (c) => {
    const id = me(c);
    return c.json(tx(db, () => dungeon.dungeonState(db, id, now())));
  });
  app.post(
    '/api/dungeon/enter',
    act((id) => dungeon.enterDungeon(db, id, now())),
  );
  app.post(
    '/api/dungeon/fight',
    act((id) => dungeon.fight(db, id, now(), rng)),
  );
  app.post(
    '/api/dungeon/leave',
    act((id) => dungeon.leaveDungeon(db, id, now())),
  );
  app.post(
    '/api/dungeon/reward',
    act((id, b) => dungeon.chooseReward(db, id, Number(b.index), now())),
  );
  app.post(
    '/api/dungeon/sell',
    act((id, b) => dungeon.sellLoot(db, id, b.lootId === 'all' || b.lootId == null ? 'all' : Number(b.lootId), now())),
  );
}
