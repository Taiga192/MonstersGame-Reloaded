/** Private mail. */
import type { Api } from '../context.ts';
import { tx } from '../../db/core.ts';
import { pageNumber } from '../validate.ts';
import * as mail from '../../game/social/mail.ts';

export function mailRoutes(api: Api) {
  const { app, db, now, me, act } = api;
  app.get('/api/mail', (c) => {
    const id = me(c);
    const page = pageNumber(c.req.query('page'));
    return c.json(c.req.query('box') === 'sent' ? mail.sentbox(db, id, page) : mail.inbox(db, id, page));
  });
  app.get('/api/mail/:id', (c) => {
    const id = me(c);
    return c.json(tx(db, () => mail.readMail(db, id, Number(c.req.param('id')), now())));
  });
  app.post(
    '/api/mail/send',
    act((id, b) => mail.sendMail(db, id, b.to, b.subject, b.body, now())),
  );
  app.post(
    '/api/mail/delete',
    act((id, b) => mail.deleteMail(db, id, b.mailId)),
  );
}
