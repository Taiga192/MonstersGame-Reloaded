// The "town" page.
import { api, refresh } from '../api.js';
import { A, img } from '../art.js';
import { catalog, isBusy, isHunting, isInDungeon, isWorking, me, now } from '../state.js';
import { STATS, bar, esc, fmt, until, when } from '../util.js';

export const CATEGORIES = [
  ['weapon', '⚔ Weapons'],
  ['armor', '🛡 Armor'],
  ['ring', '💍 Rings'],
  ['amulet', '🔮 Amulets'],
  ['potion', '🧪 Potions'],
  ['component', '🩸 Shrine parts'],
];

export const catTabs = (base, cur, counts) =>
  `<div class="tabs">${CATEGORIES.map(([k, n]) => `<a href="#/town/${base}/${k}" class="${k === cur ? 'on' : ''}">${img('items/cat_' + k, 'nav-ico')}${n}${counts ? ` <span class="pill">${counts[k] ?? 0}</span>` : ''}</a>`).join('')}</div>`;

export async function pageTown(tab = 'store', sub, more) {
  const tabs = [
    ['store', 'Store'],
    ['inventory', 'Inventory'],
    ['temple', 'Blood Temple'],
    ['sentinels', 'Sentinels'],
    ['graveyard', 'Graveyard'],
    ['dealer', 'Relic Dealer'],
  ];
  const head = `<div class="tabs">${tabs.map(([k, n]) => `<a href="#/town/${k}" class="${k === tab ? 'on' : ''}">${n}</a>`).join('')}</div>`;
  const busy = isBusy();
  if (tab === 'inventory') {
    const cat = CATEGORIES.some(([k]) => k === sub) ? sub : (CATEGORIES.find(([k]) => me.inventory.some((i) => i.slot === k))?.[0] ?? 'weapon');
    const counts = Object.fromEntries(CATEGORIES.map(([k]) => [k, me.inventory.filter((i) => i.slot === k).length]));
    const rows = me.inventory
      .filter((i) => i.slot === cat)
      .sort((x, y) => Number(y.equipped) - Number(x.equipped))
      .map((i) => {
        const def = catalog.items.find((x) => x.key === i.key);
        const hardCost = Math.round(def.price * 0.25 * (i.hardening + 1));
        return `<tr><td>${img('items/' + i.key, 'item-ico')}${esc(i.name)}${i.hardening ? ` <span class="pill gold">+${i.hardening}</span>` : ''}${i.equipped ? ' <span class="pill good">equipped</span>' : ''}${def.minLevel > me.level ? ` <span class="pill bad">needs Lv ${def.minLevel}</span>` : ''}</td><td>${describe(def, i.hardening)}</td><td class="r">
        ${def.slot === 'potion' ? `<button class="sm" data-do="/inventory/use" data-body='{"inventoryId":${i.id}}' data-ok="Potion used" ${def.potion === 'maxhp' && me.vitality_hp >= catalog.vitalityCap ? 'disabled title="Maximum reached"' : ''}>Use</button>` : ''}
        ${def.slot === 'weapon' ? `<button class="sm sec" data-do="/inventory/harden" data-body='{"inventoryId":${i.id}}' ${i.hardening >= catalog.hardenMax || me.gold < hardCost || busy ? 'disabled' : ''}>${i.hardening >= catalog.hardenMax ? 'Max' : `Harden ${fmt(hardCost)}g`}</button>` : ''}
        ${def.slot === 'component' ? `<button class="sm" data-do="/shrine/install" data-body='{"inventoryId":${i.id}}' data-ok="Installed in the shrine" ${busy ? 'disabled' : ''}>Install in shrine</button>` : ''}
        <button class="sm sec" data-do="/inventory/sell" data-body='{"inventoryId":${i.id}}' data-confirm="Sell to the shop for ${fmt(Math.floor(def.price / 2))}g?" data-ok="Sold">Shop ${fmt(Math.floor(def.price / 2))}g</button>
        <input id="tp-${i.id}" type="number" min="1" placeholder="price" value="${def.price}" style="width:6rem;padding:.15rem .3rem">
        <button class="sm" data-do="/temple/list" data-body='{"inventoryId":${i.id}}' data-from="#tp-${i.id}:price" data-ok="Listed in the Blood Temple" ${busy ? 'disabled' : ''}>List in Temple</button></td></tr>`;
      })
      .join('');
    return `${head}<div class="card"><h2>Inventory</h2><p class="muted">The best usable item of each category is equipped automatically. The shop buys back at 50%; the Blood Temple lets you sell to other players at your own price (${Math.round(catalog.templeFee * 100)}% fee). Hardening a weapon adds +${catalog.hardenBonus} Strength per level (max +${catalog.hardenMax}).</p>
      ${catTabs('inventory', cat, counts)}
      ${cat === 'potion' ? vitalityNote() : ''}
      ${rows ? `<table><tr><th>Item</th><th>Effect</th><th></th></tr>${rows}</table>` : `<p class="muted">You own nothing in this category.</p>`}</div>`;
  }
  if (tab === 'temple') {
    const list = await api('/temple');
    const rows = list
      .map((l) => {
        const def = catalog.items.find((x) => x.key === l.item_key);
        return `<tr><td>${img('items/' + def.key, 'item-ico')}${esc(def.name)}${l.hardening ? ` <span class="pill gold">+${l.hardening}</span>` : ''}</td><td>${describe(def, l.hardening)}</td><td class="r">Lv ${def.minLevel}</td>
        <td><a href="#/player/${l.seller_id}">${esc(l.seller)}</a></td><td class="muted">${until(l.expires_at) ?? 'expired'}</td>
        <td class="r">${
          l.mine
            ? `<button class="sm sec" data-do="/temple/cancel" data-body='{"listingId":${l.id}}' data-ok="Listing withdrawn">Withdraw</button>`
            : `<button class="sm" data-do="/temple/buy" data-body='{"listingId":${l.id}}' ${me.level < def.minLevel || me.gold < l.price || busy ? 'disabled' : ''}>${fmt(l.price)}g</button>`
        }</td></tr>`;
      })
      .join('');
    return `${head}<div class="card"><h2>Blood Temple</h2><p class="muted">Players trade items here. List items from your Inventory tab. The temple keeps ${Math.round(catalog.templeFee * 100)}% of every sale; unsold listings return to you after 7 days.</p>
      ${rows ? `<table><tr><th>Item</th><th>Effect</th><th class="r">Level</th><th>Seller</th><th>Expires</th><th></th></tr>${rows}</table>` : '<p class="muted">No offers right now.</p>'}</div>`;
  }
  if (tab === 'sentinels') {
    const own = me.sentinelOwned;
    const list = catalog.sentinels
      .map((s) => {
        const locked = me.level < Math.max(5, s.minLevel),
          prem = false;
        return `<tr><td>${img('sentinels/' + s.key, 'item-ico')}${esc(s.name)}</td><td class="r">${s.atk}</td><td class="r">${s.def}</td><td class="r">${s.sta}</td>
        <td class="r">Lv ${Math.max(5, s.minLevel)}</td><td class="r"><button class="sm" data-do="/sentinel/buy" data-body='{"key":"${s.key}"}' data-ok="Sentinel acquired"
        ${locked || prem || own || me.gold < s.price ? 'disabled' : ''}>${fmt(s.price)}g</button></td></tr>`;
      })
      .join('');
    const ownDef = own && catalog.sentinels.find((s) => s.key === own.sentinel_key);
    const costs = me.sentinelTrainCosts;
    return `${head}${me.level < 5 ? '<div class="card bad">Sentinels unlock at level 5.</div>' : ''}
      ${
        own
          ? `<div class="card"><h2>${img('sentinels/' + ownDef.key, 'portrait', ownDef.name)}${esc(ownDef.name)}</h2>
        <p>Attack ${ownDef.atk} <b class="good">+${own.t_atk}</b> · Defense ${ownDef.def} <b class="good">+${own.t_def}</b> · Stamina ${ownDef.sta} <b class="good">+${own.t_sta}</b></p>
        <div class="row">${['atk', 'def', 'sta'].map((a) => `<button class="sm" data-do="/sentinel/train" data-body='{"attr":"${a}"}' ${me.gold < costs[a] ? 'disabled' : ''}>Train ${a} (${fmt(costs[a])}g)</button>`).join('')}
        <button class="sm sec" data-do="/sentinel/dismiss" data-confirm="Dismiss and get ${fmt(ownDef.price)}g back? Training is lost." data-ok="Dismissed">Dismiss (+${fmt(ownDef.price)}g)</button></div>
        <p class="muted">Its attributes are added to yours in every fight. Dismissing refunds the full price, so sentinels also work as a gold bank.</p></div>`
          : ''
      }
      <div class="card"><h2>Sentinel market</h2><table><tr><th>Name</th><th class="r">Atk</th><th class="r">Def</th><th class="r">Sta</th><th class="r">Level</th><th></th></tr>${list}</table></div>`;
  }
  if (tab === 'dealer') {
    const d = await api('/dungeon');
    const rows = d.loot
      .map(
        (
          l,
        ) => `<tr><td>${img('icons/loot', 'item-ico')}${esc(l.name)}${l.milestone ? ' <span class="pill gold">guardian reward</span>' : ''}</td><td class="r">found on level ${l.depth}</td>
      <td class="r"><button class="sm" data-do="/dungeon/sell" data-body='{"lootId":${l.id}}' ${isInDungeon() ? 'disabled' : ''}>Sell ${fmt(l.value)}g</button></td></tr>`,
      )
      .join('');
    return `${head}<div class="card"><h2>Relic Dealer</h2>
      <p class="muted">"Bring me what the dungeon gave you and I pay in gold." Loot found in the dungeon is worth more the deeper it came from and never expires.${isInDungeon() ? ' <b class="bad">You cannot trade while you are inside the dungeon.</b>' : ''}</p>
      ${rows ? `<table>${rows}</table><p><button data-do="/dungeon/sell" data-body='{"lootId":"all"}' ${isInDungeon() ? 'disabled' : ''}>Sell everything for ${fmt(d.lootValue)} gold</button></p>` : '<p class="muted">You have nothing to sell. Fight monsters in the <a href="#/dungeon">dungeon</a>: each one has a 25% chance to drop something valuable.</p>'}</div>`;
  }
  if (tab === 'graveyard') {
    const wage = 5 + me.level * 2;
    let body;
    if (isWorking()) {
      const worked = Math.floor((now() - me.work_started) / 60000);
      body = `<p class="bad">You are digging graves and cannot do anything else. Shift ends in <b data-cd="${me.work_until}" data-refresh="1"></b>.</p>
        <div class="bar xp" data-progress="${me.work_started},${me.work_until}"><i style="width:0"></i><span></span></div>
        <p class="muted">Quit early and you are paid for the time already worked (${wage}g per hour, to the minute).</p>
        <button class="sec" data-do="/work/cancel" data-confirm="Quit the shift now? You are paid for the time worked so far.">Quit and get paid for time worked</button>`;
    } else if (me.work_started) body = `<p class="good">Shift over!</p><button data-do="/work/collect">Collect ${fmt(me.work_hours * wage)} gold</button>`;
    else if (isInDungeon()) body = `<p class="bad">You are inside the dungeon. Leave it first.</p>`;
    else if (isHunting() || me.hunt_started)
      body = `<p class="bad">${img('ui/hunting')}You are busy hunting. Finish or cancel the hunt (and collect it) first.</p>`;
    else
      body = `<p>Wage: <span class="gold">${wage}g/hour</span>. A shift can last up to 48 hours, so you can leave the game running and come back later. You cannot do anything else while working, but you can quit early for pro-rata pay.</p>
      <div class="row"><select id="hours">${Array.from({ length: 48 }, (_, i) => `<option value="${i + 1}">${i + 1} hour${i ? 's' : ''}${i + 1 >= 24 && (i + 1) % 24 === 0 ? ` (${(i + 1) / 24} day${i + 1 > 24 ? 's' : ''})` : ''} — ${fmt((i + 1) * wage)}g</option>`).join('')}</select>
      <button data-do="/work/start" data-from="#hours:hours">Start working</button></div>`;
    return `${head}<div class="card"><h2>Graveyard work</h2>${body}</div>`;
  }
  if (tab === 'shrine') {
    location.replace('#/shrine');
    return head;
  } // (the shrine used to be a Town tab)
  const cat = CATEGORIES.some(([k]) => k === sub) ? sub : 'weapon';
  const counts = Object.fromEntries(CATEGORIES.map(([k]) => [k, catalog.items.filter((i) => i.slot === k && !i.noShop).length]));
  const owned = (key) => me.inventory.filter((i) => i.key === key).length;
  // every gear line (Blade, Plate, ...) is listed on its own, tier by tier; items far above your level stay folded away
  const lineOf = (i) => i.key.replace(/_\d+$/, '');
  const all = catalog.items
    .filter((i) => i.slot === cat && !i.noShop)
    .sort(
      (x, y) =>
        (lineOf(x) === lineOf(y)
          ? x.minLevel - y.minLevel
          : catalog.items.findIndex((z) => lineOf(z) === lineOf(x)) - catalog.items.findIndex((z) => lineOf(z) === lineOf(y))) || x.price - y.price,
    );
  const shown = more === 'all' ? all : all.filter((i) => i.minLevel <= me.level + 8 || owned(i.key));
  let lastLine = '';
  const rows = shown
    .map((i) => {
      const locked = me.level < i.minLevel;
      const header =
        lineOf(i) !== lastLine && all.some((z) => lineOf(z) !== lineOf(i)) ? `<tr><th colspan="4">${esc(i.name.replace(/\s*(Mk )?\d+$/, ''))}</th></tr>` : '';
      lastLine = lineOf(i);
      return `${header}<tr class="${locked ? 'muted' : ''}"><td>${img('items/' + i.key, 'item-ico')}${esc(i.name)}${owned(i.key) ? ` <span class="pill good">owned ×${owned(i.key)}</span>` : ''}</td><td>${describe(i)}</td><td class="r">Lv ${i.minLevel}</td>
      <td class="r"><button class="sm" data-do="/store/buy" data-body='{"key":"${i.key}"}' data-ok="Purchased ${esc(i.name)}"
      ${locked || busy || me.gold < i.price || (i.potion === 'maxhp' && me.vitalityRoom <= 0) ? 'disabled' : ''}>${fmt(i.price)}g</button></td></tr>`;
    })
    .join('');
  const hidden = all.length - shown.length;
  const foot =
    more === 'all'
      ? `<p><a href="#/town/store/${cat}">Show only items near my level</a></p>`
      : hidden
        ? `<p class="muted">${hidden} more item${hidden === 1 ? '' : 's'} for higher levels. <a href="#/town/store/${cat}/all">Show all</a></p>`
        : '';
  return `${head}<div class="card"><h2>Store</h2>${catTabs('store', cat, counts)}${cat === 'potion' ? vitalityNote() : ''}<table><tr><th>Item</th><th>Effect</th><th class="r">Level</th><th></th></tr>${rows}</table>${foot}</div>`;
}

/** Vitality Potions add permanent max HP, capped in total (see CFG.vitalityCap). */
export function vitalityNote() {
  const used = me.vitality_hp,
    cap = catalog.vitalityCap;
  return `<p class="muted">🧪 <b>Vitality Potions</b> add +${catalog.vitalityGain} max HP permanently, but only up to <b>+${cap}</b> in total. Gained so far: <b class="${used >= cap ? 'bad' : 'good'}">${used} / ${cap}</b>${me.vitalityRoom > 0 ? ` · you can still use ${me.vitalityRoom} more (counting potions already in your bag)` : ' · <b>no more can be used</b>, so none can be bought'}.</p>`;
}

export function describe(i, hardening = 0) {
  const parts = STATS.filter(([k]) => i.bonus[k] || (k === 'str' && hardening && i.slot === 'weapon')).map(
    ([k]) => `+${(i.bonus[k] ?? 0) + (k === 'str' && i.slot === 'weapon' ? hardening * catalog.hardenBonus : 0)} ${k.toUpperCase()}`,
  );
  if (i.goldBonus) parts.push(`+${Math.round(i.goldBonus * 100)}% raid gold`);
  if (i.huntBonus && i.huntBonus < 1000) parts.push(`+${i.huntBonus} hunt`);
  if (i.key === 'amulet_perfection') parts.push('hunts never fail');
  if (i.potion)
    parts.push({ heal: 'full heal', maxhp: `+${catalog.vitalityGain} max HP (max +${catalog.vitalityCap} in total)`, stat: '+10% stats 1h' }[i.potion]);
  if (i.key === 'amulet_healing') parts.push('healing');
  if (i.component) {
    const { kind, tier } = i.component;
    parts.push(
      {
        chalice: `+${catalog.shrineTankPerTier * tier} blood tank`,
        altar: `+${catalog.shrineSlotsPerTier * tier} routine step${tier > 1 ? 's' : ''}`,
        idol: tier === 1 ? 'unlocks dungeon automation' : `+${Math.round(catalog.shrineBloodBonus * 100)}% blood gathered`,
      }[kind],
      `+${Math.round(catalog.shrineEfficiencyPerUpgrade * 1000) / 10}% shrine efficiency`,
    );
  }
  return parts.join(', ') || '—';
}

export function pageHideout() {
  const rows = Object.entries(catalog.hideoutMax)
    .map(([k, max]) => {
      const lv = me.hideout[k];
      return `<tr><td style="text-transform:capitalize">${k}</td><td style="width:45%">${bar('', lv, max, `${lv} / ${max}`)}</td>
      <td class="r"><button class="sm" data-do="/hideout/upgrade" data-body='{"component":"${k}"}' data-ok="Upgraded ${k}" ${lv >= max || me.gold < me.hideoutCosts[k] ? 'disabled' : ''}>${lv >= max ? 'Max' : `Upgrade ${fmt(me.hideoutCosts[k])}g`}</button></td></tr>`;
    })
    .join('');
  const tiles = Object.keys(catalog.hideoutMax)
    .map((k) => {
      const lv = me.hideout[k];
      const im = lv ? img(`hideout/${k}_${lv}`, 'tile', `${k} ${lv}`) : '';
      return im ? `<figure>${im}<figcaption>${k} ${lv}</figcaption></figure>` : '';
    })
    .join('');
  return `${tiles ? `<div class="tiles">${tiles}</div>` : ''}<div class="card" style="max-width:640px"><h2>Your hideout</h2>
    <p class="muted">Each level adds 1 Defense when you are attacked at home and makes you harder to find. Enemy Dexterity reduces the defense bonus.</p>
    <table>${rows}</table><p>Total bonus: <b>${me.hideoutTotal}</b> / 52</p></div>`;
}

export function pageAncestral() {
  if (me.level < 20) return `<div class="card"><h2>Ancestral Site</h2><p class="bad">Unlocks at level 20.</p></div>`;
  const cd = until(me.ancestralReadyAt);
  const skills = me.ancestralSkills
    .map((s) => {
      const a = Object.values(catalog.ancestral)
        .flat()
        .find((x) => x.key === s.skill_key);
      return `<tr><td>${img('ancestral/' + s.skill_key, 'item-ico')}${esc(a?.name)}</td><td>${a?.stat.toUpperCase()}</td><td class="r">Lv ${s.level}</td><td class="r good">+${s.level * 5}</td></tr>`;
    })
    .join('');
  return `<div class="card" style="max-width:640px">${img('ancestral/site', 'scene wide')}<h2>Ancestral Site</h2>
    <p>Fight the spirit of your ancestor to learn or improve a race ability. Once every 24 hours; the fee grows with every victory.</p>
    <p>Skill slots: <b>${me.ancestralSlots}</b> (1 at Lv20, 2 at Lv40, 3 at Lv60, 4 at Lv80) · Fee: <span class="gold">${fmt(me.ancestralFee)}g</span></p>
    <p>Ready in: <b data-cd="${me.ancestralReadyAt}" data-ready="now">${cd ?? 'now'}</b></p>
    <button data-do="/ancestral/challenge" ${cd || me.gold < me.ancestralFee ? 'disabled' : ''}>Challenge your ancestor</button>
    ${skills ? `<table style="margin-top:1rem"><tr><th>Ability</th><th>Stat</th><th class="r">Level</th><th class="r">Bonus</th></tr>${skills}</table>` : ''}
    <p class="muted">Abilities only apply in fights where both fighters are level 20+.</p></div>`;
}
