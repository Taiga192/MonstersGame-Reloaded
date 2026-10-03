// The "overview" page.
import { refresh } from '../api.js';
import { ico, img } from '../art.js';
import { LOCAL, catalog, isBusy, isHunting, isInDungeon, isWorking, me } from '../state.js';
import { STATS, bar, esc, fmt, raceName, when } from '../util.js';

export function pageOverview() {
  const b = me.battleStats;
  const stats = STATS.map(([k, n]) => {
    const extra = b[k] - me[k];
    return `<tr><td>${img('icons/stat_' + k)}${n}</td><td class="r">${me[k]}${extra ? ` <span class="good">+${extra}</span>` : ''}</td>
      <td class="r"><button class="sm" data-do="/train" data-body='{"stat":"${k}"}' ${me.gold < me.nextTrainCosts[k] || isBusy() ? 'disabled' : ''}>Train ${fmt(me.nextTrainCosts[k])}g</button></td></tr>`;
  }).join('');
  const inv = me.inventory.length ? me.inventory.map((i) => esc(i.name)).join(', ') : '<span class="muted">nothing</span>';
  const sen = me.sentinelOwned ? (catalog.sentinels.find((s) => s.key === me.sentinelOwned.sentinel_key)?.name ?? '?') : null;
  const skills =
    me.ancestralSkills
      .map((s) => {
        const a = Object.values(catalog.ancestral)
          .flat()
          .find((x) => x.key === s.skill_key);
        return `${esc(a?.name ?? s.skill_key)} Lv${s.level}`;
      })
      .join(', ') || '<span class="muted">none</span>';
  return `<div class="grid">
    <div class="card"><h2>${img('races/' + me.race, 'portrait', me.race)}${esc(me.name)}</h2>
      <p>${raceName(me.race)} · Level ${me.level} · ${me.wins}W / ${me.losses}L</p>
      <label>${img('icons/xp')}Experience</label>${bar('xp', me.xp, me.xpToNext, `${me.xp} / ${me.xpToNext}`)}
      <label>${img('icons/hp')}Health (+10/hour)</label>${bar('hp', me.hp, me.max_hp, `${me.hp} / ${me.max_hp}`)}
      <p class="gold">${ico('icons/gold', '')}${fmt(me.gold)} gold</p>
      ${isWorking() ? `<p class="bad">${img('ui/working')}Working in the graveyard: <b data-cd="${me.work_until}" data-refresh="1"></b> left</p>` : ''}
      ${isInDungeon() ? `<p class="bad">${ico('nav/dungeon', '🕳 ')}Inside the dungeon · <a href="#/dungeon">go to the dungeon</a></p>` : ''}
      <p class="${me.skillPoints ? 'gold' : 'muted'}">✦ Skill points: <b>${me.skillPoints}</b> · <a href="#/skills">open the skill board</a></p>
      <p class="muted">🩸 Animal blood ${fmt(me.blood)} / ${me.bloodMax}${me.level >= catalog.shrineLevel ? ` · <a href="#/shrine">Shrine: ${esc({ running: 'running', paused: 'paused', starved: 'out of blood', off: 'not started' }[me.shrine] ?? 'not built')}</a>` : ` · the shrine unlocks at level ${catalog.shrineLevel}`}</p>
      ${isHunting() ? `<p class="bad">${img('ui/hunting')}Out hunting: <b data-cd="${me.hunt_until}" data-refresh="1"></b> left · <a href="#/hunt">manage</a></p>` : ''}
    </div>
    <div class="card"><h2>Attributes</h2>
      <table><tr><th>Attribute</th><th class="r">Value</th><th></th></tr>${stats}</table>
      <p class="muted">Green = bonus from equipment, sentinel and ancestral skills. Training cost is value² − 5.</p></div>
  </div><div class="grid">
    <div class="card"><h3>Gear</h3><p>${inv}</p><p>Sentinel: ${sen ? esc(sen) : '<span class="muted">none</span>'}</p>
      <p>Ancestral skills: ${skills}</p><p class="muted">Hideout bonus: ${me.hideoutTotal} / 52</p></div>
    ${
      LOCAL
        ? ''
        : `<div class="card"><h3>Victim link</h3>
      <p class="muted">Share this. Each visitor can bite once per day and you earn 1–3 gold. New characters who join through it pay you 50 gold when they reach level 3.</p>
      <input readonly style="width:100%" value="${new URL('#/bite/' + me.id, document.baseURI).href}" data-select></div>`
    }
  </div>`;
}
