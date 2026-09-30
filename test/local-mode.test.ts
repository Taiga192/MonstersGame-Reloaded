import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { JSDOM } from 'jsdom';
import { createApp } from '../src/node-app.ts';
import { openDb } from '../src/db.ts';
import { seeded } from '../src/rng.ts';

/** The frontend in "local" (GitHub Pages) mode, with a stub of what local-boot.js provides. */
async function boot(local: boolean, api?: object) {
  const app = createApp({ db: openDb(), now: () => 1_800_000_000_000, rng: seeded(3), devClock: { offset: 0 } });
  const dom = new JSDOM(readFileSync('public/index.html', 'utf8'), { url: 'http://localhost/game/', runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window as any;
  w.MG_LOCAL = local; if (api) w.MG_LOCAL_API = api;
  w.fetch = (url: string, init?: RequestInit) => app.request('/' + String(url).replace(/^https?:\/\/localhost\/(game\/)?/, '').replace(/^\//, ''), init);
  w.confirm = () => true;
  w.eval(readFileSync('public/app.js', 'utf8'));
  const doc = w.document as Document;
  const until = async (cond: () => boolean, what: string) => { for (let i = 0; i < 100; i++) { if (cond()) return; await new Promise((r) => setTimeout(r, 20)); } throw new Error(`timeout: ${what}\n${doc.querySelector('#view')!.textContent!.slice(0, 300)}`); };
  await until(() => !!doc.querySelector('#reg'), 'login page');
  (doc.querySelector('#reg [name=name]') as HTMLInputElement).value = 'Localy';
  (doc.querySelector('#reg [name=password]') as HTMLInputElement).value = 'secret12';
  doc.querySelector('#reg')!.dispatchEvent(new w.Event('submit', { cancelable: true }));
  await until(() => doc.querySelector('#view')!.textContent!.includes('Attributes'), 'overview');
  return { w, doc, until, view: () => doc.querySelector('#view')!, close: () => w.close() };
}
const stub = (over: object = {}) => {
  const calls: any[] = [];
  return { calls, info: () => ({ storage: 'opfs', storageNote: '', sqlite: '3.53.4' }), settings: () => ({ bots: 100, botsRaidHumans: true, humanRaidChance: 0.3 }),
    applySettings: async (s: object) => { calls.push(s); }, exportSave: async () => new Uint8Array([1]), importSave: async () => {}, resetGame: async () => {}, ...over };
};

test('local mode: a "Game" page for saves and settings, no victim link, and the API base is relative to the page', async () => {
  const api = stub();
  const { w, doc, until, view, close } = await boot(true, api);
  try {
    assert.match(doc.querySelector('#top nav')!.textContent!, /Game/, 'nav entry only in local mode');
    assert.doesNotMatch(view().textContent!, /Victim link/, 'nobody can visit a victim link in a single-player game');
    w.location.hash = '#/settings';
    await until(() => view().textContent!.includes('Your save'), 'game page');
    assert.match(view().textContent!, /Saved in this browser/);
    assert.match(view().textContent!, /SQLite 3\.53\.4/);
    assert.ok(doc.querySelector('[data-local=export]') && doc.querySelector('input[data-local-import]') && doc.querySelector('[data-local=reset]'));
    assert.equal(doc.querySelector('#view .card.bad'), null, 'no warning when the save is persistent');

    // settings are validated (bots clamped to 0-300) and passed to the engine
    (doc.querySelector('form[data-local-settings] [name=bots]') as HTMLInputElement).value = '9999';
    (doc.querySelector('form[data-local-settings] [name=humanRaidChance]') as HTMLSelectElement).value = '0.6';
    (doc.querySelector('form[data-local-settings] [name=botsRaidHumans]') as HTMLInputElement).checked = false;
    doc.querySelector('form[data-local-settings]')!.dispatchEvent(new w.Event('submit', { cancelable: true }));
    await until(() => api.calls.length === 1, 'settings applied');
    assert.deepEqual(JSON.parse(JSON.stringify(api.calls[0])), { bots: 300, botsRaidHumans: false, humanRaidChance: 0.6 }); // (created inside the fake browser window, so compare as plain JSON)
  } finally { close(); }
});

test('local mode: a visible warning when the browser cannot keep the save', async () => {
  const { w, doc, until, view, close } = await boot(true, stub({ info: () => ({ storage: 'memory', storageNote: 'Persistent storage is not available in this browser (private window).', sqlite: '3.53.4' }) }));
  try {
    assert.match(view().textContent!, /Progress is not being saved/, 'shown on every page');
    assert.match(view().textContent!, /private window/);
    w.location.hash = '#/settings';
    await until(() => view().textContent!.includes('Your save'), 'game page');
    assert.match(view().textContent!, /Not saved: temporary memory only/);
  } finally { close(); }
});

test('server mode is unchanged: no Game page, victim link present', async () => {
  const { doc, view, close } = await boot(false);
  try {
    assert.doesNotMatch(doc.querySelector('#top nav')!.textContent!, /\bGame\b/);
    assert.match(view().textContent!, /Victim link/);
    assert.match((view().querySelector('input[readonly]') as HTMLInputElement).value, /^http:\/\/localhost\/game\/#\/bite\/\d+$/, 'link is built from the page location, so it works under a sub-path');
  } finally { close(); }
});
