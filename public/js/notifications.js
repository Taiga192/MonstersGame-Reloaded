// Notifications: bell, alert bar, polling.
import { api, toast } from './api.js';
import { renderHeader, route } from './router.js';
import { me, now, setSkew, token } from './state.js';
import { ago, bar, esc, when } from './util.js';

// ---------- notifications: bell, alert bar, polling ----------
export const notes = { unread: 0, cursor: 0, timer: null, open: false };

export const BASE_TITLE = document.title;

export const NOTE_ICON = {
  raid: '⚔',
  level: '⭐',
  mail: '✉',
  market: '💰',
  arena: '🏟',
  clan: '🏰',
  war: '⚔',
  shrine: '🩸',
  quests: '📜',
  announce: '📣',
  system: 'ℹ',
};

/** The bar under the header: what needs you right now (derived by the server from your state) plus unread notifications. */
export function renderAlerts(fresh = []) {
  const bar = document.getElementById('alerts');
  if (!bar) return;
  const alerts = token && me ? (me.alerts ?? []) : [];
  bar.innerHTML =
    (token && me && notes.unread
      ? `<a class="chip warn${fresh.length ? ' fresh' : ''}" id="chip-notes">🔔 ${notes.unread} new notification${notes.unread === 1 ? '' : 's'}</a>`
      : '') + alerts.map((a) => `<a class="chip ${esc(a.tone)}${fresh.includes(a.key) ? ' fresh' : ''}" href="${esc(a.link)}">${esc(a.text)}</a>`).join('');
  bar.querySelector('#chip-notes')?.addEventListener('click', toggleDrop);
  const n = token && me ? notes.unread + alerts.length : 0;
  document.title = n ? `(${n}) ${BASE_TITLE}` : BASE_TITLE;
}

export function closeDrop() {
  notes.open = false;
  const d = document.getElementById('notif-drop');
  if (d) d.hidden = true;
}

export async function toggleDrop() {
  const d = document.getElementById('notif-drop');
  if (!d) return;
  if (notes.open) return closeDrop();
  notes.open = true;
  d.hidden = false;
  try {
    const r = await api('/notifications?limit=12');
    notes.unread = r.unread;
    d.innerHTML =
      (r.items.length
        ? r.items.map((n) => noteHtml(n)).join('')
        : '<p class="muted" style="padding:.5rem">Nothing yet. When something happens to you (a raid, a sale, a war ...) it shows up here.</p>') +
      `<div class="row sp" style="padding:.4rem .6rem"><a href="#/notifications">All notifications</a><button class="sm sec" id="note-all">Mark all as read</button></div>`;
    d.querySelectorAll('a.note').forEach((a) =>
      a.addEventListener('click', () => {
        markNote(Number(a.dataset.id));
        closeDrop();
      }),
    );
    d.querySelector('#note-all').onclick = async () => {
      await api('/notifications/read', { all: true });
      notes.unread = 0;
      renderHeader(route().page);
      closeDrop();
    };
    renderHeader(route().page);
  } catch (e) {
    d.innerHTML = `<p class="bad" style="padding:.5rem">${esc(e.message)}</p>`;
  }
}

export const noteHtml = (n) =>
  `<a class="note${n.read ? '' : ' unread'}" data-id="${n.id}" href="${esc(n.link || '#/notifications')}"><b>${NOTE_ICON[n.kind] ?? '•'} ${esc(n.title)}</b><span class="muted">${esc(n.body)}${n.body ? ' · ' : ''}${ago(n.at)}</span></a>`;

export async function markNote(id) {
  try {
    await api('/notifications/read', { ids: [id] });
    notes.unread = Math.max(0, notes.unread - 1);
    renderHeader(route().page);
  } catch {
    /* the page still works */
  }
}

document.addEventListener('click', (e) => {
  if (notes.open && !e.target.closest('#notif-drop, #bell, #chip-notes')) closeDrop();
});

export const desktopOn = () => {
  try {
    return localStorage.getItem('mg_desktop') === '1' && typeof Notification !== 'undefined' && Notification.permission === 'granted';
  } catch {
    return false;
  }
};

/** Ask the server what is new. New events pop up as toasts (and as desktop notifications when you allowed them and the tab is hidden). */
export async function poll() {
  if (!token || !me || (document.hidden && !desktopOn())) return;
  try {
    const r = await api(`/notifications/poll?after=${notes.cursor}`);
    setSkew(r.serverNow - Date.now());
    const before = new Set((me.alerts ?? []).map((a) => a.key));
    me.alerts = r.alerts;
    notes.unread = r.unread;
    const fresh = r.alerts.map((a) => a.key).filter((k) => !before.has(k));
    for (const n of r.items) {
      notes.cursor = Math.max(notes.cursor, n.id);
      toast(`${NOTE_ICON[n.kind] ?? '•'} ${n.title}`);
      if (document.hidden && desktopOn()) {
        try {
          new Notification(n.title, { body: n.body });
        } catch {
          /* not allowed here */
        }
      }
    }
    renderHeader(route().page);
    renderAlerts(fresh);
    if (r.items.length) {
      const bell = document.getElementById('bell');
      bell?.classList.remove('ring');
      void bell?.offsetWidth;
      bell?.classList.add('ring');
    }
  } catch {
    /* offline for a moment: the next poll tries again */
  }
}

export function startPolling() {
  if (!notes.timer) notes.timer = setInterval(poll, 20_000);
}

export function stopPolling() {
  clearInterval(notes.timer);
  notes.timer = null;
}

document.addEventListener('visibilitychange', () => {
  if (!document.hidden) poll();
});
