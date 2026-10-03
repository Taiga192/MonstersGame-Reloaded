/** Notifications, the alert bar and the poll the page makes every few seconds. */
import type { Api } from '../context.ts';
import { tx } from '../../db/core.ts';
import * as shrine from '../../game/world/shrine.ts';
import * as quests from '../../game/world/quests.ts';
import * as notes from '../../game/social/notify.ts';
import { alertsFor } from '../../game/social/alerts.ts';

export function notificationRoutes(api: Api) {
  const { app, db, now, rng, me, act } = api;
  app.get('/api/notifications', (c) => {
    const id = me(c);
    return c.json({ items: notes.listNotifications(db, id, Number(c.req.query('limit') ?? 50)), unread: notes.unreadCount(db, id) });
  });
  // the page asks this every few seconds: what is new since the last notification it saw, how many are unread, what needs doing
  app.get('/api/notifications/poll', (c) => {
    const id = me(c);
    return c.json(
      tx(db, () => {
        const t = now();
        quests.ensureWeek(db, t);
        shrine.settle(db, id, t, rng);
        return { serverNow: t, unread: notes.unreadCount(db, id), items: notes.newerThan(db, id, Number(c.req.query('after'))), alerts: alertsFor(db, id, t) };
      }),
    );
  });
  app.post(
    '/api/notifications/read',
    act((id, b) => {
      notes.markRead(db, id, b);
      return { unread: notes.unreadCount(db, id) };
    }),
  );
}
