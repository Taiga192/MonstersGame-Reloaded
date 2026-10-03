import type { DB } from '../db/core.ts';

/**
 * Adapts a SQLite-WebAssembly database (the official @sqlite.org/sqlite-wasm "oo1" API) to the small `DB` interface the game
 * engine uses, so the exact same game code and SQL runs in the browser (or in Node for testing) as on node:sqlite.
 * Behaviour mirrors node:sqlite: rows are plain objects, integers are numbers, and run() returns { changes, lastInsertRowid }.
 */
export function wrapWasmDb(sqlite3: any, raw: any): DB {
  // node:sqlite rejects `undefined` and booleans; be as forgiving as SQLite itself is
  const norm = (v: unknown) => (v === undefined ? null : typeof v === 'boolean' ? Number(v) : v);
  const bind = (st: any, params: unknown[]) => {
    if (params.length) st.bind(params.map(norm));
  };
  return {
    exec(sql) {
      raw.exec(sql);
    },
    close() {
      raw.close();
    },
    get isTransaction() {
      return sqlite3.capi.sqlite3_get_autocommit(raw.pointer) === 0;
    },
    prepare(sql) {
      return {
        get(...params) {
          const st = raw.prepare(sql);
          try {
            bind(st, params);
            return st.step() ? st.get({}) : undefined;
          } finally {
            st.finalize();
          }
        },
        all(...params) {
          const st = raw.prepare(sql),
            rows: unknown[] = [];
          try {
            bind(st, params);
            while (st.step()) rows.push(st.get({}));
            return rows;
          } finally {
            st.finalize();
          }
        },
        run(...params) {
          const st = raw.prepare(sql);
          try {
            bind(st, params);
            st.step();
          } finally {
            st.finalize();
          }
          return { changes: Number(raw.changes()), lastInsertRowid: Number(sqlite3.capi.sqlite3_last_insert_rowid(raw.pointer)) };
        },
      };
    },
  };
}
