// The "hunt" page.
import { refresh } from '../api.js';
import { A, img } from '../art.js';
import { huntResult, isHunting, isInDungeon, me, now } from '../state.js';
import { bar, fmt } from '../util.js';

export const PLACE_LABEL = { village: '🏘 Village', small_town: '🏙 Small town', large_town: '🌆 Large town', nothing: '💨 The trail went cold' };

export function huntResultHtml(r) {
  if (!r) return '';
  const rows = r.events
    .map(
      (e, i) => `<tr><td class="muted">#${i + 1}</td><td>${img('hunt/' + e.place, 'thumb')}${PLACE_LABEL[e.place] ?? e.place}</td>
    <td class="r">${e.failed ? '' : `+${e.xp} XP`}</td><td class="r gold">${e.failed ? '' : `+${e.gold}g`}</td></tr>`,
    )
    .join('');
  return `<hr><h3>${r.cancelled ? 'Hunt abandoned' : 'Hunt complete'}</h3>
    ${rows ? `<table>${rows}</table>` : '<p class="muted">Nothing was completed.</p>'}
    <p><b>Total: +${r.xp} XP, <span class="gold">+${fmt(r.gold)}g</span></b>${r.levelsGained ? ' <span class="good">— LEVEL UP!</span>' : ''}</p>`;
}

export function pageHunt() {
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
