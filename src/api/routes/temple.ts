/** The Blood Temple (player market). */
import type { Api } from '../context.ts';
import { tx } from '../../db/core.ts';
import * as temple from '../../game/world/temple.ts';

export function templeRoutes(api: Api) {
  const { app, db, now, me, act } = api;
  app.get('/api/temple', (c) => {
    const id = me(c);
    return c.json(tx(db, () => temple.browse(db, id, now())));
  });
  app.post(
    '/api/temple/list',
    act((id, b) => temple.listItem(db, id, b.inventoryId, b.price, now())),
  );
  app.post(
    '/api/temple/cancel',
    act((id, b) => temple.cancelListing(db, id, b.listingId, now())),
  );
  app.post(
    '/api/temple/buy',
    act((id, b) => temple.buyListing(db, id, b.listingId, now())),
  );
}
