import { GameError } from '../errors.ts';

const KEY = /^[A-Za-z][A-Za-z0-9_]{0,39}$/;
const FORBIDDEN_KEYS = new Set(['constructor', 'prototype']);
const MAX_STRING = 5000, MAX_ITEM = 200, MAX_ITEMS = 50, MAX_KEYS = 40;

type Prim = string | number | boolean | null;
const isPrim = (v: unknown, max: number): v is Prim =>
  v === null || typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v)) || (typeof v === 'string' && v.length <= max);

/** A page number from a query string: a whole number from 0 to 100000, anything else (NaN, huge, negative, text) becomes 0. */
export function pageNumber(v: unknown): number {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) && n > 0 ? Math.min(n, 100_000) : 0;
}

/**
 * The input firewall for every JSON request body. The game's handlers read fields like `b.name` or `b.inventoryId` and pass them
 * to the database; without a shape check, a client could send an object where a string is expected, `__proto__` keys, huge or
 * nested values... and reach code paths nobody tested. Accepted: a flat object with at most 40 sane keys whose values are
 * strings (<= 5000 chars), finite numbers, booleans, null, or short arrays of those. Everything else is a 400.
 * The result has no prototype, so `b.constructor` and friends are simply undefined.
 */
export function cleanBody(raw: unknown): Record<string, any> {
  const bad = (m: string): never => { throw new GameError('bad_request', m, 400); };
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return bad('The request body must be a JSON object');
  const out: Record<string, any> = Object.create(null);
  const keys = Object.keys(raw);
  if (keys.length > MAX_KEYS) return bad('Too many fields');
  for (const k of keys) {
    if (!KEY.test(k) || FORBIDDEN_KEYS.has(k)) return bad(`Invalid field name`);
    const v = (raw as Record<string, unknown>)[k];
    if (Array.isArray(v)) {
      if (v.length > MAX_ITEMS || !v.every((x) => isPrim(x, MAX_ITEM) && typeof x !== 'object')) return bad(`Field "${k}" must be a short list of plain values`);
      out[k] = [...v];
    } else if (isPrim(v, MAX_STRING)) out[k] = v;
    else return bad(`Field "${k}" has an invalid value`);
  }
  return out;
}
