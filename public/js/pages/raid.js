// The "raid" page.
import { isBusy, isHunting, isInDungeon, lastResult, me } from '../state.js';
import { bar, esc, fmt, raceName, until } from '../util.js';

export function pageRaid() {
  const cd = until(me.attackReadyAt);
  const busy = isBusy();
  const canGo = !cd && !busy && me.hp >= 25;
  const found = me.found;
  const r = lastResult;
  const potion = me.inventory.find((i) => i.key === 'potion_heal');
  return `<div class="grid"><div class="card"><h2>Raid the enemy</h2>
    <p>Hunt down a ${raceName(me.race === 'vampire' ? 'werewolf' : 'vampire')} and steal their gold.</p>
    ${bar('hp', me.hp, me.max_hp, `HP ${me.hp} / ${me.max_hp}`)}
    <p>Attack cooldown: <b data-cd="${me.attackReadyAt}" data-ready="ready">${cd ?? 'ready'}</b></p>
    ${
      me.hp < 25
        ? `<p class="bad">You need at least 25 HP to raid or be raided. Health regenerates 10 per hour.</p>
      ${
        potion
          ? `<p><button class="sec" data-do="/inventory/use" data-body='{"inventoryId":${potion.id}}' data-ok="Fully healed">Use health potion</button></p>`
          : '<p class="muted">Buy a Health Potion in Town → Store (40g) to heal instantly.</p>'
      }`
        : ''
    }
    ${busy ? `<p class="bad">You are ${isInDungeon() ? 'inside the dungeon' : isHunting() ? 'out hunting' : 'working in the graveyard'} and cannot raid.</p>` : ''}
    <button data-do="/raid/search" ${canGo ? '' : 'disabled'} data-ok="Search finished">Search for an opponent</button>
    ${
      found
        ? `<hr><h3>Target found</h3><p><b class="${found.race}">${esc(found.name)}</b> · Level ${found.level}</p>
      <button data-do="/raid/attack" data-body='{"targetId":${found.id}}'>⚔ Attack!</button>`
        : ''
    }
    <p class="muted">Search fails sometimes: your Dexterity is weighed against the target's hideout.</p>
  </div>
  <div class="card"><h2>Last battle</h2>${r ? battleHtml(r) : '<p class="muted">Nothing yet.</p>'}</div></div>`;
}

export function battleHtml(r) {
  return `${r.target ? `<p>Target: <b>${esc(r.target.name)}</b> (Lv ${r.target.level})${r.warId ? ' <span class="pill bad">clan war</span>' : ''}</p>` : ''}<p><b>${esc(r.winner)}</b> won after ${r.rounds} rounds.</p>
    <p>Gold looted: <span class="gold">${fmt(r.gold)}</span> · XP: you ${r.xpAttacker}, enemy ${r.xpDefender}</p>
    <p>HP left: you ${Math.floor(r.attackerHp)}, enemy ${Math.floor(r.defenderHp)}</p>
    <a href="#/messages/${r.battleId}">View round-by-round log →</a>`;
}
