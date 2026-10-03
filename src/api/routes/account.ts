/** Accounts: register, log in and out, change the password. */
import type { Api } from '../context.ts';
import { tx } from '../../db/core.ts';
import { GameError } from '../../core/errors.ts';
import * as auth from '../../game/character/auth.ts';

export function accountRoutes(api: Api) {
  const { app, db, now, body, bearer, act, registrationCode, guard } = api;
  app.post('/api/register', async (c) => {
    const b = await body(c);
    if (registrationCode && !auth.secretMatches(b.code, registrationCode))
      throw new GameError('bad_code', 'A registration code is required to create an account on this server', 403);
    const id = tx(db, () => auth.register(db, { name: b.name, password: b.password, race: b.race, referrerId: b.referrerId }, now()));
    return c.json({ id }, 201);
  });
  app.post('/api/logout', (c) => {
    auth.logout(db, bearer(c));
    return c.json({ ok: true });
  });
  app.post('/api/login', async (c) => {
    const b = await body(c);
    guard.check(b.name, now()); // 429 while this account is locked by too many failed attempts
    try {
      const r = auth.login(db, b.name, b.password, now());
      guard.ok(b.name);
      return c.json(r);
    } catch (e) {
      if (e instanceof GameError && e.code === 'bad_login') guard.fail(b.name, now());
      throw e;
    }
  });
  app.post(
    '/api/password',
    act((id, b, c) => auth.changePassword(db, id, b.current, b.next, bearer(c), now())),
  );
}
