import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openDb } from '../../src/db/node.ts';

// Guards the harness: `npm test` must really use node:sqlite and `npm run test:wasm` must really use SQLite-WebAssembly,
// otherwise "all tests pass on WASM" could silently mean "all tests ran on node:sqlite again".
test('the active SQLite backend is the one the run asked for', () => {
  const wasm = process.execArgv.some((a) => a.includes('wasm-preload'));
  const db = openDb();
  const backend = db.constructor.name;
  if (wasm) assert.notEqual(backend, 'DatabaseSync', 'test:wasm must run on the WebAssembly adapter');
  else assert.equal(backend, 'DatabaseSync', 'npm test runs on node:sqlite');
  assert.equal(db.prepare('SELECT sqlite_version() v').get().v.split('.')[0], '3');
  console.log(`# sqlite backend: ${wasm ? 'WebAssembly' : 'node:sqlite'} ${db.prepare('SELECT sqlite_version() v').get().v}`);
});
