// Small pure helpers: escaping, number/duration formatting, progress bars.
import { now } from './state.js';

// MonstersGame-Reloaded frontend: vanilla ES modules, hash routing, no build step.

export const $ = (s) => document.querySelector(s);

export const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export const STATS = [
  ['str', 'Strength'],
  ['def', 'Defense'],
  ['agi', 'Agility'],
  ['sta', 'Stamina'],
  ['dex', 'Dexterity'],
];

export const fmt = (n) => Number(n).toLocaleString('en-US');

export const MOONS = ['🌑', '🌒', '🌓', '🌔', '🌕'];

export const ago = (t) => {
  const s = Math.max(0, Math.round((now() - t) / 1000));
  return s < 60 ? 'just now' : s < 3600 ? `${Math.floor(s / 60)} min ago` : s < 86400 ? `${Math.floor(s / 3600)} h ago` : `${Math.floor(s / 86400)} d ago`;
};

export function until(ts) {
  const ms = ts - now();
  if (ms <= 0) return null;
  const s = Math.ceil(ms / 1000),
    h = Math.floor(s / 3600),
    m = Math.floor((s % 3600) / 60);
  return h ? `${h}h ${m}m` : m ? `${m}m ${s % 60}s` : `${s}s`;
}

export const bar = (cls, val, max, label) =>
  `<div class="bar ${cls}${cls === 'hp' && val / max < 0.3 ? ' low' : ''}"><i style="width:${Math.max(0, Math.min(100, (val / max) * 100))}%"></i><span>${esc(label)}</span></div>`;

export const raceName = (r) => `<span class="${r}">${r === 'vampire' ? 'Vampire' : 'Werewolf'}</span>`;

// ---------- dungeon ----------
/** 1440000 -> '24 hours', 1200000 -> '20 minutes' */
export const dur = (ms) => {
  const m = Math.round(ms / 60000);
  return m >= 60 && m % 60 === 0 ? `${m / 60} hour${m === 60 ? '' : 's'}` : m > 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m} minute${m === 1 ? '' : 's'}`;
};

export const when = (ts) => new Date(ts).toLocaleString();
