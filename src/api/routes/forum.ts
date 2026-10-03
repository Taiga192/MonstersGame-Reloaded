/** The clan forum. */
import type { Api } from '../context.ts';
import { tx } from '../../db/core.ts';
import { pageNumber } from '../validate.ts';
import * as forum from '../../game/social/forum.ts';

export function forumRoutes(api: Api) {
  const { app, db, now, me, act } = api;
  app.get('/api/forum', (c) => {
    const id = me(c);
    return c.json(tx(db, () => forum.listThreads(db, id, now())));
  });
  app.get('/api/forum/:id', (c) => {
    const id = me(c);
    return c.json(tx(db, () => forum.getThread(db, id, Number(c.req.param('id')), pageNumber(c.req.query('page')), now())));
  });
  app.post(
    '/api/forum/thread',
    act((id, b) => forum.createThread(db, id, b.title, b.body, now())),
  );
  app.post(
    '/api/forum/reply',
    act((id, b) => forum.reply(db, id, b.threadId, b.body, now())),
  );
  app.post(
    '/api/forum/flag',
    act((id, b) => forum.setFlag(db, id, b.threadId, b.flag, !!b.value, now())),
  );
  app.post(
    '/api/forum/delete',
    act((id, b) => forum.deletePost(db, id, b.postId, now())),
  );
}
