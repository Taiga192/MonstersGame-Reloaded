import assert from 'node:assert/strict';
import { randomBytes as nodeRandom, scryptSync as nodeScrypt } from 'node:crypto';
import { test } from 'node:test';
import { randomBytes, scryptSync, timingSafeEqual } from '../../src/browser/crypto-shim.ts';

// The browser build replaces node:crypto with this shim. Password hashes must be byte-identical, so a save made in the
// browser and a database made by the Node server can verify each other's passwords.
test('browser scrypt equals node scrypt (same parameters, same output)', () => {
  for (const [pw, salt] of [
    ['secret12', 'abcdef0123456789'],
    ['pässwörd ✓', '00ff00ff00ff00ff'],
    ['', 'salt'],
  ]) {
    assert.deepEqual([...scryptSync(pw, salt, 32)], [...nodeScrypt(pw, salt, 32)], `password "${pw}"`);
  }
});

test('shim helpers behave like the node ones', () => {
  assert.equal(randomBytes(16).length, 16);
  assert.notDeepEqual([...randomBytes(16)], [...randomBytes(16)]);
  assert.equal(nodeRandom(4).length, 4);
  assert.equal(timingSafeEqual(Uint8Array.of(1, 2, 3), Uint8Array.of(1, 2, 3)), true);
  assert.equal(timingSafeEqual(Uint8Array.of(1, 2, 3), Uint8Array.of(1, 2, 4)), false);
  assert.equal(timingSafeEqual(Uint8Array.of(1, 2), Uint8Array.of(1, 2, 3)), false);
});
