// Run the whole test suite on SQLite compiled to WebAssembly (the browser engine) instead of node:sqlite:
//   npm run test:wasm
// If every test passes on both, the browser build behaves exactly like the server.
import sqlite3InitModule from '@sqlite.org/sqlite-wasm';
import { useDbFactory } from '../src/db.ts';
import { wrapWasmDb } from '../src/browser/wasm-db.ts';

const sqlite3 = await sqlite3InitModule();
useDbFactory(() => wrapWasmDb(sqlite3, new sqlite3.oo1.DB(':memory:', 'c')));
