/** Public routes: art list, game catalog, bites on a victim link, highscores and public profiles. */
import type { Api } from '../context.ts';
import { tx } from '../../db/core.ts';
import { pageNumber } from '../validate.ts';
import * as hs from '../../game/social/highscore.ts';
import * as eco from '../../game/world/economy.ts';
import { ACC_SET_SIZE, ACC_SETS, ACCOMPLISHMENTS, ANCESTRAL, CFG, ITEMS, SENTINELS } from '../../core/config.ts';

export function publicRoutes(api: Api) {
  const { app, db, now, rng, me, assets, registrationCode, clientKey } = api;
  // Which art files exist (extension-less key -> file + mtime). The frontend only renders images that are present.
  app.get('/api/assets', (c) => c.json(assets?.() ?? {}));
  app.get('/api/catalog', (c) =>
    c.json({
      items: ITEMS,
      sentinels: SENTINELS,
      ancestral: ANCESTRAL,
      hideoutMax: CFG.hideoutMax,
      accomplishments: ACCOMPLISHMENTS.map(({ key, name, desc, tiers }) => ({ key, name, desc, tiers })),
      accSets: ACC_SETS,
      accSetSize: ACC_SET_SIZE,
      shrineLevel: CFG.shrineLevel,
      shrineTankPerTier: CFG.shrineTankPerTier,
      shrineSlotsPerTier: CFG.shrineSlotsPerTier,
      shrineBloodBonus: CFG.shrineBloodBonus,
      shrineEfficiencyPerUpgrade: CFG.shrineEfficiencyPerUpgrade,
      shrineRaidLossCap: CFG.shrineRaidLossCap,
      huntPortionMs: CFG.huntPortion,
      hardenMax: CFG.hardenMax,
      hardenBonus: CFG.hardenBonusPerLevel,
      vitalityCap: CFG.vitalityCap,
      vitalityGain: CFG.vitalityGain,
      templeFee: CFG.templeFee,
      arenaSizes: CFG.arenaTournamentSizes,
      arenaMinLevel: CFG.arenaMinLevel,
      arenaStartHourUtc: CFG.arenaDailyStartHourUtc,
      registrationRequired: !!registrationCode,
      passwordMin: CFG.passwordMin,
      passwordMax: CFG.passwordMax,
    }),
  );
  app.post('/api/bite/:id', async (c) => {
    // the visitor is identified by the connection (see node-app.ts), never by a header the client can set to anything
    const visitor = clientKey ? clientKey(c) : 'local';
    return c.json(tx(db, () => eco.bite(db, Number(c.req.param('id')), visitor, now(), rng)));
  });
  // public; a valid login token additionally returns "your rank / your page"
  app.get('/api/highscore', (c) => {
    let playerId: number | undefined;
    try {
      playerId = me(c);
    } catch {
      /* anonymous is fine */
    }
    return c.json(
      tx(db, () =>
        hs.highscore(
          db,
          {
            type: c.req.query('type') ?? 'level',
            race: c.req.query('race'),
            page: pageNumber(c.req.query('page')),
            size: Number(c.req.query('size') ?? 25),
            playerId,
          },
          now(),
        ),
      ),
    );
  });
  app.get('/api/players/:id', (c) => c.json(hs.profile(db, Number(c.req.param('id')), now())));
}
