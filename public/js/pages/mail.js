// The "mail" page.
import { api } from '../api.js';
import { renderHeader } from '../router.js';
import { me } from '../state.js';
import { esc } from '../util.js';

// ---------- mail ----------
export async function pageMail(box, arg) {
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
    if (m.to_id === me.id && me.unreadMail) {
      me.unreadMail--;
      renderHeader('mail');
    } // mark-as-read already happened server side
    return `${tabs}<div class="card"><h2>${esc(m.subject)}</h2><p class="muted">From ${m.from_id ? `<a href="#/player/${m.from_id}">${esc(m.from_name)}</a>` : 'System'} to ${esc(m.to_name)} · ${new Date(m.sent_at).toLocaleString()}</p>
      <div style="white-space:pre-wrap">${esc(m.body)}</div>
      <p>${m.from_id && m.from_id !== me.id ? `<a class="btn" href="#/mail/new/${encodeURIComponent(m.from_name)}">Reply</a> ` : ''}
      <button class="sec" data-do="/mail/delete" data-body='{"mailId":${m.id}}' data-ok="Deleted" data-confirm="Delete this message?">Delete</button></p></div>`;
  }
  const sent = box === 'sent';
  const list = await api('/mail' + (sent ? '?box=sent' : ''));
  const rows = list
    .map(
      (m) =>
        `<tr class="${!sent && !m.read ? 'gold' : ''}"><td>${sent ? esc(m.to_name) : esc(m.from_name)}</td><td><a href="#/mail/${m.id}">${!sent && !m.read ? '● ' : ''}${esc(m.subject)}</a></td><td class="muted">${new Date(m.sent_at).toLocaleString()}</td></tr>`,
    )
    .join('');
  return `${tabs}<div class="card"><h2>${sent ? 'Sent' : 'Inbox'}</h2>${rows ? `<table><tr><th>${sent ? 'To' : 'From'}</th><th>Subject</th><th>Date</th></tr>${rows}</table>` : '<p class="muted">Nothing here.</p>'}</div>`;
}
