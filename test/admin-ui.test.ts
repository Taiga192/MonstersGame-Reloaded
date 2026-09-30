import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test, afterEach } from 'node:test';
import { JSDOM } from 'jsdom';
import { CFG } from '../src/config.ts';
import { openDb } from '../src/db.ts';
import { createApp } from '../src/node-app.ts';
import { seeded } from '../src/rng.ts';

const T0 = 1_800_000_000_000;
afterEach(() => { createApp({ db: openDb(), now: () => T0, rng: seeded(1) }); }); // restore config.ts for the next test

/** the real frontend against the real API; `admin` decides whether the registered player gets the flag */
async function boot(admin: boolean, opts: { singlePlayer?: boolean; local?: boolean } = {}) {
  const db = openDb();
  const app = createApp({ db, now: () => T0, rng: seeded(3), devClock: undefined, security: { limits: false }, singlePlayer: opts.singlePlayer });
  const dom = new JSDOM(readFileSync('public/index.html', 'utf8'), { url: 'http://localhost/game/', runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window as any;
  w.MG_LOCAL = !!opts.local;
  if (opts.local) w.MG_LOCAL_API = { info: () => ({ storage: 'opfs', storageNote: '', sqlite: 'x' }), settings: () => ({ bots: 0, botsRaidHumans: false, humanRaidChance: 0 }) };
  w.fetch = (url: string, init?: RequestInit) => app.request('/' + String(url).replace(/^https?:\/\/localhost\/(game\/)?/, '').replace(/^\//, ''), init);
  w.confirm = () => true;
  w.eval(readFileSync('public/app.js', 'utf8'));
  const doc = w.document as Document;
  const until = async (cond: () => boolean, what: string) => {
    for (let i = 0; i < 500; i++) { if (cond()) return; await new Promise((r) => setTimeout(r, 20)); }
    const e = new Error(`timeout: ${what}\nTOAST: ${doc.querySelector('#toast')?.textContent}\nVIEW: ${doc.querySelector('#view')!.textContent!.replace(/\s+/g, ' ').slice(0, 300)}`); w.close(); throw e;
  };
  // the account exists (and is flagged) BEFORE the page logs in, so the very first /api/me already says who it is
  await app.request('/api/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Boss', password: 'secret12', race: 'vampire' }) });
  if (admin) db.prepare('UPDATE players SET is_admin = 1').run();
  await until(() => !!doc.querySelector('#login'), 'login page'); await new Promise((r) => setTimeout(r, 50));
  (doc.querySelector('#login [name=name]') as HTMLInputElement).value = 'Boss';
  (doc.querySelector('#login [name=password]') as HTMLInputElement).value = 'secret12';
  doc.querySelector('#login')!.dispatchEvent(new w.Event('submit', { cancelable: true }));
  await until(() => doc.querySelector('#view')!.textContent!.includes('Attributes'), 'overview');
  const view = () => doc.querySelector('#view')!;
  const go = async (hash: string, text: string) => { w.location.hash = hash; await until(() => view().textContent!.includes(text), `${hash} -> ${text}`); await new Promise((r) => setTimeout(r, 50)); };
  return { w, doc, db, app, until, view, go, close: () => w.close() };
}

test('a normal player has no Admin menu and the page refuses them', async () => {
  const { doc, go, view, close } = await boot(false);
  try {
    assert.doesNotMatch(doc.querySelector('#top nav')!.textContent!, /Admin/);
    await go('#/admin', 'Administrators only');
    assert.match(view().textContent!, /Administrators only/);
  } finally { close(); }
});

test('an admin sees the menu and all tabs; saving a number changes the world; reset puts it back', async () => {
  const { doc, go, view, until, close } = await boot(true);
  try {
    assert.match(doc.querySelector('#top nav')!.textContent!, /Admin/);
    await go('#/admin', 'Wipe the world');
    assert.match(view().textContent!, /Rates/); assert.match(view().textContent!, /Speed server/); assert.match(view().textContent!, /Type WIPE/);
    assert.ok(doc.querySelector('#view input[name=password]'), 'multiplayer asks for the password before a wipe');
    await go('#/admin/settings', 'Raid cooldown');
    const row = [...doc.querySelectorAll('#view form[data-submit="/admin/setting"]')].find((f) => (f.querySelector('[name=key]') as HTMLInputElement).value === 'attackCooldown')!;
    assert.ok(row);
    (row.querySelector('[name=value]') as HTMLInputElement).value = '4';
    row.dispatchEvent(new (doc.defaultView as any).Event('submit', { cancelable: true }));
    await until(() => CFG.attackCooldown === 4 * 60_000, 'cooldown saved');
    await until(() => doc.querySelector('#view [data-do="/admin/setting/reset"]') !== null, 'reset button appears');
    (doc.querySelector('#view [data-do="/admin/setting/reset"]') as HTMLElement).click();
    await until(() => CFG.attackCooldown === 10 * 60_000, 'cooldown reset');
    await go('#/admin/log', 'What admins did');
    assert.match(view().textContent!, /setting/);
  } finally { close(); }
});

test('players tab: search, open a player, edit gold; names are shown as text, never as markup', async () => {
  const { doc, db, go, view, until, close } = await boot(true);
  try {
    db.prepare("INSERT INTO players (name, pass_hash, race, gold, hp, hp_at, max_hp, str, def, agi, sta, dex, created_at) VALUES ('<img src=x onerror=alert(1)>', '!', 'vampire', 5, 100, 0, 100, 5,5,5,5,5, 0)").run();
    await go('#/admin/players/humans/1', '<img');
    assert.equal(doc.querySelector('#view img[src=x]'), null, 'no injected element');
    await go('#/admin/players/humans/1', 'Boss');
    const link = [...doc.querySelectorAll('#view a')].find((a) => a.textContent === 'Boss')!;
    const id = (link as HTMLAnchorElement).getAttribute('href')!.split('/').pop();
    await go(`#/admin/player/${id}`, 'Give an item');
    const gold = [...doc.querySelectorAll('#view form[data-submit="/admin/player"]')].find((f) => (f.querySelector('[name=field]') as HTMLInputElement)?.value === 'gold')!;
    (gold.querySelector('[name=value]') as HTMLInputElement).value = '777777';
    gold.dispatchEvent(new (doc.defaultView as any).Event('submit', { cancelable: true }));
    await until(() => (db.prepare('SELECT gold FROM players WHERE name = ?').get('Boss') as any).gold === 777777, 'gold saved');
    // the search form narrows the list
    await go('#/admin/players/humans/1', 'Boss');
    const f = doc.querySelector('#view form[data-admin-search]')!;
    (f.querySelector('[name=q]') as HTMLInputElement).value = 'zzz-nobody';
    f.dispatchEvent(new (doc.defaultView as any).Event('submit', { cancelable: true }));
    await until(() => !view().textContent!.includes('Boss') && view().textContent!.includes('0 found'), 'search applied');
  } finally { close(); }
});

test('the wipe form: confirmation word and password are required, then the world restarts', async () => {
  const { doc, db, go, until, close } = await boot(true);
  try {
    db.prepare('UPDATE players SET level = 9, gold = 4000').run();
    await go('#/admin', 'Wipe the world');
    const form = doc.querySelector('#view form[data-submit="/admin/wipe"]')!;
    const submit = () => form.dispatchEvent(new (doc.defaultView as any).Event('submit', { cancelable: true }));
    (form.querySelector('[name=confirm]') as HTMLInputElement).value = 'nope'; (form.querySelector('[name=password]') as HTMLInputElement).value = 'secret12';
    submit(); await new Promise((r) => setTimeout(r, 300));
    assert.equal((db.prepare('SELECT level FROM players').get() as any).level, 9, 'wrong word: nothing happens');
    (form.querySelector('[name=confirm]') as HTMLInputElement).value = 'WIPE';
    submit();
    await until(() => (db.prepare('SELECT level FROM players').get() as any).level === 1, 'wiped');
    assert.equal((db.prepare('SELECT gold FROM players').get() as any).gold, CFG.startGold);
  } finally { close(); }
});

test('single player (browser build): admin without a password prompt and without the multiplayer admin-flag tools', async () => {
  const { doc, go, view, close } = await boot(false, { singlePlayer: true, local: true });
  try {
    assert.match(doc.querySelector('#top nav')!.textContent!, /Admin/, 'the one player is always an admin');
    await go('#/admin', 'Wipe the world');
    assert.equal(doc.querySelector('#view input[name=password]'), null, 'no password needed when you are alone');
    assert.match(view().textContent!, /Single player: you are always the admin/);
  } finally { close(); }
});
