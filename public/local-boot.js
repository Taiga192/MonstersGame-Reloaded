// Local (GitHub Pages) mode: the whole game runs in a Web Worker in this browser, with its SQLite database in the browser's
// private file system. This script starts the worker and makes the page's ordinary fetch('api/...') calls talk to it instead
// of a server, so app.js works unchanged. It does nothing when window.MG_LOCAL is false (Node server mode).
if (window.MG_LOCAL) {
  const realFetch = window.fetch.bind(window);
  const base = new URL('.', location.href).pathname; // works from any sub-path, e.g. /MonstersGame/
  const view = () => document.getElementById('view');
  const fatal = (title, text) => {
    const card = `<div class="card center" style="max-width:640px"><h2>${title}</h2><p>${text}</p></div>`;
    if (view()) view().innerHTML = card; else addEventListener('DOMContentLoaded', () => { view().innerHTML = card; });
  };

  const settingsKey = 'mg_settings';
  const defaults = { bots: 100, botsRaidHumans: true, humanRaidChance: 0.3 };
  const loadSettings = () => { try { return { ...defaults, ...JSON.parse(localStorage.getItem(settingsKey) || '{}') }; } catch { return { ...defaults }; } };
  const saveSettings = (s) => { try { localStorage.setItem(settingsKey, JSON.stringify(s)); } catch { /* private mode */ } };

  let worker, seq = 0;
  const pending = new Map();
  const rpc = (msg, transfer = []) => new Promise((resolve, reject) => {
    const id = ++seq; pending.set(id, { resolve, reject });
    worker.postMessage({ id, ...msg }, transfer);
  });

  const info = { storage: 'memory', storageNote: '', sqlite: '' };

  // One game per browser at a time: the database file can only be open once (a second tab would corrupt nothing but fail).
  const acquireLock = () => new Promise((resolve) => {
    if (!navigator.locks) return resolve(true);
    navigator.locks.request('monstersgame-save', { ifAvailable: true }, (lock) => { resolve(!!lock); if (lock) return new Promise(() => {}); }); // held until the tab closes
  });

  const ready = (async () => {
    if (!window.Worker || !window.WebAssembly) throw Object.assign(new Error('This browser cannot run the game (Web Workers or WebAssembly are missing). Please use a current Chrome, Firefox, Edge or Safari.'), { fatal: 'Unsupported browser' });
    if (!(await acquireLock())) throw Object.assign(new Error('MonstersGame-Reloaded is already open in another tab or window. The saved game can only be used by one tab at a time. Close the other one and reload this page.'), { fatal: 'Already open' });
    const assets = await realFetch('assets.json').then((r) => (r.ok ? r.json() : {}), () => ({}));
    worker = new Worker(new URL('engine.worker.js', location.href), { type: 'module' });
    worker.onmessage = (ev) => { const p = pending.get(ev.data.id); if (!p) return; pending.delete(ev.data.id); ev.data.ok ? p.resolve(ev.data) : p.reject(Object.assign(new Error(ev.data.error), { code: ev.data.code })); };
    worker.onerror = (e) => { for (const p of pending.values()) p.reject(new Error(e.message || 'The game engine crashed')); pending.clear(); };
    Object.assign(info, await rpc({ op: 'init', settings: loadSettings(), assets }));
    return info;
  })();
  ready.catch((e) => fatal(e.fatal || 'The game could not start', `${e.message}`));

  // API calls (relative "api/...") are answered by the worker; everything else (images, json) is a normal request.
  window.fetch = async (input, init = {}) => {
    const u = new URL(typeof input === 'string' ? input : input.url, location.href);
    if (!u.pathname.startsWith(base + 'api/')) return realFetch(input, init);
    await ready;
    const r = await rpc({ op: 'http', method: (init.method || 'GET').toUpperCase(), url: '/api/' + u.pathname.slice(base.length + 4) + u.search, headers: init.headers || {}, body: init.body });
    return new Response(r.body, { status: r.status, headers: { 'content-type': r.contentType } });
  };

  // used by the "Game" page (save export/import/reset, settings)
  window.MG_LOCAL_API = {
    info: () => ({ ...info }),
    settings: () => loadSettings(),
    async applySettings(s) { saveSettings(s); await rpc({ op: 'settings', settings: s }); },
    async exportSave() { const r = await rpc({ op: 'export' }); return r.bytes; },
    async importSave(bytes) { await rpc({ op: 'import', bytes }, [bytes.buffer]); },
    async resetGame() { await rpc({ op: 'reset' }); },
  };
}
