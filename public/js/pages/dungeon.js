// The "dungeon" page.
import { api, refresh } from '../api.js';
import { img } from '../art.js';
import { dungeonResult, isHunting, isWorking, now } from '../state.js';
import { bar, dur, esc, fmt, until, when } from '../util.js';

export const THREAT = {
  trivial: ['trivial', 'good'],
  easy: ['easy', 'good'],
  even: ['an even fight', 'gold'],
  dangerous: ['dangerous', 'bad'],
  deadly: ['deadly', 'bad'],
};

export function fightHtml(r) {
  if (!r) return '';
  const lines = r.log
    .map(
      (l) =>
        `<div>R${l.round}: ${l.who === 'you' ? 'You' : esc(r.monster.name)} ${l.hit ? `hit${l.who === 'you' ? '' : 's you'} for <b>${l.damage}</b>` : '<span class="muted">miss' + (l.who === 'you' ? '' : 'es') + '</span>'} · you ${l.hpYou} HP · monster ${l.hpMonster} HP</div>`,
    )
    .join('');
  return `<h3>${r.won ? '✔ Level ' + r.depth + ' cleared' : '✖ Defeated on level ' + r.depth}</h3>
    <p>${esc(r.monster.name)}${r.monster.guardian ? ' <span class="pill gold">guardian</span>' : ''} · ${r.rounds} rounds · you lost <b>${r.hpLost}</b> HP${r.won ? ` (${r.hpLeft} left)` : ''}</p>
    ${r.won && r.checkpoint ? `<p class="gold">🚩 Checkpoint! Level ${r.checkpoint} is saved: after the weekly reset you continue from here.</p>` : ''}
    ${r.won ? `<p class="good">+${r.xp} XP${r.levelsGained ? ' — LEVEL UP!' : ''}${r.drop ? ` · dropped <b>${esc(r.drop.name)}</b> (${fmt(r.drop.value)}g)` : ' · nothing dropped'}</p>` : '<p class="muted">You keep all XP and items. The run is over; this level is still to be beaten.</p>'}
    <details><summary class="muted">Round by round</summary><div class="log">${lines}</div></details>`;
}

export async function pageDungeon() {
  const d = await api('/dungeon');
  const m = d.monster,
    [threatText, threatCls] = THREAT[m.threat];
  const cd = until(d.cooldownUntil);
  const week = `resets in ${until(d.weekEndsAt) ?? 'a moment'}`;
  const summary = `<p class="muted">This week (${week}): cleared <b>${d.cleared}</b> levels · ${d.kills} kills · ${d.deaths} deaths · ${d.runs} runs · +${d.xpWeek} XP · best ever <b>${d.bestEver}</b></p>
    <p class="muted">🚩 Checkpoint: ${d.checkpoint > 1 ? `you restart each week from level <b>${d.checkpoint}</b>` : 'none yet, every week starts on level 1'} · next one on level <b>${d.nextCheckpoint}</b> (every ${d.checkpointEvery} levels; you have to reach it to keep it)</p>`;
  const monsterCard = `<div class="row" style="align-items:flex-start">${img(`dungeon/${m.guardian ? 'guardian' : 'monster'}_${m.tier + 1}`, 'portrait')}
      <div><h2 style="border:0;margin:0">Level ${m.depth}${m.guardian ? ' <span class="pill gold">guardian</span>' : ''}</h2>
      <p style="margin:.2rem 0"><b>${esc(m.name)}</b> · <span class="${threatCls}">${threatText}</span></p>
      <p class="muted" style="margin:0">Reward: <b class="good">+${m.xp} XP</b> · ${Math.round(d.dropChance * 100)}% chance of a valuable drop${m.guardian ? ' · <b class="gold">choose 1 of 3 rewards</b>' : ''}</p></div></div>`;

  const choice = d.pending
    ? `<div class="card" style="border-color:var(--gold)"><h2>🏆 Guardian defeated!</h2>
      <p>Choose <b>one</b> reward. You can sell it to the relic dealer in town. The others are lost.</p>
      <div class="grid">${d.pending
        .map(
          (
            o,
            i,
          ) => `<div class="card" style="margin:0"><h3>${img('icons/loot', 'item-ico')}${esc(o.name)}</h3><p class="gold" style="font-size:1.2rem;margin:.3rem 0">${fmt(o.value)} gold</p>
        <button data-do="/dungeon/reward" data-body='{"index":${i}}'>Take this</button></div>`,
        )
        .join('')}</div></div>`
    : '';

  let main;
  if (d.active) {
    main = `<div class="card">${monsterCard}
      <p style="margin-top:.8rem"><span class="muted">Dungeon HP (separate from your real HP, never regenerates here)</span></p>
      ${bar('hp', d.hp, d.maxHp, `${d.hp} / ${d.maxHp}`)}
      <p class="muted">You are dragged out if you do nothing for ${Math.round(d.idleLimit / 60000)} minutes (progress is kept): <b data-cd="${d.idleUntil}" data-refresh="1"></b></p>
      <div class="row"><button data-do="/dungeon/fight" ${d.pending || d.readyAt > now() ? 'disabled' : ''}>⚔ Fight</button>
        ${d.readyAt > now() ? `<span class="muted">The next monster arrives in <b data-cd="${d.readyAt}" data-refresh="1">${until(d.readyAt) ?? ''}</b></span>` : ''}
        <button class="sec" data-do="/dungeon/leave" data-confirm="Leave the dungeon? Progress is saved, but you can only enter the dungeon once per day: the next run is possible in ${dur(d.cooldown)}.">🚪 Leave</button>
        ${d.pending ? '<span class="muted">Choose your reward first.</span>' : ''}</div>
      ${dungeonResult ? '<hr>' + fightHtml(dungeonResult) : ''}</div>`;
  } else {
    const blocked = isHunting() || isWorking();
    main = `<div class="card"><h2>Enter the dungeon</h2>${dungeonResult && dungeonResult.died ? `<p class="bad">You died on level ${dungeonResult.depth}. XP and items are safe.</p>` : ''}
      <p>Next up:</p>${monsterCard}
      <p style="margin-top:.8rem"><button data-do="/dungeon/enter" ${d.canEnter && !blocked ? '' : 'disabled'}>Descend</button>
        ${!d.canEnter ? `<span class="muted"> You can enter again in <b data-cd="${d.cooldownUntil}" data-refresh="1">${cd ?? ''}</b></span>` : ''}
        ${blocked ? '<span class="bad"> Finish or cancel your hunt / work first.</span>' : ''}</p>
      <ul class="muted"><li>You enter with a <b>full dungeon HP pool</b> equal to your max HP, independent of your real HP.</li>
        <li>One monster per level, stronger every level. Winning gives XP, a ${Math.round(d.dropChance * 100)}% drop chance and takes you one level deeper. Dungeon HP is <b>not restored</b> during a run.</li>
        <li>${d.fightCooldown ? `After every victory the next monster needs <b>${dur(d.fightCooldown)}</b> to arrive, so a long run takes real time (you are locked inside meanwhile).` : 'Monsters come one after the other.'}</li>
        <li>Every ${d.milestone}th level is a guardian: beat it to choose one of three high value rewards.</li>
        <li>Every ${d.checkpointEvery}th level is a <b>checkpoint</b>: if you reach it, the weekly reset sends you back there instead of level 1. Miss it and you start over.</li>
        <li>Dying costs nothing (XP and items are kept) but ends the run. Progress is saved when you leave or die and <b>resets every Monday</b> (to your last checkpoint).</li>
        <li>While inside you cannot be raided and cannot raid, hunt or work. <b>One run per day:</b> after leaving or dying you can re-enter ${dur(d.cooldown)} later.</li></ul>
      ${dungeonResult ? '<hr>' + fightHtml(dungeonResult) : ''}</div>`;
  }
  const loot = `<div class="card"><div class="row sp"><h3 style="margin:0">Your loot</h3><a href="#/town/dealer">Relic Dealer →</a></div>
    ${
      d.loot.length
        ? `<p>${d.loot.length} item${d.loot.length === 1 ? '' : 's'} worth <span class="gold">${fmt(d.lootValue)}g</span>: ${d.loot
            .slice(0, 6)
            .map((l) => esc(l.name))
            .join(', ')}${d.loot.length > 6 ? '…' : ''}</p>`
        : '<p class="muted">Nothing yet.</p>'
    }
    <p class="muted">Sell loot to the dealer in town (not possible inside the dungeon). <a href="#/highscore/dungeon/all">This week's ranking</a></p></div>`;
  return `${summary}${choice}${main}${loot}`;
}
