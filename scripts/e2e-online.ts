// End-to-end check of the ONLINE setup in real Firefox: the frontend is served from one origin (like itch.io / GitHub Pages)
// and talks to the game server on ANOTHER origin (cross-origin, so CORS is really exercised):
//   npm run e2e:online
// Checks: play across origins, progress survives clearing ALL browser data and a server restart, other players share the
// world, a site that is not on the CORS list is blocked.
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import puppeteer from 'puppeteer-core';

const API = 8291, WEB = 8292, API2 = 8293;
const FIREFOX = process.env.FIREFOX ?? '/usr/bin/firefox';
const results: string[] = [];
const ok = (name: string, cond: unknown, detail = '') => { results.push(`${cond ? '✔' : '✖'} ${name}${detail ? ` (${detail})` : ''}`); if (!cond) process.exitCode = 1; };
const tmp = mkdtempSync(join(tmpdir(), 'mg-online-'));
const procs: ChildProcess[] = [];

const startServer = async (port: number, cors: string, db = join(tmp, 'game.db')) => {
  const p = spawn('node', ['src/server.ts'], { env: { ...process.env, NODE_ENV: 'production', PORT: String(port), DB_PATH: db, BOTS: '10', CORS_ORIGINS: cors, BACKUP_DIR: join(tmp, 'backups') }, stdio: ['ignore', 'pipe', 'ignore'] });
  procs.push(p);
  let log = ''; p.stdout!.on('data', (d) => (log += d));
  for (let i = 0; i < 100 && !/API on/.test(log); i++) await new Promise((r) => setTimeout(r, 100));
  return p;
};
const stop = (p: ChildProcess) => new Promise<void>((r) => { p.on('exit', () => r()); p.kill('SIGTERM'); });
const call = async (path: string, body?: unknown, token?: string, port = API) => (await fetch(`http://localhost:${port}/api${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) })).json() as Promise<any>;

// frontend build pointing at the server, served by a Pages-like static server on a different port
spawnSync('node', ['scripts/build-pages.ts', join(tmp, 'site'), '--api', `http://localhost:${API}`], { stdio: 'ignore' });
procs.push(spawn('node', ['scripts/preview.ts', join(tmp, 'site'), '/', String(WEB)], { stdio: 'ignore' }));
let server = await startServer(API, `http://localhost:${WEB}`);
await new Promise((r) => setTimeout(r, 500));

const browser = await puppeteer.launch({ browser: 'firefox', executablePath: FIREFOX, headless: true, protocol: 'webDriverBiDi' });
const errors: string[] = [];
try {
  const page = await browser.newPage();
  page.on('pageerror', (e) => errors.push(String(e)));
  const text = () => page.evaluate(() => document.querySelector('#view')!.textContent ?? '');
  const waitText = (t: string) => page.waitForFunction((x) => document.querySelector('#view')?.textContent?.includes(x), { timeout: 30000 }, t);
  const site = `http://localhost:${WEB}/`;

  // 1. cross-origin play
  await page.goto(site, { waitUntil: 'load' });
  await page.waitForSelector('#reg', { timeout: 30000 });
  ok('frontend and game server are different origins', new URL(site).origin !== `http://localhost:${API}`);
  await page.type('#reg [name=name]', 'Overseas'); await page.type('#reg [name=password]', 'secret12'); await page.click('#reg button');
  await waitText('Attributes');
  ok('registered through the cross-origin API (CORS + preflight work)', true);
  await page.evaluate(() => (document.querySelector('[data-do="/train"][data-body*="str"]') as HTMLElement).click());
  await page.waitForFunction(() => /Strength\s*6/.test(document.querySelector('#view')?.textContent ?? ''), { timeout: 15000 });
  ok('an action is processed on the server (Strength 5 -> 6)', true);

  // 2. the world is shared: another player registers and writes to us; bots exist
  const other = await call('/register', { name: 'Neighbour', password: 'secret12', race: 'werewolf' });
  const otherToken = (await call('/login', { name: 'Neighbour', password: 'secret12' })).token;
  await call('/mail/send', { to: 'Overseas', subject: 'Hello from another player', body: 'Are you there?' }, otherToken);
  await page.evaluate(() => { location.hash = '#/mail'; });
  await waitText('Hello from another player');
  ok('another player\'s message arrives (shared world)', other.id > 0);
  const hs = await page.evaluate(async () => (await (await fetch('http://localhost:8291/api/highscore?type=level&size=100')).json()).total);
  ok('bots + both players in one world', hs === 12, `total ${hs}`);

  // 3. THE point: clearing every bit of browser data does not lose the game
  await page.evaluate(() => { localStorage.clear(); sessionStorage.clear(); });
  await page.reload({ waitUntil: 'load' });
  await page.waitForSelector('#login', { timeout: 30000 });
  ok('after clearing all browser data you are logged out...', true);
  await page.type('#login [name=name]', 'Overseas'); await page.type('#login [name=password]', 'secret12'); await page.click('#login button');
  await waitText('Attributes');
  ok('...but logging in again brings the character back (Strength 6)', /Strength\s*6/.test(await text()));

  // 4. a server restart keeps everything, the final backup is taken on shutdown
  await stop(server);
  await new Promise((r) => setTimeout(r, 500));
  server = await startServer(API, `http://localhost:${WEB}`);
  await page.reload({ waitUntil: 'load' });
  await waitText('Attributes');
  ok('after a server restart: same login session and character', /Strength\s*6/.test(await text()));
  const hs2 = await page.evaluate(async () => (await (await fetch('http://localhost:8291/api/highscore?type=level&size=100')).json()).total);
  ok('after a server restart: same world (bots kept, not re-created)', hs2 === 12, `total ${hs2}`);

  // 5. logout ends the session on the server
  const token = await page.evaluate(() => localStorage.getItem('mg_token'));
  await page.evaluate(() => (document.querySelector('[data-act=logout]') as HTMLElement).click());
  await page.waitForSelector('#login', { timeout: 15000 });
  const after = await call('/me', undefined, token!);
  ok('logout kills the token on the server', after.error === 'unauthorized');

  // 6. a site that is NOT on the CORS list is blocked by the browser
  const strict = await startServer(API2, 'https://somewhere-else.example', join(tmp, 'other.db'));
  const verdict = await page.evaluate(async (port) => { try { await fetch(`http://localhost:${port}/api/catalog`); return 'reachable'; } catch { return 'blocked'; } }, API2);
  ok('a server that does not list this site is unreachable from it (CORS)', verdict === 'blocked', verdict);
  await stop(strict);
} catch (e) {
  ok('test run', false, String(e));
} finally {
  console.log(results.join('\n'));
  if (errors.length) console.log('\npage errors:\n' + [...new Set(errors)].map((e) => '  ' + e.slice(0, 200)).join('\n'));
  await browser.close().catch(() => {});
  for (const p of procs) p.kill('SIGKILL');
  rmSync(tmp, { recursive: true, force: true });
}
