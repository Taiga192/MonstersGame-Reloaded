import assert from 'node:assert/strict';
import { frontendBundle } from '../support/frontend.ts';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { JSDOM } from 'jsdom';

const sha = (t: string) => createHash('sha256').update(t).digest('hex'); // sessions are stored as the SHA-256 of the token
import { createApp } from '../../src/server/create-app.ts';
import { openDb } from '../../src/db/node.ts';
import { seeded } from '../../src/core/rng.ts';

/** The frontend hosted on another site (itch.io style) talking to a game server at `api`. */
async function boot(api: string | undefined) {
  const db = openDb();
  const app = createApp({ db, now: () => 1_800_000_000_000, rng: seeded(3), devClock: { offset: 0 } });
  const dom = new JSDOM(readFileSync('public/index.html', 'utf8'), {
    url: 'https://html.itch.zone/game/',
    runScripts: 'outside-only',
    pretendToBeVisual: true,
  });
  const w = dom.window as any;
  if (api !== undefined) w.MG_API = api;
  const calls: { url: string; method: string; auth?: string }[] = [];
  w.fetch = (url: string, init: any = {}) => {
    const u = new URL(String(url), 'https://html.itch.zone/game/');
    calls.push({ url: u.href, method: init.method ?? 'GET', auth: init.headers?.authorization });
    if (u.host === 'game.example.com' || (api === undefined && u.host === 'html.itch.zone' && u.pathname.startsWith('/game/api/'))) {
      const path = u.pathname.replace(/^\/game/, '') + u.search;
      return app.request(path, init);
    }
    if (u.pathname.endsWith('/assets.json')) return Promise.resolve(new Response('{}', { headers: { 'content-type': 'application/json' } }));
    return Promise.reject(new Error('unexpected request to ' + u.href));
  };
  w.confirm = () => true;
  w.eval(frontendBundle());
  const doc = w.document as Document;
  const until = async (cond: () => boolean, what: string) => {
    for (let i = 0; i < 500; i++) {
      if (cond()) return;
      await new Promise((r) => setTimeout(r, 20));
    }
    const e = new Error('timeout: ' + what + '\n' + doc.querySelector('#view')!.textContent!.slice(0, 200));
    w.close();
    throw e;
  };
  await until(() => !!doc.querySelector('#reg'), 'login page');
  await new Promise((r) => setTimeout(r, 50)); // the page attaches its form handlers a tick after rendering
  (doc.querySelector('#reg [name=name]') as HTMLInputElement).value = 'Remote';
  (doc.querySelector('#reg [name=password]') as HTMLInputElement).value = 'secret12';
  doc.querySelector('#reg')!.dispatchEvent(new w.Event('submit', { cancelable: true }));
  await until(() => doc.querySelector('#view')!.textContent!.includes('Attributes'), 'overview');
  return { w, doc, db, calls, until, close: () => w.close() };
}

test('remote server mode: every API call goes to the configured server, art comes from the frontend itself', async () => {
  const { calls, close } = await boot('https://game.example.com/'); // (trailing slash on purpose)
  try {
    const apiCalls = calls.filter((c) => c.url.includes('/api/'));
    assert.ok(apiCalls.length >= 4, 'catalog, register, login, me...');
    assert.ok(
      apiCalls.every((c) => c.url.startsWith('https://game.example.com/api/')),
      apiCalls.map((c) => c.url).join('\n'),
    );
    assert.equal(
      calls.some((c) => c.url.includes('/api/assets')),
      false,
      'the game server does not host the art',
    );
    assert.ok(
      calls.some((c) => c.url === 'https://html.itch.zone/game/assets.json'),
      'the frontend ships its own list of art files',
    );
    assert.ok(calls.some((c) => c.url === 'https://game.example.com/api/register' && c.method === 'POST'));
  } finally {
    close();
  }
});

test('remote server mode: logout ends the session on the SERVER (not only in the browser)', async () => {
  const { w, doc, db, calls, until, close } = await boot('https://game.example.com');
  try {
    const token = w.localStorage.getItem('mg_token');
    assert.ok(token);
    assert.equal((db.prepare('SELECT COUNT(*) n FROM sessions WHERE token = ?').get(sha(token)) as any).n, 1);
    (doc.querySelector('[data-act=logout]') as HTMLElement).click();
    await until(() => !!doc.querySelector('#login'), 'back at the login screen');
    const logoutCall = calls.find((c) => c.url === 'https://game.example.com/api/logout');
    assert.ok(logoutCall && logoutCall.method === 'POST', 'the server was told');
    assert.equal(logoutCall!.auth, `Bearer ${token}`, 'with the token that is being ended');
    assert.equal((db.prepare('SELECT COUNT(*) n FROM sessions WHERE token = ?').get(sha(token)) as any).n, 0, 'so a copied token is worthless');
    assert.equal(w.localStorage.getItem('mg_token'), null);
  } finally {
    close();
  }
});

test('same-origin mode is unchanged: relative api/ URLs and the server-side asset list', async () => {
  const { calls, close } = await boot(undefined);
  try {
    const apiCalls = calls.filter((c) => c.url.includes('/api/'));
    assert.ok(
      apiCalls.every((c) => c.url.startsWith('https://html.itch.zone/game/api/')),
      'relative to the page, so it works from any sub-path',
    );
    assert.ok(calls.some((c) => c.url.endsWith('/api/assets')));
  } finally {
    close();
  }
});
