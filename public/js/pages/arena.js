// The "arena" page.
import { api } from '../api.js';
import { ico, img } from '../art.js';
import { catalog, me } from '../state.js';
import { MOONS, esc, fmt } from '../util.js';

// ---------- arena ----------
export const RANK_NAME = (r) => (r === null ? 'Unranked' : r === 1 ? '👑 Rank 1' : `Rank ${r}`);

export async function pageArena(arg, arg2) {
  if (arg === 'match') {
    const m = await api('/arena/match/' + arg2);
    const lines = m.log
      .map(
        (l) =>
          `<div>R${l.round}: ${esc(l.attacker)} ${l.hit ? `hits for <b>${l.damage}</b>` : '<span class="muted">misses</span>'} → ${l.targetHp} HP left</div>`,
      )
      .join('');
    return `<div class="card"><h2>Arena match #${m.id}</h2><p>${m.rounds} rounds</p><div class="log">${lines}</div><p><a href="#/arena/${m.event_id}">← Event</a></p></div>`;
  }
  if (arg === 'ranking') {
    const kind = arg2 === 'alltime' ? 'alltime' : 'season';
    const rows = (await api('/arena/ranking?kind=' + kind))
      .map(
        (r, i) =>
          `<tr><td>${i + 1}</td><td><a href="#/player/${r.id}" class="${r.race}">${esc(r.name)}</a></td><td class="r">${r.level}</td><td class="r">${Math.round(r.points)}</td></tr>`,
      )
      .join('');
    return `<div class="tabs"><a href="#/arena">← Arena</a><a href="#/arena/ranking/season" class="${kind === 'season' ? 'on' : ''}">This season</a><a href="#/arena/ranking/alltime" class="${kind === 'alltime' ? 'on' : ''}">All-time (decays 2%/day)</a></div>
      <div class="card"><h2>Arena ranking</h2>${rows ? `<table><tr><th>#</th><th>Name</th><th class="r">Level</th><th class="r">Points</th></tr>${rows}</table>` : '<p class="muted">No arena results yet.</p>'}</div>`;
  }
  if (arg && /^\d+$/.test(arg)) {
    const e = await api('/arena/event/' + arg);
    const entries = e.entries
      .map(
        (x) =>
          `<tr><td>${x.place ?? '–'}</td><td><a href="#/player/${x.player_id}">${esc(x.name)}</a></td><td class="r">${x.skill.toFixed(1)}</td><td class="r">${Math.round(x.strength)}</td></tr>`,
      )
      .join('');
    const matches = e.matches
      .map(
        (m) =>
          `<tr><td>Round ${m.round}</td><td>${esc(m.a_name)} vs ${esc(m.b_name)}</td><td>${esc(m.winner_id === m.a_id ? m.a_name : m.b_name)} won</td><td><a href="#/arena/match/${m.id}">log</a></td></tr>`,
      )
      .join('');
    return `<div class="card"><h2>${e.kind === 'duel' ? 'Duel' : `Tournament (${e.size})`} #${e.id} <span class="pill">${esc(e.status)}</span></h2>
      <p>Entry fee ${fmt(e.fee)}g · skill band ${(e.base_skill * (1 - e.deviation / 100)).toFixed(0)}–${(e.base_skill * (1 + e.deviation / 100)).toFixed(0)} · counts: ${[e.with_eq && 'equipment', e.with_sen && 'sentinels', e.with_anc && 'ancestral'].filter(Boolean).join(', ') || 'base stats only'}</p>
      ${e.status === 'full' ? `<p>Starts around ${new Date(e.start_at).toUTCString()}</p>` : ''}
      <table><tr><th>Place</th><th>Fighter</th><th class="r">Skill avg</th><th class="r">Strength</th></tr>${entries}</table>
      ${matches ? `<h3 style="margin-top:1rem">Matches</h3><table>${matches}</table>` : ''}<p><a href="#/arena">← Arena</a></p></div>`;
  }
  const { status: st, events } = await api('/arena');
  const skill = (me.str + me.def + me.agi + me.sta + me.dex) / 5;
  const rows = events
    .map((e) => {
      const band = `${(e.base_skill * (1 - e.deviation / 100)).toFixed(0)}–${(e.base_skill * (1 + e.deviation / 100)).toFixed(0)}`;
      const inBand = Math.abs(skill - e.base_skill) <= (e.base_skill * e.deviation) / 100 + 1e-9;
      const status =
        e.status === 'open'
          ? `open · closes in <b data-cd="${e.deadline}"></b>`
          : e.status === 'full'
            ? `full · starts ~${String(catalog.arenaStartHourUtc).padStart(2, '0')}:00 UTC`
            : 'finished';
      return `<tr><td><a href="#/arena/${e.id}">#${e.id}</a></td><td>${img('arena/' + e.kind, 'nav-ico')}${e.kind === 'duel' ? 'Duel' : `Tournament ${e.size}`}<div class="muted">by ${esc(e.creator)}</div></td><td>${band}<div class="muted">${[e.with_eq && 'gear', e.with_sen && 'sentinel', e.with_anc && 'ancestral'].filter(Boolean).join('+') || 'base'}</div></td>
      <td class="r">${fmt(e.fee)}g</td><td class="r">${e.entries}/${e.size}</td><td>${status}</td><td class="r">
      ${e.status === 'open' && !e.joined ? `<button class="sm" data-do="/arena/join" data-body='{"eventId":${e.id}}' data-ok="Registered" ${!inBand || st.current || me.gold < e.fee || me.level < catalog.arenaMinLevel ? 'disabled' : ''} title="${inBand ? '' : 'Your skill average is outside the band'}">Join</button>` : ''}
      ${e.joined && e.status !== 'done' && e.creator_id !== me.id ? `<button class="sm sec" data-do="/arena/leave" data-body='{"eventId":${e.id}}' data-ok="You left the event">Leave</button>` : ''}
      ${e.creator_id === me.id && (e.status === 'open' || e.status === 'full') ? `<button class="sm sec" data-do="/arena/cancel" data-body='{"eventId":${e.id}}' data-confirm="Cancel and refund everybody?" data-ok="Event cancelled">Cancel</button>` : ''}</td></tr>`;
    })
    .join('');
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
