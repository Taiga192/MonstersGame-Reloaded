// Hash routing, page rendering, header and the delegated click/form handlers.
import { act, logout, refresh, toast } from './api.js';
import { A, img } from './art.js';
import { notes, renderAlerts, toggleDrop } from './notifications.js';
import { pageAcc } from './pages/achievements.js';
import { pageAdmin, setAdminQ } from './pages/admin.js';
import { pageArena } from './pages/arena.js';
import { pageClan } from './pages/clan.js';
import { renderDev } from './pages/dev.js';
import { pageDungeon } from './pages/dungeon.js';
import { pageHighscore, pageMessages, pageProfile } from './pages/highscore.js';
import { pageHunt } from './pages/hunt.js';
import { pageNotifications } from './pages/inbox.js';
import { pageBite, pageLogin } from './pages/login.js';
import { pageMail } from './pages/mail.js';
import { pageOverview } from './pages/overview.js';
import { pageQuests } from './pages/quests.js';
import { pageRaid } from './pages/raid.js';
import { localAction, pageSettings, storageWarning } from './pages/settings.js';
import { pageShrine } from './pages/shrine.js';
import { initSkillBoard, pageSkills } from './pages/skills.js';
import { pageAncestral, pageHideout, pageTown } from './pages/town.js';
import { me, now, token } from './state.js';
import { $, esc, fmt, raceName, until } from './util.js';

// ---------- routing ----------
export const PAGES = [
  ['overview', 'Overview'],
  ['raid', 'Raid'],
  ['hunt', 'Hunt'],
  ['dungeon', 'Dungeon'],
  ['quests', 'Quests'],
  ['skills', 'Skills'],
  ['shrine', 'Shrine'],
  ['town', 'Town'],
  ['hideout', 'Hideout'],
  ['ancestral', 'Ancestral Site'],
  ['arena', 'Arena'],
  ['acc', 'Achievements'],
  ['clan', 'Clan'],
  ['mail', 'Mail'],
  ['messages', 'Reports'],
  ['highscore', 'Highscore'],
  ...(window.MG_LOCAL ? [['settings', 'Game']] : []),
];

/** the menu; "Admin" only exists for admins (single player: always). The server checks again on every admin request. */
export const pages = () => (me?.isAdmin ? [...PAGES, ['admin', 'Admin']] : PAGES);

/**
 * The parts of the URL after '#/' end up in page templates and API paths. They are reduced to a harmless alphabet at the source
 * (letters, digits, _ . - and % for percent-encoded names); anything else becomes empty, so a crafted link cannot inject markup.
 */
export const safeSegment = (v) => (v === undefined ? undefined : /^[A-Za-z0-9_.\-%]{0,80}$/.test(v) ? v : '');

export function route() {
  const [, page = 'overview', arg, arg2, arg3] = location.hash.split('/').map((v, i) => (i === 0 ? v : safeSegment(v)));
  return { page: page || 'overview', arg, arg2, arg3 };
}

addEventListener('hashchange', render);

export const BANNER_TITLES = {
  login: 'Welcome',
  overview: 'Overview',
  raid: 'Raid',
  hunt: 'Manhunt',
  store: 'Store',
  inventory: 'Inventory',
  temple: 'Blood Temple',
  sentinels: 'Sentinels',
  war: 'War Room',
  dungeon: 'The Dungeon',
  skills: 'Skills',
  shrine: 'The Shrine',
  quests: 'Weekly quests',
  notifications: 'Notifications',
  dealer: 'Relic Dealer',
  graveyard: 'Graveyard',
  hideout: 'Hideout',
  ancestral: 'Ancestral Site',
  arena: 'Arena',
  achievements: 'Achievements',
  clan: 'Clan',
  forum: 'Clan Forum',
  mail: 'Mail',
  reports: 'Battle Reports',
  highscore: 'Highscore',
  profile: 'Profile',
  bite: 'A victim link',
};

export function bannerFor(page, arg) {
  const key =
    page === 'town'
      ? arg || 'store'
      : page === 'clan' && (arg === 'forum' || arg === 'war')
        ? arg
        : ({ acc: 'achievements', messages: 'reports', player: 'profile' }[page] ?? page);
  const src = A(`banners/${key}`);
  return src ? `<div class="banner" style="background-image:url('${src}')"><h1>${esc(BANNER_TITLES[key] ?? '')}</h1></div>` : '';
}

export let renderSeq = 0;

/**
 * Draw the current route. Renders can overlap (a click and a countdown-triggered refresh, or a slow page fetch), so every
 * call gets a number and only the LATEST one may write to the page: an older, slower render must never overwrite newer data.
 */
export async function render() {
  const seq = ++renderSeq;
  const latest = () => seq === renderSeq;
  const { page, arg, arg2, arg3 } = route();
  renderHeader(page);
  const view = $('#view');
  try {
    if (page === 'bite') {
      const h = bannerFor('bite') + (await pageBite(arg));
      if (latest()) view.innerHTML = h;
      return;
    }
    if (page === 'highscore' && !me) {
      const h = await pageHighscore(arg, arg2, arg3);
      if (latest()) view.innerHTML = h;
      return;
    }
    if (!token) return void (view.innerHTML = bannerFor('login') + pageLogin());
    if (!me) return await refresh();
    const fn =
      {
        overview: pageOverview,
        raid: pageRaid,
        hunt: pageHunt,
        town: pageTown,
        hideout: pageHideout,
        ancestral: pageAncestral,
        clan: pageClan,
        messages: pageMessages,
        highscore: pageHighscore,
        dungeon: pageDungeon,
        quests: pageQuests,
        notifications: pageNotifications,
        skills: pageSkills,
        shrine: pageShrine,
        arena: pageArena,
        acc: pageAcc,
        mail: pageMail,
        player: pageProfile,
        settings: pageSettings,
        admin: pageAdmin,
      }[page] ?? pageOverview;
    const html = await fn(arg, arg2, arg3);
    if (!latest() || route().page !== page) return; // superseded by a newer render or navigation
    view.innerHTML = storageWarning() + bannerFor(page, arg) + html;
    bind();
  } catch (e) {
    if (latest()) view.innerHTML = `<div class="card bad">${esc(e.message)}</div>`;
  }
  if (latest()) renderDev();
}

export function renderHeader(page) {
  $('#top').innerHTML =
    `<span class="brand">${A('brand/logo') ? `<img class="logo" src="${A('brand/logo')}" alt="MonstersGame-Reloaded">` : '🦇 MonstersGame-Reloaded'}</span>` +
    (me
      ? `
    <nav>${pages()
      .map(
        ([k, n]) =>
          `<a href="#/${k}" class="${k === page ? 'on' : ''}">${img('nav/' + k, 'nav-ico')}${n}${k === 'mail' && me.unreadMail ? ` <span class="pill gold">${me.unreadMail}</span>` : ''}${k === 'quests' && me.questsReady ? ` <span class="pill gold">${me.questsReady}</span>` : ''}</a>`,
      )
      .join('')}</nav>
    <span class="who"><a id="bell" title="Notifications" role="button" tabindex="0">🔔${notes.unread ? `<span class="badge">${notes.unread > 99 ? '99+' : notes.unread}</span>` : ''}</a> · ${esc(me.name)} · ${raceName(me.race)} · Lv ${me.level} · <span class="gold">${fmt(me.gold)}g</span>
    · <a data-act="logout">Logout</a></span>`
      : '');
  $('#top [data-act=logout]')?.addEventListener('click', () => logout());
  $('#bell')?.addEventListener('click', toggleDrop);
  renderAlerts();
}

// generic delegated click handling: <button data-do="path" data-body='{"a":1}' data-ok="msg">
export function bind() {
  const view = $('#view');
  // (a strict Content Security Policy forbids inline onclick attributes, so behaviours are attached here)
  view.querySelectorAll('input[data-select]').forEach((el) => {
    el.onclick = () => el.select();
  });
  // browser-only mode: save/export/import/reset and world settings
  view.querySelectorAll('[data-local]').forEach((el) => {
    el.onclick = () => localAction(el.dataset.local, el);
  });
  view.querySelectorAll('input[data-local-import]').forEach((el) => {
    el.onchange = () => localAction('import', el);
  });
  view.querySelectorAll('form[data-local-settings]').forEach((f) => {
    f.onsubmit = async (e) => {
      e.preventDefault();
      const d = Object.fromEntries(new FormData(f)),
        was = localStorage.getItem('mg_dev') === '1';
      try {
        await window.MG_LOCAL_API.applySettings({
          bots: Math.max(0, Math.min(300, Number(d.bots) || 0)),
          botsRaidHumans: !!f.elements.botsRaidHumans.checked,
          humanRaidChance: Number(d.humanRaidChance),
        });
        localStorage.setItem('mg_dev', f.elements.dev.checked ? '1' : '0');
        if (was !== f.elements.dev.checked) location.reload();
        else {
          toast('Settings applied');
          render();
        }
      } catch (err) {
        toast(err.message, true);
      }
    };
  });
  view.querySelectorAll('[data-skill-board]').forEach(initSkillBoard);
  // shrine routine editor: the rows become ["hunt:6", "work:4"]
  view.querySelectorAll('form[data-shrine-routine]').forEach((f) => {
    f.onsubmit = (e) => {
      e.preventDefault();
      const steps = [];
      for (let i = 0; f.elements['kind' + i]; i++) {
        const kind = f.elements['kind' + i].value,
          n = Number(f.elements['amount' + i].value);
        if (kind) steps.push(`${kind}:${n}`);
      }
      act('/shrine/routine', { steps }, 'Routine saved');
    };
  });
  // admin player search
  view.querySelectorAll('form[data-admin-search]').forEach((f) => {
    f.onsubmit = (e) => {
      e.preventDefault();
      setAdminQ(f.elements.q.value.trim().slice(0, 40));
      const h = `#/admin/players/${f.elements.who.value}/1`;
      if (location.hash === h) render();
      else location.hash = h;
    };
  });
  // highscore: page size selector and "go to rank #"
  view.querySelectorAll('select[data-hs-size]').forEach((sel) => {
    sel.onchange = () => {
      try {
        localStorage.setItem('mg_hs_size', sel.value);
      } catch {
        /* private mode */
      }
      const [, , t, r] = location.hash.split('/');
      const h = `#/highscore/${t ?? 'level'}/${r ?? 'all'}/1`;
      if (location.hash === h) render();
      else location.hash = h;
    };
  });
  view.querySelectorAll('form[data-hs-jump]').forEach((f) => {
    f.onsubmit = (e) => {
      e.preventDefault();
      const rank = Math.max(1, parseInt(f.querySelector('input').value, 10) || 1);
      location.hash = `${f.dataset.base}/${Math.floor((rank - 1) / Number(f.dataset.hsJump)) + 1}`;
    };
  });
  // <form data-submit="/path" data-goto="#/x/{id}" data-ok="msg">: name=value fields; type=number/data-num -> Number; checkbox -> boolean; name="x[]" -> array of checked values
  view.querySelectorAll('form[data-submit]').forEach((form) => {
    form.onsubmit = async (e) => {
      e.preventDefault();
      const body = {};
      for (const el of form.elements) {
        if (!el.name) continue;
        if (el.name.endsWith('[]')) {
          const k = el.name.slice(0, -2);
          body[k] ??= [];
          if (el.checked) body[k].push(el.value);
          continue;
        }
        if (el.type === 'checkbox') {
          body[el.name] = el.checked;
          continue;
        }
        body[el.name] = el.type === 'number' || el.dataset.num ? Number(el.value) : el.value;
      }
      if (form.dataset.confirm && !confirm(form.dataset.confirm)) return;
      if (typeof body.kind === 'string' && body.kind.startsWith('tournament:')) {
        body.size = Number(body.kind.split(':')[1]);
        body.kind = 'tournament';
      }
      const r = await act(form.dataset.submit, body, form.dataset.ok);
      if (r && form.dataset.goto) location.hash = form.dataset.goto.replace('{id}', r.id);
    };
  });
  view.querySelectorAll('[data-do]').forEach((el) => {
    el.onclick = () => {
      const body = el.dataset.body ? JSON.parse(el.dataset.body) : {};
      // inputs referenced via data-from="#id:field"
      (el.dataset.from || '')
        .split(',')
        .filter(Boolean)
        .forEach((spec) => {
          const [sel, field] = spec.split(':');
          const v = view.querySelector(sel)?.value;
          body[field] = isNaN(v) || v === '' ? v : Number(v);
        });
      if (el.dataset.confirm && !confirm(el.dataset.confirm)) return;
      act(el.dataset.do, body, el.dataset.ok);
    };
  });
}

export const fired = new Set();

export function tickCd() {
  document.querySelectorAll('[data-cd]').forEach((el) => {
    const ts = Number(el.dataset.cd),
      t = until(ts);
    el.textContent = t ?? el.dataset.ready ?? 'ready';
    // when a countdown that changes the page state hits zero, reload state once
    if (t === null && el.dataset.refresh && !fired.has(ts)) {
      fired.add(ts);
      refresh();
    }
  });
  document.querySelectorAll('[data-progress]').forEach((el) => {
    const [from, to] = el.dataset.progress.split(',').map(Number);
    const pct = Math.max(0, Math.min(100, ((now() - from) / (to - from)) * 100));
    el.querySelector('i').style.width = pct + '%';
    el.querySelector('span').textContent = Math.floor(pct) + '%';
  });
}
