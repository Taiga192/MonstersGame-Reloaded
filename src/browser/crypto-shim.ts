// Stand-in for `node:crypto` in the browser build (aliased by scripts/build-pages.ts). Only what src/game/auth.ts needs.
// scrypt uses node's default parameters (N=16384, r=8, p=1), so password hashes are identical to the ones node:crypto makes.
import { scrypt } from '@noble/hashes/scrypt.js';
import { sha256 } from '@noble/hashes/sha2.js';

export function randomBytes(n: number): Uint8Array {
  const b = new Uint8Array(n);
  crypto.getRandomValues(b);
  return b;
}

export function scryptSync(password: string, salt: string, keylen: number): Uint8Array {
  return scrypt(new TextEncoder().encode(password), new TextEncoder().encode(salt), { N: 16384, r: 8, p: 1, dkLen: keylen });
}

export function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

/** Only what auth.ts needs: createHash('sha256').update(text).digest('hex'). */
export function createHash(algo: string) {
  if (algo !== 'sha256') throw new Error('only sha256 is available in the browser build');
  let data = '';
  const api = {
    update(text: string) { data += text; return api; },
    digest(_enc: 'hex') { return Array.from(sha256(new TextEncoder().encode(data)), (b) => b.toString(16).padStart(2, '0')).join(''); },
  };
  return api;
}
