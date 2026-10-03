/** Administration: settings, presets, players, announcements and the world wipe. Single player: always allowed; multiplayer: players with the admin flag. */
import type { Context } from 'hono';
import type { Api } from '../context.ts';
import { tx } from '../../db/core.ts';
import { GameError } from '../../core/errors.ts';
import * as auth from '../../game/character/auth.ts';
import * as admin from '../../game/admin/admin.ts';
import { applyPreset, describeSettings, PRESETS, resetAllSettings, resetSetting, setSetting } from '../../core/settings.ts';
import { pageNumber } from '../validate.ts';

export function adminRoutes(api: Api) {
  const { app, db, now, me, body, singlePlayer, onWipe } = api;
  const adminId = (c: Context) => {
    const id = me(c);
    if (!admin.isAdmin(db, id, singlePlayer)) throw new GameError('forbidden', 'Administrators only', 403);
    return id;
  };
  const adminAct =
    <T>(fn: (id: number, b: Record<string, any>) => T) =>
    async (c: Context) => {
      const id = adminId(c);
      const b = await body(c);
      return c.json(tx(db, () => fn(id, b)) ?? { ok: true });
    };
  /** dangerous actions need the admin's password again on a public server (a stolen login token alone must not be enough) */
  const sure = (id: number, b: Record<string, any>) => {
    if (!singlePlayer) auth.confirmPassword(db, id, b.password);
  };
  const settingsView = () => ({
    singlePlayer,
    settings: describeSettings(db),
    presets: Object.entries(PRESETS).map(([key, p]) => ({ key, label: p.label, description: p.description })),
    world: admin.overview(db, now()),
    playerFields: admin.PLAYER_FIELDS,
  });
  app.get('/api/admin', (c) => {
    adminId(c);
    return c.json(tx(db, settingsView));
  });
  app.post(
    '/api/admin/setting',
    adminAct((id, b) => {
      const r = setSetting(db, b.key, b.value);
      admin.log(db, id, 'setting', `${r.key} = ${r.value}`, now());
      return r;
    }),
  );
  app.post(
    '/api/admin/setting/reset',
    adminAct((id, b) => {
      resetSetting(db, b.key);
      admin.log(db, id, 'setting.reset', String(b.key), now());
    }),
  );
  app.post(
    '/api/admin/settings/reset',
    adminAct((id) => {
      resetAllSettings(db);
      admin.log(db, id, 'settings.reset', 'all settings back to the defaults', now());
    }),
  );
  app.post(
    '/api/admin/preset',
    adminAct((id, b) => {
      const label = applyPreset(db, b.name);
      admin.log(db, id, 'preset', label, now());
      return { preset: label };
    }),
  );
  app.post(
    '/api/admin/announce',
    adminAct((id, b) => admin.announce(db, id, b.subject, b.body, now())),
  );
  app.get('/api/admin/players', (c) => {
    adminId(c);
    return c.json(admin.listPlayers(db, { q: c.req.query('q'), who: c.req.query('who'), page: Math.max(1, pageNumber(c.req.query('page'))) }));
  });
  app.get('/api/admin/player/:id', (c) => {
    adminId(c);
    return c.json(admin.playerDetail(db, Number(c.req.param('id'))));
  });
  app.post(
    '/api/admin/player',
    adminAct((id, b) => {
      if (b.field === 'is_admin') sure(id, b);
      admin.setPlayerField(db, id, b.id, b.field, b.value, singlePlayer, now());
    }),
  );
  app.post(
    '/api/admin/player/give',
    adminAct((id, b) => admin.giveItem(db, id, b.id, b.key, now())),
  );
  app.post(
    '/api/admin/player/release',
    adminAct((id, b) => admin.release(db, id, b.id, now())),
  );
  app.post(
    '/api/admin/player/password',
    adminAct((id, b) => {
      sure(id, b);
      auth.adminSetPassword(db, b.id, b.newPassword);
      admin.log(db, id, 'player.password', `new password for player ${Number(b.id)}`, now());
    }),
  );
  app.post(
    '/api/admin/player/delete',
    adminAct((id, b) => {
      sure(id, b);
      admin.deletePlayer(db, id, b.id, now());
    }),
  );
  app.post('/api/admin/wipe', async (c) => {
    const id = adminId(c);
    const b = await body(c);
    if (b.confirm !== 'WIPE') throw new GameError('not_confirmed', 'Type WIPE to confirm', 400);
    const r = tx(db, () => {
      sure(id, b);
      return admin.wipeWorld(db, id, b.mode, now());
    });
    onWipe?.();
    return c.json(r);
  });
}
