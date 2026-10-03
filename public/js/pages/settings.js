// The "settings" page.
import { toast } from '../api.js';
import { render } from '../router.js';
import { me } from '../state.js';
import { esc } from '../util.js';

// ---------- local (browser-only) mode: saves and settings ----------
export const storageWarning = () => {
  const n = window.MG_LOCAL_API?.info().storageNote;
  return n ? `<div class="card bad"><b>⚠ Progress is not being saved.</b> ${esc(n)}</div>` : '';
};

export async function pageSettings() {
  const L = window.MG_LOCAL_API;
  if (!L) return '<div class="card"><h2>Game</h2><p class="muted">This page belongs to the browser-only version of the game.</p></div>';
  const info = L.info(),
    st = L.settings();
  let usage = '',
    persisted = false;
  try {
    const e = await navigator.storage.estimate();
    persisted = await navigator.storage.persisted();
    usage = `${(e.usage / 1048576).toFixed(1)} MB used of ${Math.round(e.quota / 1048576).toLocaleString('en-US')} MB available`;
  } catch {
    /* not supported */
  }
  return `<div class="grid">
    <div class="card"><h2>Your save</h2>
      <p>${info.storage === 'opfs' ? '<span class="good">✔ Saved in this browser</span> (private file system)' : '<span class="bad">✖ Not saved: temporary memory only</span>'} · SQLite ${esc(info.sqlite)}</p>
      <p class="muted">The whole game world, including the ${st.bots} bots, lives in this browser on this device. It is not uploaded anywhere. ${usage ? esc(usage) + '.' : ''}</p>
      ${info.storage === 'opfs' && !persisted ? '<p class="muted">Browsers may delete site data when disk space runs low. <button class="sm sec" data-local="persist">Ask the browser to keep it</button></p>' : ''}
      <div class="row"><button data-local="export">⬇ Export save</button>
        <label class="btn sec" style="margin:0;cursor:pointer">⬆ Import save<input type="file" accept=".db,.sqlite,.sqlite3" data-local-import hidden></label></div>
      <p class="muted">Export gives you a backup file (and lets you move the game to another browser or device). Importing replaces the current game.</p>
      <hr><button class="sec" data-local="reset">🗑 Delete save and start a new world</button></div>
    <form class="card" data-local-settings><h2>World settings</h2>
      <label>Number of bots (0 = you are alone)</label><input name="bots" type="number" min="0" max="300" value="${st.bots}" style="width:6rem">
      <label style="display:inline"><input type="checkbox" name="botsRaidHumans" ${st.botsRaidHumans ? 'checked' : ''}> bots may raid me</label>
      <label>How often a bot that finds you actually attacks</label>
      <select name="humanRaidChance">${[0.1, 0.3, 0.6, 1].map((v) => `<option value="${v}" ${v === st.humanRaidChance ? 'selected' : ''}>${Math.round(v * 100)}%</option>`).join('')}</select>
      <label style="display:inline"><input type="checkbox" name="dev" ${localStorage.getItem('mg_dev') === '1' ? 'checked' : ''}> show the test tools (cheats, time skip)</label>
      <p class="muted">Bots only play while this page is open, exactly like the server version only plays while it is running. Reducing the number of bots does not remove existing ones.</p>
      <button>Apply</button></form></div>
    <div class="card"><h3>How this version works</h3><p class="muted">This is a single-player copy of the game: the rules, the database and the bots all run in your browser, so nobody else can join your world.
      Progress is saved after every action. Only one tab can have the game open at a time.</p></div>`;
}

export async function localAction(kind, el) {
  const L = window.MG_LOCAL_API;
  try {
    if (kind === 'export') {
      const bytes = await L.exportSave();
      const a = Object.assign(document.createElement('a'), {
        href: URL.createObjectURL(new Blob([bytes], { type: 'application/vnd.sqlite3' })),
        download: `monstersgame-${new Date().toISOString().slice(0, 10)}.db`,
      });
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
      toast('Save exported');
    } else if (kind === 'persist') {
      toast((await navigator.storage.persist()) ? 'The browser will keep your save' : 'The browser did not agree (it may still keep it)', false);
      render();
    } else if (kind === 'reset') {
      if (prompt('This deletes your character and the whole world permanently.\nType DELETE to confirm.') !== 'DELETE') return;
      await L.resetGame();
      localStorage.removeItem('mg_token');
      location.hash = '#/';
      location.reload();
    } else if (kind === 'import') {
      const file = el.files[0];
      if (!file) return;
      if (!confirm(`Replace your current game with "${file.name}"? The current game will be lost (export it first if you want to keep it).`)) {
        el.value = '';
        return;
      }
      await L.importSave(new Uint8Array(await file.arrayBuffer()));
      localStorage.removeItem('mg_token');
      location.hash = '#/';
      location.reload();
    }
  } catch (e) {
    toast(e.message, true);
  }
}
