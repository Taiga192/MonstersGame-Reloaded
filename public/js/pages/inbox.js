// The "inbox" page.
import { api, toast } from '../api.js';
import { desktopOn, noteHtml, notes } from '../notifications.js';
import { renderHeader } from '../router.js';
import { when } from '../util.js';

// ---------- notifications page ----------
export async function pageNotifications() {
  const r = await api('/notifications?limit=100');
  notes.unread = r.unread;
  renderHeader('notifications');
  const supported = typeof Notification !== 'undefined';
  return `<div class="card"><div class="row sp"><h2 style="border:0;margin:0">Notifications</h2><button class="sec sm" data-do="/notifications/read" data-body='{"all":true}' data-ok="All marked as read" ${r.unread ? '' : 'disabled'}>Mark all as read</button></div>
    ${r.items.length ? r.items.map(noteHtml).join('') : '<p class="muted">Nothing yet. When something happens to you (a raid, a sale, a war, a level) it is listed here and the bell at the top lights up.</p>'}
    ${supported ? `<hr><label style="display:inline"><input type="checkbox" id="desktop-notes" ${desktopOn() ? 'checked' : ''}> also show desktop notifications while this tab is in the background</label><p class="muted">Your browser asks for permission. The game only asks while it is open in a tab: it cannot reach you when it is closed.</p>` : ''}</div>`;
}

// (the checkbox lives in a page that is drawn again after every action, so one delegated listener at the top level)
document.addEventListener('change', async (e) => {
  if (e.target?.id !== 'desktop-notes') return;
  try {
    if (e.target.checked) {
      const perm = Notification.permission === 'granted' ? 'granted' : await Notification.requestPermission();
      if (perm !== 'granted') {
        e.target.checked = false;
        toast('The browser did not allow desktop notifications', true);
        return;
      }
    }
    localStorage.setItem('mg_desktop', e.target.checked ? '1' : '0');
    toast(e.target.checked ? 'Desktop notifications are on' : 'Desktop notifications are off');
  } catch {
    /* storage or notifications not available */
  }
});
