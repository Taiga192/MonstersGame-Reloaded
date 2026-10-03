// MonstersGame-Reloaded frontend: vanilla ES modules, hash routing, no build step.

const $ = (s) => document.querySelector(s);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const STATS = [['str', 'Strength'], ['def', 'Defense'], ['agi', 'Agility'], ['sta', 'Stamina'], ['dex', 'Dexterity']];
const fmt = (n) => Number(n).toLocaleString('en-US');

// Art assets: { "items/itm_Blade_1": {file, v} } from /api/assets. Anything missing simply isn't rendered (text/emoji stay).
let assets = {};
// absolute URL built from the page's own location, so it also works from a sub-path and inside CSS variables
const A = (key) => (assets[key] ? new URL(`assets/${assets[key].file}?v=${assets[key].v}`, document.baseURI).href : null);
const API_BASE = String(window.MG_API || '').replace(/\/+$/, ''); // '' = the server that served this page
const LOCAL = !!window.MG_LOCAL; // browser-only build (GitHub Pages): the game runs in this browser, see local-boot.js
const img = (key, cls = 'ico', alt = '') => (A(key) ? `<img class="${cls}" src="${A(key)}" alt="${esc(alt)}" loading="lazy">` : '');
/** icon with fallback text (emoji) when the image does not exist yet */
const ico = (key, fallback = '', cls = 'ico') => img(key, cls) || fallback;
const MOONS = ['🌑', '🌒', '🌓', '🌔', '🌕'];

function applyTheme() {
  const root = document.documentElement.style;
  for (const [k, v] of [['--img-site', 'bg/site'], ['--img-header', 'bg/header'], ['--img-card', 'bg/card']]) root.setProperty(k, A(v) ? `url("${A(v)}")` : 'none');
  const race = me?.race;
  root.setProperty('--img-race', race && A(`bg/${race}`) ? `url("${A(`bg/${race}`)}")` : 'none');
  document.body.classList.toggle('has-race-bg', !!(race && A(`bg/${race}`)));
  const fav = A('brand/favicon');
  if (fav) { let l = document.querySelector('link[rel=icon]'); if (!l) { l = document.createElement('link'); l.rel = 'icon'; document.head.appendChild(l); } l.href = fav; }
}

let token = localStorage.getItem('mg_token');
let me = null, catalog = null, skew = 0, lastResult = null, devEnabled = false, huntResult = null, dungeonResult = null;

// ---------- notifications: bell, alert bar, polling ----------
const notes = { unread: 0, cursor: 0, timer: null, open: false };
const BASE_TITLE = document.title;
const NOTE_ICON = { raid: '⚔', level: '⭐', mail: '✉', market: '💰', arena: '🏟', clan: '🏰', war: '⚔', shrine: '🩸', quests: '📜', announce: '📣', system: 'ℹ' };
const ago = (t) => { const s = Math.max(0, Math.round((now() - t) / 1000)); return s < 60 ? 'just now' : s < 3600 ? `${Math.floor(s / 60)} min ago` : s < 86400 ? `${Math.floor(s / 3600)} h ago` : `${Math.floor(s / 86400)} d ago`; };

/** The bar under the header: what needs you right now (derived by the server from your state) plus unread notifications. */
function renderAlerts(fresh = []) {
  const bar = document.getElementById('alerts'); if (!bar) return;
  const alerts = token && me ? me.alerts ?? [] : [];
  bar.innerHTML = (token && me && notes.unread ? `<a class="chip warn${fresh.length ? ' fresh' : ''}" id="chip-notes">🔔 ${notes.unread} new notification${notes.unread === 1 ? '' : 's'}</a>` : '')
    + alerts.map((a) => `<a class="chip ${esc(a.tone)}${fresh.includes(a.key) ? ' fresh' : ''}" href="${esc(a.link)}">${esc(a.text)}</a>`).join('');
  bar.querySelector('#chip-notes')?.addEventListener('click', toggleDrop);
  const n = (token && me ? notes.unread + alerts.length : 0);
  document.title = n ? `(${n}) ${BASE_TITLE}` : BASE_TITLE;
}

function closeDrop() { notes.open = false; const d = document.getElementById('notif-drop'); if (d) d.hidden = true; }
async function toggleDrop() {
  const d = document.getElementById('notif-drop'); if (!d) return;
  if (notes.open) return closeDrop();
  notes.open = true; d.hidden = false;
  try {
    const r = await api('/notifications?limit=12');
    notes.unread = r.unread;
    d.innerHTML = (r.items.length ? r.items.map((n) => noteHtml(n)).join('') : '<p class="muted" style="padding:.5rem">Nothing yet. When something happens to you (a raid, a sale, a war ...) it shows up here.</p>')
      + `<div class="row sp" style="padding:.4rem .6rem"><a href="#/notifications">All notifications</a><button class="sm sec" id="note-all">Mark all as read</button></div>`;
    d.querySelectorAll('a.note').forEach((a) => a.addEventListener('click', () => { markNote(Number(a.dataset.id)); closeDrop(); }));
    d.querySelector('#note-all').onclick = async () => { await api('/notifications/read', { all: true }); notes.unread = 0; renderHeader(route().page); closeDrop(); };
    renderHeader(route().page);
  } catch (e) { d.innerHTML = `<p class="bad" style="padding:.5rem">${esc(e.message)}</p>`; }
}
const noteHtml = (n) => `<a class="note${n.read ? '' : ' unread'}" data-id="${n.id}" href="${esc(n.link || '#/notifications')}"><b>${NOTE_ICON[n.kind] ?? '•'} ${esc(n.title)}</b><span class="muted">${esc(n.body)}${n.body ? ' · ' : ''}${ago(n.at)}</span></a>`;
async function markNote(id) {
  try { await api('/notifications/read', { ids: [id] }); notes.unread = Math.max(0, notes.unread - 1); renderHeader(route().page); } catch { /* the page still works */ }
}
document.addEventListener('click', (e) => { if (notes.open && !e.target.closest('#notif-drop, #bell, #chip-notes')) closeDrop(); });

const desktopOn = () => { try { return localStorage.getItem('mg_desktop') === '1' && typeof Notification !== 'undefined' && Notification.permission === 'granted'; } catch { return false; } };
/** Ask the server what is new. New events pop up as toasts (and as desktop notifications when you allowed them and the tab is hidden). */
async function poll() {
  if (!token || !me || (document.hidden && !desktopOn())) return;
  try {
    const r = await api(`/notifications/poll?after=${notes.cursor}`);
    skew = r.serverNow - Date.now();
    const before = new Set((me.alerts ?? []).map((a) => a.key));
    me.alerts = r.alerts; notes.unread = r.unread;
    const fresh = r.alerts.map((a) => a.key).filter((k) => !before.has(k));
    for (const n of r.items) {
      notes.cursor = Math.max(notes.cursor, n.id);
      toast(`${NOTE_ICON[n.kind] ?? '•'} ${n.title}`);
      if (document.hidden && desktopOn()) { try { new Notification(n.title, { body: n.body }); } catch { /* not allowed here */ } }
    }
    renderHeader(route().page); renderAlerts(fresh);
    if (r.items.length) { const bell = document.getElementById('bell'); bell?.classList.remove('ring'); void bell?.offsetWidth; bell?.classList.add('ring'); }
  } catch { /* offline for a moment: the next poll tries again */ }
}
function startPolling() { if (!notes.timer) notes.timer = setInterval(poll, 20_000); }
function stopPolling() { clearInterval(notes.timer); notes.timer = null; }
document.addEventListener('visibilitychange', () => { if (!document.hidden) poll(); });

// ---------- infrastructure ----------
async function api(path, body) {
  // Same-origin by default (relative, so a sub-path like /MonstersGame/ works). With window.MG_API set (config.js) the game is
  // served from somewhere else (itch.io, GitHub Pages) and talks to that game server instead.
  const res = await fetch(API_BASE ? `${API_BASE}/api${path}` : 'api' + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401 && token) logout(true);
    throw new Error(data.message || data.error || res.statusText);
  }
  return data;
}

let toastTimer;
function toast(msg, err = false) {
  const t = $('#toast');
  t.textContent = msg; t.className = 'show' + (err ? ' err' : '');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => (t.className = ''), err ? 4500 : 2500);
}

/** Run an action, toast the outcome, refresh state and re-render. */
async function act(path, body, okMsg) {
  try {
    const r = await api(path, body ?? {});
    const msg = resultMessage(path, r);
    if (msg) toast(msg.text, msg.err); else if (okMsg) toast(okMsg);
    if (path === '/raid/attack' || path === '/clan/war/attack') lastResult = r;
    if (path === '/hunt/collect' || path === '/hunt/cancel') huntResult = r;
    if (path === '/dungeon/fight') dungeonResult = r;
    if (path === '/dungeon/enter') dungeonResult = null;
    await refresh();
    return r;
  } catch (e) { toast(e.message, true); }
}

/** Human readable outcome for actions whose result matters; null = use the default message. */
function resultMessage(path, r) {
  if (path === '/raid/search' && !r.found) return { err: true, text: r.reason === 'no_opponents' ? 'No suitable opponents right now (level range, protection, HP).' : 'You lost the trail. Try again.' };
  if (path === '/clan/war/attack') return { text: `War: ${r.winner} won against ${r.target.name}! ${r.gold ? `Looted ${r.gold} gold.` : ''}` };
  if (path === '/raid/attack') return { text: `${r.winner} won! ${r.gold ? `Looted ${r.gold} gold.` : ''}` };
  if (path === '/dungeon/enter') return { text: 'You descend into the dungeon…' };
  if (path === '/dungeon/leave') return { text: 'You climb out. Your progress is saved.' };
  if (path === '/dungeon/fight') return r.won
    ? { text: `Level ${r.depth} cleared! +${r.xp} XP${r.drop ? `, found ${r.drop.name} (${r.drop.value}g)` : ''}${r.choice ? ' — the guardian offers you a reward!' : ''}${r.checkpoint ? ` — checkpoint: level ${r.checkpoint} is saved!` : ''}${r.component ? ` — the guardian dropped ${r.component}!` : ''}` }
    : { err: true, text: `You died on level ${r.depth}. Your XP and items are safe; the level is still waiting for you.` };
  if (path === '/dungeon/reward') return { text: `You take the ${r.name} (worth ${fmt(r.value)}g)` };
  if (path === '/dungeon/sell') return { text: `The dealer pays ${fmt(r.gold)} gold for ${r.count} item${r.count === 1 ? '' : 's'}` };
  if (path === '/temple/buy') return { text: `You bought ${r.item} for ${fmt(r.paid)} gold` };
  if (path === '/inventory/harden') return { text: `Weapon hardened to +${r.hardening} (${fmt(r.cost)}g)` };
  if (path === '/quests/claim') return { text: `Quest done! You took ${r.text}` };
  if (path === '/hunt/start') return { text: 'You slip into the night… the hunt has begun.' };
  if (path === '/hunt/collect') return { text: `Hunt complete: +${r.xp} XP, +${r.gold} gold${r.levelsGained ? ' — LEVEL UP!' : ''}${r.found?.length ? ` — you found ${r.found.join(', ')}!` : ''}` };
  if (path === '/hunt/cancel') return { text: `Hunt abandoned: ${r.portionsCompleted} portion(s) paid out (+${r.xp} XP, +${r.gold} gold)` };
  if (path === '/work/start') return { text: 'You start your shift at the graveyard.' };
  if (path === '/work/collect') return { text: `Shift complete: earned ${r.wages} gold` };
  if (path === '/work/cancel') return { text: `You quit early after ${Math.floor(r.minutesWorked / 60)}h ${r.minutesWorked % 60}m and were paid ${r.wages} gold` };
  if (path === '/ancestral/challenge') return r.won ? { text: 'The ancestor acknowledges you. Ability improved!' } : { err: true, text: 'The ancestor defeated you. The fee is lost.' };
  return null;
}

async function refresh() {
  if (!token) return;
  me = await api('/me');
  skew = me.serverNow - Date.now();
  notes.unread = me.unreadNotifications; if (!notes.cursor) notes.cursor = me.notificationCursor;
  startPolling();
  applyTheme();
  render();
}

function logout(silent) {
  if (token && !silent) api('/logout', {}).catch(() => {}); // end the session on the server too, not only in this browser
  token = null; me = null; localStorage.removeItem('mg_token');
  stopPolling(); notes.unread = 0; notes.cursor = 0; renderAlerts(); closeDrop();
  if (!silent) toast('Logged out');
  location.hash = '#/'; render();
}

const now = () => Date.now() + skew;
const isHunting = () => me.hunt_until > now();
const isWorking = () => me.work_until > now();
const isInDungeon = () => me.dungeon_until > now();
const isBusy = () => isHunting() || isWorking() || isInDungeon();
function until(ts) {
  const ms = ts - now();
  if (ms <= 0) return null;
  const s = Math.ceil(ms / 1000), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  return h ? `${h}h ${m}m` : m ? `${m}m ${s % 60}s` : `${s}s`;
}
const bar = (cls, val, max, label) =>
  `<div class="bar ${cls}${cls === 'hp' && val / max < 0.3 ? ' low' : ''}"><i style="width:${Math.max(0, Math.min(100, (val / max) * 100))}%"></i><span>${esc(label)}</span></div>`;
const raceName = (r) => `<span class="${r}">${r === 'vampire' ? 'Vampire' : 'Werewolf'}</span>`;

// ---------- routing ----------
const PAGES = [['overview', 'Overview'], ['raid', 'Raid'], ['hunt', 'Hunt'], ['dungeon', 'Dungeon'], ['quests', 'Quests'], ['skills', 'Skills'], ['shrine', 'Shrine'], ['town', 'Town'], ['hideout', 'Hideout'],
  ['ancestral', 'Ancestral Site'], ['arena', 'Arena'], ['acc', 'Achievements'], ['clan', 'Clan'], ['mail', 'Mail'], ['messages', 'Reports'], ['highscore', 'Highscore'],
  ...(window.MG_LOCAL ? [['settings', 'Game']] : [])];
/** the menu; "Admin" only exists for admins (single player: always). The server checks again on every admin request. */
const pages = () => (me?.isAdmin ? [...PAGES, ['admin', 'Admin']] : PAGES);

/**
 * The parts of the URL after '#/' end up in page templates and API paths. They are reduced to a harmless alphabet at the source
 * (letters, digits, _ . - and % for percent-encoded names); anything else becomes empty, so a crafted link cannot inject markup.
 */
const safeSegment = (v) => (v === undefined ? undefined : /^[A-Za-z0-9_.\-%]{0,80}$/.test(v) ? v : '');
function route() {
  const [, page = 'overview', arg, arg2, arg3] = location.hash.split('/').map((v, i) => (i === 0 ? v : safeSegment(v)));
  return { page: page || 'overview', arg, arg2, arg3 };
}
addEventListener('hashchange', render);

const BANNER_TITLES = { login: 'Welcome', overview: 'Overview', raid: 'Raid', hunt: 'Manhunt', store: 'Store', inventory: 'Inventory', temple: 'Blood Temple', sentinels: 'Sentinels',
  war: 'War Room', dungeon: 'The Dungeon', skills: 'Skills', shrine: 'The Shrine', quests: 'Weekly quests', notifications: 'Notifications', dealer: 'Relic Dealer', graveyard: 'Graveyard', hideout: 'Hideout', ancestral: 'Ancestral Site', arena: 'Arena', achievements: 'Achievements', clan: 'Clan', forum: 'Clan Forum', mail: 'Mail', reports: 'Battle Reports',
  highscore: 'Highscore', profile: 'Profile', bite: 'A victim link' };
function bannerFor(page, arg) {
  const key = page === 'town' ? (arg || 'store') : page === 'clan' && (arg === 'forum' || arg === 'war') ? arg : { acc: 'achievements', messages: 'reports', player: 'profile' }[page] ?? page;
  const src = A(`banners/${key}`);
  return src ? `<div class="banner" style="background-image:url('${src}')"><h1>${esc(BANNER_TITLES[key] ?? '')}</h1></div>` : '';
}

let renderSeq = 0;
/**
 * Draw the current route. Renders can overlap (a click and a countdown-triggered refresh, or a slow page fetch), so every
 * call gets a number and only the LATEST one may write to the page: an older, slower render must never overwrite newer data.
 */
async function render() {
  const seq = ++renderSeq;
  const latest = () => seq === renderSeq;
  const { page, arg, arg2, arg3 } = route();
  renderHeader(page);
  const view = $('#view');
  try {
    if (page === 'bite') { const h = bannerFor('bite') + (await pageBite(arg)); if (latest()) view.innerHTML = h; return; }
    if (page === 'highscore' && !me) { const h = await pageHighscore(arg, arg2, arg3); if (latest()) view.innerHTML = h; return; }
    if (!token) return void (view.innerHTML = bannerFor('login') + pageLogin());
    if (!me) return await refresh();
    const fn = { overview: pageOverview, raid: pageRaid, hunt: pageHunt, town: pageTown, hideout: pageHideout,
      ancestral: pageAncestral, clan: pageClan, messages: pageMessages, highscore: pageHighscore,
      dungeon: pageDungeon, quests: pageQuests, notifications: pageNotifications, skills: pageSkills, shrine: pageShrine, arena: pageArena, acc: pageAcc, mail: pageMail, player: pageProfile, settings: pageSettings, admin: pageAdmin }[page] ?? pageOverview;
    const html = await fn(arg, arg2, arg3);
    if (!latest() || route().page !== page) return; // superseded by a newer render or navigation
    view.innerHTML = storageWarning() + bannerFor(page, arg) + html;
    bind();
  } catch (e) { if (latest()) view.innerHTML = `<div class="card bad">${esc(e.message)}</div>`; }
  if (latest()) renderDev();
}

function renderHeader(page) {
  $('#top').innerHTML = `<span class="brand">${A('brand/logo') ? `<img class="logo" src="${A('brand/logo')}" alt="MonstersGame-Reloaded">` : '🦇 MonstersGame-Reloaded'}</span>` + (me ? `
    <nav>${pages().map(([k, n]) => `<a href="#/${k}" class="${k === page ? 'on' : ''}">${img('nav/' + k, 'nav-ico')}${n}${k === 'mail' && me.unreadMail ? ` <span class="pill gold">${me.unreadMail}</span>` : ''}${k === 'quests' && me.questsReady ? ` <span class="pill gold">${me.questsReady}</span>` : ''}</a>`).join('')}</nav>
    <span class="who"><a id="bell" title="Notifications" role="button" tabindex="0">🔔${notes.unread ? `<span class="badge">${notes.unread > 99 ? '99+' : notes.unread}</span>` : ''}</a> · ${esc(me.name)} · ${raceName(me.race)} · Lv ${me.level} · <span class="gold">${fmt(me.gold)}g</span>
    · <a data-act="logout">Logout</a></span>` : '');
  $('#top [data-act=logout]')?.addEventListener('click', () => logout());
  $('#bell')?.addEventListener('click', toggleDrop);
  renderAlerts();
}

// generic delegated click handling: <button data-do="path" data-body='{"a":1}' data-ok="msg">
function bind() {
  const view = $('#view');
  // (a strict Content Security Policy forbids inline onclick attributes, so behaviours are attached here)
  view.querySelectorAll('input[data-select]').forEach((el) => { el.onclick = () => el.select(); });
  // browser-only mode: save/export/import/reset and world settings
  view.querySelectorAll('[data-local]').forEach((el) => { el.onclick = () => localAction(el.dataset.local, el); });
  view.querySelectorAll('input[data-local-import]').forEach((el) => { el.onchange = () => localAction('import', el); });
  view.querySelectorAll('form[data-local-settings]').forEach((f) => {
    f.onsubmit = async (e) => {
      e.preventDefault();
      const d = Object.fromEntries(new FormData(f)), was = localStorage.getItem('mg_dev') === '1';
      try {
        await window.MG_LOCAL_API.applySettings({ bots: Math.max(0, Math.min(300, Number(d.bots) || 0)), botsRaidHumans: !!f.elements.botsRaidHumans.checked, humanRaidChance: Number(d.humanRaidChance) });
        localStorage.setItem('mg_dev', f.elements.dev.checked ? '1' : '0');
        if (was !== f.elements.dev.checked) location.reload(); else { toast('Settings applied'); render(); }
      } catch (err) { toast(err.message, true); }
    };
  });
  view.querySelectorAll('[data-skill-board]').forEach(initSkillBoard);
  // shrine routine editor: the rows become ["hunt:6", "work:4"]
  view.querySelectorAll('form[data-shrine-routine]').forEach((f) => {
    f.onsubmit = (e) => {
      e.preventDefault();
      const steps = [];
      for (let i = 0; f.elements['kind' + i]; i++) { const kind = f.elements['kind' + i].value, n = Number(f.elements['amount' + i].value); if (kind) steps.push(`${kind}:${n}`); }
      act('/shrine/routine', { steps }, 'Routine saved');
    };
  });
  // admin player search
  view.querySelectorAll('form[data-admin-search]').forEach((f) => {
    f.onsubmit = (e) => { e.preventDefault(); adminQ = f.elements.q.value.trim().slice(0, 40); const h = `#/admin/players/${f.elements.who.value}/1`; if (location.hash === h) render(); else location.hash = h; };
  });
  // highscore: page size selector and "go to rank #"
  view.querySelectorAll('select[data-hs-size]').forEach((sel) => {
    sel.onchange = () => { try { localStorage.setItem('mg_hs_size', sel.value); } catch { /* private mode */ } const [, , t, r] = location.hash.split('/'); const h = `#/highscore/${t ?? 'level'}/${r ?? 'all'}/1`; if (location.hash === h) render(); else location.hash = h; };
  });
  view.querySelectorAll('form[data-hs-jump]').forEach((f) => {
    f.onsubmit = (e) => { e.preventDefault(); const rank = Math.max(1, parseInt(f.querySelector('input').value, 10) || 1); location.hash = `${f.dataset.base}/${Math.floor((rank - 1) / Number(f.dataset.hsJump)) + 1}`; };
  });
  // <form data-submit="/path" data-goto="#/x/{id}" data-ok="msg">: name=value fields; type=number/data-num -> Number; checkbox -> boolean; name="x[]" -> array of checked values
  view.querySelectorAll('form[data-submit]').forEach((form) => {
    form.onsubmit = async (e) => {
      e.preventDefault();
      const body = {};
      for (const el of form.elements) {
        if (!el.name) continue;
        if (el.name.endsWith('[]')) { const k = el.name.slice(0, -2); body[k] ??= []; if (el.checked) body[k].push(el.value); continue; }
        if (el.type === 'checkbox') { body[el.name] = el.checked; continue; }
        body[el.name] = el.type === 'number' || el.dataset.num ? Number(el.value) : el.value;
      }
      if (form.dataset.confirm && !confirm(form.dataset.confirm)) return;
      if (typeof body.kind === 'string' && body.kind.startsWith('tournament:')) { body.size = Number(body.kind.split(':')[1]); body.kind = 'tournament'; }
      const r = await act(form.dataset.submit, body, form.dataset.ok);
      if (r && form.dataset.goto) location.hash = form.dataset.goto.replace('{id}', r.id);
    };
  });
  view.querySelectorAll('[data-do]').forEach((el) => {
    el.onclick = () => {
      const body = el.dataset.body ? JSON.parse(el.dataset.body) : {};
      // inputs referenced via data-from="#id:field"
      (el.dataset.from || '').split(',').filter(Boolean).forEach((spec) => {
        const [sel, field] = spec.split(':'); const v = view.querySelector(sel)?.value;
        body[field] = isNaN(v) || v === '' ? v : Number(v);
      });
      if (el.dataset.confirm && !confirm(el.dataset.confirm)) return;
      act(el.dataset.do, body, el.dataset.ok);
    };
  });
}
const fired = new Set();
function tickCd() {
  document.querySelectorAll('[data-cd]').forEach((el) => {
    const ts = Number(el.dataset.cd), t = until(ts);
    el.textContent = t ?? el.dataset.ready ?? 'ready';
    // when a countdown that changes the page state hits zero, reload state once
    if (t === null && el.dataset.refresh && !fired.has(ts)) { fired.add(ts); refresh(); }
  });
  document.querySelectorAll('[data-progress]').forEach((el) => {
    const [from, to] = el.dataset.progress.split(',').map(Number);
    const pct = Math.max(0, Math.min(100, ((now() - from) / (to - from)) * 100));
    el.querySelector('i').style.width = pct + '%';
    el.querySelector('span').textContent = Math.floor(pct) + '%';
  });
}

// ---------- pages ----------
function pageLogin() {
  setTimeout(() => {
    $('#login')?.addEventListener('submit', async (e) => {
      e.preventDefault(); const f = new FormData(e.target);
      try { const r = await api('/login', { name: f.get('name'), password: f.get('password') }); token = r.token; localStorage.setItem('mg_token', token); await refresh(); location.hash = '#/overview'; }
      catch (err) { toast(err.message, true); }
    });
    $('#reg')?.addEventListener('submit', async (e) => {
      e.preventDefault(); const f = new FormData(e.target);
      try {
        const ref = Number(localStorage.getItem('mg_ref')) || undefined;
        await api('/register', { name: f.get('name'), password: f.get('password'), race: f.get('race'), referrerId: ref, code: f.get('code') || undefined });
        const r = await api('/login', { name: f.get('name'), password: f.get('password') });
        token = r.token; localStorage.setItem('mg_token', token); await refresh(); location.hash = '#/overview'; toast('Welcome to the night!');
      } catch (err) { toast(err.message, true); }
    });
  });
  return `${A('brand/hero') ? `<div class="hero" style="background-image:url('${A('brand/hero')}')"></div>` : ''}<div class="grid" style="max-width:800px;margin:2rem auto">
    <form id="login" class="card"><h2>Login</h2>
      <label>Name</label><input name="name" required autocomplete="username" style="width:100%">
      <label>Password</label><input name="password" type="password" required autocomplete="current-password" style="width:100%">
      <p><button>Enter</button></p></form>
    <form id="reg" class="card"><h2>Create character</h2>
      <label>Name</label><input name="name" required pattern="[A-Za-z0-9_\\-]{3,20}" style="width:100%">
      <label>Password (${catalog?.passwordMin ?? 8}-${catalog?.passwordMax ?? 128} characters)</label><input name="password" type="password" required minlength="${catalog?.passwordMin ?? 8}" maxlength="${catalog?.passwordMax ?? 128}" autocomplete="new-password" style="width:100%">
      ${catalog?.registrationRequired ? '<label>Registration code (from the server owner)</label><input name="code" required autocomplete="off" style="width:100%">' : ''}
      <label>Race</label>
      <select name="race" style="width:100%"><option value="vampire">Vampire</option><option value="werewolf">Werewolf</option></select>
      ${A('races/vampire') || A('races/werewolf') ? `<div class="row" style="justify-content:center;margin-top:.6rem">${img('races/vampire', 'portrait sm', 'Vampire')}${img('races/werewolf', 'portrait sm', 'Werewolf')}</div>` : ''}
      <p><button>Begin the war</button></p></form>
  </div><p class="center muted">Vampires and Werewolves are locked in an eternal war. Pick your side, grow strong, raid the enemy.</p>`;
}

async function pageBite(id) {
  localStorage.setItem('mg_ref', id); // whoever bites and then registers becomes a recruit
  setTimeout(() => $('#bite')?.addEventListener('click', async () => {
    try { const r = await api('/bite/' + id, {}); $('#bite-res').innerHTML = `<p class="good">You feasted! Your victim earned ${r.amount} gold.</p>`; }
    catch (e) { $('#bite-res').innerHTML = `<p class="bad">${esc(e.message)}</p>`; }
  }));
  return `<div class="card center"><h2>A victim link</h2><p>Someone left a victim out here. Take a bite?</p>
    <p><button id="bite">Bite!</button> <a href="#/">Join the war</a></p><div id="bite-res"></div></div>`;
}

function pageOverview() {
  const b = me.battleStats;
  const stats = STATS.map(([k, n]) => {
    const extra = b[k] - me[k];
    return `<tr><td>${img('icons/stat_' + k)}${n}</td><td class="r">${me[k]}${extra ? ` <span class="good">+${extra}</span>` : ''}</td>
      <td class="r"><button class="sm" data-do="/train" data-body='{"stat":"${k}"}' ${me.gold < me.nextTrainCosts[k] || isBusy() ? 'disabled' : ''}>Train ${fmt(me.nextTrainCosts[k])}g</button></td></tr>`;
  }).join('');
  const inv = me.inventory.length ? me.inventory.map((i) => esc(i.name)).join(', ') : '<span class="muted">nothing</span>';
  const sen = me.sentinelOwned ? (catalog.sentinels.find((s) => s.key === me.sentinelOwned.sentinel_key)?.name ?? '?') : null;
  const skills = me.ancestralSkills.map((s) => {
    const a = Object.values(catalog.ancestral).flat().find((x) => x.key === s.skill_key);
    return `${esc(a?.name ?? s.skill_key)} Lv${s.level}`;
  }).join(', ') || '<span class="muted">none</span>';
  return `<div class="grid">
    <div class="card"><h2>${img('races/' + me.race, 'portrait', me.race)}${esc(me.name)}</h2>
      <p>${raceName(me.race)} · Level ${me.level} · ${me.wins}W / ${me.losses}L</p>
      <label>${img('icons/xp')}Experience</label>${bar('xp', me.xp, me.xpToNext, `${me.xp} / ${me.xpToNext}`)}
      <label>${img('icons/hp')}Health (+10/hour)</label>${bar('hp', me.hp, me.max_hp, `${me.hp} / ${me.max_hp}`)}
      <p class="gold">${ico('icons/gold', '')}${fmt(me.gold)} gold</p>
      ${isWorking() ? `<p class="bad">${img('ui/working')}Working in the graveyard: <b data-cd="${me.work_until}" data-refresh="1"></b> left</p>` : ''}
      ${isInDungeon() ? `<p class="bad">${ico('nav/dungeon', '🕳 ')}Inside the dungeon · <a href="#/dungeon">go to the dungeon</a></p>` : ''}
      <p class="${me.skillPoints ? 'gold' : 'muted'}">✦ Skill points: <b>${me.skillPoints}</b> · <a href="#/skills">open the skill board</a></p>
      <p class="muted">🩸 Animal blood ${fmt(me.blood)} / ${me.bloodMax}${me.level >= catalog.shrineLevel ? ` · <a href="#/shrine">Shrine: ${esc({ running: 'running', paused: 'paused', starved: 'out of blood', off: 'not started' }[me.shrine] ?? 'not built')}</a>` : ` · the shrine unlocks at level ${catalog.shrineLevel}`}</p>
      ${isHunting() ? `<p class="bad">${img('ui/hunting')}Out hunting: <b data-cd="${me.hunt_until}" data-refresh="1"></b> left · <a href="#/hunt">manage</a></p>` : ''}
    </div>
    <div class="card"><h2>Attributes</h2>
      <table><tr><th>Attribute</th><th class="r">Value</th><th></th></tr>${stats}</table>
      <p class="muted">Green = bonus from equipment, sentinel and ancestral skills. Training cost is value² − 5.</p></div>
  </div><div class="grid">
    <div class="card"><h3>Gear</h3><p>${inv}</p><p>Sentinel: ${sen ? esc(sen) : '<span class="muted">none</span>'}</p>
      <p>Ancestral skills: ${skills}</p><p class="muted">Hideout bonus: ${me.hideoutTotal} / 52</p></div>
    ${LOCAL ? '' : `<div class="card"><h3>Victim link</h3>
      <p class="muted">Share this. Each visitor can bite once per day and you earn 1–3 gold. New characters who join through it pay you 50 gold when they reach level 3.</p>
      <input readonly style="width:100%" value="${new URL('#/bite/' + me.id, document.baseURI).href}" data-select></div>`}
  </div>`;
}

function pageRaid() {
  const cd = until(me.attackReadyAt);
  const busy = isBusy();
  const canGo = !cd && !busy && me.hp >= 25;
  const found = me.found;
  const r = lastResult;
  const potion = me.inventory.find((i) => i.key === 'potion_heal');
  return `<div class="grid"><div class="card"><h2>Raid the enemy</h2>
    <p>Hunt down a ${raceName(me.race === 'vampire' ? 'werewolf' : 'vampire')} and steal their gold.</p>
    ${bar('hp', me.hp, me.max_hp, `HP ${me.hp} / ${me.max_hp}`)}
    <p>Attack cooldown: <b data-cd="${me.attackReadyAt}" data-ready="ready">${cd ?? 'ready'}</b></p>
    ${me.hp < 25 ? `<p class="bad">You need at least 25 HP to raid or be raided. Health regenerates 10 per hour.</p>
      ${potion ? `<p><button class="sec" data-do="/inventory/use" data-body='{"inventoryId":${potion.id}}' data-ok="Fully healed">Use health potion</button></p>`
        : '<p class="muted">Buy a Health Potion in Town → Store (40g) to heal instantly.</p>'}` : ''}
    ${busy ? `<p class="bad">You are ${isInDungeon() ? 'inside the dungeon' : isHunting() ? 'out hunting' : 'working in the graveyard'} and cannot raid.</p>` : ''}
    <button data-do="/raid/search" ${canGo ? '' : 'disabled'} data-ok="Search finished">Search for an opponent</button>
    ${found ? `<hr><h3>Target found</h3><p><b class="${found.race}">${esc(found.name)}</b> · Level ${found.level}</p>
      <button data-do="/raid/attack" data-body='{"targetId":${found.id}}'>⚔ Attack!</button>` : ''}
    <p class="muted">Search fails sometimes: your Dexterity is weighed against the target's hideout.</p>
  </div>
  <div class="card"><h2>Last battle</h2>${r ? battleHtml(r) : '<p class="muted">Nothing yet.</p>'}</div></div>`;
}

function battleHtml(r) {
  return `${r.target ? `<p>Target: <b>${esc(r.target.name)}</b> (Lv ${r.target.level})${r.warId ? ' <span class="pill bad">clan war</span>' : ''}</p>` : ''}<p><b>${esc(r.winner)}</b> won after ${r.rounds} rounds.</p>
    <p>Gold looted: <span class="gold">${fmt(r.gold)}</span> · XP: you ${r.xpAttacker}, enemy ${r.xpDefender}</p>
    <p>HP left: you ${Math.floor(r.attackerHp)}, enemy ${Math.floor(r.defenderHp)}</p>
    <a href="#/messages/${r.battleId}">View round-by-round log →</a>`;
}

const PLACE_LABEL = { village: '🏘 Village', small_town: '🏙 Small town', large_town: '🌆 Large town', nothing: '💨 The trail went cold' };

function huntResultHtml(r) {
  if (!r) return '';
  const rows = r.events.map((e, i) => `<tr><td class="muted">#${i + 1}</td><td>${img('hunt/' + e.place, 'thumb')}${PLACE_LABEL[e.place] ?? e.place}</td>
    <td class="r">${e.failed ? '' : `+${e.xp} XP`}</td><td class="r gold">${e.failed ? '' : `+${e.gold}g`}</td></tr>`).join('');
  return `<hr><h3>${r.cancelled ? 'Hunt abandoned' : 'Hunt complete'}</h3>
    ${rows ? `<table>${rows}</table>` : '<p class="muted">Nothing was completed.</p>'}
    <p><b>Total: +${r.xp} XP, <span class="gold">+${fmt(r.gold)}g</span></b>${r.levelsGained ? ' <span class="good">— LEVEL UP!</span>' : ''}</p>`;
}

function pageHunt() {
  const left = Math.max(0, Math.floor(me.huntMinutesLeft / 10));
  const places = ['village', 'small_town', 'large_town'].map((k) => img('hunt/' + k, 'scene')).join('');
  const chances = `${places ? `<div class="scenes">${places}</div>` : ''}<p class="muted">Every 10 minute portion picks a target: 🏘 village (50%) base reward · 🏙 small town (35%) +100% XP and gold (×2) · 🌆 large town (15%) +250% XP and gold (×3.5).
    A village pays 2 XP and about 8–15 gold; gold scales with your level.
    <b class="good">While you are out hunting nobody can raid you.</b> Some portions fail; Dexterity lowers that risk.</p>`;
  let body;
  if (isHunting()) {
    const total = (me.hunt_until - me.hunt_started) / 600000;
    body = `<p class="bad">You are out on the hunt and cannot do anything else. Ends in <b data-cd="${me.hunt_until}" data-refresh="1"></b>.</p>
      <div class="bar xp" data-progress="${me.hunt_started},${me.hunt_until}"><i style="width:0"></i><span></span></div>
      <p class="muted">${total} portion(s) planned. Cancelling now pays out only fully completed 10-minute portions and gives the unused time back.</p>
      <button class="sec" data-do="/hunt/cancel" data-confirm="Abandon the hunt? Only completed 10-minute portions pay out.">Cancel hunt</button>`;
  } else if (me.hunt_started) {
    body = `<p class="good">Your hunt is over. Time to see what you caught!</p><button data-do="/hunt/collect">Collect spoils</button>`;
  } else {
    body = `<p>Hunting time left today: <b>${me.huntMinutesLeft} min</b> (3 h per day, resets at midnight UTC)</p>
      <div class="row"><select id="portions">${Array.from({ length: Math.max(1, left) }, (_, i) => `<option value="${i + 1}">${i + 1} × 10 min (${(i + 1) * 10} min)</option>`).join('')}</select>
      <button data-do="/hunt/start" data-from="#portions:portions" ${left && !me.work_started && !isInDungeon() ? '' : 'disabled'}>Start hunting</button></div>
      ${isInDungeon() ? '<p class="bad">You are inside the dungeon. Leave it first.</p>' : ''}
      ${me.work_started ? '<p class="bad">You are working in the graveyard. Finish or quit the shift (and collect) first.</p>' : ''}`;
  }
  return `<div class="card" style="max-width:600px"><h2>Manhunt</h2>${chances}${body}${isHunting() ? '' : huntResultHtml(huntResult)}</div>`;
}

const CATEGORIES = [['weapon', '⚔ Weapons'], ['armor', '🛡 Armor'], ['ring', '💍 Rings'], ['amulet', '🔮 Amulets'], ['potion', '🧪 Potions'], ['component', '🩸 Shrine parts']];
const catTabs = (base, cur, counts) => `<div class="tabs">${CATEGORIES.map(([k, n]) => `<a href="#/town/${base}/${k}" class="${k === cur ? 'on' : ''}">${img('items/cat_' + k, 'nav-ico')}${n}${counts ? ` <span class="pill">${counts[k] ?? 0}</span>` : ''}</a>`).join('')}</div>`;

async function pageTown(tab = 'store', sub, more) {
  const tabs = [['store', 'Store'], ['inventory', 'Inventory'], ['temple', 'Blood Temple'], ['sentinels', 'Sentinels'], ['graveyard', 'Graveyard'], ['dealer', 'Relic Dealer']];
  const head = `<div class="tabs">${tabs.map(([k, n]) => `<a href="#/town/${k}" class="${k === tab ? 'on' : ''}">${n}</a>`).join('')}</div>`;
  const busy = isBusy();
  if (tab === 'inventory') {
    const cat = CATEGORIES.some(([k]) => k === sub) ? sub : (CATEGORIES.find(([k]) => me.inventory.some((i) => i.slot === k))?.[0] ?? 'weapon');
    const counts = Object.fromEntries(CATEGORIES.map(([k]) => [k, me.inventory.filter((i) => i.slot === k).length]));
    const rows = me.inventory.filter((i) => i.slot === cat).sort((x, y) => Number(y.equipped) - Number(x.equipped)).map((i) => {
      const def = catalog.items.find((x) => x.key === i.key);
      const hardCost = Math.round(def.price * 0.25 * (i.hardening + 1));
      return `<tr><td>${img('items/' + i.key, 'item-ico')}${esc(i.name)}${i.hardening ? ` <span class="pill gold">+${i.hardening}</span>` : ''}${i.equipped ? ' <span class="pill good">equipped</span>' : ''}${def.minLevel > me.level ? ` <span class="pill bad">needs Lv ${def.minLevel}</span>` : ''}</td><td>${describe(def, i.hardening)}</td><td class="r">
        ${def.slot === 'potion' ? `<button class="sm" data-do="/inventory/use" data-body='{"inventoryId":${i.id}}' data-ok="Potion used" ${def.potion === 'maxhp' && me.vitality_hp >= catalog.vitalityCap ? 'disabled title="Maximum reached"' : ''}>Use</button>` : ''}
        ${def.slot === 'weapon' ? `<button class="sm sec" data-do="/inventory/harden" data-body='{"inventoryId":${i.id}}' ${i.hardening >= catalog.hardenMax || me.gold < hardCost || busy ? 'disabled' : ''}>${i.hardening >= catalog.hardenMax ? 'Max' : `Harden ${fmt(hardCost)}g`}</button>` : ''}
        ${def.slot === 'component' ? `<button class="sm" data-do="/shrine/install" data-body='{"inventoryId":${i.id}}' data-ok="Installed in the shrine" ${busy ? 'disabled' : ''}>Install in shrine</button>` : ''}
        <button class="sm sec" data-do="/inventory/sell" data-body='{"inventoryId":${i.id}}' data-confirm="Sell to the shop for ${fmt(Math.floor(def.price / 2))}g?" data-ok="Sold">Shop ${fmt(Math.floor(def.price / 2))}g</button>
        <input id="tp-${i.id}" type="number" min="1" placeholder="price" value="${def.price}" style="width:6rem;padding:.15rem .3rem">
        <button class="sm" data-do="/temple/list" data-body='{"inventoryId":${i.id}}' data-from="#tp-${i.id}:price" data-ok="Listed in the Blood Temple" ${busy ? 'disabled' : ''}>List in Temple</button></td></tr>`;
    }).join('');
    return `${head}<div class="card"><h2>Inventory</h2><p class="muted">The best usable item of each category is equipped automatically. The shop buys back at 50%; the Blood Temple lets you sell to other players at your own price (${Math.round(catalog.templeFee * 100)}% fee). Hardening a weapon adds +${catalog.hardenBonus} Strength per level (max +${catalog.hardenMax}).</p>
      ${catTabs('inventory', cat, counts)}
      ${cat === 'potion' ? vitalityNote() : ''}
      ${rows ? `<table><tr><th>Item</th><th>Effect</th><th></th></tr>${rows}</table>` : `<p class="muted">You own nothing in this category.</p>`}</div>`;
  }
  if (tab === 'temple') {
    const list = await api('/temple');
    const rows = list.map((l) => {
      const def = catalog.items.find((x) => x.key === l.item_key);
      return `<tr><td>${img('items/' + def.key, 'item-ico')}${esc(def.name)}${l.hardening ? ` <span class="pill gold">+${l.hardening}</span>` : ''}</td><td>${describe(def, l.hardening)}</td><td class="r">Lv ${def.minLevel}</td>
        <td><a href="#/player/${l.seller_id}">${esc(l.seller)}</a></td><td class="muted">${until(l.expires_at) ?? 'expired'}</td>
        <td class="r">${l.mine ? `<button class="sm sec" data-do="/temple/cancel" data-body='{"listingId":${l.id}}' data-ok="Listing withdrawn">Withdraw</button>`
          : `<button class="sm" data-do="/temple/buy" data-body='{"listingId":${l.id}}' ${me.level < def.minLevel || me.gold < l.price || busy ? 'disabled' : ''}>${fmt(l.price)}g</button>`}</td></tr>`;
    }).join('');
    return `${head}<div class="card"><h2>Blood Temple</h2><p class="muted">Players trade items here. List items from your Inventory tab. The temple keeps ${Math.round(catalog.templeFee * 100)}% of every sale; unsold listings return to you after 7 days.</p>
      ${rows ? `<table><tr><th>Item</th><th>Effect</th><th class="r">Level</th><th>Seller</th><th>Expires</th><th></th></tr>${rows}</table>` : '<p class="muted">No offers right now.</p>'}</div>`;
  }
  if (tab === 'sentinels') {
    const own = me.sentinelOwned;
    const list = catalog.sentinels.map((s) => {
      const locked = me.level < Math.max(5, s.minLevel), prem = false;
      return `<tr><td>${img('sentinels/' + s.key, 'item-ico')}${esc(s.name)}</td><td class="r">${s.atk}</td><td class="r">${s.def}</td><td class="r">${s.sta}</td>
        <td class="r">Lv ${Math.max(5, s.minLevel)}</td><td class="r"><button class="sm" data-do="/sentinel/buy" data-body='{"key":"${s.key}"}' data-ok="Sentinel acquired"
        ${locked || prem || own || me.gold < s.price ? 'disabled' : ''}>${fmt(s.price)}g</button></td></tr>`;
    }).join('');
    const ownDef = own && catalog.sentinels.find((s) => s.key === own.sentinel_key);
    const costs = me.sentinelTrainCosts;
    return `${head}${me.level < 5 ? '<div class="card bad">Sentinels unlock at level 5.</div>' : ''}
      ${own ? `<div class="card"><h2>${img('sentinels/' + ownDef.key, 'portrait', ownDef.name)}${esc(ownDef.name)}</h2>
        <p>Attack ${ownDef.atk} <b class="good">+${own.t_atk}</b> · Defense ${ownDef.def} <b class="good">+${own.t_def}</b> · Stamina ${ownDef.sta} <b class="good">+${own.t_sta}</b></p>
        <div class="row">${['atk', 'def', 'sta'].map((a) => `<button class="sm" data-do="/sentinel/train" data-body='{"attr":"${a}"}' ${me.gold < costs[a] ? 'disabled' : ''}>Train ${a} (${fmt(costs[a])}g)</button>`).join('')}
        <button class="sm sec" data-do="/sentinel/dismiss" data-confirm="Dismiss and get ${fmt(ownDef.price)}g back? Training is lost." data-ok="Dismissed">Dismiss (+${fmt(ownDef.price)}g)</button></div>
        <p class="muted">Its attributes are added to yours in every fight. Dismissing refunds the full price, so sentinels also work as a gold bank.</p></div>` : ''}
      <div class="card"><h2>Sentinel market</h2><table><tr><th>Name</th><th class="r">Atk</th><th class="r">Def</th><th class="r">Sta</th><th class="r">Level</th><th></th></tr>${list}</table></div>`;
  }
  if (tab === 'dealer') {
    const d = await api('/dungeon');
    const rows = d.loot.map((l) => `<tr><td>${img('icons/loot', 'item-ico')}${esc(l.name)}${l.milestone ? ' <span class="pill gold">guardian reward</span>' : ''}</td><td class="r">found on level ${l.depth}</td>
      <td class="r"><button class="sm" data-do="/dungeon/sell" data-body='{"lootId":${l.id}}' ${isInDungeon() ? 'disabled' : ''}>Sell ${fmt(l.value)}g</button></td></tr>`).join('');
    return `${head}<div class="card"><h2>Relic Dealer</h2>
      <p class="muted">"Bring me what the dungeon gave you and I pay in gold." Loot found in the dungeon is worth more the deeper it came from and never expires.${isInDungeon() ? ' <b class="bad">You cannot trade while you are inside the dungeon.</b>' : ''}</p>
      ${rows ? `<table>${rows}</table><p><button data-do="/dungeon/sell" data-body='{"lootId":"all"}' ${isInDungeon() ? 'disabled' : ''}>Sell everything for ${fmt(d.lootValue)} gold</button></p>` : '<p class="muted">You have nothing to sell. Fight monsters in the <a href="#/dungeon">dungeon</a>: each one has a 25% chance to drop something valuable.</p>'}</div>`;
  }
  if (tab === 'graveyard') {
    const wage = 5 + me.level * 2;
    let body;
    if (isWorking()) {
      const worked = Math.floor((now() - me.work_started) / 60000);
      body = `<p class="bad">You are digging graves and cannot do anything else. Shift ends in <b data-cd="${me.work_until}" data-refresh="1"></b>.</p>
        <div class="bar xp" data-progress="${me.work_started},${me.work_until}"><i style="width:0"></i><span></span></div>
        <p class="muted">Quit early and you are paid for the time already worked (${wage}g per hour, to the minute).</p>
        <button class="sec" data-do="/work/cancel" data-confirm="Quit the shift now? You are paid for the time worked so far.">Quit and get paid for time worked</button>`;
    } else if (me.work_started) body = `<p class="good">Shift over!</p><button data-do="/work/collect">Collect ${fmt(me.work_hours * wage)} gold</button>`;
    else if (isInDungeon()) body = `<p class="bad">You are inside the dungeon. Leave it first.</p>`;
    else if (isHunting() || me.hunt_started) body = `<p class="bad">${img('ui/hunting')}You are busy hunting. Finish or cancel the hunt (and collect it) first.</p>`;
    else body = `<p>Wage: <span class="gold">${wage}g/hour</span>. A shift can last up to 48 hours, so you can leave the game running and come back later. You cannot do anything else while working, but you can quit early for pro-rata pay.</p>
      <div class="row"><select id="hours">${Array.from({ length: 48 }, (_, i) => `<option value="${i + 1}">${i + 1} hour${i ? 's' : ''}${i + 1 >= 24 && (i + 1) % 24 === 0 ? ` (${(i + 1) / 24} day${i + 1 > 24 ? 's' : ''})` : ''} — ${fmt((i + 1) * wage)}g</option>`).join('')}</select>
      <button data-do="/work/start" data-from="#hours:hours">Start working</button></div>`;
    return `${head}<div class="card"><h2>Graveyard work</h2>${body}</div>`;
  }
  if (tab === 'shrine') { location.replace('#/shrine'); return head; } // (the shrine used to be a Town tab)
  const cat = CATEGORIES.some(([k]) => k === sub) ? sub : 'weapon';
  const counts = Object.fromEntries(CATEGORIES.map(([k]) => [k, catalog.items.filter((i) => i.slot === k && !i.noShop).length]));
  const owned = (key) => me.inventory.filter((i) => i.key === key).length;
  // every gear line (Blade, Plate, ...) is listed on its own, tier by tier; items far above your level stay folded away
  const lineOf = (i) => i.key.replace(/_\d+$/, '');
  const all = catalog.items.filter((i) => i.slot === cat && !i.noShop).sort((x, y) => (lineOf(x) === lineOf(y) ? x.minLevel - y.minLevel : catalog.items.findIndex((z) => lineOf(z) === lineOf(x)) - catalog.items.findIndex((z) => lineOf(z) === lineOf(y))) || x.price - y.price);
  const shown = more === 'all' ? all : all.filter((i) => i.minLevel <= me.level + 8 || owned(i.key));
  let lastLine = '';
  const rows = shown.map((i) => {
    const locked = me.level < i.minLevel;
    const header = lineOf(i) !== lastLine && all.some((z) => lineOf(z) !== lineOf(i)) ? `<tr><th colspan="4">${esc(i.name.replace(/\s*(Mk )?\d+$/, ''))}</th></tr>` : '';
    lastLine = lineOf(i);
    return `${header}<tr class="${locked ? 'muted' : ''}"><td>${img('items/' + i.key, 'item-ico')}${esc(i.name)}${owned(i.key) ? ` <span class="pill good">owned ×${owned(i.key)}</span>` : ''}</td><td>${describe(i)}</td><td class="r">Lv ${i.minLevel}</td>
      <td class="r"><button class="sm" data-do="/store/buy" data-body='{"key":"${i.key}"}' data-ok="Purchased ${esc(i.name)}"
      ${locked || busy || me.gold < i.price || (i.potion === 'maxhp' && me.vitalityRoom <= 0) ? 'disabled' : ''}>${fmt(i.price)}g</button></td></tr>`;
  }).join('');
  const hidden = all.length - shown.length;
  const foot = more === 'all' ? `<p><a href="#/town/store/${cat}">Show only items near my level</a></p>` : hidden ? `<p class="muted">${hidden} more item${hidden === 1 ? '' : 's'} for higher levels. <a href="#/town/store/${cat}/all">Show all</a></p>` : '';
  return `${head}<div class="card"><h2>Store</h2>${catTabs('store', cat, counts)}${cat === 'potion' ? vitalityNote() : ''}<table><tr><th>Item</th><th>Effect</th><th class="r">Level</th><th></th></tr>${rows}</table>${foot}</div>`;
}
const STEP_LABEL = { hunt: ['Hunt', 'portions of 10 min'], work: ['Graveyard work', 'hours'], dungeon: ['Dungeon run', 'fights'] };
/** "hunt:6" -> "Hunt 6 × 10 min" */
const stepName = (t) => { const [k, n] = t.split(':'); return k === 'hunt' ? `Hunt ${n} × ${dur(catalog.huntPortionMs ?? 600000)}` : k === 'work' ? `Work ${n} h` : `Dungeon run (up to ${n} fights)`; };
async function pageShrine() { return shrineHtml(); }
async function shrineHtml() {
  const s = await api('/shrine');
  const pct = (x) => `${Math.round(x * 1000) / 10}%`;
  if (!s.unlocked) return `<div class="card"><h2>Shrine</h2><p class="muted">An old shrine stands outside the town. It will answer you from level <b>${s.unlockLevel}</b>.</p>
    <p class="muted">It hunts and works for you while you are away, fuelled by animal blood that you gather by playing.</p></div>`;
  const about = `<ul class="muted"><li>Every <b>manual</b> action gathers animal blood on the way (hunting, work, raids, dungeon fights). The shrine can hold <b>${s.tank}</b>.</li>
      <li>While the shrine runs, it works through your routine and pays <b>${pct(s.efficiency)}</b> of what the same time would pay by hand. An automated hour burns <b>${s.bloodPerHour}</b> blood.</li>
      <li>The usual daily limits stay (3 hours of hunting a day, one dungeon run a day). With an <b>Idol of the Hunt</b> installed the shrine can also do dungeon runs: all or nothing (a paused run is cancelled).</li>
      <li><b>No protection while it runs:</b> you can be raided, but a raid takes at most ${Math.round(catalog.shrineRaidLossCap * 100)}% of your gold.</li>
      <li>Hunting, working, raiding or entering the dungeon by hand <b>pauses</b> the shrine (the step in progress is paid pro rata). Press Start when you are done.</li></ul>`;
  if (!s.owned) return `<div class="card"><h2>Shrine</h2><p>Build the shrine for <b class="gold">${fmt(s.price)} gold</b>.</p>
      <p><button data-do="/shrine/buy" data-ok="The shrine is yours" ${me.gold < s.price || isBusy() ? 'disabled' : ''}>Build the shrine</button></p>${about}</div>`;
  const cur = s.current;
  const statusPill = { running: '<span class="pill good">running</span>', paused: '<span class="pill gold">paused</span>', starved: '<span class="pill bad">out of blood</span>', off: '<span class="pill">not started</span>' }[s.status];
  const slotRows = Array.from({ length: s.slots }, (_, i) => { const [k, n] = (s.routine[i] ?? ':').split(':');
    return `<div class="row" style="margin:.2rem 0"><span class="muted" style="min-width:3rem">Step ${i + 1}</span>
      <select name="kind${i}"><option value="">— nothing —</option>${Object.entries(STEP_LABEL).filter(([key]) => key !== 'dungeon' || s.dungeonUnlocked).map(([key, [name]]) => `<option value="${key}" ${key === k ? 'selected' : ''}>${name}</option>`).join('')}</select>
      <input name="amount${i}" type="number" min="1" max="48" value="${n || ''}" style="width:5rem" aria-label="amount"> <span class="muted">portions (hunt) / hours (work)${s.dungeonUnlocked ? ' / fights (dungeon)' : ''}</span></div>`; }).join('');
  return `<div class="grid"><div class="card"><h2>Shrine ${statusPill}</h2>
      <label>🩸 Animal blood (about ${s.hoursOfFuel} h of work)</label>${bar('hp', s.blood, s.tank, `${fmt(s.blood)} / ${s.tank}`)}
      <p class="muted">Efficiency ${pct(s.efficiency)} (best possible ${pct(s.maxEfficiency)}) · ${s.bloodPerHour} blood per automated hour</p>
      ${cur ? `<p>Now: <b>${esc(stepName(cur.step))}</b> · ends in <b data-cd="${cur.endsAt}" data-refresh="1"></b></p><div class="bar xp" data-progress="${cur.startedAt},${cur.endsAt}"><i></i><span></span></div>` : ''}
      ${s.status === 'starved' ? '<p class="bad">The shrine ran out of blood. Hunt, work, raid or delve to gather more, then start it again.</p>' : ''}
      <div class="row" style="margin-top:.6rem">${s.status === 'running'
        ? '<button class="sec" data-do="/shrine/pause" data-ok="Shrine paused">⏸ Pause</button>'
        : `<button data-do="/shrine/start" data-ok="The shrine is working" ${isBusy() || !s.routine.length ? 'disabled' : ''}>▶ ${s.status === 'paused' ? 'Resume' : 'Start'}</button>`}</div>
      ${isBusy() ? '<p class="muted">Finish what you are doing by hand first.</p>' : ''}</div>
    <form class="card" data-shrine-routine><h2>Routine</h2><p class="muted">The steps repeat in order until the blood runs out. Changing the routine pauses the shrine.</p>${slotRows}<p><button>Save routine</button></p></form></div>
    <div class="card"><h2>Parts</h2><p class="muted">Every installed tier adds ${Math.round(catalog.shrineEfficiencyPerUpgrade * 1000) / 10}% efficiency (${s.upgrades} of 6 so far). Tier I is sold in the <a href="#/town/store/component">shop</a>; tier II is found while hunting large towns and beating dungeon guardians, or bought from other players in the Blood Temple.</p>
      <table>${['chalice', 'altar', 'idol'].map((k) => { const t = s.parts[k] ?? 0, name = { chalice: 'Blood Chalice', altar: 'Bone Altar', idol: 'Idol of the Hunt' }[k], what = { chalice: `tank ${s.tank}`, altar: `${s.slots} routine steps`, idol: t >= 2 ? `+${Math.round(catalog.shrineBloodBonus * 100)}% blood` : t === 1 ? 'dungeon automation' : '' }[k];
        return `<tr><td>${esc(name)}</td><td>${t ? `tier ${t === 1 ? 'I' : 'II'} <span class="muted">(${esc(what)})</span>` : '<span class="muted">not installed</span>'}</td><td class="r">${t ? `<button class="sm sec" data-do="/shrine/remove" data-body='${esc(JSON.stringify({ kind: k }))}' ${isBusy() ? 'disabled' : ''}>Remove</button>` : ''}</td></tr>`; }).join('')}</table>
      ${s.bag.length ? `<h3>In your bag</h3><table>${s.bag.map((b) => { const def = catalog.items.find((x) => x.key === b.key); return `<tr><td>${esc(def.name)}</td><td class="muted">${esc(describe(def))}</td><td class="r"><button class="sm" data-do="/shrine/install" data-body='${esc(JSON.stringify({ inventoryId: b.id }))}' ${isBusy() ? 'disabled' : ''}>Install</button></td></tr>`; }).join('')}</table>` : '<p class="muted">No parts in your bag.</p>'}</div>
    <div class="card"><h3>How it works</h3>${about}</div>`;
}
/** Vitality Potions add permanent max HP, capped in total (see CFG.vitalityCap). */
function vitalityNote() {
  const used = me.vitality_hp, cap = catalog.vitalityCap;
  return `<p class="muted">🧪 <b>Vitality Potions</b> add +${catalog.vitalityGain} max HP permanently, but only up to <b>+${cap}</b> in total. Gained so far: <b class="${used >= cap ? 'bad' : 'good'}">${used} / ${cap}</b>${me.vitalityRoom > 0 ? ` · you can still use ${me.vitalityRoom} more (counting potions already in your bag)` : ' · <b>no more can be used</b>, so none can be bought'}.</p>`;
}
function describe(i, hardening = 0) {
  const parts = STATS.filter(([k]) => i.bonus[k] || (k === 'str' && hardening && i.slot === 'weapon')).map(([k]) => `+${(i.bonus[k] ?? 0) + (k === 'str' && i.slot === 'weapon' ? hardening * catalog.hardenBonus : 0)} ${k.toUpperCase()}`);
  if (i.goldBonus) parts.push(`+${Math.round(i.goldBonus * 100)}% raid gold`);
  if (i.huntBonus && i.huntBonus < 1000) parts.push(`+${i.huntBonus} hunt`);
  if (i.key === 'amulet_perfection') parts.push('hunts never fail');
  if (i.potion) parts.push({ heal: 'full heal', maxhp: `+${catalog.vitalityGain} max HP (max +${catalog.vitalityCap} in total)`, stat: '+10% stats 1h' }[i.potion]);
  if (i.key === 'amulet_healing') parts.push('healing');
  if (i.component) { const { kind, tier } = i.component; parts.push({ chalice: `+${catalog.shrineTankPerTier * tier} blood tank`, altar: `+${catalog.shrineSlotsPerTier * tier} routine step${tier > 1 ? 's' : ''}`, idol: tier === 1 ? 'unlocks dungeon automation' : `+${Math.round(catalog.shrineBloodBonus * 100)}% blood gathered` }[kind], `+${Math.round(catalog.shrineEfficiencyPerUpgrade * 1000) / 10}% shrine efficiency`); }
  return parts.join(', ') || '—';
}

function pageHideout() {
  const rows = Object.entries(catalog.hideoutMax).map(([k, max]) => {
    const lv = me.hideout[k];
    return `<tr><td style="text-transform:capitalize">${k}</td><td style="width:45%">${bar('', lv, max, `${lv} / ${max}`)}</td>
      <td class="r"><button class="sm" data-do="/hideout/upgrade" data-body='{"component":"${k}"}' data-ok="Upgraded ${k}" ${lv >= max || me.gold < me.hideoutCosts[k] ? 'disabled' : ''}>${lv >= max ? 'Max' : `Upgrade ${fmt(me.hideoutCosts[k])}g`}</button></td></tr>`;
  }).join('');
  const tiles = Object.keys(catalog.hideoutMax).map((k) => { const lv = me.hideout[k]; const im = lv ? img(`hideout/${k}_${lv}`, 'tile', `${k} ${lv}`) : ''; return im ? `<figure>${im}<figcaption>${k} ${lv}</figcaption></figure>` : ''; }).join('');
  return `${tiles ? `<div class="tiles">${tiles}</div>` : ''}<div class="card" style="max-width:640px"><h2>Your hideout</h2>
    <p class="muted">Each level adds 1 Defense when you are attacked at home and makes you harder to find. Enemy Dexterity reduces the defense bonus.</p>
    <table>${rows}</table><p>Total bonus: <b>${me.hideoutTotal}</b> / 52</p></div>`;
}

function pageAncestral() {
  if (me.level < 20) return `<div class="card"><h2>Ancestral Site</h2><p class="bad">Unlocks at level 20.</p></div>`;
  const cd = until(me.ancestralReadyAt);
  const skills = me.ancestralSkills.map((s) => {
    const a = Object.values(catalog.ancestral).flat().find((x) => x.key === s.skill_key);
    return `<tr><td>${img('ancestral/' + s.skill_key, 'item-ico')}${esc(a?.name)}</td><td>${a?.stat.toUpperCase()}</td><td class="r">Lv ${s.level}</td><td class="r good">+${s.level * 5}</td></tr>`;
  }).join('');
  return `<div class="card" style="max-width:640px">${img('ancestral/site', 'scene wide')}<h2>Ancestral Site</h2>
    <p>Fight the spirit of your ancestor to learn or improve a race ability. Once every 24 hours; the fee grows with every victory.</p>
    <p>Skill slots: <b>${me.ancestralSlots}</b> (1 at Lv20, 2 at Lv40, 3 at Lv60, 4 at Lv80) · Fee: <span class="gold">${fmt(me.ancestralFee)}g</span></p>
    <p>Ready in: <b data-cd="${me.ancestralReadyAt}" data-ready="now">${cd ?? 'now'}</b></p>
    <button data-do="/ancestral/challenge" ${cd || me.gold < me.ancestralFee ? 'disabled' : ''}>Challenge your ancestor</button>
    ${skills ? `<table style="margin-top:1rem"><tr><th>Ability</th><th>Stat</th><th class="r">Level</th><th class="r">Bonus</th></tr>${skills}</table>` : ''}
    <p class="muted">Abilities only apply in fights where both fighters are level 20+.</p></div>`;
}

const PERM_LABEL = { recruit: 'Recruit (applications)', kick: 'Kick members', war: 'Wars & negotiation', treasury: 'Treasury (domicile)', forum: 'Moderate forum' };

async function pageClan(tab, id) {
  const mine = me.clan ? await api('/clan/mine') : null;
  if (!mine) {
    const list = await api('/clans');
    const rows = list.filter((c) => c.race === me.race).map((c) => `<tr><td>${esc(c.name)}</td><td class="r">${c.members}</td><td>${c.is_open ? '<span class="good">open</span>' : '<span class="muted">applications</span>'}</td>
      <td class="r">${c.is_open ? `<button class="sm" data-do="/clan/join" data-body='{"clanId":${c.id}}' data-ok="Joined">Join</button>`
        : `<button class="sm sec" data-do="/clan/apply" data-body='{"clanId":${c.id},"message":"I would like to join!"}' data-ok="Application sent">Apply</button>`}</td></tr>`).join('');
    return `<div class="grid"><div class="card"><h2>Found a clan</h2>
      <p class="muted">Requires level 3. Members must be of your race.</p>
      <input id="cname" placeholder="Clan name" maxlength="24"> <button data-do="/clan/create" data-from="#cname:name" data-ok="Clan founded" ${me.level < 3 ? 'disabled' : ''}>Create</button></div>
      <div class="card"><h2>${me.race === 'vampire' ? 'Vampire' : 'Werewolf'} clans</h2>${rows ? `<table><tr><th>Name</th><th class="r">Members</th><th>Recruiting</th><th></th></tr>${rows}</table>` : '<p class="muted">None yet.</p>'}</div></div>`;
  }
  const leader = mine.leader_id === me.id;
  const can = (p) => mine.myPerms.includes(p);
  const tabs = [['', 'Overview'], ['war', mine.war ? '⚔ War' : 'War'], ['forum', 'Forum'], ...(leader ? [['admin', 'Permissions']] : [])];
  const head = `<div class="tabs">${tabs.map(([k, n]) => `<a href="#/clan/${k}" class="${(tab ?? '') === k ? 'on' : ''}">${n}</a>`).join('')}</div>`;

  if (tab === 'forum') return head + (await pageForum(id, can('forum')));
  if (tab === 'war') return head + (await pageWar(can('war')));

  if (tab === 'admin' && leader) {
    const rows = mine.members.filter((m) => m.id !== me.id).map((m) => `<form class="card" data-submit="/clan/perms" data-ok="Permissions saved" style="margin:.5rem 0">
      <input type="hidden" name="playerId" value="${m.id}" data-num="1"><b>${esc(m.name)}</b> <span class="muted">Lv ${m.level}</span>
      <div class="row">${mine.allPerms.map((p) => `<label style="display:inline;margin:0"><input type="checkbox" name="perms[]" value="${p}" ${m.perms.includes(p) ? 'checked' : ''}> ${PERM_LABEL[p]}</label>`).join('')}
      <button class="sm">Save</button></div></form>`).join('');
    return `${head}<div class="card"><h2>Permissions</h2><p class="muted">The leader always has every right. Officers with "kick" cannot remove other officers.</p>${rows || '<p class="muted">No other members.</p>'}</div>`;
  }

  const apps = can('recruit') ? await api('/clan/applications') : [];
  const enemies = can('war') && !mine.war ? (await api('/clans')).filter((c) => c.race !== me.race) : [];
  const war = mine.war;
  return `${head}<div class="grid"><div class="card"><h2>${esc(mine.name)}</h2>
      <p>Members ${mine.members.length} / ${mine.capacity} · Domicile level ${mine.domicile_level} · Treasury <span class="gold">${fmt(mine.treasury)}g</span></p>
      <p>Recruiting: <b>${mine.is_open ? 'open to everyone' : 'applications only'}</b>
        ${can('recruit') ? `<button class="sm sec" data-do="/clan/recruiting" data-body='{"open":${!mine.is_open}}'>${mine.is_open ? 'Require applications' : 'Open recruiting'}</button>` : ''}</p>
      <div class="row"><input id="don" type="number" min="1" value="50" style="width:6rem"><button data-do="/clan/donate" data-from="#don:amount" data-ok="Donated">Donate</button>
      ${can('treasury') ? `<button class="sec" data-do="/clan/upgrade" data-ok="Domicile expanded (+5 slots)">Expand domicile (${fmt(mine.upgradeCost)}g)</button>` : ''}</div>
      <p><button class="sec sm" data-do="/clan/leave" data-confirm="Leave the clan?">Leave clan</button></p>
      ${mine.myPerms.length && !leader ? `<p class="muted">Your rights: ${mine.myPerms.map((p) => PERM_LABEL[p]).join(', ')}</p>` : ''}</div>
    <div class="card"><h2>War</h2>
      ${war ? `<p>Status: <b class="bad">${esc(war.status)}</b> against <b>${esc(mine.enemy.name)}</b>. During a war you may hit the same enemy 4× per 12 h. Raiding during a ceasefire ends it.</p>
        <p><a class="btn" href="#/clan/war">⚔ Open the war room</a></p>
        ${can('war') ? `<div class="row"><button class="sec sm" data-do="/clan/war/peace" data-ok="Peace offered / accepted">Peace</button>
        <button class="sec sm" data-do="/clan/war/ceasefire" data-ok="Ceasefire offered / accepted">Ceasefire</button>
        <button class="sm" data-do="/clan/war/capitulate" data-confirm="Surrender?">Capitulate</button></div>` : '<p class="muted">You need the war permission to negotiate.</p>'}`
        : `<p class="muted">Not at war. Declaring needs the war permission and at least 5 members.</p>
        ${can('war') ? `<div class="row"><select id="enemy">${enemies.map((c) => `<option value="${c.id}">${esc(c.name)} (${c.members})</option>`).join('')}</select>
        <button data-do="/clan/war/declare" data-from="#enemy:clanId" data-ok="War declared!" ${enemies.length ? '' : 'disabled'}>Declare war</button></div>` : ''}`}</div></div>
    ${apps.length ? `<div class="card"><h2>Applications</h2><table>${apps.map((a) => `<tr><td><a href="#/player/${a.player_id}">${esc(a.name)}</a> <span class="muted">Lv ${a.level}</span></td><td>${esc(a.message)}</td>
      <td class="r"><button class="sm" data-do="/clan/application" data-body='{"playerId":${a.player_id},"accept":true}' data-ok="Accepted">Accept</button>
      <button class="sm sec" data-do="/clan/application" data-body='{"playerId":${a.player_id},"accept":false}'>Decline</button></td></tr>`).join('')}</table></div>` : ''}
    <div class="card"><h2>Members</h2><table><tr><th>Name</th><th class="r">Level</th><th>Role</th><th></th></tr>
      ${mine.members.map((m) => `<tr><td><a href="#/player/${m.id}">${esc(m.name)}</a></td><td class="r">${m.level}</td><td>${esc(m.clan_role)}${m.id !== mine.leader_id && m.perms.length ? ' <span class="pill">officer</span>' : ''}</td>
      <td class="r">${can('kick') && m.id !== me.id && m.id !== mine.leader_id ? `<button class="sm sec" data-do="/clan/kick" data-body='{"playerId":${m.id}}' data-confirm="Kick ${esc(m.name)}?">Kick</button>` : ''}</td></tr>`).join('')}</table></div>`;
}

const TARGET_LABEL = { available: ['attackable', 'good'], range: ['outside your skill range', 'muted'], low_hp: ['too wounded (< 25 HP)', 'bad'], busy: ['busy (working / hunting)', 'muted'], protected: ['recently attacked', 'muted'], limit: ['hit the maximum times', 'muted'] };

async function pageWar(canNegotiate) {
  const w = await api('/clan/war');
  if (!w.war) return `<div class="card"><h2>War room</h2><p class="muted">Your clan is not at war. A clan leader (or a member with the war right) can declare war on an enemy clan from the Overview tab. It needs at least 5 members.</p></div>`;
  const sb = w.scoreboard, mineC = sb.clans.find((c) => c.clan_id === w.myClan.id) ?? { points: 0, attacks: 0, gold: 0 }, enC = sb.clans.find((c) => c.clan_id === w.enemyClan.id) ?? { points: 0, attacks: 0, gold: 0 };
  const cd = until(w.attackReadyAt), avail = w.targets.filter((t) => t.status === 'available').length, busy = isBusy();
  const reason = busy ? 'You are working or hunting' : cd ? `Cooldown: ${cd}` : me.hp < 25 ? 'You need at least 25 HP' : !avail ? 'No enemy is attackable right now' : '';
  const targets = w.targets.map((t) => {
    const [label, cls] = TARGET_LABEL[t.status];
    return `<tr class="${t.status === 'available' ? '' : 'muted'}"><td><a href="#/player/${t.id}">${esc(t.name)}</a></td><td class="r">${t.level}</td>
      <td class="${cls}">${label}${t.status === 'protected' && t.protectedUntil ? ` (${until(t.protectedUntil) ?? 'now'})` : ''}</td><td class="r">${t.hitsLeft} / ${w.maxHits}</td></tr>`;
  }).join('');
  const mrows = (clanId) => sb.members.filter((m) => m.clan_id === clanId).map((m) => `<tr class="${m.player_id === me.id ? 'gold' : ''}"><td>${esc(m.name)}</td><td class="r">${m.attacks}</td><td class="r">${m.wins}</td><td class="r">${m.defended}</td><td class="r">${fmt(m.gold)}</td></tr>`).join('');
  const r = lastResult && lastResult.warId === w.war.id ? lastResult : null;
  return `<div class="card"><div class="row sp"><h2 style="border:0;margin:0">${esc(w.myClan.name)} <span class="muted">vs</span> ${esc(w.enemyClan.name)}</h2><span class="pill ${w.war.status === 'active' ? 'bad' : 'gold'}">${esc(w.war.status)}</span></div>
      <p style="font-size:2rem;text-align:center;margin:.6rem 0" class="gold"><span class="good">${mineC.points}</span> : <span class="bad">${enC.points}</span></p>
      <p class="muted" style="text-align:center;margin:0">Score = battles won by your clan's members vs. the enemy clan's members (attacking or defending).</p></div>
    <div class="grid"><div class="card"><h2>Attack</h2>
      ${bar('hp', me.hp, me.max_hp, `HP ${me.hp} / ${me.max_hp}`)}
      <p>Attack cooldown: <b data-cd="${me.attackReadyAt}" data-ready="ready">${cd ?? 'ready'}</b> · Attackable enemies: <b>${avail}</b> / ${w.targets.length}</p>
      <p class="muted">Picks a random enemy war member whose skill level is within ±${Math.round(w.skillBand * 100)}% of yours and fights them at once. You can hit each enemy up to ${w.maxHits}× per 12 hours; hit enemies are protected for 1 hour. ${w.war.status === 'ceasefire' ? '<b class="bad">Attacking during a ceasefire ends it.</b>' : ''}</p>
      <button data-do="/clan/war/attack" ${reason ? 'disabled' : ''}>⚔ Attack a random enemy</button> ${reason ? `<span class="muted">${esc(reason)}</span>` : ''}
      ${me.hp < 25 ? `<p class="bad">Too wounded. ${me.inventory.some((i) => i.key === 'potion_heal') ? '<button class="sec sm" data-do="/inventory/use" data-body=\'{"inventoryId":' + me.inventory.find((i) => i.key === 'potion_heal').id + '}\'>Use health potion</button>' : 'Buy a Health Potion in the Store.'}</p>` : ''}
      ${canNegotiate ? `<hr><div class="row"><span class="muted">Negotiate:</span><button class="sec sm" data-do="/clan/war/peace" data-ok="Peace offered / accepted">Peace</button><button class="sec sm" data-do="/clan/war/ceasefire" data-ok="Ceasefire offered / accepted">Ceasefire</button><button class="sm" data-do="/clan/war/capitulate" data-confirm="Surrender?">Capitulate</button></div>` : ''}</div>
    <div class="card"><h2>Last war battle</h2>${r ? battleHtml(r) : '<p class="muted">You have not fought in this war yet.</p>'}</div></div>
    <div class="card"><h2>Enemy roster — ${esc(w.enemyClan.name)}</h2><table><tr><th>Name</th><th class="r">Level</th><th>Status</th><th class="r">Your hits left</th></tr>${targets}</table></div>
    <div class="grid"><div class="card"><h3>${esc(w.myClan.name)} <span class="muted">${mineC.attacks} attacks · ${fmt(mineC.gold)}g looted</span></h3><table><tr><th>Member</th><th class="r">Attacks</th><th class="r">Won</th><th class="r">Defended</th><th class="r">Gold</th></tr>${mrows(w.myClan.id)}</table></div>
      <div class="card"><h3>${esc(w.enemyClan.name)} <span class="muted">${enC.attacks} attacks · ${fmt(enC.gold)}g looted</span></h3><table><tr><th>Member</th><th class="r">Attacks</th><th class="r">Won</th><th class="r">Defended</th><th class="r">Gold</th></tr>${mrows(w.enemyClan.id)}</table></div></div>`;
}

async function pageForum(threadId, mod) {
  if (threadId) {
    const t = await api('/forum/' + threadId);
    const posts = t.posts.map((p) => `<div class="card" style="margin:.5rem 0"><div class="row sp"><b><a href="#/player/${p.author_id}">${esc(p.author)}</a></b>
      <span class="muted">${new Date(p.created_at).toLocaleString()} ${p.author_id === me.id || t.mod ? `<a data-do="/forum/delete" data-body='{"postId":${p.id}}' data-confirm="Delete this post?">delete</a>` : ''}</span></div>
      <div style="white-space:pre-wrap">${esc(p.body)}</div></div>`).join('');
    return `<div class="card"><div class="row sp"><h2 style="border:0;margin:0">${t.pinned ? '📌 ' : ''}${t.locked ? '🔒 ' : ''}${esc(t.title)}</h2><a href="#/clan/forum">← Threads</a></div>
      ${mod ? `<div class="row"><button class="sm sec" data-do="/forum/flag" data-body='{"threadId":${t.id},"flag":"pinned","value":${!t.pinned}}'>${t.pinned ? 'Unpin' : 'Pin'}</button>
        <button class="sm sec" data-do="/forum/flag" data-body='{"threadId":${t.id},"flag":"locked","value":${!t.locked}}'>${t.locked ? 'Unlock' : 'Lock'}</button></div>` : ''}
      ${posts}
      ${t.locked && !mod ? '<p class="muted">This thread is locked.</p>' : `<form data-submit="/forum/reply" data-ok="Posted"><input type="hidden" name="threadId" value="${t.id}" data-num="1">
        <label>Reply</label><textarea name="body" rows="4" required maxlength="4000" style="width:100%"></textarea><p><button>Post reply</button></p></form>`}</div>`;
  }
  const threads = await api('/forum');
  return `<div class="grid"><div class="card"><h2>Clan forum</h2>${threads.length ? `<table><tr><th>Thread</th><th>Author</th><th class="r">Replies</th><th>Last post</th></tr>
      ${threads.map((t) => `<tr><td>${t.pinned ? '📌 ' : ''}${t.locked ? '🔒 ' : ''}<a href="#/clan/forum/${t.id}">${esc(t.title)}</a></td><td>${esc(t.author)}</td><td class="r">${t.replies}</td><td class="muted">${new Date(t.last_at).toLocaleString()}</td></tr>`).join('')}</table>` : '<p class="muted">No threads yet.</p>'}</div>
    <form class="card" data-submit="/forum/thread" data-goto="#/clan/forum/{id}"><h3>New thread</h3><label>Title</label><input name="title" required maxlength="80" style="width:100%">
      <label>Message</label><textarea name="body" rows="4" required maxlength="4000" style="width:100%"></textarea><p><button>Create thread</button></p></form></div>`;
}

async function pageMessages(id) {
  if (id) {
    const b = await api('/battles/' + id);
    const lines = b.log.map((l) => `<div>R${l.round}: ${esc(l.attacker)} ${l.hit ? `hits for <b>${l.damage}</b>` : '<span class="muted">misses</span>'} → ${l.targetHp} HP left</div>`).join('');
    return `<div class="card"><h2>Battle #${b.id}</h2><p>${b.rounds} rounds · ${fmt(b.gold)} gold looted${b.war_id ? ' · <span class="bad">clan war</span>' : ''}</p>
      <div class="log">${lines}</div><p><a href="#/messages">← Back</a></p></div>`;
  }
  const rows = (await api('/messages')).map((m) => {
    const won = m.winner_id === me.id, atk = m.attacker === me.name;
    return `<tr><td class="muted">${new Date(m.at).toLocaleString()}</td><td>${atk ? `You raided <b>${esc(m.defender)}</b>` : `<b>${esc(m.attacker)}</b> raided you`}</td>
      <td class="${won ? 'good' : 'bad'}">${won ? 'Victory' : 'Defeat'}</td><td class="r">${m.gold ? fmt(m.gold) + 'g' : ''}</td><td><a href="#/messages/${m.id}">Details</a></td></tr>`;
  }).join('');
  return `<div class="card"><h2>Battle reports</h2>${rows ? `<table>${rows}</table>` : '<p class="muted">No battles yet.</p>'}</div>`;
}

const HS_TABS = [['level', 'Level'], ['wins', 'Raid wins'], ['loot', 'Gold looted'], ['hunter', 'Hunter'], ['worker', 'Gravedigger'], ['dungeon', 'Dungeon (week)'], ['arena_season', 'Arena (season)'], ['arena_alltime', 'Arena (all-time)'], ['clans', 'Clans']];

const hsSize = () => { try { return Number(localStorage.getItem('mg_hs_size')) || 25; } catch { return 25; } };

/** Compact page list: 1 … 4 5 [6] 7 8 … 40 */
function pageWindow(cur, total) {
  const set = new Set([0, total - 1, cur - 2, cur - 1, cur, cur + 1, cur + 2].filter((n) => n >= 0 && n < total));
  const out = []; let prev = -1;
  for (const n of [...set].sort((x, y) => x - y)) { if (n - prev > 1) out.push('…'); out.push(n); prev = n; }
  return out;
}

async function pageHighscore(type = 'level', race = 'all', pageArg = '1') {
  const size = hsSize();
  const q = new URLSearchParams({ type, race: race === 'all' ? '' : race, page: String(Math.max(0, (parseInt(pageArg, 10) || 1) - 1)), size: String(size) });
  const r = await api('/highscore?' + q);
  const isClan = type === 'clans';
  const valueHead = { level: 'XP', wins: 'Wins', loot: 'Gold', hunter: 'Portions', worker: 'Hours', dungeon: 'Levels cleared', arena_season: 'Points', arena_alltime: 'Points', clans: 'Total level' }[type];
  const base = `#/highscore/${type}/${race}`;
  const mine = (p) => (isClan ? me?.clan?.id === p.id : me?.id === p.id);
  const rows = r.rows.map((p, i) => `<tr class="${mine(p) ? 'gold' : ''}"><td>${r.page * r.pageSize + i + 1}</td>
    <td class="${p.race}">${isClan ? esc(p.name) : `<a href="#/player/${p.id}" class="${p.race}">${esc(p.name)}</a>`}${mine(p) ? ' ◀' : ''}</td>
    ${isClan ? `<td class="r">${p.members}</td>` : `<td class="r">${p.level}</td><td>${p.clan ? esc(p.clan) : ''}</td>`}
    <td class="r">${fmt(p.value ?? 0)}</td></tr>`).join('');
  const nav = r.pages > 1 ? `<div class="pager">
      ${r.page > 0 ? `<a href="${base}/1">« First</a><a href="${base}/${r.page}">‹ Prev</a>` : '<span class="muted">« First</span><span class="muted">‹ Prev</span>'}
      ${pageWindow(r.page, r.pages).map((n) => (n === '…' ? '<span class="muted">…</span>' : `<a href="${base}/${n + 1}" class="${n === r.page ? 'cur' : ''}">${n + 1}</a>`)).join('')}
      ${r.page < r.pages - 1 ? `<a href="${base}/${r.page + 2}">Next ›</a><a href="${base}/${r.pages}">Last »</a>` : '<span class="muted">Next ›</span><span class="muted">Last »</span>'}
    </div>` : '';
  const first = r.total ? r.page * r.pageSize + 1 : 0, last = Math.min(r.total, (r.page + 1) * r.pageSize);
  return `<div class="tabs">${HS_TABS.map(([k, n]) => `<a href="#/highscore/${k}/${race}" class="${k === type ? 'on' : ''}">${n}</a>`).join('')}</div>
    <div class="row sp" style="margin-bottom:.6rem"><span>Race: ${['all', 'vampire', 'werewolf'].map((x) => `<a href="#/highscore/${type}/${x}" class="${x === race ? 'gold' : ''}">${x}</a>`).join(' · ')}</span>
      <span class="row">${r.myRank ? `<a class="btn" href="${base}/${r.myPage + 1}">📍 Your rank: #${fmt(r.myRank)}</a>` : ''}
      <form data-hs-jump="${r.pageSize}" data-base="${base}" class="row" style="gap:.3rem"><input type="number" min="1" max="${Math.max(1, r.total)}" placeholder="rank #" style="width:6rem"><button class="sm sec">Go</button></form>
      <label style="margin:0;display:inline">Per page <select data-hs-size>${[25, 50, 100].map((n) => `<option ${n === r.pageSize ? 'selected' : ''}>${n}</option>`).join('')}</select></label></span></div>
    <div class="card"><div class="row sp"><h2 style="border:0;margin:0">Highscore</h2><span class="muted">${r.total ? `${fmt(first)}–${fmt(last)} of ${fmt(r.total)} ${isClan ? 'clans' : 'players'} · page ${r.page + 1} / ${r.pages}` : ''}</span></div>
      ${nav}${rows ? `<table><tr><th>#</th><th>Name</th>${isClan ? '<th class="r">Members</th>' : '<th class="r">Level</th><th>Clan</th>'}<th class="r">${valueHead}</th></tr>${rows}</table>` : '<p class="muted">Nobody on this list yet.</p>'}${nav}</div>`;
}

async function pageProfile(id) {
  const p = await api('/players/' + id);
  const a = p.arena;
  return `<div class="card" style="max-width:640px"><h2 class="${p.race}">${img('races/' + p.race, 'portrait', p.race)}${esc(p.name)}</h2>
    <p>${raceName(p.race)} · Level ${p.level} · ${p.wins} wins / ${p.losses} losses · joined ${new Date(p.joined).toLocaleDateString()}</p>
    <p>Clan: ${p.clan ? esc(p.clan.name) : '<span class="muted">none</span>'}</p>
    <p>Dungeon: ${p.dungeon.week ? `level ${p.dungeon.week} cleared this week` : 'not delved this week'} · best ever ${p.dungeon.bestEver}</p>
    <p>Arena: ${a.rank ? `Rank ${a.rank}${a.rank === 1 ? ' 👑' : ''}` : 'unranked'} · ${a.points} pts ${a.trend ?? ''}</p>
    ${a.titles.length ? `<p>${a.titles.map((t) => `🏆 ${esc(t.season)} #${t.place}`).join(' · ')}</p>` : ''}
    ${p.accomplishments.length ? `<p>${p.accomplishments.map((x) => `<span class="pill">${esc(x.name)} ${x.tier}/${x.maxTier}</span>`).join(' ')}</p>` : ''}
    ${me && me.id !== p.id ? `<a class="btn" href="#/mail/new/${encodeURIComponent(p.name)}">✉ Send message</a>` : ''}</div>`;
}

// ---------- dungeon ----------
/** 1440000 -> '24 hours', 1200000 -> '20 minutes' */
const dur = (ms) => { const m = Math.round(ms / 60000); return m >= 60 && m % 60 === 0 ? `${m / 60} hour${m === 60 ? '' : 's'}` : m > 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m} minute${m === 1 ? '' : 's'}`; };
const THREAT = { trivial: ['trivial', 'good'], easy: ['easy', 'good'], even: ['an even fight', 'gold'], dangerous: ['dangerous', 'bad'], deadly: ['deadly', 'bad'] };

function fightHtml(r) {
  if (!r) return '';
  const lines = r.log.map((l) => `<div>R${l.round}: ${l.who === 'you' ? 'You' : esc(r.monster.name)} ${l.hit ? `hit${l.who === 'you' ? '' : 's you'} for <b>${l.damage}</b>` : '<span class="muted">miss' + (l.who === 'you' ? '' : 'es') + '</span>'} · you ${l.hpYou} HP · monster ${l.hpMonster} HP</div>`).join('');
  return `<h3>${r.won ? '✔ Level ' + r.depth + ' cleared' : '✖ Defeated on level ' + r.depth}</h3>
    <p>${esc(r.monster.name)}${r.monster.guardian ? ' <span class="pill gold">guardian</span>' : ''} · ${r.rounds} rounds · you lost <b>${r.hpLost}</b> HP${r.won ? ` (${r.hpLeft} left)` : ''}</p>
    ${r.won && r.checkpoint ? `<p class="gold">🚩 Checkpoint! Level ${r.checkpoint} is saved: after the weekly reset you continue from here.</p>` : ''}
    ${r.won ? `<p class="good">+${r.xp} XP${r.levelsGained ? ' — LEVEL UP!' : ''}${r.drop ? ` · dropped <b>${esc(r.drop.name)}</b> (${fmt(r.drop.value)}g)` : ' · nothing dropped'}</p>` : '<p class="muted">You keep all XP and items. The run is over; this level is still to be beaten.</p>'}
    <details><summary class="muted">Round by round</summary><div class="log">${lines}</div></details>`;
}

async function pageDungeon() {
  const d = await api('/dungeon');
  const m = d.monster, [threatText, threatCls] = THREAT[m.threat];
  const cd = until(d.cooldownUntil);
  const week = `resets in ${until(d.weekEndsAt) ?? 'a moment'}`;
  const summary = `<p class="muted">This week (${week}): cleared <b>${d.cleared}</b> levels · ${d.kills} kills · ${d.deaths} deaths · ${d.runs} runs · +${d.xpWeek} XP · best ever <b>${d.bestEver}</b></p>
    <p class="muted">🚩 Checkpoint: ${d.checkpoint > 1 ? `you restart each week from level <b>${d.checkpoint}</b>` : 'none yet, every week starts on level 1'} · next one on level <b>${d.nextCheckpoint}</b> (every ${d.checkpointEvery} levels; you have to reach it to keep it)</p>`;
  const monsterCard = `<div class="row" style="align-items:flex-start">${img(`dungeon/${m.guardian ? 'guardian' : 'monster'}_${m.tier + 1}`, 'portrait')}
      <div><h2 style="border:0;margin:0">Level ${m.depth}${m.guardian ? ' <span class="pill gold">guardian</span>' : ''}</h2>
      <p style="margin:.2rem 0"><b>${esc(m.name)}</b> · <span class="${threatCls}">${threatText}</span></p>
      <p class="muted" style="margin:0">Reward: <b class="good">+${m.xp} XP</b> · ${Math.round(d.dropChance * 100)}% chance of a valuable drop${m.guardian ? ' · <b class="gold">choose 1 of 3 rewards</b>' : ''}</p></div></div>`;

  const choice = d.pending ? `<div class="card" style="border-color:var(--gold)"><h2>🏆 Guardian defeated!</h2>
      <p>Choose <b>one</b> reward. You can sell it to the relic dealer in town. The others are lost.</p>
      <div class="grid">${d.pending.map((o, i) => `<div class="card" style="margin:0"><h3>${img('icons/loot', 'item-ico')}${esc(o.name)}</h3><p class="gold" style="font-size:1.2rem;margin:.3rem 0">${fmt(o.value)} gold</p>
        <button data-do="/dungeon/reward" data-body='{"index":${i}}'>Take this</button></div>`).join('')}</div></div>` : '';

  let main;
  if (d.active) {
    main = `<div class="card">${monsterCard}
      <p style="margin-top:.8rem"><span class="muted">Dungeon HP (separate from your real HP, never regenerates here)</span></p>
      ${bar('hp', d.hp, d.maxHp, `${d.hp} / ${d.maxHp}`)}
      <p class="muted">You are dragged out if you do nothing for ${Math.round(d.idleLimit / 60000)} minutes (progress is kept): <b data-cd="${d.idleUntil}" data-refresh="1"></b></p>
      <div class="row"><button data-do="/dungeon/fight" ${d.pending || d.readyAt > now() ? 'disabled' : ''}>⚔ Fight</button>
        ${d.readyAt > now() ? `<span class="muted">The next monster arrives in <b data-cd="${d.readyAt}" data-refresh="1">${until(d.readyAt) ?? ''}</b></span>` : ''}
        <button class="sec" data-do="/dungeon/leave" data-confirm="Leave the dungeon? Progress is saved, but you can only enter the dungeon once per day: the next run is possible in ${dur(d.cooldown)}.">🚪 Leave</button>
        ${d.pending ? '<span class="muted">Choose your reward first.</span>' : ''}</div>
      ${dungeonResult ? '<hr>' + fightHtml(dungeonResult) : ''}</div>`;
  } else {
    const blocked = isHunting() || isWorking();
    main = `<div class="card"><h2>Enter the dungeon</h2>${dungeonResult && dungeonResult.died ? `<p class="bad">You died on level ${dungeonResult.depth}. XP and items are safe.</p>` : ''}
      <p>Next up:</p>${monsterCard}
      <p style="margin-top:.8rem"><button data-do="/dungeon/enter" ${d.canEnter && !blocked ? '' : 'disabled'}>Descend</button>
        ${!d.canEnter ? `<span class="muted"> You can enter again in <b data-cd="${d.cooldownUntil}" data-refresh="1">${cd ?? ''}</b></span>` : ''}
        ${blocked ? '<span class="bad"> Finish or cancel your hunt / work first.</span>' : ''}</p>
      <ul class="muted"><li>You enter with a <b>full dungeon HP pool</b> equal to your max HP, independent of your real HP.</li>
        <li>One monster per level, stronger every level. Winning gives XP, a ${Math.round(d.dropChance * 100)}% drop chance and takes you one level deeper. Dungeon HP is <b>not restored</b> during a run.</li>
        <li>${d.fightCooldown ? `After every victory the next monster needs <b>${dur(d.fightCooldown)}</b> to arrive, so a long run takes real time (you are locked inside meanwhile).` : 'Monsters come one after the other.'}</li>
        <li>Every ${d.milestone}th level is a guardian: beat it to choose one of three high value rewards.</li>
        <li>Every ${d.checkpointEvery}th level is a <b>checkpoint</b>: if you reach it, the weekly reset sends you back there instead of level 1. Miss it and you start over.</li>
        <li>Dying costs nothing (XP and items are kept) but ends the run. Progress is saved when you leave or die and <b>resets every Monday</b> (to your last checkpoint).</li>
        <li>While inside you cannot be raided and cannot raid, hunt or work. <b>One run per day:</b> after leaving or dying you can re-enter ${dur(d.cooldown)} later.</li></ul>
      ${dungeonResult ? '<hr>' + fightHtml(dungeonResult) : ''}</div>`;
  }
  const loot = `<div class="card"><div class="row sp"><h3 style="margin:0">Your loot</h3><a href="#/town/dealer">Relic Dealer →</a></div>
    ${d.loot.length ? `<p>${d.loot.length} item${d.loot.length === 1 ? '' : 's'} worth <span class="gold">${fmt(d.lootValue)}g</span>: ${d.loot.slice(0, 6).map((l) => esc(l.name)).join(', ')}${d.loot.length > 6 ? '…' : ''}</p>` : '<p class="muted">Nothing yet.</p>'}
    <p class="muted">Sell loot to the dealer in town (not possible inside the dungeon). <a href="#/highscore/dungeon/all">This week's ranking</a></p></div>`;
  return `${summary}${choice}${main}${loot}`;
}

// ---------- achievements ----------
async function pageAcc() {
  const { status, sets, bonus } = await api('/accomplishments');
  const earned = status.filter((s) => s.tier > 0);
  const rows = status.map((s) => `<tr><td>${img('accomplishments/' + s.key, 'item-ico')}<b>${esc(s.name)}</b><div class="muted">${esc(s.desc)}</div></td>
    <td style="width:35%">${bar('xp', s.tier, s.maxTier, `tier ${s.tier} / ${s.maxTier}`)}<div class="muted">${fmt(s.value)}${s.next ? ` / ${fmt(s.next)}` : ' (max)'}</div></td>
    <td class="r">${s.tier ? `<span class="good">${esc(s.bonusText.replace(/^\+\d+/, (m) => '+' + (parseInt(m) * s.tier)))}</span>` : `<span class="muted">${esc(s.bonusText)}/tier</span>`}</td></tr>`).join('');
  const setCards = sets.map((st) => `<form class="card" data-submit="/accomplishments/save" data-ok="Set saved" style="margin:.5rem 0${st.active ? ';border-color:var(--good)' : ''}">
    <input type="hidden" name="slot" value="${st.slot}" data-num="1">
    <div class="row sp"><b>Set ${st.slot + 1} ${st.active ? '<span class="pill good">ACTIVE</span>' : ''}</b>
      <span><button class="sm">Save</button> ${st.active ? '' : `<button type="button" class="sm sec" data-do="/accomplishments/activate" data-body='{"slot":${st.slot}}' data-ok="Set ${st.slot + 1} activated" ${isBusy() ? 'disabled' : ''}>Activate</button>`}</span></div>
    <div class="row">${earned.length ? earned.map((s) => `<label style="display:inline;margin:0"><input type="checkbox" name="keys[]" value="${s.key}" ${st.keys.includes(s.key) ? 'checked' : ''}> ${esc(s.name)}</label>`).join('') : '<span class="muted">Earn accomplishments to fill a set.</span>'}</div></form>`).join('');
  const b = [...Object.entries(bonus.stats).filter(([, v]) => v).map(([k, v]) => `+${v} ${k.toUpperCase()}`),
    bonus.raidGold ? `+${Math.round(bonus.raidGold * 100)}% raid gold` : '', bonus.huntReward ? `+${Math.round(bonus.huntReward * 100)}% hunt rewards` : '', bonus.workWage ? `+${Math.round(bonus.workWage * 100)}% wages` : ''].filter(Boolean);
  return `<div class="grid"><div class="card"><h2>Accomplishments</h2><p class="muted">Earned automatically without limit. Only accomplishments in your <b>active set</b> give their bonus. Each set holds ${catalog.accSetSize}. You cannot switch sets while working or hunting.</p>
    <p>Current bonus: ${b.length ? `<b class="good">${b.join(', ')}</b>` : '<span class="muted">none</span>'}</p>${setCards}</div>
    <div class="card"><h2>Progress</h2><table>${rows}</table></div></div>`;
}

// ---------- arena ----------
const RANK_NAME = (r) => (r === null ? 'Unranked' : r === 1 ? '👑 Rank 1' : `Rank ${r}`);

async function pageArena(arg, arg2) {
  if (arg === 'match') {
    const m = await api('/arena/match/' + arg2);
    const lines = m.log.map((l) => `<div>R${l.round}: ${esc(l.attacker)} ${l.hit ? `hits for <b>${l.damage}</b>` : '<span class="muted">misses</span>'} → ${l.targetHp} HP left</div>`).join('');
    return `<div class="card"><h2>Arena match #${m.id}</h2><p>${m.rounds} rounds</p><div class="log">${lines}</div><p><a href="#/arena/${m.event_id}">← Event</a></p></div>`;
  }
  if (arg === 'ranking') {
    const kind = arg2 === 'alltime' ? 'alltime' : 'season';
    const rows = (await api('/arena/ranking?kind=' + kind)).map((r, i) => `<tr><td>${i + 1}</td><td><a href="#/player/${r.id}" class="${r.race}">${esc(r.name)}</a></td><td class="r">${r.level}</td><td class="r">${Math.round(r.points)}</td></tr>`).join('');
    return `<div class="tabs"><a href="#/arena">← Arena</a><a href="#/arena/ranking/season" class="${kind === 'season' ? 'on' : ''}">This season</a><a href="#/arena/ranking/alltime" class="${kind === 'alltime' ? 'on' : ''}">All-time (decays 2%/day)</a></div>
      <div class="card"><h2>Arena ranking</h2>${rows ? `<table><tr><th>#</th><th>Name</th><th class="r">Level</th><th class="r">Points</th></tr>${rows}</table>` : '<p class="muted">No arena results yet.</p>'}</div>`;
  }
  if (arg && /^\d+$/.test(arg)) {
    const e = await api('/arena/event/' + arg);
    const entries = e.entries.map((x) => `<tr><td>${x.place ?? '–'}</td><td><a href="#/player/${x.player_id}">${esc(x.name)}</a></td><td class="r">${x.skill.toFixed(1)}</td><td class="r">${Math.round(x.strength)}</td></tr>`).join('');
    const matches = e.matches.map((m) => `<tr><td>Round ${m.round}</td><td>${esc(m.a_name)} vs ${esc(m.b_name)}</td><td>${esc(m.winner_id === m.a_id ? m.a_name : m.b_name)} won</td><td><a href="#/arena/match/${m.id}">log</a></td></tr>`).join('');
    return `<div class="card"><h2>${e.kind === 'duel' ? 'Duel' : `Tournament (${e.size})`} #${e.id} <span class="pill">${esc(e.status)}</span></h2>
      <p>Entry fee ${fmt(e.fee)}g · skill band ${(e.base_skill * (1 - e.deviation / 100)).toFixed(0)}–${(e.base_skill * (1 + e.deviation / 100)).toFixed(0)} · counts: ${[e.with_eq && 'equipment', e.with_sen && 'sentinels', e.with_anc && 'ancestral'].filter(Boolean).join(', ') || 'base stats only'}</p>
      ${e.status === 'full' ? `<p>Starts around ${new Date(e.start_at).toUTCString()}</p>` : ''}
      <table><tr><th>Place</th><th>Fighter</th><th class="r">Skill avg</th><th class="r">Strength</th></tr>${entries}</table>
      ${matches ? `<h3 style="margin-top:1rem">Matches</h3><table>${matches}</table>` : ''}<p><a href="#/arena">← Arena</a></p></div>`;
  }
  const { status: st, events } = await api('/arena');
  const skill = (me.str + me.def + me.agi + me.sta + me.dex) / 5;
  const rows = events.map((e) => {
    const band = `${(e.base_skill * (1 - e.deviation / 100)).toFixed(0)}–${(e.base_skill * (1 + e.deviation / 100)).toFixed(0)}`;
    const inBand = Math.abs(skill - e.base_skill) <= (e.base_skill * e.deviation) / 100 + 1e-9;
    const status = e.status === 'open' ? `open · closes in <b data-cd="${e.deadline}"></b>` : e.status === 'full' ? `full · starts ~${String(catalog.arenaStartHourUtc).padStart(2, '0')}:00 UTC` : 'finished';
    return `<tr><td><a href="#/arena/${e.id}">#${e.id}</a></td><td>${img('arena/' + e.kind, 'nav-ico')}${e.kind === 'duel' ? 'Duel' : `Tournament ${e.size}`}<div class="muted">by ${esc(e.creator)}</div></td><td>${band}<div class="muted">${[e.with_eq && 'gear', e.with_sen && 'sentinel', e.with_anc && 'ancestral'].filter(Boolean).join('+') || 'base'}</div></td>
      <td class="r">${fmt(e.fee)}g</td><td class="r">${e.entries}/${e.size}</td><td>${status}</td><td class="r">
      ${e.status === 'open' && !e.joined ? `<button class="sm" data-do="/arena/join" data-body='{"eventId":${e.id}}' data-ok="Registered" ${!inBand || st.current || me.gold < e.fee || me.level < catalog.arenaMinLevel ? 'disabled' : ''} title="${inBand ? '' : 'Your skill average is outside the band'}">Join</button>` : ''}
      ${e.joined && e.status !== 'done' && e.creator_id !== me.id ? `<button class="sm sec" data-do="/arena/leave" data-body='{"eventId":${e.id}}' data-ok="You left the event">Leave</button>` : ''}
      ${e.creator_id === me.id && (e.status === 'open' || e.status === 'full') ? `<button class="sm sec" data-do="/arena/cancel" data-body='{"eventId":${e.id}}' data-confirm="Cancel and refund everybody?" data-ok="Event cancelled">Cancel</button>` : ''}</td></tr>`;
  }).join('');
  return `<div class="grid"><div class="card"><h2>Your arena record</h2>
      <p style="font-size:1.4rem">${img(st.rank ? 'ranks/rank_' + st.rank : 'ranks/unranked', 'badge')}${RANK_NAME(st.rank)} <span title="last 30 days: ${st.wins30}/${st.matches30} won">${st.trend ? ico('icons/moon_' + MOONS.indexOf(st.trend), st.trend) : ''}</span></p>
      <p>All-time points: <b>${fmt(st.points)}</b> <span class="muted">(shrink 2% per day)</span><br>Season ${esc(st.season)}: <b>${fmt(Math.round(st.seasonScore.points))}</b> pts · ${st.seasonScore.wins}W / ${st.seasonScore.losses}L</p>
      ${st.titles.length ? `<p>${st.titles.map((t) => `🏆 ${esc(t.season)} #${t.place}`).join(' · ')}</p>` : ''}
      <p class="muted">Your skill average: <b>${skill.toFixed(1)}</b>. The moon shows your win rate over the last 30 days (🌑 poor … 🌕 excellent). Arena fights never change your real HP, gold or win record. Potions have no effect there.</p>
      <p><a href="#/arena/ranking/season">Season ranking</a> · <a href="#/arena/ranking/alltime">All-time ranking</a></p></div>
    <form class="card" data-submit="/arena/create" data-ok="Event created; you are registered"><h2>Create an event</h2>
      ${st.current ? '<p class="bad">You are already registered in an event.</p>' : me.level < catalog.arenaMinLevel ? `<p class="bad">The arena unlocks at level ${catalog.arenaMinLevel}.</p>` : ''}
      <div class="row"><div><label>Type</label><select name="kind"><option value="duel">Duel (2)</option>${catalog.arenaSizes.map((n) => `<option value="tournament:${n}">Tournament (${n})</option>`).join('')}</select></div>
        <div><label>Entry fee (gold)</label><input name="fee" type="number" min="0" value="100" style="width:7rem"></div>
        <div><label>Skill band ±%</label><input name="deviation" type="number" min="0" max="100" value="25" style="width:5rem"></div>
        <div><label>Registration</label><select name="registrationMinutes" data-num="1"><option value="30">30 min</option><option value="60" selected>1 hour</option><option value="360">6 hours</option><option value="1440">1 day</option><option value="4320">3 days</option></select></div></div>
      <div class="row"><label style="display:inline"><input type="checkbox" name="withEq"> count equipment</label><label style="display:inline"><input type="checkbox" name="withSen"> count sentinels</label><label style="display:inline"><input type="checkbox" name="withAnc"> count ancestral skills</label></div>
      <p class="muted">Full events start automatically at ~${catalog.arenaStartHourUtc}:00 UTC. Stats are frozen at registration. The winner takes the fee pool (tournaments: 70% winner, 30% finalist). Everyone earns points, more for upsets.</p>
      <button ${st.current || me.level < catalog.arenaMinLevel ? 'disabled' : ''}>Create &amp; register</button></form></div>
    <div class="card"><h2>Open events</h2>${rows ? `<table><tr><th></th><th>Event</th><th>Skill band</th><th class="r">Fee</th><th class="r">Players</th><th>Status</th><th></th></tr>${rows}</table>` : '<p class="muted">No events yet. Create one!</p>'}</div>`;
}

// ---------- mail ----------
async function pageMail(box, arg) {
  const tabs = `<div class="tabs"><a href="#/mail" class="${!box ? 'on' : ''}">Inbox</a><a href="#/mail/sent" class="${box === 'sent' ? 'on' : ''}">Sent</a><a href="#/mail/new" class="${box === 'new' ? 'on' : ''}">✉ New message</a></div>`;
  if (box === 'new') {
    const to = arg ? decodeURIComponent(arg) : '';
    return `${tabs}<form class="card" data-submit="/mail/send" data-goto="#/mail/sent" data-ok="Message sent" style="max-width:640px"><h2>New message</h2>
      <label>To (player name)</label><input name="to" required value="${esc(to)}" style="width:100%">
      <label>Subject</label><input name="subject" required maxlength="60" style="width:100%">
      <label>Message</label><textarea name="body" rows="8" required maxlength="2000" style="width:100%"></textarea><p><button>Send</button></p></form>`;
  }
  if (box && /^\d+$/.test(box)) {
    const m = await api('/mail/' + box);
    if (m.to_id === me.id && me.unreadMail) { me.unreadMail--; renderHeader('mail'); } // mark-as-read already happened server side
    return `${tabs}<div class="card"><h2>${esc(m.subject)}</h2><p class="muted">From ${m.from_id ? `<a href="#/player/${m.from_id}">${esc(m.from_name)}</a>` : 'System'} to ${esc(m.to_name)} · ${new Date(m.sent_at).toLocaleString()}</p>
      <div style="white-space:pre-wrap">${esc(m.body)}</div>
      <p>${m.from_id && m.from_id !== me.id ? `<a class="btn" href="#/mail/new/${encodeURIComponent(m.from_name)}">Reply</a> ` : ''}
      <button class="sec" data-do="/mail/delete" data-body='{"mailId":${m.id}}' data-ok="Deleted" data-confirm="Delete this message?">Delete</button></p></div>`;
  }
  const sent = box === 'sent';
  const list = await api('/mail' + (sent ? '?box=sent' : ''));
  const rows = list.map((m) => `<tr class="${!sent && !m.read ? 'gold' : ''}"><td>${sent ? esc(m.to_name) : esc(m.from_name)}</td><td><a href="#/mail/${m.id}">${!sent && !m.read ? '● ' : ''}${esc(m.subject)}</a></td><td class="muted">${new Date(m.sent_at).toLocaleString()}</td></tr>`).join('');
  return `${tabs}<div class="card"><h2>${sent ? 'Sent' : 'Inbox'}</h2>${rows ? `<table><tr><th>${sent ? 'To' : 'From'}</th><th>Subject</th><th>Date</th></tr>${rows}</table>` : '<p class="muted">Nothing here.</p>'}</div>`;
}

// ---------- notifications page ----------
async function pageNotifications() {
  const r = await api('/notifications?limit=100');
  notes.unread = r.unread; renderHeader('notifications');
  const supported = typeof Notification !== 'undefined';
  return `<div class="card"><div class="row sp"><h2 style="border:0;margin:0">Notifications</h2><button class="sec sm" data-do="/notifications/read" data-body='{"all":true}' data-ok="All marked as read" ${r.unread ? '' : 'disabled'}>Mark all as read</button></div>
    ${r.items.length ? r.items.map(noteHtml).join('') : '<p class="muted">Nothing yet. When something happens to you (a raid, a sale, a war, a level) it is listed here and the bell at the top lights up.</p>'}
    ${supported ? `<hr><label style="display:inline"><input type="checkbox" id="desktop-notes" ${desktopOn() ? 'checked' : ''}> also show desktop notifications while this tab is in the background</label><p class="muted">Your browser asks for permission. The game only asks while it is open in a tab: it cannot reach you when it is closed.</p>` : ''}</div>`;
}
// (the checkbox lives in a page that is drawn again after every action, so one delegated listener at the top level)
document.addEventListener('change', async (e) => {
  if (e.target?.id !== 'desktop-notes') return;
  try {
    if (e.target.checked) { const perm = Notification.permission === 'granted' ? 'granted' : await Notification.requestPermission(); if (perm !== 'granted') { e.target.checked = false; toast('The browser did not allow desktop notifications', true); return; } }
    localStorage.setItem('mg_desktop', e.target.checked ? '1' : '0');
    toast(e.target.checked ? 'Desktop notifications are on' : 'Desktop notifications are off');
  } catch { /* storage or notifications not available */ }
});

// ---------- weekly quests ----------
const CAT_ICON = { hunt: '🏹', work: '⚰', pvp: '⚔', war: '🏰', dungeon: '🕳', arena: '🏟', ancestral: '👻', economy: '💰', progress: '⭐', social: '💬', shrine: '🩸' };
const SPECIAL_ICON = { blood: '🩸', potions: '🧪', loot: '💎' };
async function pageQuests() {
  const q = await api('/quests');
  const left = until(q.endsAt) ?? 'a moment';
  const card = (x) => {
    const pct = Math.round((x.progress / x.target) * 100);
    const rewards = x.claimed ? '' : `<div class="row" style="gap:.3rem">${[['gold', `💰 ${fmt(x.rewards.gold)} gold`], ['xp', `✨ ${fmt(x.rewards.xp)} XP`], ['special', `${SPECIAL_ICON[x.rewards.special.kind]} ${x.rewards.special.label}`]].map(([k, label]) =>
      x.done && !x.locked ? `<button class="sm" data-do="/quests/claim" data-body='${esc(JSON.stringify({ quest: x.id, choice: k }))}' title="Choose this reward">${esc(label)}</button>` : `<span class="pill" title="${x.locked ? 'locked' : 'you choose one when it is done'}">${esc(label)}</span>`).join('')}</div>`;
    return `<div class="card quest ${x.claimed ? 'claimed' : x.done && !x.locked ? 'done' : ''} ${x.locked ? 'locked' : ''}" style="margin:0">
      <div class="row sp"><b>${CAT_ICON[x.category] ?? '•'} ${esc(x.title)}</b><span class="pill ${esc(x.tier)}">${esc(x.tier)}</span></div>
      <div>${esc(x.text)}</div>
      ${bar('xp', x.progress, x.target, `${fmt(x.progress)} / ${fmt(x.target)}`)}
      ${x.locked ? `<div class="muted">🔒 Unlocks at level ${x.minLevel}</div>` : x.claimed ? `<div class="good">✔ Reward taken: ${esc({ gold: 'gold', xp: 'XP', special: 'special' }[x.claimed])}</div>` : x.done ? '<div class="gold"><b>Done! Choose your reward:</b></div>' : '<div class="muted">Your reward (choose one when done):</div>'}
      ${rewards}</div>`;
  };
  return `<div class="card"><div class="row sp"><h2 style="border:0;margin:0">Weekly quests</h2><span class="muted">${q.claimed} of ${q.quests.length} rewards taken · new quests in <b>${esc(left)}</b></span></div>
    <p class="muted">The same ten quests for everybody this week, new ones every Monday. You can plan: nothing is daily. Every finished quest lets you choose <b>one</b> of three rewards, and they grow with your level. What you do not claim before Monday is gone. Progress counts from Monday on, whatever you did before.</p></div>
    <div class="grid">${q.quests.map(card).join('')}</div>`;
}

// ---------- skill board ----------
let skillBoard = null, skillState = null, skillSelected = null, skillView = null;
const KIND_R = { small: 9, notable: 15, keystone: 23, origin: 19, hub: 8, bridge: 9 };
const KIND_NAME = { small: 'Minor node', notable: 'Notable', keystone: 'Keystone', origin: 'Start node (class)', hub: 'Hub', bridge: 'Bridge' };
const SVGNS = 'http://www.w3.org/2000/svg';
const svgEl = (tag, attrs = {}, parent) => { const e = document.createElementNS(SVGNS, tag); for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v); if (parent) parent.appendChild(e); return e; };

async function pageSkills() {
  const [board, st] = await Promise.all([skillBoard ?? api('/skills/board'), api('/skills')]);
  skillBoard = board; skillState = st;
  const regionColor = (key) => board.regions.find((r) => r.key === key)?.color ?? '#8a7a8a';
  return `<div class="grid"><div class="card"><h2>Skill board</h2>
      <p><span class="${st.free ? 'gold' : ''}" style="font-size:1.3rem"><b>${st.free}</b></span> <span class="muted">of ${st.total} points to spend</span>${st.title ? ` · <b>${esc(st.title)}</b>` : ' · <span class="muted">no class yet: your first point goes on a start node</span>'}</p>
      <p class="muted">You get 1 point per level. <b>Double-click</b> a node to learn it (hover to read what it does). Start nodes and small nodes cost 1 point, <b>notables 2</b>, <b>keystones 3</b>. Pick a start node (your class) first, then take nodes that touch the ones you have. The keystone at the end of each region is a huge bonus with a drawback; the arcs between regions lead into neighbouring regions.</p>
      <div class="row"><button class="sec sm" data-skill-zoom="1.3">＋</button><button class="sec sm" data-skill-zoom="0.77">－</button><button class="sec sm" data-skill-zoom="0">fit</button>
        <button class="sec sm" data-do="/skills/respec" data-confirm="Reset the whole board for ${fmt(st.respecCost)} gold? All points come back." ${st.used ? '' : 'disabled'}>Reset board (${fmt(st.respecCost)}g)</button></div>
      <p class="muted" style="margin-top:.6rem">${board.regions.map((r) => `<a data-skill-goto="${esc(r.key)}.start" style="color:${r.color}">${img('skills/region_' + r.key, 'nav-ico') || '● '}${esc(r.name)}</a>`).join(' &nbsp; ')}</p></div>
    <div class="card"><h3>Your bonuses</h3>${st.summary.length ? `<ul style="margin:.2rem 0;padding-left:1.1rem">${st.summary.map((t) => `<li class="${t.startsWith('-') ? 'bad' : 'good'}">${esc(t)}</li>`).join('')}</ul>` : '<p class="muted">Nothing yet.</p>'}</div></div>
    <div class="card" style="padding:.4rem"><div id="skill-box" data-skill-board style="position:relative"><svg id="skill-svg" style="width:100%;height:70vh;min-height:420px;touch-action:none;cursor:grab;background:#0b070b ${A('skills/board_bg') ? `url('${A('skills/board_bg')}') center / cover` : ''};border-radius:6px" role="img" aria-label="skill board"></svg>
      <div id="skill-panel" class="card" style="position:absolute;left:.6rem;bottom:.6rem;max-width:340px;margin:0;display:none"></div>
      <div id="skill-tip" class="card" style="position:absolute;display:none;max-width:280px;margin:0;pointer-events:none;z-index:5;background:#120d12f2;padding:.5rem .7rem"></div></div></div>`;
}

function initSkillBoard(box) {
  const board = skillBoard, st = skillState, svg = box.querySelector('#skill-svg');
  const byId = new Map(board.nodes.map((n) => [n.id, n]));
  const taken = new Set(st.allocated), avail = new Set(st.available), reach = new Set(st.reachable);
  let drag = null, moved = false;
  const R = 700;
  let view = skillView; // start where the build is (or at the centre)
  if (!view) { const last = st.allocated.length ? byId.get(st.allocated[st.allocated.length - 1]) : null; view = last ? { x: last.x * 0.7, y: last.y * 0.7, k: 1.5 } : { x: 0, y: 0, k: 1 }; }
  const apply = () => { const w = (2 * R) / view.k; svg.setAttribute('viewBox', `${view.x - w / 2} ${view.y - w / 2} ${w} ${w}`); skillView = view; };
  apply();
  const colorOf = (n) => board.regions.find((r) => n.region === r.key)?.color ?? '#9a8a9a';
  // links first (so the nodes sit on top)
  const drawn = new Set();
  for (const n of board.nodes) for (const l of n.links) {
    const key = [n.id, l].sort().join('|'); if (drawn.has(key)) continue; drawn.add(key);
    const m = byId.get(l), on = taken.has(n.id) && taken.has(l);
    svgEl('line', { x1: n.x, y1: n.y, x2: m.x, y2: m.y, stroke: on ? colorOf(n) : '#3a2a3a', 'stroke-width': on ? 5 : 3, 'stroke-linecap': 'round' }, svg);
  }
  const panel = box.querySelector('#skill-panel'), tip = box.querySelector('#skill-tip');
  const pts = (n) => `${n} point${n === 1 ? '' : 's'}`;
  /** why a node cannot be taken right now (null when it can, or when it is already taken) */
  const status = (n) => taken.has(n.id) ? null : avail.has(n.id) ? null
    : reach.has(n.id) ? `Needs ${pts(n.cost)}, you have ${st.free}.`
    : !st.allocated.length ? 'Pick a start node first: that is your class.' : 'Not connected to your nodes yet.';
  const effects = (n) => `<ul style="margin:.25rem 0;padding-left:1.1rem">${n.text.map((t) => `<li class="${t.startsWith('-') ? 'bad' : 'good'}">${esc(t)}</li>`).join('')}</ul>`;
  const showPanel = () => {
    const n = skillSelected && byId.get(skillSelected);
    if (!n) { panel.style.display = 'none'; return; }
    const have = taken.has(n.id), can = avail.has(n.id);
    panel.style.display = 'block';
    panel.innerHTML = `<b style="color:${colorOf(n)}">${esc(n.name)}</b> <span class="pill">${esc(KIND_NAME[n.kind])} · ${pts(n.cost)}</span>${effects(n)}
      ${have ? `<button class="sec sm" data-do="/skills/refund" data-body='${esc(JSON.stringify({ node: n.id }))}'>Take back (${fmt(st.refundCost)}g)</button> <span class="muted">${n.kind === 'origin' ? 'your class' : ''}</span>`
        : can ? `<button class="sm" data-do="/skills/allocate" data-body='${esc(JSON.stringify({ node: n.id }))}'>Take (${pts(n.cost)})</button> <span class="muted">or double-click the node</span>`
        : `<span class="muted">${esc(status(n))}</span>`}`;
    // (the panel changes without the page being redrawn, so its buttons are wired here; assigning onclick never doubles a handler)
    panel.querySelectorAll('[data-do]').forEach((el) => { el.onclick = () => act(el.dataset.do, JSON.parse(el.dataset.body)); });
  };
  // the tooltip that follows the mouse
  const showTip = (e, n) => {
    const have = taken.has(n.id), can = avail.has(n.id);
    tip.innerHTML = `<b style="color:${colorOf(n)}">${esc(n.name)}</b> <span class="pill">${esc(KIND_NAME[n.kind])} · ${pts(n.cost)}</span>${effects(n)}
      <div class="${have ? 'good' : can ? 'gold' : 'muted'}" style="font-size:.85rem">${have ? '✔ Learned' : can ? 'Double-click to learn' : esc(status(n))}</div>`;
    tip.style.display = 'block';
    const r = box.getBoundingClientRect(), w = tip.offsetWidth || 240, h = tip.offsetHeight || 100;
    tip.style.left = `${Math.max(4, Math.min(e.clientX - r.left + 16, r.width - w - 4))}px`;
    tip.style.top = `${Math.max(4, Math.min(e.clientY - r.top + 16, r.height - h - 4))}px`;
  };
  const hideTip = () => { tip.style.display = 'none'; };
  let selRing = null;
  const select = (n) => { skillSelected = n.id; selRing?.remove(); selRing = svgEl('circle', { cx: n.x, cy: n.y, r: (KIND_R[n.kind] ?? 9) + 11, fill: 'none', stroke: '#fff', 'stroke-width': 2, 'pointer-events': 'none' }, svg); showPanel(); };
  for (const n of board.nodes) {
    const have = taken.has(n.id), can = avail.has(n.id), r = KIND_R[n.kind] ?? 9;
    const g = svgEl('g', { 'data-node': n.id, style: 'cursor:pointer' }, svg);
    if (can) svgEl('circle', { cx: n.x, cy: n.y, r: r + 7, fill: 'none', stroke: '#e6c04a', 'stroke-width': 3, opacity: 0.8 }, g);
    svgEl('circle', { cx: n.x, cy: n.y, r, fill: have ? colorOf(n) : '#1c141c', stroke: have || can ? colorOf(n) : reach.has(n.id) ? '#8a6a3a' : '#4a3a4a', 'stroke-width': n.kind === 'keystone' ? 5 : 3 }, g);
    if (n.kind === 'keystone' || n.kind === 'origin') svgEl('circle', { cx: n.x, cy: n.y, r: r - 7, fill: 'none', stroke: have ? '#fff' : colorOf(n), 'stroke-width': 2, opacity: 0.7 }, g);
    if (n.kind === 'notable') svgEl('circle', { cx: n.x, cy: n.y, r: r - 6, fill: have ? '#fff' : 'none', stroke: colorOf(n), 'stroke-width': 2, opacity: 0.6 }, g);
    g.addEventListener('mouseenter', (e) => { if (!drag) showTip(e, n); });
    g.addEventListener('mousemove', (e) => { if (!drag) showTip(e, n); });
    g.addEventListener('mouseleave', hideTip);
    g.addEventListener('click', (e) => { if (moved) return; e.stopPropagation(); select(n); }); // (selecting does not redraw the board: a double click must reach the same node)
    g.addEventListener('dblclick', (e) => {
      e.stopPropagation(); hideTip();
      if (taken.has(n.id)) return toast('You already have this node. Use "Take back" in the panel to remove it.', true);
      if (!avail.has(n.id)) return toast(status(n), true);
      act('/skills/allocate', { node: n.id });
    });
  }
  const sel = skillSelected && byId.get(skillSelected);
  if (sel) select(sel); else showPanel();
  // pan with the pointer, zoom with the wheel and the buttons
  svg.addEventListener('pointerdown', (e) => { drag = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y }; moved = false; svg.style.cursor = 'grabbing'; });
  svg.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y; if (Math.abs(dx) + Math.abs(dy) > 4) moved = true;
    const scale = (2 * R) / view.k / svg.getBoundingClientRect().width;
    view = { ...view, x: drag.vx - dx * scale, y: drag.vy - dy * scale }; apply();
  });
  const endDrag = () => { drag = null; svg.style.cursor = 'grab'; setTimeout(() => { moved = false; }, 0); };
  svg.addEventListener('pointerup', endDrag); svg.addEventListener('pointerleave', endDrag);
  const zoom = (f) => { view = f === 0 ? { x: 0, y: 0, k: 1 } : { ...view, k: Math.min(6, Math.max(0.6, view.k * f)) }; apply(); };
  svg.addEventListener('wheel', (e) => { e.preventDefault(); zoom(e.deltaY < 0 ? 1.15 : 0.87); }, { passive: false });
  box.closest('#view').querySelectorAll('[data-skill-zoom]').forEach((b) => { b.onclick = () => zoom(Number(b.dataset.skillZoom)); });
  box.closest('#view').querySelectorAll('[data-skill-goto]').forEach((a) => { a.onclick = () => { const n = byId.get(a.dataset.skillGoto); if (n) { view = { x: n.x * 0.6, y: n.y * 0.6, k: 1.8 }; apply(); } }; });
}

// ---------- admin: rates, cooldowns, players, wipe ----------
let adminQ = '';
const ADMIN_TABS = [['world', 'World'], ['settings', 'Settings'], ['players', 'Players'], ['log', 'Log']];
const adminNum = (v) => fmt(Math.round(Number(v)));
const when = (ts) => new Date(ts).toLocaleString();
/** one "save this number" row: a hidden key plus a number box, handled by the generic form[data-submit] code */
const settingForm = (s) => `<form class="row" data-submit="/admin/setting" data-ok="Saved" style="gap:.3rem"><input type="hidden" name="key" value="${esc(s.key)}">
  <input name="value" type="number" step="${s.int ? 1 : 'any'}" min="${s.min}" max="${s.max}" value="${s.value}" style="width:7rem" aria-label="${esc(s.label)}"> <span class="muted">${esc(s.unit)}</span>
  <button class="sm">Save</button>${s.changed ? `<button type="button" class="sm sec" data-do="/admin/setting/reset" data-body="${esc(JSON.stringify({ key: s.key }))}" data-ok="Back to the default">reset (${s.default})</button>` : ''}</form>`;

async function pageAdmin(tab = 'world', arg2, arg3) {
  if (!me.isAdmin) return '<div class="card bad">Administrators only.</div>';
  const tabs = `<div class="tabs">${ADMIN_TABS.map(([k, n]) => `<a href="#/admin/${k}" class="${k === tab ? 'on' : ''}">${n}</a>`).join('')}</div>`;
  if (tab === 'player') return pageAdminPlayer(Number(arg2));
  const v = await api('/admin');
  if (tab === 'settings') {
    const groups = [...new Set(v.settings.map((s) => s.group))];
    return `<h2>Admin</h2>${tabs}<p class="muted">Changes are active immediately, for everybody, and stay after a restart. Durations are shown in minutes or hours. "reset" puts one number back to the default.</p>
      ${groups.map((g) => `<div class="card"><h3>${esc(g)}</h3><table>${v.settings.filter((s) => s.group === g).map((s) =>
        `<tr><td>${esc(s.label)}${s.help ? `<div class="muted" style="font-size:.8rem">${esc(s.help)}</div>` : ''}</td><td class="r">${settingForm(s)}</td></tr>`).join('')}</table></div>`).join('')}
      <div class="card"><button class="sec" data-do="/admin/settings/reset" data-confirm="Put ALL settings back to the defaults?">Reset every setting to the default</button></div>`;
  }
  if (tab === 'players') {
    const who = ['all', 'humans', 'bots', 'admins'].includes(arg2) ? arg2 : 'humans', page = Math.max(1, Number(arg3) || 1);
    const r = await api(`/admin/players?who=${who}&page=${page}&q=${encodeURIComponent(adminQ)}`);
    return `<h2>Admin</h2>${tabs}
      <form class="row card" data-admin-search data-who="${who}"><select name="who">${['humans', 'bots', 'admins', 'all'].map((w) => `<option ${w === who ? 'selected' : ''}>${w}</option>`).join('')}</select>
        <input name="q" value="${esc(adminQ)}" placeholder="name contains…" maxlength="40"><button>Search</button><span class="muted">${fmt(r.total)} found</span></form>
      <div class="card"><table><tr><th>Name</th><th>Race</th><th class="r">Level</th><th class="r">Gold</th><th class="r">HP</th><th></th></tr>
      ${r.rows.map((p) => `<tr><td><a href="#/admin/player/${p.id}">${esc(p.name)}</a> ${p.is_admin ? '<span class="pill gold">admin</span>' : ''}${p.is_bot ? ' <span class="pill">bot</span>' : ''}${p.busy ? ' <span class="pill">busy</span>' : ''}</td>
        <td>${raceName(p.race)}</td><td class="r">${p.level}</td><td class="r gold">${adminNum(p.gold)}</td><td class="r">${p.hp < 0 ? 0 : Math.floor(p.hp)}/${p.max_hp}</td><td class="r"><a href="#/admin/player/${p.id}">edit</a></td></tr>`).join('')}</table>
      <div class="pager">${page > 1 ? `<a href="#/admin/players/${who}/${page - 1}">‹ prev</a>` : ''}<span>page ${r.page} / ${r.pages}</span>${page < r.pages ? `<a href="#/admin/players/${who}/${page + 1}">next ›</a>` : ''}</div></div>`;
  }
  if (tab === 'log') {
    return `<h2>Admin</h2>${tabs}<div class="card"><h3>What admins did</h3>${v.world.log.length ? `<table>${v.world.log.map((l) =>
      `<tr><td class="muted">${esc(when(l.at))}</td><td>${esc(l.admin_name)}</td><td>${esc(l.action)}</td><td>${esc(l.detail)}</td></tr>`).join('')}</table>` : '<p class="muted">Nothing yet.</p>'}</div>`;
  }
  // world
  const w = v.world, rate = (k) => v.settings.find((s) => s.key === k);
  return `<h2>Admin</h2>${tabs}
    <div class="grid">
      <div class="card"><h3>World</h3>
        <p>Started <b>${esc(when(w.worldStartedAt))}</b> · wiped ${w.wipes}×</p>
        <p>${fmt(w.humans)} players · ${fmt(w.bots)} bots · ${fmt(w.admins)} admin${w.admins === 1 ? '' : 's'} · ${fmt(w.clans)} clans · ${fmt(w.battles)} battles</p>
        <p class="muted">Highest level ${w.topLevel} · ${adminNum(w.totalGold)} gold in circulation</p>
        <p class="muted">${v.singlePlayer ? 'Single player: you are always the admin.' : 'Multiplayer: admins are set by hand on the server: <code>node scripts/admin.ts &lt;database&gt; grant &lt;name&gt;</code>'}</p></div>
      <div class="card"><h3>Rates</h3><p class="muted">1 = normal. For a speed server use the preset below or type your own numbers.</p>
        <table>${['rateXp', 'rateGold', 'rateLevelXp'].map((k) => `<tr><td>${esc(rate(k).label)}</td><td class="r">${settingForm(rate(k))}</td></tr>`).join('')}</table>
        <p class="muted">More numbers (every cooldown, combat, economy …) are on the <a href="#/admin/settings">Settings</a> tab.</p></div>
    </div>
    <div class="card"><h3>Presets</h3><p class="muted">A preset replaces all current settings.</p>
      ${v.presets.map((p) => `<div class="row sp" style="margin:.4rem 0"><span><b>${esc(p.label)}</b><br><span class="muted">${esc(p.description)}</span></span>
        <button class="sec" data-do="/admin/preset" data-body="${esc(JSON.stringify({ name: p.key }))}" data-confirm="Apply the preset “${esc(p.label)}”? Your current settings are replaced." data-ok="Preset applied">Apply</button></div>`).join('')}</div>
    <form class="card" data-submit="/admin/announce" data-ok="Sent"><h3>Announcement</h3><p class="muted">Sends a mail from “System” to every player.</p>
      <label>Subject</label><input name="subject" maxlength="100" required style="width:100%"><label>Message</label><textarea name="body" maxlength="2000" required rows="3" style="width:100%"></textarea><p><button>Send to everyone</button></p></form>
    <form class="card" data-submit="/admin/wipe" data-ok="The world was wiped" data-confirm="This deletes the world. There is no undo. Continue?" style="border-color:var(--bad)"><h3 class="bad">Wipe the world</h3>
      <p class="muted">Deletes clans, wars, battles, market, mail, forum, arena, dungeon and all bots, and resets every character to level 1. Your settings and the log stay. Take a backup first (Game page / server backup).</p>
      <label>What to keep</label><select name="mode"><option value="progress">Keep all accounts (names and passwords), reset their characters</option><option value="everything">Keep only admin accounts (everybody else registers again)</option></select>
      <label>Type WIPE to confirm</label><input name="confirm" autocomplete="off" placeholder="WIPE" style="width:8rem">
      ${v.singlePlayer ? '' : '<label>Your password</label><input name="password" type="password" autocomplete="current-password">'}
      <p><button class="bad">Wipe now</button></p></form>`;
}

async function pageAdminPlayer(id) {
  const p = await api(`/admin/player/${id}`);
  const tabs = `<div class="tabs">${ADMIN_TABS.map(([k, n]) => `<a href="#/admin/${k}" class="${k === 'players' ? 'on' : ''}">${n}</a>`).join('')}</div>`;
  const field = (name, label) => `<form class="row" data-submit="/admin/player" data-ok="Saved" style="gap:.3rem;margin:.2rem 0"><input type="hidden" name="id" value="${p.id}" data-num="1"><input type="hidden" name="field" value="${name}">
    <label style="min-width:9rem;margin:0">${label}</label><input name="value" type="number" step="1" value="${Math.floor(p[name])}" style="width:9rem"><button class="sm">Save</button></form>`;
  const items = (catalog?.items ?? []).map((i) => `<option value="${esc(i.key)}">${esc(i.name)} (${esc(i.slot)})</option>`).join('');
  const pw = !window.MG_LOCAL ? '<label>Your (admin) password</label><input name="password" type="password" autocomplete="current-password">' : '';
  return `<h2>Admin</h2>${tabs}<h3>${esc(p.name)} ${raceName(p.race)} ${p.is_admin ? '<span class="pill gold">admin</span>' : ''}${p.is_bot ? ' <span class="pill">bot</span>' : ''}</h3>
    <div class="grid"><div class="card"><h3>Character</h3>
      ${[['level', 'Level (resets XP and health)'], ['xp', 'XP'], ['gold', 'Gold'], ['str', 'Strength'], ['def', 'Defence'], ['agi', 'Agility'], ['sta', 'Stamina'], ['dex', 'Dexterity'], ['max_hp', 'Max health'], ['hp', 'Health'], ['vitality_hp', 'Health from potions'], ['wins', 'Wins'], ['losses', 'Losses']].map(([k, l]) => field(k, l)).join('')}</div>
    <div class="card"><h3>Actions</h3>
      <p><button data-do="/admin/player/release" data-body="${esc(JSON.stringify({ id: p.id }))}" data-ok="Released">Release (end hunt / work / dungeon, clear all cooldowns)</button></p>
      <form data-submit="/admin/player/give" data-ok="Item added"><input type="hidden" name="id" value="${p.id}" data-num="1"><label>Give an item</label><select name="key">${items}</select> <button class="sm">Give</button></form>
      ${p.is_bot || window.MG_LOCAL ? '' : `<form data-submit="/admin/player" data-ok="Saved"><input type="hidden" name="id" value="${p.id}" data-num="1"><input type="hidden" name="field" value="is_admin"><input type="hidden" name="value" value="${p.is_admin ? 0 : 1}" data-num="1">
        ${pw}<p><button class="sec">${p.is_admin ? 'Remove admin rights' : 'Make admin'}</button></p></form>
      <form data-submit="/admin/player/password" data-ok="Password changed, the player was logged out"><input type="hidden" name="id" value="${p.id}" data-num="1"><label>New password for this player</label><input name="newPassword" type="password" autocomplete="new-password" minlength="${catalog?.passwordMin ?? 8}">${pw}<p><button class="sec">Set password</button></p></form>`}
      <form data-submit="/admin/player/delete" data-ok="Deleted" data-goto="#/admin/players" data-confirm="Delete ${esc(p.name)} and everything they own? There is no undo."><input type="hidden" name="id" value="${p.id}" data-num="1">${pw}<p><button class="bad">Delete this player</button></p></form></div>
    <div class="card"><h3>Inventory</h3>${p.inventory.length ? `<ul>${p.inventory.map((i) => `<li>${esc((catalog?.items ?? []).find((x) => x.key === i.item_key)?.name ?? i.item_key)}${i.hardening ? ` +${i.hardening}` : ''}</li>`).join('')}</ul>` : '<p class="muted">Empty.</p>'}</div></div>`;
}

// ---------- local (browser-only) mode: saves and settings ----------
const storageWarning = () => { const n = window.MG_LOCAL_API?.info().storageNote; return n ? `<div class="card bad"><b>⚠ Progress is not being saved.</b> ${esc(n)}</div>` : ''; };

async function pageSettings() {
  const L = window.MG_LOCAL_API;
  if (!L) return '<div class="card"><h2>Game</h2><p class="muted">This page belongs to the browser-only version of the game.</p></div>';
  const info = L.info(), st = L.settings();
  let usage = '', persisted = false;
  try { const e = await navigator.storage.estimate(); persisted = await navigator.storage.persisted(); usage = `${(e.usage / 1048576).toFixed(1)} MB used of ${Math.round(e.quota / 1048576).toLocaleString('en-US')} MB available`; } catch { /* not supported */ }
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

async function localAction(kind, el) {
  const L = window.MG_LOCAL_API;
  try {
    if (kind === 'export') {
      const bytes = await L.exportSave();
      const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(new Blob([bytes], { type: 'application/vnd.sqlite3' })), download: `monstersgame-${new Date().toISOString().slice(0, 10)}.db` });
      a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 5000); toast('Save exported');
    } else if (kind === 'persist') {
      toast((await navigator.storage.persist()) ? 'The browser will keep your save' : 'The browser did not agree (it may still keep it)', false); render();
    } else if (kind === 'reset') {
      if (prompt('This deletes your character and the whole world permanently.\nType DELETE to confirm.') !== 'DELETE') return;
      await L.resetGame(); localStorage.removeItem('mg_token'); location.hash = '#/'; location.reload();
    } else if (kind === 'import') {
      const file = el.files[0]; if (!file) return;
      if (!confirm(`Replace your current game with "${file.name}"? The current game will be lost (export it first if you want to keep it).`)) { el.value = ''; return; }
      await L.importSave(new Uint8Array(await file.arrayBuffer())); localStorage.removeItem('mg_token'); location.hash = '#/'; location.reload();
    }
  } catch (e) { toast(e.message, true); }
}

// ---------- dev panel ----------
function renderDev() {
  const el = $('#dev');
  if (!devEnabled || !me) return void (el.innerHTML = '');
  if (el.dataset.built === '1') return;
  el.dataset.built = '1';
  el.innerHTML = `<details><summary>🛠 Test tools</summary>
    <div class="row"><input id="dg" type="number" placeholder="gold" value="1000"><button class="sm" data-dev="grant" data-f="dg:gold">+gold</button></div>
    <div class="row"><button class="sm" data-dev="blood">Fill blood tank</button></div>
    <div class="row"><input id="dl" type="number" placeholder="level" value="20"><button class="sm" data-dev="level" data-f="dl:level">Set level</button></div>
    <div class="row"><button class="sm" data-dev="heal">Full heal</button><button class="sm" data-dev="bots" data-f="dn:count">+bots</button><input id="dn" type="number" value="10"></div>
    <div class="row"><button class="sm" data-dev="arena-fill">Fill my arena event</button><button class="sm" data-dev="market">Seed market</button></div>
    <div class="row"><button class="sm" data-dev="applicants">Clan applicants</button><button class="sm" data-dev="mail">Get mail</button></div>
    <div class="row"><span class="muted">Automatic bots:</span></div>
    <div class="row"><button class="sm" data-dev="bots-report">Bot report</button><button class="sm" data-dev="bots-act">Bots act now</button><button class="sm" data-dev="bots-add">+10 bots</button></div>
    <div class="row"><input id="ds" type="number" value="200" style="width:5rem"><button class="sm" data-dev="stats" data-f="ds:value">Set all attributes</button></div>
    <div class="row"><span class="muted">Dungeon:</span><button class="sm" data-dev="dungeon" data-body='{"clearCooldown":true}'>Reset cooldown</button>
      <button class="sm" data-dev="dungeon" data-body='{"depth":9,"clearCooldown":true,"leave":true}'>Depth 9</button><button class="sm" data-dev="dungeon" data-body='{"depth":30,"clearCooldown":true,"leave":true}'>Depth 30</button></div>
    <div class="row"><span class="muted">Clan wars:</span></div>
    <div class="row"><button class="sm" data-dev="fill-clan">Fill my clan (5)</button><button class="sm" data-dev="enemy-clan">Enemy bot clan</button></div>
    <div class="row"><button class="sm" data-dev="enemy-declare">Enemy declares war</button><button class="sm" data-dev="heal-bots">Heal bots</button></div>
    <div class="row"><button class="sm" data-dev="enemy-negotiate" data-a="peace">Enemy: peace</button><button class="sm" data-dev="enemy-negotiate" data-a="ceasefire">Enemy: ceasefire</button><button class="sm" data-dev="enemy-negotiate" data-a="capitulate">Enemy: surrender</button></div>
    <div class="row"><span class="muted">Skip time:</span>
      ${[10, 60, 720, 1440].map((m) => `<button class="sm" data-dev="skip" data-m="${m}">${m >= 60 ? m / 60 + 'h' : m + 'm'}</button>`).join('')}</div></details>`;
  el.querySelectorAll('[data-dev]').forEach((b) => (b.onclick = async () => {
    const body = {};
    if (b.dataset.f) { const [id, key] = b.dataset.f.split(':'); body[key] = Number(el.querySelector('#' + id).value); }
    if (b.dataset.m) body.minutes = Number(b.dataset.m);
    if (b.dataset.a) body.action = b.dataset.a;
    if (b.dataset.body) Object.assign(body, JSON.parse(b.dataset.body));
    try { const r = await api('/dev/' + b.dataset.dev, body); toast(r.message ? r.message : r.created ? `Added ${r.created.length} bots` : r.added ? `Added ${r.added} arena bots` : 'Done'); await refresh(); }
    catch (e) { toast(e.message, true); }
  }));
}

// ---------- boot ----------
(async () => {
  catalog = await api('/catalog');
  assets = API_BASE ? await fetch('assets.json').then((r) => (r.ok ? r.json() : {}), () => ({})) : await api('/assets').catch(() => ({}));
  applyTheme();
  devEnabled = await api('/dev').then(() => true, () => false);
  if (LOCAL) devEnabled = devEnabled && localStorage.getItem('mg_dev') === '1'; // test tools are opt-in on the public site
  if (token) await refresh().catch(() => logout(true)); else render();
  setInterval(tickCd, 1000);
})().catch((e) => console.error('boot failed', e)); // (local-boot.js already shows the reason on screen)
