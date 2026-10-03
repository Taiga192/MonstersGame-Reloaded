/// <reference lib="webworker" />
// The whole game (rules, SQLite database, bots) running inside a Web Worker in the player's browser.
// The page talks to it like to a server: it sends HTTP-style requests and the worker answers them with the same Hono API
// the Node server uses. The database lives in the browser's private file system (OPFS) via SQLite WebAssembly.
import sqlite3InitModule from '@sqlite.org/sqlite-wasm';
import { createApi } from '../api/create-api.ts';
import { ensureBots, tickBots } from '../bots/runner.ts';
import { initSchema, tx, type DB } from '../db/core.ts';
import * as arena from '../game/combat/arena.ts';
import { wrapWasmDb } from './wasm-db.ts';

export interface Settings {
  bots: number;
  botsRaidHumans: boolean;
  humanRaidChance: number;
}
type Storage = 'opfs' | 'memory';

const DB_FILE = '/monstersgame.db';
let sqlite3: any,
  poolUtil: any = null,
  raw: any,
  db: DB,
  app: ReturnType<typeof createApi>;
let storage: Storage = 'memory',
  storageNote = '';
let settings: Settings = { bots: 100, botsRaidHumans: true, humanRaidChance: 0.3 };
let assets: Record<string, { file: string; v: number }> = {};
const devClock = { offset: 0 }; // the Test tools can fast-forward the game clock (single player: nobody else is affected)
const now = () => Date.now() + devClock.offset;
const timers: ReturnType<typeof setInterval>[] = [];

/** Open the database: OPFS when possible (persistent), otherwise in memory (progress is lost when the tab closes). */
async function openDatabase() {
  sqlite3 ??= await sqlite3InitModule();
  try {
    poolUtil ??= await sqlite3.installOpfsSAHPoolVfs({ name: 'monstersgame', directory: '/monstersgame', initialCapacity: 6 });
    raw = new poolUtil.OpfsSAHPoolDb(DB_FILE);
    storage = 'opfs';
    storageNote = '';
  } catch (e) {
    const msg = String((e as Error)?.message ?? e);
    if (/lock|access ?handle|in use|NoModificationAllowed|another/i.test(msg))
      throw Object.assign(new Error('The game is already open in another tab or window.'), { code: 'locked' });
    raw = new sqlite3.oo1.DB(':memory:', 'c');
    storage = 'memory';
    storageNote = `Persistent storage is not available in this browser (${msg}). Your progress will be lost when you close the tab. Export your save from the Game page to keep it.`;
  }
  db = wrapWasmDb(sqlite3, raw);
  initSchema(db);
}

function startGame() {
  if (settings.bots > 0) ensureBots(db, settings.bots, now(), Math.random); // new worlds start with bots at level 1
  app = createApi({
    db,
    now,
    rng: Math.random,
    devClock,
    assets: () => assets,
    singlePlayer: true,
    onWipe: () => {
      if (settings.bots > 0) ensureBots(db, settings.bots, now(), Math.random);
    },
  });
  for (const t of timers.splice(0)) clearInterval(t);
  // same rhythm as the Node server: bots play every 20 s, the arena checks its schedule every 30 s (only while the game is open)
  timers.push(
    setInterval(() => {
      try {
        if (settings.bots > 0) tickBots(db, now(), Math.random, { humans: settings.botsRaidHumans, humanRaidChance: settings.humanRaidChance });
      } catch (e) {
        console.error('[bots]', e);
      }
    }, 20_000),
  );
  timers.push(
    setInterval(() => {
      try {
        tx(db, () => arena.tick(db, now(), Math.random));
      } catch (e) {
        console.error('[arena]', e);
      }
    }, 30_000),
  );
}

function closeDatabase() {
  for (const t of timers.splice(0)) clearInterval(t);
  try {
    raw?.close();
  } catch {
    /* already closed */
  }
}

function exportSave(): Uint8Array {
  if (storage === 'opfs') return poolUtil.exportFile(DB_FILE);
  return sqlite3.capi.sqlite3_js_db_export(raw.pointer);
}

async function importSave(bytes: Uint8Array) {
  const header = new TextDecoder().decode(bytes.slice(0, 15));
  if (header !== 'SQLite format 3') throw new Error('This is not a MonstersGame-Reloaded save file (not an SQLite database).');
  closeDatabase();
  if (storage === 'opfs') await poolUtil.importDb(DB_FILE, bytes);
  else {
    raw = new sqlite3.oo1.DB(':memory:', 'c');
    const p = sqlite3.wasm.allocFromTypedArray(bytes);
    sqlite3.capi.sqlite3_deserialize(
      raw.pointer,
      'main',
      p,
      bytes.length,
      bytes.length,
      sqlite3.capi.SQLITE_DESERIALIZE_FREEONCLOSE | sqlite3.capi.SQLITE_DESERIALIZE_RESIZEABLE,
    );
  }
  await openDatabase();
  if (!db.prepare("SELECT 1 x FROM sqlite_master WHERE name = 'players'").get()) throw new Error('This file is a database, but not a MonstersGame save.');
  startGame();
}

async function resetGame() {
  closeDatabase();
  if (storage === 'opfs') await poolUtil.wipeFiles(); // forgets every file in the pool, including the save
  await openDatabase();
  startGame();
}

type Msg =
  | { id: number; op: 'init'; settings: Settings; assets: typeof assets }
  | { id: number; op: 'http'; method: string; url: string; headers: Record<string, string>; body?: string }
  | { id: number; op: 'export' }
  | { id: number; op: 'import'; bytes: Uint8Array }
  | { id: number; op: 'reset' }
  | { id: number; op: 'settings'; settings: Settings };

const reply = (id: number, data: object, transfer: Transferable[] = []) => (self as unknown as Worker).postMessage({ id, ...data }, transfer);

self.onmessage = async (ev: MessageEvent<Msg>) => {
  const m = ev.data;
  try {
    if (m.op === 'init') {
      settings = m.settings;
      assets = m.assets;
      await openDatabase();
      startGame();
      reply(m.id, { ok: true, storage, storageNote, sqlite: sqlite3.version.libVersion });
    } else if (m.op === 'http') {
      const res = await app.request(m.url, { method: m.method, headers: m.headers, body: m.body });
      reply(m.id, { ok: true, status: res.status, contentType: res.headers.get('content-type') ?? 'application/json', body: await res.text() });
    } else if (m.op === 'export') {
      const bytes = exportSave();
      reply(m.id, { ok: true, bytes }, [bytes.buffer]);
    } else if (m.op === 'import') {
      await importSave(m.bytes);
      reply(m.id, { ok: true });
    } else if (m.op === 'reset') {
      await resetGame();
      reply(m.id, { ok: true });
    } else if (m.op === 'settings') {
      settings = m.settings;
      if (settings.bots > 0) ensureBots(db, settings.bots, now(), Math.random);
      reply(m.id, { ok: true });
    }
  } catch (e) {
    reply(m.id, { ok: false, error: String((e as Error)?.message ?? e), code: (e as { code?: string })?.code });
  }
};
