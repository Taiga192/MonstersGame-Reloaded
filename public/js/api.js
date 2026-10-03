// Talking to the server: requests, toasts, actions, session refresh and logout.
import { applyTheme } from './art.js';
import { closeDrop, notes, renderAlerts, startPolling, stopPolling } from './notifications.js';
import { render } from './router.js';
import { API_BASE, me, setDungeonResult, setHuntResult, setLastResult, setMe, setSkew, setToken, token } from './state.js';
import { $, fmt } from './util.js';

// ---------- infrastructure ----------
export async function api(path, body) {
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

export let toastTimer;

export function toast(msg, err = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'show' + (err ? ' err' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.className = ''), err ? 4500 : 2500);
}

/** Run an action, toast the outcome, refresh state and re-render. */
export async function act(path, body, okMsg) {
  try {
    const r = await api(path, body ?? {});
    const msg = resultMessage(path, r);
    if (msg) toast(msg.text, msg.err);
    else if (okMsg) toast(okMsg);
    if (path === '/raid/attack' || path === '/clan/war/attack') setLastResult(r);
    if (path === '/hunt/collect' || path === '/hunt/cancel') setHuntResult(r);
    if (path === '/dungeon/fight') setDungeonResult(r);
    if (path === '/dungeon/enter') setDungeonResult(null);
    await refresh();
    return r;
  } catch (e) {
    toast(e.message, true);
  }
}

/** Human readable outcome for actions whose result matters; null = use the default message. */
export function resultMessage(path, r) {
  if (path === '/raid/search' && !r.found)
    return {
      err: true,
      text: r.reason === 'no_opponents' ? 'No suitable opponents right now (level range, protection, HP).' : 'You lost the trail. Try again.',
    };
  if (path === '/clan/war/attack') return { text: `War: ${r.winner} won against ${r.target.name}! ${r.gold ? `Looted ${r.gold} gold.` : ''}` };
  if (path === '/raid/attack') return { text: `${r.winner} won! ${r.gold ? `Looted ${r.gold} gold.` : ''}` };
  if (path === '/dungeon/enter') return { text: 'You descend into the dungeon…' };
  if (path === '/dungeon/leave') return { text: 'You climb out. Your progress is saved.' };
  if (path === '/dungeon/fight')
    return r.won
      ? {
          text: `Level ${r.depth} cleared! +${r.xp} XP${r.drop ? `, found ${r.drop.name} (${r.drop.value}g)` : ''}${r.choice ? ' — the guardian offers you a reward!' : ''}${r.checkpoint ? ` — checkpoint: level ${r.checkpoint} is saved!` : ''}${r.component ? ` — the guardian dropped ${r.component}!` : ''}`,
        }
      : { err: true, text: `You died on level ${r.depth}. Your XP and items are safe; the level is still waiting for you.` };
  if (path === '/dungeon/reward') return { text: `You take the ${r.name} (worth ${fmt(r.value)}g)` };
  if (path === '/dungeon/sell') return { text: `The dealer pays ${fmt(r.gold)} gold for ${r.count} item${r.count === 1 ? '' : 's'}` };
  if (path === '/temple/buy') return { text: `You bought ${r.item} for ${fmt(r.paid)} gold` };
  if (path === '/inventory/harden') return { text: `Weapon hardened to +${r.hardening} (${fmt(r.cost)}g)` };
  if (path === '/quests/claim') return { text: `Quest done! You took ${r.text}` };
  if (path === '/hunt/start') return { text: 'You slip into the night… the hunt has begun.' };
  if (path === '/hunt/collect')
    return {
      text: `Hunt complete: +${r.xp} XP, +${r.gold} gold${r.levelsGained ? ' — LEVEL UP!' : ''}${r.found?.length ? ` — you found ${r.found.join(', ')}!` : ''}`,
    };
  if (path === '/hunt/cancel') return { text: `Hunt abandoned: ${r.portionsCompleted} portion(s) paid out (+${r.xp} XP, +${r.gold} gold)` };
  if (path === '/work/start') return { text: 'You start your shift at the graveyard.' };
  if (path === '/work/collect') return { text: `Shift complete: earned ${r.wages} gold` };
  if (path === '/work/cancel')
    return { text: `You quit early after ${Math.floor(r.minutesWorked / 60)}h ${r.minutesWorked % 60}m and were paid ${r.wages} gold` };
  if (path === '/ancestral/challenge')
    return r.won ? { text: 'The ancestor acknowledges you. Ability improved!' } : { err: true, text: 'The ancestor defeated you. The fee is lost.' };
  return null;
}

export async function refresh() {
  if (!token) return;
  setMe(await api('/me'));
  setSkew(me.serverNow - Date.now());
  notes.unread = me.unreadNotifications;
  if (!notes.cursor) notes.cursor = me.notificationCursor;
  startPolling();
  applyTheme();
  render();
}

export function logout(silent) {
  if (token && !silent) api('/logout', {}).catch(() => {}); // end the session on the server too, not only in this browser
  setToken(null);
  setMe(null);
  localStorage.removeItem('mg_token');
  stopPolling();
  notes.unread = 0;
  notes.cursor = 0;
  renderAlerts();
  closeDrop();
  if (!silent) toast('Logged out');
  location.hash = '#/';
  render();
}
