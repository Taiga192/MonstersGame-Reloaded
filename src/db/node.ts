import { DatabaseSync } from 'node:sqlite';
import { initSchema, type DB } from './core.ts';

export * from './core.ts';

let factory: ((path: string) => DB) | null = null;
/** Swap the SQLite implementation (the test suite can run on SQLite-WebAssembly, see test/support/wasm-preload.ts). */
export function useDbFactory(f: ((path: string) => DB) | null) {
  factory = f;
}

/** Open (and create/migrate) a database on node:sqlite. `:memory:` by default. */
export function openDb(path = ':memory:'): DB {
  let db: DB;
  if (factory) db = factory(path);
  else {
    const raw = new DatabaseSync(path);
    raw.exec('PRAGMA journal_mode = WAL;');
    db = raw;
  }
  initSchema(db);
  return db;
}
