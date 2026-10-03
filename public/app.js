// MonstersGame-Reloaded frontend: vanilla ES modules (js/), hash routing, no build step. This file only boots the app.
import { api, logout, refresh } from './js/api.js';
import { applyTheme } from './js/art.js';
import { render, tickCd } from './js/router.js';
import { API_BASE, LOCAL, devEnabled, setAssets, setCatalog, setDevEnabled, token } from './js/state.js';

// ---------- boot ----------
(async () => {
  setCatalog(await api('/catalog'));
  setAssets(
    API_BASE
      ? await fetch('assets.json').then(
          (r) => (r.ok ? r.json() : {}),
          () => ({}),
        )
      : await api('/assets').catch(() => ({})),
  );
  applyTheme();
  setDevEnabled(
    await api('/dev').then(
      () => true,
      () => false,
    ),
  );
  if (LOCAL) setDevEnabled(devEnabled && localStorage.getItem('mg_dev') === '1'); // test tools are opt-in on the public site
  if (token) await refresh().catch(() => logout(true));
  else render();
  setInterval(tickCd, 1000);
})().catch((e) => console.error('boot failed', e)); // (local-boot.js already shows the reason on screen)
