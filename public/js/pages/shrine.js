// The "shrine" page.
import { api, refresh } from '../api.js';
import { describe } from './town.js';
import { catalog, isBusy, me } from '../state.js';
import { bar, dur, esc, fmt, until, when } from '../util.js';

export const STEP_LABEL = { hunt: ['Hunt', 'portions of 10 min'], work: ['Graveyard work', 'hours'], dungeon: ['Dungeon run', 'fights'] };

/** "hunt:6" -> "Hunt 6 × 10 min" */
export const stepName = (t) => {
  const [k, n] = t.split(':');
  return k === 'hunt' ? `Hunt ${n} × ${dur(catalog.huntPortionMs ?? 600000)}` : k === 'work' ? `Work ${n} h` : `Dungeon run (up to ${n} fights)`;
};

export async function pageShrine() {
  return shrineHtml();
}

export async function shrineHtml() {
  const s = await api('/shrine');
  const pct = (x) => `${Math.round(x * 1000) / 10}%`;
  if (!s.unlocked)
    return `<div class="card"><h2>Shrine</h2><p class="muted">An old shrine stands outside the town. It will answer you from level <b>${s.unlockLevel}</b>.</p>
    <p class="muted">It hunts and works for you while you are away, fuelled by animal blood that you gather by playing.</p></div>`;
  const about = `<ul class="muted"><li>Every <b>manual</b> action gathers animal blood on the way (hunting, work, raids, dungeon fights). The shrine can hold <b>${s.tank}</b>.</li>
      <li>While the shrine runs, it works through your routine and pays <b>${pct(s.efficiency)}</b> of what the same time would pay by hand. An automated hour burns <b>${s.bloodPerHour}</b> blood.</li>
      <li>The usual daily limits stay (3 hours of hunting a day, one dungeon run a day). With an <b>Idol of the Hunt</b> installed the shrine can also do dungeon runs: all or nothing (a paused run is cancelled).</li>
      <li><b>No protection while it runs:</b> you can be raided, but a raid takes at most ${Math.round(catalog.shrineRaidLossCap * 100)}% of your gold.</li>
      <li>Hunting, working, raiding or entering the dungeon by hand <b>pauses</b> the shrine (the step in progress is paid pro rata). Press Start when you are done.</li></ul>`;
  if (!s.owned)
    return `<div class="card"><h2>Shrine</h2><p>Build the shrine for <b class="gold">${fmt(s.price)} gold</b>.</p>
      <p><button data-do="/shrine/buy" data-ok="The shrine is yours" ${me.gold < s.price || isBusy() ? 'disabled' : ''}>Build the shrine</button></p>${about}</div>`;
  const cur = s.current;
  const statusPill = {
    running: '<span class="pill good">running</span>',
    paused: '<span class="pill gold">paused</span>',
    starved: '<span class="pill bad">out of blood</span>',
    off: '<span class="pill">not started</span>',
  }[s.status];
  const slotRows = Array.from({ length: s.slots }, (_, i) => {
    const [k, n] = (s.routine[i] ?? ':').split(':');
    return `<div class="row" style="margin:.2rem 0"><span class="muted" style="min-width:3rem">Step ${i + 1}</span>
      <select name="kind${i}"><option value="">— nothing —</option>${Object.entries(STEP_LABEL)
        .filter(([key]) => key !== 'dungeon' || s.dungeonUnlocked)
        .map(([key, [name]]) => `<option value="${key}" ${key === k ? 'selected' : ''}>${name}</option>`)
        .join('')}</select>
      <input name="amount${i}" type="number" min="1" max="48" value="${n || ''}" style="width:5rem" aria-label="amount"> <span class="muted">portions (hunt) / hours (work)${s.dungeonUnlocked ? ' / fights (dungeon)' : ''}</span></div>`;
  }).join('');
  return `<div class="grid"><div class="card"><h2>Shrine ${statusPill}</h2>
      <label>🩸 Animal blood (about ${s.hoursOfFuel} h of work)</label>${bar('hp', s.blood, s.tank, `${fmt(s.blood)} / ${s.tank}`)}
      <p class="muted">Efficiency ${pct(s.efficiency)} (best possible ${pct(s.maxEfficiency)}) · ${s.bloodPerHour} blood per automated hour</p>
      ${cur ? `<p>Now: <b>${esc(stepName(cur.step))}</b> · ends in <b data-cd="${cur.endsAt}" data-refresh="1"></b></p><div class="bar xp" data-progress="${cur.startedAt},${cur.endsAt}"><i></i><span></span></div>` : ''}
      ${s.status === 'starved' ? '<p class="bad">The shrine ran out of blood. Hunt, work, raid or delve to gather more, then start it again.</p>' : ''}
      <div class="row" style="margin-top:.6rem">${
        s.status === 'running'
          ? '<button class="sec" data-do="/shrine/pause" data-ok="Shrine paused">⏸ Pause</button>'
          : `<button data-do="/shrine/start" data-ok="The shrine is working" ${isBusy() || !s.routine.length ? 'disabled' : ''}>▶ ${s.status === 'paused' ? 'Resume' : 'Start'}</button>`
      }</div>
      ${isBusy() ? '<p class="muted">Finish what you are doing by hand first.</p>' : ''}</div>
    <form class="card" data-shrine-routine><h2>Routine</h2><p class="muted">The steps repeat in order until the blood runs out. Changing the routine pauses the shrine.</p>${slotRows}<p><button>Save routine</button></p></form></div>
    <div class="card"><h2>Parts</h2><p class="muted">Every installed tier adds ${Math.round(catalog.shrineEfficiencyPerUpgrade * 1000) / 10}% efficiency (${s.upgrades} of 6 so far). Tier I is sold in the <a href="#/town/store/component">shop</a>; tier II is found while hunting large towns and beating dungeon guardians, or bought from other players in the Blood Temple.</p>
      <table>${['chalice', 'altar', 'idol']
        .map((k) => {
          const t = s.parts[k] ?? 0,
            name = { chalice: 'Blood Chalice', altar: 'Bone Altar', idol: 'Idol of the Hunt' }[k],
            what = {
              chalice: `tank ${s.tank}`,
              altar: `${s.slots} routine steps`,
              idol: t >= 2 ? `+${Math.round(catalog.shrineBloodBonus * 100)}% blood` : t === 1 ? 'dungeon automation' : '',
            }[k];
          return `<tr><td>${esc(name)}</td><td>${t ? `tier ${t === 1 ? 'I' : 'II'} <span class="muted">(${esc(what)})</span>` : '<span class="muted">not installed</span>'}</td><td class="r">${t ? `<button class="sm sec" data-do="/shrine/remove" data-body='${esc(JSON.stringify({ kind: k }))}' ${isBusy() ? 'disabled' : ''}>Remove</button>` : ''}</td></tr>`;
        })
        .join('')}</table>
      ${
        s.bag.length
          ? `<h3>In your bag</h3><table>${s.bag
              .map((b) => {
                const def = catalog.items.find((x) => x.key === b.key);
                return `<tr><td>${esc(def.name)}</td><td class="muted">${esc(describe(def))}</td><td class="r"><button class="sm" data-do="/shrine/install" data-body='${esc(JSON.stringify({ inventoryId: b.id }))}' ${isBusy() ? 'disabled' : ''}>Install</button></td></tr>`;
              })
              .join('')}</table>`
          : '<p class="muted">No parts in your bag.</p>'
      }</div>
    <div class="card"><h3>How it works</h3>${about}</div>`;
}
