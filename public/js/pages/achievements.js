// The "achievements" page.
import { api } from '../api.js';
import { img } from '../art.js';
import { catalog, isBusy } from '../state.js';
import { bar, esc, fmt } from '../util.js';

// ---------- achievements ----------
export async function pageAcc() {
  const { status, sets, bonus } = await api('/accomplishments');
  const earned = status.filter((s) => s.tier > 0);
  const rows = status
    .map(
      (s) => `<tr><td>${img('accomplishments/' + s.key, 'item-ico')}<b>${esc(s.name)}</b><div class="muted">${esc(s.desc)}</div></td>
    <td style="width:35%">${bar('xp', s.tier, s.maxTier, `tier ${s.tier} / ${s.maxTier}`)}<div class="muted">${fmt(s.value)}${s.next ? ` / ${fmt(s.next)}` : ' (max)'}</div></td>
    <td class="r">${s.tier ? `<span class="good">${esc(s.bonusText.replace(/^\+\d+/, (m) => '+' + parseInt(m) * s.tier))}</span>` : `<span class="muted">${esc(s.bonusText)}/tier</span>`}</td></tr>`,
    )
    .join('');
  const setCards = sets
    .map(
      (st) => `<form class="card" data-submit="/accomplishments/save" data-ok="Set saved" style="margin:.5rem 0${st.active ? ';border-color:var(--good)' : ''}">
    <input type="hidden" name="slot" value="${st.slot}" data-num="1">
    <div class="row sp"><b>Set ${st.slot + 1} ${st.active ? '<span class="pill good">ACTIVE</span>' : ''}</b>
      <span><button class="sm">Save</button> ${st.active ? '' : `<button type="button" class="sm sec" data-do="/accomplishments/activate" data-body='{"slot":${st.slot}}' data-ok="Set ${st.slot + 1} activated" ${isBusy() ? 'disabled' : ''}>Activate</button>`}</span></div>
    <div class="row">${earned.length ? earned.map((s) => `<label style="display:inline;margin:0"><input type="checkbox" name="keys[]" value="${s.key}" ${st.keys.includes(s.key) ? 'checked' : ''}> ${esc(s.name)}</label>`).join('') : '<span class="muted">Earn accomplishments to fill a set.</span>'}</div></form>`,
    )
    .join('');
  const b = [
    ...Object.entries(bonus.stats)
      .filter(([, v]) => v)
      .map(([k, v]) => `+${v} ${k.toUpperCase()}`),
    bonus.raidGold ? `+${Math.round(bonus.raidGold * 100)}% raid gold` : '',
    bonus.huntReward ? `+${Math.round(bonus.huntReward * 100)}% hunt rewards` : '',
    bonus.workWage ? `+${Math.round(bonus.workWage * 100)}% wages` : '',
  ].filter(Boolean);
  return `<div class="grid"><div class="card"><h2>Accomplishments</h2><p class="muted">Earned automatically without limit. Only accomplishments in your <b>active set</b> give their bonus. Each set holds ${catalog.accSetSize}. You cannot switch sets while working or hunting.</p>
    <p>Current bonus: ${b.length ? `<b class="good">${b.join(', ')}</b>` : '<span class="muted">none</span>'}</p>${setCards}</div>
    <div class="card"><h2>Progress</h2><table>${rows}</table></div></div>`;
}
