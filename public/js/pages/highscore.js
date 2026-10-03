// The "highscore" page.
import { api } from '../api.js';
import { img } from '../art.js';
import { me } from '../state.js';
import { esc, fmt, raceName } from '../util.js';

export async function pageMessages(id) {
  if (id) {
    const b = await api('/battles/' + id);
    const lines = b.log
      .map(
        (l) =>
          `<div>R${l.round}: ${esc(l.attacker)} ${l.hit ? `hits for <b>${l.damage}</b>` : '<span class="muted">misses</span>'} → ${l.targetHp} HP left</div>`,
      )
      .join('');
    return `<div class="card"><h2>Battle #${b.id}</h2><p>${b.rounds} rounds · ${fmt(b.gold)} gold looted${b.war_id ? ' · <span class="bad">clan war</span>' : ''}</p>
      <div class="log">${lines}</div><p><a href="#/messages">← Back</a></p></div>`;
  }
  const rows = (await api('/messages'))
    .map((m) => {
      const won = m.winner_id === me.id,
        atk = m.attacker === me.name;
      return `<tr><td class="muted">${new Date(m.at).toLocaleString()}</td><td>${atk ? `You raided <b>${esc(m.defender)}</b>` : `<b>${esc(m.attacker)}</b> raided you`}</td>
      <td class="${won ? 'good' : 'bad'}">${won ? 'Victory' : 'Defeat'}</td><td class="r">${m.gold ? fmt(m.gold) + 'g' : ''}</td><td><a href="#/messages/${m.id}">Details</a></td></tr>`;
    })
    .join('');
  return `<div class="card"><h2>Battle reports</h2>${rows ? `<table>${rows}</table>` : '<p class="muted">No battles yet.</p>'}</div>`;
}

export const HS_TABS = [
  ['level', 'Level'],
  ['wins', 'Raid wins'],
  ['loot', 'Gold looted'],
  ['hunter', 'Hunter'],
  ['worker', 'Gravedigger'],
  ['dungeon', 'Dungeon (week)'],
  ['arena_season', 'Arena (season)'],
  ['arena_alltime', 'Arena (all-time)'],
  ['clans', 'Clans'],
];

export const hsSize = () => {
  try {
    return Number(localStorage.getItem('mg_hs_size')) || 25;
  } catch {
    return 25;
  }
};

/** Compact page list: 1 … 4 5 [6] 7 8 … 40 */
export function pageWindow(cur, total) {
  const set = new Set([0, total - 1, cur - 2, cur - 1, cur, cur + 1, cur + 2].filter((n) => n >= 0 && n < total));
  const out = [];
  let prev = -1;
  for (const n of [...set].sort((x, y) => x - y)) {
    if (n - prev > 1) out.push('…');
    out.push(n);
    prev = n;
  }
  return out;
}

export async function pageHighscore(type = 'level', race = 'all', pageArg = '1') {
  const size = hsSize();
  const q = new URLSearchParams({ type, race: race === 'all' ? '' : race, page: String(Math.max(0, (parseInt(pageArg, 10) || 1) - 1)), size: String(size) });
  const r = await api('/highscore?' + q);
  const isClan = type === 'clans';
  const valueHead = {
    level: 'XP',
    wins: 'Wins',
    loot: 'Gold',
    hunter: 'Portions',
    worker: 'Hours',
    dungeon: 'Levels cleared',
    arena_season: 'Points',
    arena_alltime: 'Points',
    clans: 'Total level',
  }[type];
  const base = `#/highscore/${type}/${race}`;
  const mine = (p) => (isClan ? me?.clan?.id === p.id : me?.id === p.id);
  const rows = r.rows
    .map(
      (p, i) => `<tr class="${mine(p) ? 'gold' : ''}"><td>${r.page * r.pageSize + i + 1}</td>
    <td class="${p.race}">${isClan ? esc(p.name) : `<a href="#/player/${p.id}" class="${p.race}">${esc(p.name)}</a>`}${mine(p) ? ' ◀' : ''}</td>
    ${isClan ? `<td class="r">${p.members}</td>` : `<td class="r">${p.level}</td><td>${p.clan ? esc(p.clan) : ''}</td>`}
    <td class="r">${fmt(p.value ?? 0)}</td></tr>`,
    )
    .join('');
  const nav =
    r.pages > 1
      ? `<div class="pager">
      ${r.page > 0 ? `<a href="${base}/1">« First</a><a href="${base}/${r.page}">‹ Prev</a>` : '<span class="muted">« First</span><span class="muted">‹ Prev</span>'}
      ${pageWindow(r.page, r.pages)
        .map((n) => (n === '…' ? '<span class="muted">…</span>' : `<a href="${base}/${n + 1}" class="${n === r.page ? 'cur' : ''}">${n + 1}</a>`))
        .join('')}
      ${r.page < r.pages - 1 ? `<a href="${base}/${r.page + 2}">Next ›</a><a href="${base}/${r.pages}">Last »</a>` : '<span class="muted">Next ›</span><span class="muted">Last »</span>'}
    </div>`
      : '';
  const first = r.total ? r.page * r.pageSize + 1 : 0,
    last = Math.min(r.total, (r.page + 1) * r.pageSize);
  return `<div class="tabs">${HS_TABS.map(([k, n]) => `<a href="#/highscore/${k}/${race}" class="${k === type ? 'on' : ''}">${n}</a>`).join('')}</div>
    <div class="row sp" style="margin-bottom:.6rem"><span>Race: ${['all', 'vampire', 'werewolf'].map((x) => `<a href="#/highscore/${type}/${x}" class="${x === race ? 'gold' : ''}">${x}</a>`).join(' · ')}</span>
      <span class="row">${r.myRank ? `<a class="btn" href="${base}/${r.myPage + 1}">📍 Your rank: #${fmt(r.myRank)}</a>` : ''}
      <form data-hs-jump="${r.pageSize}" data-base="${base}" class="row" style="gap:.3rem"><input type="number" min="1" max="${Math.max(1, r.total)}" placeholder="rank #" style="width:6rem"><button class="sm sec">Go</button></form>
      <label style="margin:0;display:inline">Per page <select data-hs-size>${[25, 50, 100].map((n) => `<option ${n === r.pageSize ? 'selected' : ''}>${n}</option>`).join('')}</select></label></span></div>
    <div class="card"><div class="row sp"><h2 style="border:0;margin:0">Highscore</h2><span class="muted">${r.total ? `${fmt(first)}–${fmt(last)} of ${fmt(r.total)} ${isClan ? 'clans' : 'players'} · page ${r.page + 1} / ${r.pages}` : ''}</span></div>
      ${nav}${rows ? `<table><tr><th>#</th><th>Name</th>${isClan ? '<th class="r">Members</th>' : '<th class="r">Level</th><th>Clan</th>'}<th class="r">${valueHead}</th></tr>${rows}</table>` : '<p class="muted">Nobody on this list yet.</p>'}${nav}</div>`;
}

export async function pageProfile(id) {
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
