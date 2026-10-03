// The "quests" page.
import { api } from '../api.js';
import { bar, esc, fmt, until } from '../util.js';

// ---------- weekly quests ----------
export const CAT_ICON = {
  hunt: '🏹',
  work: '⚰',
  pvp: '⚔',
  war: '🏰',
  dungeon: '🕳',
  arena: '🏟',
  ancestral: '👻',
  economy: '💰',
  progress: '⭐',
  social: '💬',
  shrine: '🩸',
};

export const SPECIAL_ICON = { blood: '🩸', potions: '🧪', loot: '💎' };

export async function pageQuests() {
  const q = await api('/quests');
  const left = until(q.endsAt) ?? 'a moment';
  const card = (x) => {
    const pct = Math.round((x.progress / x.target) * 100);
    const rewards = x.claimed
      ? ''
      : `<div class="row" style="gap:.3rem">${[
          ['gold', `💰 ${fmt(x.rewards.gold)} gold`],
          ['xp', `✨ ${fmt(x.rewards.xp)} XP`],
          ['special', `${SPECIAL_ICON[x.rewards.special.kind]} ${x.rewards.special.label}`],
        ]
          .map(([k, label]) =>
            x.done && !x.locked
              ? `<button class="sm" data-do="/quests/claim" data-body='${esc(JSON.stringify({ quest: x.id, choice: k }))}' title="Choose this reward">${esc(label)}</button>`
              : `<span class="pill" title="${x.locked ? 'locked' : 'you choose one when it is done'}">${esc(label)}</span>`,
          )
          .join('')}</div>`;
    return `<div class="card quest ${x.claimed ? 'claimed' : x.done && !x.locked ? 'done' : ''} ${x.locked ? 'locked' : ''}" style="margin:0">
      <div class="row sp"><b>${CAT_ICON[x.category] ?? '•'} ${esc(x.title)}</b><span class="pill ${esc(x.tier)}">${esc(x.tier)}</span></div>
      <div>${esc(x.text)}</div>
      ${bar('xp', x.progress, x.target, `${fmt(x.progress)} / ${fmt(x.target)}`)}
      ${x.locked ? `<div class="muted">🔒 Unlocks at level ${x.minLevel}</div>` : x.claimed ? `<div class="good">✔ Reward taken: ${esc({ gold: 'gold', xp: 'XP', special: 'special' }[x.claimed])}</div>` : x.done ? '<div class="gold"><b>Done! Choose your reward:</b></div>' : '<div class="muted">Your reward (choose one when done):</div>'}
      ${rewards}</div>`;
  };
  return `<div class="card"><div class="row sp"><h2 style="border:0;margin:0">Weekly quests</h2><span class="muted">${q.claimed} of ${q.quests.length} rewards taken · new quests in <b>${esc(left)}</b></span></div>
    <p class="muted">The same ten quests for everybody this week, new ones every Monday. You can plan: nothing is daily. Every finished quest lets you choose <b>one</b> of three rewards, and they grow with your level. What you do not claim before Monday is gone. Progress counts from Monday on, whatever you did before.</p></div>
    <div class="grid">${q.quests.map(card).join('')}</div>`;
}
