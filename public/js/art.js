// Art assets: image lookup with text/emoji fallback and the theme variables.
import { assets, me } from './state.js';
import { esc, when } from './util.js';

// absolute URL built from the page's own location, so it also works from a sub-path and inside CSS variables
export const A = (key) => (assets[key] ? new URL(`assets/${assets[key].file}?v=${assets[key].v}`, document.baseURI).href : null);

export const img = (key, cls = 'ico', alt = '') => (A(key) ? `<img class="${cls}" src="${A(key)}" alt="${esc(alt)}" loading="lazy">` : '');

/** icon with fallback text (emoji) when the image does not exist yet */
export const ico = (key, fallback = '', cls = 'ico') => img(key, cls) || fallback;

export function applyTheme() {
  const root = document.documentElement.style;
  for (const [k, v] of [
    ['--img-site', 'bg/site'],
    ['--img-header', 'bg/header'],
    ['--img-card', 'bg/card'],
  ])
    root.setProperty(k, A(v) ? `url("${A(v)}")` : 'none');
  const race = me?.race;
  root.setProperty('--img-race', race && A(`bg/${race}`) ? `url("${A(`bg/${race}`)}")` : 'none');
  document.body.classList.toggle('has-race-bg', !!(race && A(`bg/${race}`)));
  const fav = A('brand/favicon');
  if (fav) {
    let l = document.querySelector('link[rel=icon]');
    if (!l) {
      l = document.createElement('link');
      l.rel = 'icon';
      document.head.appendChild(l);
    }
    l.href = fav;
  }
}
