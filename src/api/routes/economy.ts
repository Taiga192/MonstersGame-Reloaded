/** Training, shop, inventory, sentinels, hideout, hunting, graveyard work and the Ancestral Site. */
import type { Api } from '../context.ts';
import * as eco from '../../game/world/economy.ts';

export function economyRoutes(api: Api) {
  const { app, db, now, rng, act } = api;
  app.post(
    '/api/train',
    act((id, b) => eco.trainStat(db, id, b.stat, now())),
  );
  app.post(
    '/api/store/buy',
    act((id, b) => eco.buyItem(db, id, b.key, now())),
  );
  app.post(
    '/api/inventory/sell',
    act((id, b) => eco.sellItem(db, id, b.inventoryId, now())),
  );
  app.post(
    '/api/inventory/use',
    act((id, b) => eco.usePotion(db, id, b.inventoryId, now())),
  );
  app.post(
    '/api/sentinel/buy',
    act((id, b) => eco.buySentinel(db, id, b.key, now())),
  );
  app.post(
    '/api/sentinel/train',
    act((id, b) => eco.trainSentinel(db, id, b.attr, now())),
  );
  app.post(
    '/api/sentinel/dismiss',
    act((id) => eco.dismissSentinel(db, id)),
  );
  app.post(
    '/api/hideout/upgrade',
    act((id, b) => eco.upgradeHideout(db, id, b.component, now())),
  );
  app.post(
    '/api/hunt/start',
    act((id, b) => eco.startHunt(db, id, b.portions ?? 1, now())),
  );
  app.post(
    '/api/hunt/collect',
    act((id) => eco.collectHunt(db, id, now(), rng)),
  );
  app.post(
    '/api/hunt/cancel',
    act((id) => eco.cancelHunt(db, id, now(), rng)),
  );
  app.post(
    '/api/work/start',
    act((id, b) => eco.startWork(db, id, b.hours, now())),
  );
  app.post(
    '/api/work/collect',
    act((id) => eco.collectWork(db, id, now())),
  );
  app.post(
    '/api/work/cancel',
    act((id) => eco.cancelWork(db, id, now())),
  );
  app.post(
    '/api/ancestral/challenge',
    act((id) => eco.ancestralChallenge(db, id, now(), rng)),
  );

  app.post(
    '/api/inventory/harden',
    act((id, b) => eco.hardenWeapon(db, id, b.inventoryId, now())),
  );
}
