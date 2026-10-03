// The "admin" page.
import { api } from '../api.js';
import { A } from '../art.js';
import { catalog, me, now } from '../state.js';
import { esc, fmt, raceName, when } from '../util.js';

// ---------- admin: rates, cooldowns, players, wipe ----------
export let adminQ = '';
export const setAdminQ = (v) => {
  adminQ = v;
};

export const ADMIN_TABS = [
  ['world', 'World'],
  ['settings', 'Settings'],
  ['players', 'Players'],
  ['log', 'Log'],
];

export const adminNum = (v) => fmt(Math.round(Number(v)));

/** one "save this number" row: a hidden key plus a number box, handled by the generic form[data-submit] code */
export const settingForm = (
  s,
) => `<form class="row" data-submit="/admin/setting" data-ok="Saved" style="gap:.3rem"><input type="hidden" name="key" value="${esc(s.key)}">
  <input name="value" type="number" step="${s.int ? 1 : 'any'}" min="${s.min}" max="${s.max}" value="${s.value}" style="width:7rem" aria-label="${esc(s.label)}"> <span class="muted">${esc(s.unit)}</span>
  <button class="sm">Save</button>${s.changed ? `<button type="button" class="sm sec" data-do="/admin/setting/reset" data-body="${esc(JSON.stringify({ key: s.key }))}" data-ok="Back to the default">reset (${s.default})</button>` : ''}</form>`;

export async function pageAdmin(tab = 'world', arg2, arg3) {
  if (!me.isAdmin) return '<div class="card bad">Administrators only.</div>';
  const tabs = `<div class="tabs">${ADMIN_TABS.map(([k, n]) => `<a href="#/admin/${k}" class="${k === tab ? 'on' : ''}">${n}</a>`).join('')}</div>`;
  if (tab === 'player') return pageAdminPlayer(Number(arg2));
  const v = await api('/admin');
  if (tab === 'settings') {
    const groups = [...new Set(v.settings.map((s) => s.group))];
    return `<h2>Admin</h2>${tabs}<p class="muted">Changes are active immediately, for everybody, and stay after a restart. Durations are shown in minutes or hours. "reset" puts one number back to the default.</p>
      ${groups
        .map(
          (g) =>
            `<div class="card"><h3>${esc(g)}</h3><table>${v.settings
              .filter((s) => s.group === g)
              .map(
                (s) =>
                  `<tr><td>${esc(s.label)}${s.help ? `<div class="muted" style="font-size:.8rem">${esc(s.help)}</div>` : ''}</td><td class="r">${settingForm(s)}</td></tr>`,
              )
              .join('')}</table></div>`,
        )
        .join('')}
      <div class="card"><button class="sec" data-do="/admin/settings/reset" data-confirm="Put ALL settings back to the defaults?">Reset every setting to the default</button></div>`;
  }
  if (tab === 'players') {
    const who = ['all', 'humans', 'bots', 'admins'].includes(arg2) ? arg2 : 'humans',
      page = Math.max(1, Number(arg3) || 1);
    const r = await api(`/admin/players?who=${who}&page=${page}&q=${encodeURIComponent(adminQ)}`);
    return `<h2>Admin</h2>${tabs}
      <form class="row card" data-admin-search data-who="${who}"><select name="who">${['humans', 'bots', 'admins', 'all'].map((w) => `<option ${w === who ? 'selected' : ''}>${w}</option>`).join('')}</select>
        <input name="q" value="${esc(adminQ)}" placeholder="name contains…" maxlength="40"><button>Search</button><span class="muted">${fmt(r.total)} found</span></form>
      <div class="card"><table><tr><th>Name</th><th>Race</th><th class="r">Level</th><th class="r">Gold</th><th class="r">HP</th><th></th></tr>
      ${r.rows
        .map(
          (
            p,
          ) => `<tr><td><a href="#/admin/player/${p.id}">${esc(p.name)}</a> ${p.is_admin ? '<span class="pill gold">admin</span>' : ''}${p.is_bot ? ' <span class="pill">bot</span>' : ''}${p.busy ? ' <span class="pill">busy</span>' : ''}</td>
        <td>${raceName(p.race)}</td><td class="r">${p.level}</td><td class="r gold">${adminNum(p.gold)}</td><td class="r">${p.hp < 0 ? 0 : Math.floor(p.hp)}/${p.max_hp}</td><td class="r"><a href="#/admin/player/${p.id}">edit</a></td></tr>`,
        )
        .join('')}</table>
      <div class="pager">${page > 1 ? `<a href="#/admin/players/${who}/${page - 1}">‹ prev</a>` : ''}<span>page ${r.page} / ${r.pages}</span>${page < r.pages ? `<a href="#/admin/players/${who}/${page + 1}">next ›</a>` : ''}</div></div>`;
  }
  if (tab === 'log') {
    return `<h2>Admin</h2>${tabs}<div class="card"><h3>What admins did</h3>${
      v.world.log.length
        ? `<table>${v.world.log
            .map((l) => `<tr><td class="muted">${esc(when(l.at))}</td><td>${esc(l.admin_name)}</td><td>${esc(l.action)}</td><td>${esc(l.detail)}</td></tr>`)
            .join('')}</table>`
        : '<p class="muted">Nothing yet.</p>'
    }</div>`;
  }
  // world
  const w = v.world,
    rate = (k) => v.settings.find((s) => s.key === k);
  return `<h2>Admin</h2>${tabs}
    <div class="grid">
      <div class="card"><h3>World</h3>
        <p>Started <b>${esc(when(w.worldStartedAt))}</b> · wiped ${w.wipes}×</p>
        <p>${fmt(w.humans)} players · ${fmt(w.bots)} bots · ${fmt(w.admins)} admin${w.admins === 1 ? '' : 's'} · ${fmt(w.clans)} clans · ${fmt(w.battles)} battles</p>
        <p class="muted">Highest level ${w.topLevel} · ${adminNum(w.totalGold)} gold in circulation</p>
        <p class="muted">${v.singlePlayer ? 'Single player: you are always the admin.' : 'Multiplayer: admins are set by hand on the server: <code>node scripts/admin.ts &lt;database&gt; grant &lt;name&gt;</code>'}</p></div>
      <div class="card"><h3>Rates</h3><p class="muted">1 = normal. For a speed server use the preset below or type your own numbers.</p>
        <table>${['rateXp', 'rateGold', 'rateLevelXp'].map((k) => `<tr><td>${esc(rate(k).label)}</td><td class="r">${settingForm(rate(k))}</td></tr>`).join('')}</table>
        <p class="muted">More numbers (every cooldown, combat, economy …) are on the <a href="#/admin/settings">Settings</a> tab.</p></div>
    </div>
    <div class="card"><h3>Presets</h3><p class="muted">A preset replaces all current settings.</p>
      ${v.presets
        .map(
          (p) => `<div class="row sp" style="margin:.4rem 0"><span><b>${esc(p.label)}</b><br><span class="muted">${esc(p.description)}</span></span>
        <button class="sec" data-do="/admin/preset" data-body="${esc(JSON.stringify({ name: p.key }))}" data-confirm="Apply the preset “${esc(p.label)}”? Your current settings are replaced." data-ok="Preset applied">Apply</button></div>`,
        )
        .join('')}</div>
    <form class="card" data-submit="/admin/announce" data-ok="Sent"><h3>Announcement</h3><p class="muted">Sends a mail from “System” to every player.</p>
      <label>Subject</label><input name="subject" maxlength="100" required style="width:100%"><label>Message</label><textarea name="body" maxlength="2000" required rows="3" style="width:100%"></textarea><p><button>Send to everyone</button></p></form>
    <form class="card" data-submit="/admin/wipe" data-ok="The world was wiped" data-confirm="This deletes the world. There is no undo. Continue?" style="border-color:var(--bad)"><h3 class="bad">Wipe the world</h3>
      <p class="muted">Deletes clans, wars, battles, market, mail, forum, arena, dungeon and all bots, and resets every character to level 1. Your settings and the log stay. Take a backup first (Game page / server backup).</p>
      <label>What to keep</label><select name="mode"><option value="progress">Keep all accounts (names and passwords), reset their characters</option><option value="everything">Keep only admin accounts (everybody else registers again)</option></select>
      <label>Type WIPE to confirm</label><input name="confirm" autocomplete="off" placeholder="WIPE" style="width:8rem">
      ${v.singlePlayer ? '' : '<label>Your password</label><input name="password" type="password" autocomplete="current-password">'}
      <p><button class="bad">Wipe now</button></p></form>`;
}

export async function pageAdminPlayer(id) {
  const p = await api(`/admin/player/${id}`);
  const tabs = `<div class="tabs">${ADMIN_TABS.map(([k, n]) => `<a href="#/admin/${k}" class="${k === 'players' ? 'on' : ''}">${n}</a>`).join('')}</div>`;
  const field = (
    name,
    label,
  ) => `<form class="row" data-submit="/admin/player" data-ok="Saved" style="gap:.3rem;margin:.2rem 0"><input type="hidden" name="id" value="${p.id}" data-num="1"><input type="hidden" name="field" value="${name}">
    <label style="min-width:9rem;margin:0">${label}</label><input name="value" type="number" step="1" value="${Math.floor(p[name])}" style="width:9rem"><button class="sm">Save</button></form>`;
  const items = (catalog?.items ?? []).map((i) => `<option value="${esc(i.key)}">${esc(i.name)} (${esc(i.slot)})</option>`).join('');
  const pw = !window.MG_LOCAL ? '<label>Your (admin) password</label><input name="password" type="password" autocomplete="current-password">' : '';
  return `<h2>Admin</h2>${tabs}<h3>${esc(p.name)} ${raceName(p.race)} ${p.is_admin ? '<span class="pill gold">admin</span>' : ''}${p.is_bot ? ' <span class="pill">bot</span>' : ''}</h3>
    <div class="grid"><div class="card"><h3>Character</h3>
      ${[
        ['level', 'Level (resets XP and health)'],
        ['xp', 'XP'],
        ['gold', 'Gold'],
        ['str', 'Strength'],
        ['def', 'Defence'],
        ['agi', 'Agility'],
        ['sta', 'Stamina'],
        ['dex', 'Dexterity'],
        ['max_hp', 'Max health'],
        ['hp', 'Health'],
        ['vitality_hp', 'Health from potions'],
        ['wins', 'Wins'],
        ['losses', 'Losses'],
      ]
        .map(([k, l]) => field(k, l))
        .join('')}</div>
    <div class="card"><h3>Actions</h3>
      <p><button data-do="/admin/player/release" data-body="${esc(JSON.stringify({ id: p.id }))}" data-ok="Released">Release (end hunt / work / dungeon, clear all cooldowns)</button></p>
      <form data-submit="/admin/player/give" data-ok="Item added"><input type="hidden" name="id" value="${p.id}" data-num="1"><label>Give an item</label><select name="key">${items}</select> <button class="sm">Give</button></form>
      ${
        p.is_bot || window.MG_LOCAL
          ? ''
          : `<form data-submit="/admin/player" data-ok="Saved"><input type="hidden" name="id" value="${p.id}" data-num="1"><input type="hidden" name="field" value="is_admin"><input type="hidden" name="value" value="${p.is_admin ? 0 : 1}" data-num="1">
        ${pw}<p><button class="sec">${p.is_admin ? 'Remove admin rights' : 'Make admin'}</button></p></form>
      <form data-submit="/admin/player/password" data-ok="Password changed, the player was logged out"><input type="hidden" name="id" value="${p.id}" data-num="1"><label>New password for this player</label><input name="newPassword" type="password" autocomplete="new-password" minlength="${catalog?.passwordMin ?? 8}">${pw}<p><button class="sec">Set password</button></p></form>`
      }
      <form data-submit="/admin/player/delete" data-ok="Deleted" data-goto="#/admin/players" data-confirm="Delete ${esc(p.name)} and everything they own? There is no undo."><input type="hidden" name="id" value="${p.id}" data-num="1">${pw}<p><button class="bad">Delete this player</button></p></form></div>
    <div class="card"><h3>Inventory</h3>${p.inventory.length ? `<ul>${p.inventory.map((i) => `<li>${esc((catalog?.items ?? []).find((x) => x.key === i.item_key)?.name ?? i.item_key)}${i.hardening ? ` +${i.hardening}` : ''}</li>`).join('')}</ul>` : '<p class="muted">Empty.</p>'}</div></div>`;
}
