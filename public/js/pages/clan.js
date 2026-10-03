// The "clan" page.
import { api } from '../api.js';
import { A } from '../art.js';
import { battleHtml } from './raid.js';
import { isBusy, lastResult, me } from '../state.js';
import { bar, esc, fmt, until } from '../util.js';

export const PERM_LABEL = {
  recruit: 'Recruit (applications)',
  kick: 'Kick members',
  war: 'Wars & negotiation',
  treasury: 'Treasury (domicile)',
  forum: 'Moderate forum',
};

export async function pageClan(tab, id) {
  const mine = me.clan ? await api('/clan/mine') : null;
  if (!mine) {
    const list = await api('/clans');
    const rows = list
      .filter((c) => c.race === me.race)
      .map(
        (
          c,
        ) => `<tr><td>${esc(c.name)}</td><td class="r">${c.members}</td><td>${c.is_open ? '<span class="good">open</span>' : '<span class="muted">applications</span>'}</td>
      <td class="r">${
        c.is_open
          ? `<button class="sm" data-do="/clan/join" data-body='{"clanId":${c.id}}' data-ok="Joined">Join</button>`
          : `<button class="sm sec" data-do="/clan/apply" data-body='{"clanId":${c.id},"message":"I would like to join!"}' data-ok="Application sent">Apply</button>`
      }</td></tr>`,
      )
      .join('');
    return `<div class="grid"><div class="card"><h2>Found a clan</h2>
      <p class="muted">Requires level 3. Members must be of your race.</p>
      <input id="cname" placeholder="Clan name" maxlength="24"> <button data-do="/clan/create" data-from="#cname:name" data-ok="Clan founded" ${me.level < 3 ? 'disabled' : ''}>Create</button></div>
      <div class="card"><h2>${me.race === 'vampire' ? 'Vampire' : 'Werewolf'} clans</h2>${rows ? `<table><tr><th>Name</th><th class="r">Members</th><th>Recruiting</th><th></th></tr>${rows}</table>` : '<p class="muted">None yet.</p>'}</div></div>`;
  }
  const leader = mine.leader_id === me.id;
  const can = (p) => mine.myPerms.includes(p);
  const tabs = [['', 'Overview'], ['war', mine.war ? '⚔ War' : 'War'], ['forum', 'Forum'], ...(leader ? [['admin', 'Permissions']] : [])];
  const head = `<div class="tabs">${tabs.map(([k, n]) => `<a href="#/clan/${k}" class="${(tab ?? '') === k ? 'on' : ''}">${n}</a>`).join('')}</div>`;

  if (tab === 'forum') return head + (await pageForum(id, can('forum')));
  if (tab === 'war') return head + (await pageWar(can('war')));

  if (tab === 'admin' && leader) {
    const rows = mine.members
      .filter((m) => m.id !== me.id)
      .map(
        (m) => `<form class="card" data-submit="/clan/perms" data-ok="Permissions saved" style="margin:.5rem 0">
      <input type="hidden" name="playerId" value="${m.id}" data-num="1"><b>${esc(m.name)}</b> <span class="muted">Lv ${m.level}</span>
      <div class="row">${mine.allPerms.map((p) => `<label style="display:inline;margin:0"><input type="checkbox" name="perms[]" value="${p}" ${m.perms.includes(p) ? 'checked' : ''}> ${PERM_LABEL[p]}</label>`).join('')}
      <button class="sm">Save</button></div></form>`,
      )
      .join('');
    return `${head}<div class="card"><h2>Permissions</h2><p class="muted">The leader always has every right. Officers with "kick" cannot remove other officers.</p>${rows || '<p class="muted">No other members.</p>'}</div>`;
  }

  const apps = can('recruit') ? await api('/clan/applications') : [];
  const enemies = can('war') && !mine.war ? (await api('/clans')).filter((c) => c.race !== me.race) : [];
  const war = mine.war;
  return `${head}<div class="grid"><div class="card"><h2>${esc(mine.name)}</h2>
      <p>Members ${mine.members.length} / ${mine.capacity} · Domicile level ${mine.domicile_level} · Treasury <span class="gold">${fmt(mine.treasury)}g</span></p>
      <p>Recruiting: <b>${mine.is_open ? 'open to everyone' : 'applications only'}</b>
        ${can('recruit') ? `<button class="sm sec" data-do="/clan/recruiting" data-body='{"open":${!mine.is_open}}'>${mine.is_open ? 'Require applications' : 'Open recruiting'}</button>` : ''}</p>
      <div class="row"><input id="don" type="number" min="1" value="50" style="width:6rem"><button data-do="/clan/donate" data-from="#don:amount" data-ok="Donated">Donate</button>
      ${can('treasury') ? `<button class="sec" data-do="/clan/upgrade" data-ok="Domicile expanded (+5 slots)">Expand domicile (${fmt(mine.upgradeCost)}g)</button>` : ''}</div>
      <p><button class="sec sm" data-do="/clan/leave" data-confirm="Leave the clan?">Leave clan</button></p>
      ${mine.myPerms.length && !leader ? `<p class="muted">Your rights: ${mine.myPerms.map((p) => PERM_LABEL[p]).join(', ')}</p>` : ''}</div>
    <div class="card"><h2>War</h2>
      ${
        war
          ? `<p>Status: <b class="bad">${esc(war.status)}</b> against <b>${esc(mine.enemy.name)}</b>. During a war you may hit the same enemy 4× per 12 h. Raiding during a ceasefire ends it.</p>
        <p><a class="btn" href="#/clan/war">⚔ Open the war room</a></p>
        ${
          can('war')
            ? `<div class="row"><button class="sec sm" data-do="/clan/war/peace" data-ok="Peace offered / accepted">Peace</button>
        <button class="sec sm" data-do="/clan/war/ceasefire" data-ok="Ceasefire offered / accepted">Ceasefire</button>
        <button class="sm" data-do="/clan/war/capitulate" data-confirm="Surrender?">Capitulate</button></div>`
            : '<p class="muted">You need the war permission to negotiate.</p>'
        }`
          : `<p class="muted">Not at war. Declaring needs the war permission and at least 5 members.</p>
        ${
          can('war')
            ? `<div class="row"><select id="enemy">${enemies.map((c) => `<option value="${c.id}">${esc(c.name)} (${c.members})</option>`).join('')}</select>
        <button data-do="/clan/war/declare" data-from="#enemy:clanId" data-ok="War declared!" ${enemies.length ? '' : 'disabled'}>Declare war</button></div>`
            : ''
        }`
      }</div></div>
    ${
      apps.length
        ? `<div class="card"><h2>Applications</h2><table>${apps
            .map(
              (a) => `<tr><td><a href="#/player/${a.player_id}">${esc(a.name)}</a> <span class="muted">Lv ${a.level}</span></td><td>${esc(a.message)}</td>
      <td class="r"><button class="sm" data-do="/clan/application" data-body='{"playerId":${a.player_id},"accept":true}' data-ok="Accepted">Accept</button>
      <button class="sm sec" data-do="/clan/application" data-body='{"playerId":${a.player_id},"accept":false}'>Decline</button></td></tr>`,
            )
            .join('')}</table></div>`
        : ''
    }
    <div class="card"><h2>Members</h2><table><tr><th>Name</th><th class="r">Level</th><th>Role</th><th></th></tr>
      ${mine.members
        .map(
          (
            m,
          ) => `<tr><td><a href="#/player/${m.id}">${esc(m.name)}</a></td><td class="r">${m.level}</td><td>${esc(m.clan_role)}${m.id !== mine.leader_id && m.perms.length ? ' <span class="pill">officer</span>' : ''}</td>
      <td class="r">${can('kick') && m.id !== me.id && m.id !== mine.leader_id ? `<button class="sm sec" data-do="/clan/kick" data-body='{"playerId":${m.id}}' data-confirm="Kick ${esc(m.name)}?">Kick</button>` : ''}</td></tr>`,
        )
        .join('')}</table></div>`;
}

export const TARGET_LABEL = {
  available: ['attackable', 'good'],
  range: ['outside your skill range', 'muted'],
  low_hp: ['too wounded (< 25 HP)', 'bad'],
  busy: ['busy (working / hunting)', 'muted'],
  protected: ['recently attacked', 'muted'],
  limit: ['hit the maximum times', 'muted'],
};

export async function pageWar(canNegotiate) {
  const w = await api('/clan/war');
  if (!w.war)
    return `<div class="card"><h2>War room</h2><p class="muted">Your clan is not at war. A clan leader (or a member with the war right) can declare war on an enemy clan from the Overview tab. It needs at least 5 members.</p></div>`;
  const sb = w.scoreboard,
    mineC = sb.clans.find((c) => c.clan_id === w.myClan.id) ?? { points: 0, attacks: 0, gold: 0 },
    enC = sb.clans.find((c) => c.clan_id === w.enemyClan.id) ?? { points: 0, attacks: 0, gold: 0 };
  const cd = until(w.attackReadyAt),
    avail = w.targets.filter((t) => t.status === 'available').length,
    busy = isBusy();
  const reason = busy
    ? 'You are working or hunting'
    : cd
      ? `Cooldown: ${cd}`
      : me.hp < 25
        ? 'You need at least 25 HP'
        : !avail
          ? 'No enemy is attackable right now'
          : '';
  const targets = w.targets
    .map((t) => {
      const [label, cls] = TARGET_LABEL[t.status];
      return `<tr class="${t.status === 'available' ? '' : 'muted'}"><td><a href="#/player/${t.id}">${esc(t.name)}</a></td><td class="r">${t.level}</td>
      <td class="${cls}">${label}${t.status === 'protected' && t.protectedUntil ? ` (${until(t.protectedUntil) ?? 'now'})` : ''}</td><td class="r">${t.hitsLeft} / ${w.maxHits}</td></tr>`;
    })
    .join('');
  const mrows = (clanId) =>
    sb.members
      .filter((m) => m.clan_id === clanId)
      .map(
        (m) =>
          `<tr class="${m.player_id === me.id ? 'gold' : ''}"><td>${esc(m.name)}</td><td class="r">${m.attacks}</td><td class="r">${m.wins}</td><td class="r">${m.defended}</td><td class="r">${fmt(m.gold)}</td></tr>`,
      )
      .join('');
  const r = lastResult && lastResult.warId === w.war.id ? lastResult : null;
  return `<div class="card"><div class="row sp"><h2 style="border:0;margin:0">${esc(w.myClan.name)} <span class="muted">vs</span> ${esc(w.enemyClan.name)}</h2><span class="pill ${w.war.status === 'active' ? 'bad' : 'gold'}">${esc(w.war.status)}</span></div>
      <p style="font-size:2rem;text-align:center;margin:.6rem 0" class="gold"><span class="good">${mineC.points}</span> : <span class="bad">${enC.points}</span></p>
      <p class="muted" style="text-align:center;margin:0">Score = battles won by your clan's members vs. the enemy clan's members (attacking or defending).</p></div>
    <div class="grid"><div class="card"><h2>Attack</h2>
      ${bar('hp', me.hp, me.max_hp, `HP ${me.hp} / ${me.max_hp}`)}
      <p>Attack cooldown: <b data-cd="${me.attackReadyAt}" data-ready="ready">${cd ?? 'ready'}</b> · Attackable enemies: <b>${avail}</b> / ${w.targets.length}</p>
      <p class="muted">Picks a random enemy war member whose skill level is within ±${Math.round(w.skillBand * 100)}% of yours and fights them at once. You can hit each enemy up to ${w.maxHits}× per 12 hours; hit enemies are protected for 1 hour. ${w.war.status === 'ceasefire' ? '<b class="bad">Attacking during a ceasefire ends it.</b>' : ''}</p>
      <button data-do="/clan/war/attack" ${reason ? 'disabled' : ''}>⚔ Attack a random enemy</button> ${reason ? `<span class="muted">${esc(reason)}</span>` : ''}
      ${me.hp < 25 ? `<p class="bad">Too wounded. ${me.inventory.some((i) => i.key === 'potion_heal') ? '<button class="sec sm" data-do="/inventory/use" data-body=\'{"inventoryId":' + me.inventory.find((i) => i.key === 'potion_heal').id + "}'>Use health potion</button>" : 'Buy a Health Potion in the Store.'}</p>` : ''}
      ${canNegotiate ? `<hr><div class="row"><span class="muted">Negotiate:</span><button class="sec sm" data-do="/clan/war/peace" data-ok="Peace offered / accepted">Peace</button><button class="sec sm" data-do="/clan/war/ceasefire" data-ok="Ceasefire offered / accepted">Ceasefire</button><button class="sm" data-do="/clan/war/capitulate" data-confirm="Surrender?">Capitulate</button></div>` : ''}</div>
    <div class="card"><h2>Last war battle</h2>${r ? battleHtml(r) : '<p class="muted">You have not fought in this war yet.</p>'}</div></div>
    <div class="card"><h2>Enemy roster — ${esc(w.enemyClan.name)}</h2><table><tr><th>Name</th><th class="r">Level</th><th>Status</th><th class="r">Your hits left</th></tr>${targets}</table></div>
    <div class="grid"><div class="card"><h3>${esc(w.myClan.name)} <span class="muted">${mineC.attacks} attacks · ${fmt(mineC.gold)}g looted</span></h3><table><tr><th>Member</th><th class="r">Attacks</th><th class="r">Won</th><th class="r">Defended</th><th class="r">Gold</th></tr>${mrows(w.myClan.id)}</table></div>
      <div class="card"><h3>${esc(w.enemyClan.name)} <span class="muted">${enC.attacks} attacks · ${fmt(enC.gold)}g looted</span></h3><table><tr><th>Member</th><th class="r">Attacks</th><th class="r">Won</th><th class="r">Defended</th><th class="r">Gold</th></tr>${mrows(w.enemyClan.id)}</table></div></div>`;
}

export async function pageForum(threadId, mod) {
  if (threadId) {
    const t = await api('/forum/' + threadId);
    const posts = t.posts
      .map(
        (p) => `<div class="card" style="margin:.5rem 0"><div class="row sp"><b><a href="#/player/${p.author_id}">${esc(p.author)}</a></b>
      <span class="muted">${new Date(p.created_at).toLocaleString()} ${p.author_id === me.id || t.mod ? `<a data-do="/forum/delete" data-body='{"postId":${p.id}}' data-confirm="Delete this post?">delete</a>` : ''}</span></div>
      <div style="white-space:pre-wrap">${esc(p.body)}</div></div>`,
      )
      .join('');
    return `<div class="card"><div class="row sp"><h2 style="border:0;margin:0">${t.pinned ? '📌 ' : ''}${t.locked ? '🔒 ' : ''}${esc(t.title)}</h2><a href="#/clan/forum">← Threads</a></div>
      ${
        mod
          ? `<div class="row"><button class="sm sec" data-do="/forum/flag" data-body='{"threadId":${t.id},"flag":"pinned","value":${!t.pinned}}'>${t.pinned ? 'Unpin' : 'Pin'}</button>
        <button class="sm sec" data-do="/forum/flag" data-body='{"threadId":${t.id},"flag":"locked","value":${!t.locked}}'>${t.locked ? 'Unlock' : 'Lock'}</button></div>`
          : ''
      }
      ${posts}
      ${
        t.locked && !mod
          ? '<p class="muted">This thread is locked.</p>'
          : `<form data-submit="/forum/reply" data-ok="Posted"><input type="hidden" name="threadId" value="${t.id}" data-num="1">
        <label>Reply</label><textarea name="body" rows="4" required maxlength="4000" style="width:100%"></textarea><p><button>Post reply</button></p></form>`
      }</div>`;
  }
  const threads = await api('/forum');
  return `<div class="grid"><div class="card"><h2>Clan forum</h2>${
    threads.length
      ? `<table><tr><th>Thread</th><th>Author</th><th class="r">Replies</th><th>Last post</th></tr>
      ${threads.map((t) => `<tr><td>${t.pinned ? '📌 ' : ''}${t.locked ? '🔒 ' : ''}<a href="#/clan/forum/${t.id}">${esc(t.title)}</a></td><td>${esc(t.author)}</td><td class="r">${t.replies}</td><td class="muted">${new Date(t.last_at).toLocaleString()}</td></tr>`).join('')}</table>`
      : '<p class="muted">No threads yet.</p>'
  }</div>
    <form class="card" data-submit="/forum/thread" data-goto="#/clan/forum/{id}"><h3>New thread</h3><label>Title</label><input name="title" required maxlength="80" style="width:100%">
      <label>Message</label><textarea name="body" rows="4" required maxlength="4000" style="width:100%"></textarea><p><button>Create thread</button></p></form></div>`;
}
