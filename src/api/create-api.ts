import { Hono } from 'hono';
import { GameError } from '../core/errors.ts';
import { applySettings } from '../core/settings.ts';
import { createContext, type Deps } from './context.ts';
import { LoginGuard } from './login-guard.ts';
import { publicRoutes } from './routes/public.ts';
import { accountRoutes } from './routes/account.ts';
import { characterRoutes } from './routes/character.ts';
import { economyRoutes } from './routes/economy.ts';
import { notificationRoutes } from './routes/notifications.ts';
import { questRoutes } from './routes/quests.ts';
import { skillRoutes } from './routes/skills.ts';
import { shrineRoutes } from './routes/shrine.ts';
import { raidRoutes } from './routes/raids.ts';
import { clanRoutes } from './routes/clans.ts';
import { forumRoutes } from './routes/forum.ts';
import { accomplishmentRoutes } from './routes/accomplishments.ts';
import { arenaRoutes } from './routes/arena.ts';
import { dungeonRoutes } from './routes/dungeon.ts';
import { templeRoutes } from './routes/temple.ts';
import { mailRoutes } from './routes/mail.ts';
import { adminRoutes } from './routes/admin.ts';
import { devRoutes } from './routes/dev.ts';

export type { Deps } from './context.ts';

/** The whole game API as a Web-standard Hono app: it runs on Node, in a Web Worker in the browser, or anywhere else. */
export function createApi(deps: Deps) {
  const { db, devClock, middleware = [], globalMiddleware = [] } = deps;
  const app = new Hono();
  for (const mw of globalMiddleware) app.use('*', mw); // (middleware only wraps routes that are registered AFTER it)
  for (const mw of middleware) app.use('/api/*', mw);
  applySettings(db); // the world's tuned numbers (admin page) are active from the first request

  app.onError((e, c) => {
    if (e instanceof GameError) return c.json({ error: e.code, message: e.message }, e.status as 400);
    // a field of the wrong type (missing, null, boolean, list...) that reached a query: the client's mistake, not ours
    if (e instanceof TypeError && /bound to SQLite/i.test(e.message)) return c.json({ error: 'bad_request', message: 'A field has the wrong type' }, 400);
    console.error(e);
    return c.json({ error: 'internal', message: 'Internal error' }, 500);
  });

  const api = createContext(app, deps, new LoginGuard());
  for (const register of [
    publicRoutes,
    accountRoutes,
    characterRoutes,
    economyRoutes,
    notificationRoutes,
    questRoutes,
    skillRoutes,
    shrineRoutes,
    raidRoutes,
    clanRoutes,
    forumRoutes,
    accomplishmentRoutes,
    arenaRoutes,
    dungeonRoutes,
    templeRoutes,
    mailRoutes,
    adminRoutes,
  ])
    register(api);
  if (devClock) devRoutes(api, devClock);
  return app;
}
