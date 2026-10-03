// End-to-end check of the GitHub Pages build in a REAL browser (Firefox via WebDriver BiDi):
//   npm run build:pages && npm run e2e
// Serves dist/ from a sub-path without special headers (like GitHub Pages), registers a character, plays, reloads to prove
// the save persists in OPFS, and opens a second tab to check the "already open" guard. Needs Firefox installed.
import { spawn } from 'node:child_process';
import puppeteer from 'puppeteer-core';

const PORT = 8181,
  BASE = '/MonstersGame/',
  URL0 = `http://localhost:${PORT}${BASE}`;
const FIREFOX = process.env.FIREFOX ?? '/usr/bin/firefox';
const results: string[] = [];
const ok = (name: string, cond: unknown, detail = '') => {
  results.push(`${cond ? '✔' : '✖'} ${name}${detail ? ` (${detail})` : ''}`);
  if (!cond) process.exitCode = 1;
};

const server = spawn('node', ['scripts/preview.ts', 'dist', BASE, String(PORT)], { stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 1000));
const browser = await puppeteer.launch({ browser: 'firefox', executablePath: FIREFOX, headless: true, protocol: 'webDriverBiDi' });
const errors: string[] = [];
try {
  const page = await browser.newPage();
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  const text = () => page.evaluate(() => document.querySelector('#view')!.textContent ?? '');
  const waitText = (t: string, ms = 30000) => page.waitForFunction((x) => document.querySelector('#view')?.textContent?.includes(x), { timeout: ms }, t);

  // 1. loads from a sub-path and the worker + SQLite start
  await page.goto(URL0, { waitUntil: 'load' });
  await page.waitForSelector('#reg', { timeout: 30000 });
  const info = await page.evaluate(() => (window as any).MG_LOCAL_API.info());
  ok('game engine started in the browser', info.sqlite, `SQLite ${info.sqlite}`);
  ok('database is persistent (OPFS), not memory', info.storage === 'opfs', info.storage + (info.storageNote ? ': ' + info.storageNote : ''));

  // 2. register (password hashing runs in the browser) and land on the overview
  await page.type('#reg [name=name]', 'Browserling');
  await page.type('#reg [name=password]', 'secret12');
  await page.click('#reg button');
  await waitText('Attributes');
  ok('registered and logged in', /Browserling/.test(await page.evaluate(() => document.querySelector('#top')!.textContent ?? '')));

  // 3. the world exists: 100 bots at level 1
  const hs = await page.evaluate(async () => await (await fetch('api/highscore?type=level&size=100')).json());
  ok('100 bots + you in the world', hs.total === 101, `total ${hs.total}`);
  ok(
    'bots start at level 1',
    hs.rows.every((r: any) => r.level === 1),
  );

  // 4. play: train strength (costs 20 of the 100 starting gold)
  await page.evaluate(() => (document.querySelector('[data-do="/train"][data-body*="str"]') as HTMLElement).click());
  await page.waitForFunction(() => /Strength\s*6/.test(document.querySelector('#view')?.textContent ?? ''), { timeout: 15000 });
  ok('an action is processed and saved (Strength 5 -> 6)', true);

  // 5. bots play inside the worker
  const token = await page.evaluate(() => localStorage.getItem('mg_token'));
  const act = await page.evaluate(
    async (t) =>
      await (
        await fetch('api/dev/bots-act', { method: 'POST', headers: { authorization: 'Bearer ' + t, 'content-type': 'application/json' }, body: '{}' })
      ).json(),
    token,
  );
  ok('bots can act (test tool)', /100 bots played a session/.test(act.message ?? ''), act.message ?? JSON.stringify(act));

  // 6. export produces a real SQLite file
  const header = await page.evaluate(async () => {
    const b: Uint8Array = await (window as any).MG_LOCAL_API.exportSave();
    return { size: b.length, magic: new TextDecoder().decode(b.slice(0, 15)) };
  });
  ok('export gives a SQLite file', header.magic === 'SQLite format 3', `${(header.size / 1024).toFixed(0)} KB`);

  // 7. a second tab must be refused (one game per browser at a time)
  const second = await browser.newPage();
  await second.goto(URL0, { waitUntil: 'load' });
  await second
    .waitForFunction(() => /already open in another tab/.test(document.querySelector('#view')?.textContent ?? ''), { timeout: 20000 })
    .then(
      () => ok('second tab is refused with a clear message', true),
      () => ok('second tab is refused with a clear message', false, 'no message'),
    );
  await second.close();

  // 8. persistence: a full reload keeps the login, the character and the changed stat
  await page.reload({ waitUntil: 'load' });
  await waitText('Attributes');
  ok('after reload: still logged in with the saved character', /Strength\s*6/.test(await text()));
  const hs2 = await page.evaluate(async () => await (await fetch('api/highscore?type=level&size=100')).json());
  ok('after reload: the same world (bots not re-created)', hs2.total === 101, `total ${hs2.total}`);

  // 9. save management: export -> reset (fresh world) -> import (character and password come back)
  const saved = await page.evaluate(async () => Array.from((await (window as any).MG_LOCAL_API.exportSave()) as Uint8Array));
  await page.evaluate(() => (window as any).MG_LOCAL_API.resetGame());
  await page.reload({ waitUntil: 'load' });
  await page.waitForSelector('#reg', { timeout: 30000 });
  const fresh = await page.evaluate(async () => await (await fetch('api/highscore?type=level&size=100')).json());
  ok(
    'reset gives a brand-new world without the character',
    fresh.total === 100 && !fresh.rows.some((r: any) => r.name === 'Browserling'),
    `total ${fresh.total}`,
  );
  await page.evaluate(async (arr) => (window as any).MG_LOCAL_API.importSave(new Uint8Array(arr)), saved);
  await page.reload({ waitUntil: 'load' });
  await page.waitForSelector('#login', { timeout: 30000 }); // the old session token was reset, so we log in again...
  await page.type('#login [name=name]', 'Browserling');
  await page.type('#login [name=password]', 'secret12'); // ...with the password hash that was restored from the save
  await page.click('#login button');
  await waitText('Attributes');
  ok('import restores the character (password, Strength 6)', /Strength\s*6/.test(await text()));
  const hs3 = await page.evaluate(async () => await (await fetch('api/highscore?type=level&size=100')).json());
  ok('import restores the whole world', hs3.total === 101, `total ${hs3.total}`);

  // 10. the Game page is there and the public site hides the cheats by default
  await page.evaluate(() => {
    location.hash = '#/settings';
  });
  await waitText('Your save');
  ok('Game page shows the save status', /Saved in this browser/.test(await text()));
  ok('test tools are off by default on the public site', await page.evaluate(() => !document.querySelector('#dev details')));

  // 11. admin page (single player: always available): change the raid cooldown, reload, it must still be changed; then wipe the world
  ok('Admin menu exists in single player', await page.evaluate(() => /Admin/.test(document.querySelector('#top nav')?.textContent ?? '')));
  await page.evaluate(() => {
    location.hash = '#/admin/settings';
  });
  await waitText('Raid cooldown');
  await page.evaluate(() => {
    const f = [...document.querySelectorAll('#view form[data-submit="/admin/setting"]')].find(
      (x) => (x.querySelector('[name=key]') as HTMLInputElement).value === 'attackCooldown',
    )!;
    (f.querySelector('[name=value]') as HTMLInputElement).value = '3';
    f.dispatchEvent(new Event('submit', { cancelable: true }));
  });
  await page.waitForFunction(() => /reset \(10\)/.test(document.querySelector('#view')?.textContent ?? ''), { timeout: 15000 });
  await page.reload({ waitUntil: 'load' });
  await page.evaluate(() => {
    location.hash = '#/admin/settings';
  });
  await waitText('Raid cooldown');
  ok(
    'a changed cooldown is saved in the browser database (still 3 min after reload)',
    await page.evaluate(() => /reset \(10\)/.test(document.querySelector('#view')?.textContent ?? '')),
  );
  await page.evaluate(() => {
    location.hash = '#/admin/world';
  });
  await waitText('Wipe the world');
  await page.evaluate(() => {
    window.confirm = () => true; // (a real confirm() dialog would block the automated browser)
    const f = document.querySelector('#view form[data-submit="/admin/wipe"]')!;
    (f.querySelector('[name=confirm]') as HTMLInputElement).value = 'WIPE';
    f.dispatchEvent(new Event('submit', { cancelable: true }));
  });
  let wiped: { total: number; allLevel1: boolean } | undefined;
  for (let i = 0; i < 40 && !wiped; i++) {
    await new Promise((r) => setTimeout(r, 500));
    const r = await page.evaluate(async () => {
      const x = await (await fetch('api/highscore?type=level&size=100')).json();
      return { total: x.total as number, allLevel1: x.rows.every((y: any) => y.level === 1) };
    });
    if (r.total === 101 && r.allLevel1) wiped = r;
  }
  ok('wipe: character restarted and fresh bots were created (101 players, all level 1)', !!wiped);
} catch (e) {
  ok('test run', false, String(e));
} finally {
  console.log(results.join('\n'));
  if (errors.length) console.log('\nbrowser console errors:\n' + [...new Set(errors)].map((e) => '  ' + e.slice(0, 200)).join('\n'));
  await browser.close().catch(() => {});
  server.kill();
}
