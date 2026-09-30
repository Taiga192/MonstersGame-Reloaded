import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { JSDOM } from 'jsdom';
import { createApp } from '../src/node-app.ts';
import { listAssets } from '../src/assets.ts';
import { openDb } from '../src/db.ts';
import { seeded } from '../src/rng.ts';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

function tmpPublic(files: string[]) {
  const dir = mkdtempSync(join(tmpdir(), 'mg-public-'));
  for (const f of ['index.html', 'app.js', 'style.css']) copyFileSync(join('public', f), join(dir, f));
  for (const f of files) { const p = join(dir, 'assets', f); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, PNG); }
  return dir;
}

test('listAssets: keys drop the extension, any image type works, nested folders, non-images ignored', () => {
  const dir = tmpPublic(['brand/logo.png', 'bg/site.jpg', 'items/itm_Blade_1.webp', 'notes.txt', 'deep/er/x.svg']);
  try {
    const a = listAssets(dir);
    assert.deepEqual(Object.keys(a).sort(), ['bg/site', 'brand/logo', 'deep/er/x', 'items/itm_Blade_1']);
    assert.equal(a['items/itm_Blade_1'].file, 'items/itm_Blade_1.webp');
    assert.ok(a['brand/logo'].v > 0);
    assert.deepEqual(listAssets(join(dir, 'nowhere')), {});
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

async function boot(publicDir: string) {
  const clock = { offset: 0 };
  const app = createApp({ db: openDb(), now: () => 1_800_000_000_000 + clock.offset, rng: seeded(5), devClock: clock, publicDir });
  const dom = new JSDOM(readFileSync(join(publicDir, 'index.html'), 'utf8'), { url: 'http://localhost/', runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window as any;
  const errors: string[] = [];
  w.addEventListener('error', (e: any) => errors.push(e.message));
  w.fetch = (url: string, init?: RequestInit) => app.request('/' + String(url).replace(/^https?:\/\/localhost\/?/, '').replace(/^\//, ''), init);
  w.confirm = () => true;
  w.eval(readFileSync(join(publicDir, 'app.js'), 'utf8'));
  const doc = w.document as Document;
  const until = async (cond: () => boolean, what: string) => {
    for (let i = 0; i < 500; i++) { if (cond()) return; await new Promise((r) => setTimeout(r, 20)); }
    { const e = new Error(`timeout waiting for ${what}\nVIEW: ${doc.querySelector('#view')!.textContent!.slice(0, 300)}`); w.close(); throw e; }
  };
  const register = async (name: string) => {
    await until(() => !!doc.querySelector('#reg'), 'login page'); await new Promise((r) => setTimeout(r, 50)); // the page attaches its form handlers a tick after rendering
    (doc.querySelector('#reg [name=name]') as HTMLInputElement).value = name;
    (doc.querySelector('#reg [name=password]') as HTMLInputElement).value = 'secret12';
    doc.querySelector('#reg')!.dispatchEvent(new w.Event('submit', { cancelable: true }));
    await until(() => doc.querySelector('#view')!.textContent!.includes('Attributes'), 'overview');
  };
  const go = async (hash: string, text: string) => { w.location.hash = hash; await until(() => doc.querySelector('#view')!.textContent!.includes(text), `${hash} → ${text}`); };
  return { w, doc, until, register, go, errors, close: () => w.close() };
}

test('UI without any art: no <img> anywhere, text and emoji fallbacks stay', async () => {
  const dir = tmpPublic([]);
  const { doc, register, go, errors, close } = await boot(dir);
  try {
    await register('Plain');
    for (const [h, t] of [['#/overview', 'Attributes'], ['#/hunt', 'Manhunt'], ['#/town/store/weapon', 'Blade Mk 1'], ['#/town/sentinels', 'Sentinel market'], ['#/hideout', 'Your hideout'], ['#/arena', 'Your arena record']] as const) {
      await go(h, t);
      assert.equal(doc.querySelectorAll('img').length, 0, `${h} rendered an <img> without assets`);
    }
    assert.match(doc.querySelector('#top')!.textContent!, /MonstersGame-Reloaded/, 'text brand as fallback');
    assert.equal(doc.querySelectorAll('.banner').length, 0);
    assert.deepEqual(errors, []);
  } finally { close(); rmSync(dir, { recursive: true, force: true }); }
});

test('UI with art: logo, nav/stat/item icons, banners, portraits, hunt scenes, theme variables and favicon', async () => {
  const dir = tmpPublic([
    'brand/logo.png', 'brand/favicon.webp', 'bg/site.jpg', 'bg/vampire.jpg', 'banners/overview.jpg', 'banners/store.jpg', 'nav/raid.png', 'nav/overview.png',
    'icons/stat_str.png', 'icons/gold.png', 'races/vampire.png', 'items/itm_Blade_1.png', 'items/cat_weapon.png', 'sentinels/sen_1.png', 'hunt/village.jpg', 'hideout/wall_1.png', 'ranks/unranked.png',
  ]);
  const { w, doc, until, register, go, errors, close } = await boot(dir);
  try {
    await register('Pretty');
    const srcs = (sel: string) => [...doc.querySelectorAll<HTMLImageElement>(sel)].map((i) => i.getAttribute('src')!);
    // theme
    assert.match(doc.documentElement.style.getPropertyValue('--img-site'), /bg\/site\.jpg/);
    assert.match(doc.documentElement.style.getPropertyValue('--img-race'), /bg\/vampire\.jpg/, 'race background for a vampire');
    assert.ok(doc.body.classList.contains('has-race-bg'));
    assert.match(doc.querySelector<HTMLLinkElement>('link[rel=icon]')!.getAttribute('href')!, /favicon\.webp/);
    // header
    assert.ok(srcs('#top img.logo')[0].includes('brand/logo.png'));
    assert.equal(doc.querySelectorAll('#top .nav-ico').length, 2, 'only nav icons that exist are shown');
    // overview: banner, portrait, stat icon, gold icon; version param for cache busting
    assert.match(doc.querySelector<HTMLElement>('.banner')!.getAttribute('style')!, /banners\/overview\.jpg\?v=\d+/);
    assert.ok(srcs('#view img.portrait')[0].includes('races/vampire.png'));
    assert.ok(srcs('#view img.ico').some((s) => s.includes('icons/stat_str.png')));
    assert.ok(srcs('#view img.ico').some((s) => s.includes('icons/gold.png')));
    assert.equal(doc.querySelectorAll('#view img[src*="stat_def"]').length, 0, 'missing icons are not rendered');
    // store: banner, category icon, item icon only for the item that has art
    await go('#/town/store/weapon', 'Blade Mk 1');
    await until(() => !!doc.querySelector('.banner') && !!doc.querySelector('.item-ico'), 'store art');
    assert.equal(doc.querySelectorAll('#view .item-ico').length, 1);
    assert.ok(srcs('#view .item-ico')[0].includes('items/itm_Blade_1.png'));
    assert.ok(srcs('#view .card .tabs img')[0].includes('items/cat_weapon.png'));
    // pages without a banner file stay clean
    await go('#/hunt', 'Manhunt');
    assert.equal(doc.querySelectorAll('.banner').length, 0);
    assert.equal(doc.querySelectorAll('#view .scenes img').length, 1, 'only the village scene exists');
    // sentinel market
    await go('#/town/sentinels', 'Sentinel market');
    assert.ok(srcs('#view .item-ico')[0].includes('sentinels/sen_1.png'));
    // arena: unranked badge
    await go('#/arena', 'Your arena record');
    assert.ok(srcs('#view img.badge')[0].includes('ranks/unranked.png'));
    // hideout tile appears after the first upgrade of the wall
    await go('#/hideout', 'Your hideout');
    assert.equal(doc.querySelectorAll('#view .tiles img').length, 0, 'level 0 shows no tile');
    (doc.querySelector('#dg') as HTMLInputElement).value = '5000';
    (doc.querySelector('[data-dev=grant]') as HTMLElement).click();
    await new Promise((r) => setTimeout(r, 200));
    await go('#/hideout', 'Your hideout');
    (doc.querySelector('[data-do="/hideout/upgrade"][data-body*="wall"]') as HTMLElement).click();
    await until(() => doc.querySelectorAll('#view .tiles img').length === 1, 'wall tile');
    assert.ok(srcs('#view .tiles img')[0].includes('hideout/wall_1.png'));
    assert.deepEqual(errors, []);
    void w;
  } finally { close(); rmSync(dir, { recursive: true, force: true }); }
});

test('GET /api/assets lists what exists', async () => {
  const dir = tmpPublic(['brand/logo.png']);
  try {
    const app = createApp({ db: openDb(), now: () => 1, rng: seeded(1), publicDir: dir });
    const r = await (await app.request('/api/assets')).json() as Record<string, { file: string }>;
    assert.equal(r['brand/logo'].file, 'brand/logo.png');
    const file = await app.request('/assets/brand/logo.png'); // and the static server actually serves it (absolute publicDir)
    assert.equal(file.status, 200);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
