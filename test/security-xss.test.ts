import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { JSDOM } from 'jsdom';
import { openDb } from '../src/db.ts';
import { createApp } from '../src/node-app.ts';
import { seeded } from '../src/rng.ts';

const T0 = 1_800_000_000_000;
const H = { 'content-type': 'application/json' };
// Every one of these tries to become real HTML or run script if a text is put into the page without escaping.
const PAYLOADS = [
  '<img src=x onerror="window.__xss=1">',
  '<script>window.__xss=1</script>',
  '"><svg onload=window.__xss=1>',
  "'><b id=injected>pwned</b>",
  '<iframe srcdoc="<script>parent.__xss=1</script>"></iframe>',
  '</td></tr></table><h1 id=injected>x</h1>',
  '<a href="javascript:window.__xss=1">click</a>',
];

test('XSS: user-written text (forum, mail, clan applications) is always shown as text, never as HTML', async (t) => {
  const db = openDb();
  const app = createApp({ db, now: () => T0, rng: seeded(2) });
  const post = (path: string, body: unknown, token?: string) => app.request(path, { method: 'POST', headers: { ...H, ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
  const reg = async (name: string) => { await post('/api/register', { name, password: 'secret12', race: 'vampire' }); return ((await (await post('/api/login', { name, password: 'secret12' })).json()) as any).token as string; };
  const leader = await reg('Leader1'), member = await reg('Member1');
  db.prepare('UPDATE players SET level = 5').run();
  assert.equal((await post('/api/clan/create', { name: 'Test Court' }, leader)).status, 200);
  await post('/api/clan/recruiting', { open: false }, leader);
  const clanId = (db.prepare('SELECT id FROM clans').get() as any).id;
  for (const [i, p] of PAYLOADS.entries()) {
    if (i === 0) { await post('/api/clan/apply', { clanId, message: p }, member); } // one application per player: the first payload
    assert.equal((await post('/api/forum/thread', { title: p.slice(0, 80), body: p }, leader)).status, 200, 'forum thread ' + i);
    assert.equal((await post('/api/mail/send', { to: 'Leader1', subject: p.slice(0, 60), body: p }, member)).status, 200, 'mail ' + i);
  }

  const dom = new JSDOM(readFileSync('public/index.html', 'utf8'), { url: 'http://localhost/', runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window as any;
  t.after(() => w.close()); // also when an assertion fails: a leftover window would keep the test runner alive
  w.localStorage.setItem('mg_token', leader);
  w.fetch = (url: string, init?: RequestInit) => app.request('/' + String(url).replace(/^https?:\/\/localhost\/?/, '').replace(/^\//, ''), init);
  w.eval(readFileSync('public/app.js', 'utf8'));
  const doc = w.document as Document;
  const view = () => doc.querySelector('#view')!;
  const until = async (cond: () => boolean, what: string) => { for (let i = 0; i < 150; i++) { if (cond()) return; await new Promise((r) => setTimeout(r, 20)); } throw new Error('timeout: ' + what + '\n' + view().textContent!.slice(0, 200)); };
  const dangerous = 'script, iframe, object, embed, svg, img[src="x"], #injected, h1, [onerror], [onload], [onfocus], [onmouseover], a[href^="javascript"]';
  const check = (where: string) => {
    assert.equal(w.__xss, undefined, `${where}: script ran`);
    assert.equal(doc.querySelectorAll(`#view ${dangerous.split(', ').join(', #view ')}, #top ${dangerous.split(', ').join(', #top ')}`).length - doc.querySelectorAll('#view h1').length, 0, `${where}: injected element found: ${[...doc.querySelectorAll('#view script, #view iframe, #view svg, #view img[src="x"], #view #injected')].map((e) => e.outerHTML).join(' ')}`);
  };
  const visit = async (hash: string, marker: string, literal = true) => {
    w.location.hash = hash;
    await until(() => view().textContent!.includes(marker), hash);
    if (literal) assert.ok(view().textContent!.includes(PAYLOADS[0]) || view().textContent!.includes('<img src=x'), `${hash}: the payload should be visible as literal text`);
    check(hash);
  };

  await until(() => view().textContent!.includes('Attributes'), 'logged in overview');
  await visit('#/clan', 'Applications');            // the application message (rendered inside a table cell)
  await visit('#/clan/forum', 'Clan forum');        // thread titles
  await visit('#/clan/forum/1', 'Reply');           // thread title + post bodies
  await visit('#/mail', 'Inbox');                   // mail subjects
  await visit('#/mail/1', 'Reply', false);          // mail subject and body
  // second thread and a different payload family
  await visit('#/clan/forum/3', 'Reply', false);
  await visit('#/mail/3', 'Reply', false);
  await visit('#/highscore/level/all', 'Highscore', false);
});

test('XSS: attacker-controlled parts of the URL (#/page/arg/...) cannot inject markup or attributes', async (t) => {
  const db = openDb();
  const app = createApp({ db, now: () => T0, rng: seeded(3) });
  const post = (path: string, body: unknown) => app.request(path, { method: 'POST', headers: H, body: JSON.stringify(body) });
  await post('/api/register', { name: 'Victim1', password: 'secret12', race: 'vampire' });
  const token = ((await (await post('/api/login', { name: 'Victim1', password: 'secret12' })).json()) as any).token as string;
  const dom = new JSDOM(readFileSync('public/index.html', 'utf8'), { url: 'http://localhost/', runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window as any;
  t.after(() => w.close()); // also when an assertion fails: a leftover window would keep the test runner alive
  w.localStorage.setItem('mg_token', token);
  w.fetch = (url: string, init?: RequestInit) => app.request('/' + String(url).replace(/^https?:\/\/localhost\/?/, '').replace(/^\//, ''), init);
  w.eval(readFileSync('public/app.js', 'utf8'));
  const doc = w.document as Document;
  const until = async (cond: () => boolean, what: string) => { for (let i = 0; i < 150; i++) { if (cond()) return; await new Promise((r) => setTimeout(r, 20)); } throw new Error('timeout: ' + what); };
  await until(() => doc.querySelector('#view')!.textContent!.includes('Attributes'), 'overview');
  const hostile = ['<img src=x onerror=window.__xss=1>', '"><img src=x onerror=window.__xss=1>', '" onmouseover="window.__xss=1" x="', "'onfocus='window.__xss=1", '<script>window.__xss=1</script>', 'javascript:window.__xss=1', '&#34;><svg onload=window.__xss=1>'];
  for (const h of hostile) {
    for (const hash of [`#/highscore/level/${h}`, `#/highscore/${h}/all/1`, `#/highscore/level/all/${h}`, `#/mail/new/${h}`, `#/clan/forum/${h}`, `#/player/${h}`, `#/arena/${h}`, `#/town/${h}/${h}`, `#/${h}`, `#/dungeon/${h}`, `#/messages/${h}`, `#/bite/${h}`]) {
      w.location.hash = hash;
      await new Promise((r) => setTimeout(r, 40));
      assert.equal(w.__xss, undefined, `script ran for ${hash}`);
      assert.equal(doc.querySelectorAll('#view img[src="x"], #view svg, #view script, #view [onerror], #view [onload], #view [onmouseover], #view [onfocus]').length, 0, `injected markup for ${hash}: ${doc.querySelector('#view')!.innerHTML.slice(0, 200)}`);
      for (const el of doc.querySelectorAll('#view *')) for (const a of el.getAttributeNames()) assert.ok(!/^on/i.test(a), `event attribute "${a}" appeared for ${hash}`);
    }
  }
});
