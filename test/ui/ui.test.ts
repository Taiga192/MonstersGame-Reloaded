import assert from 'node:assert/strict';
import { frontendBundle } from '../support/frontend.ts';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { JSDOM } from 'jsdom';
import { createApp } from '../../src/server/create-app.ts';
import { openDb } from '../../src/db/node.ts';
import { seeded } from '../../src/core/rng.ts';

/** Loads the real frontend into jsdom, wired straight to the in-process API. */
async function boot() {
  const clock = { offset: 0 };
  const db = openDb();
  const app = createApp({ db, now: () => 1_800_000_000_000 + clock.offset, rng: seeded(7), devClock: clock });
  const dom = new JSDOM(readFileSync('public/index.html', 'utf8'), { url: 'http://localhost/', runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window as any;
  const errors: string[] = [];
  w.addEventListener('error', (e: any) => errors.push(e.message));
  w.fetch = (url: string, init?: RequestInit) =>
    app.request(
      '/' +
        String(url)
          .replace(/^https?:\/\/localhost\/?/, '')
          .replace(/^\//, ''),
      init,
    );
  w.confirm = () => true;
  w.eval(frontendBundle());
  const doc = w.document as Document;
  const until = async (cond: () => boolean, what: string) => {
    for (let i = 0; i < 500; i++) {
      if (cond()) return;
      await new Promise((r) => setTimeout(r, 20));
    }
    {
      const e = new Error(
        `timeout waiting for ${what}\nVIEW: ${doc.querySelector('#view')!.textContent!.slice(0, 300)}\nTOAST: ${doc.querySelector('#toast')!.textContent}`,
      );
      w.close();
      throw e;
    }
  };
  const view = () => doc.querySelector('#view')!;
  const go = async (hash: string, text: string) => {
    w.location.hash = hash;
    await until(() => view().textContent!.includes(text), `${hash} → "${text}"`);
  };
  const click = (sel: string, text?: string) => {
    const el = [...doc.querySelectorAll<HTMLElement>(sel)].find((e) => !text || e.textContent!.includes(text));
    assert.ok(el, `no element ${sel} ${text ?? ''}`);
    assert.ok(!(el as HTMLButtonElement).disabled, `${sel} ${text} is disabled`);
    el.click();
    return el;
  };
  return { w, doc, db, until, view, go, click, errors, close: () => w.close() };
}

test('UI: register, browse every page, train, raid with bots, dev tools', async () => {
  const { w, doc, until, view, go, click, errors, close } = await boot();
  try {
    await until(() => !!doc.querySelector('#reg'), 'login page');
    await new Promise((r) => setTimeout(r, 50)); // the page attaches its form handlers a tick after rendering

    // register
    (doc.querySelector('#reg [name=name]') as HTMLInputElement).value = 'Tester';
    (doc.querySelector('#reg [name=password]') as HTMLInputElement).value = 'secret12';
    doc.querySelector('#reg')!.dispatchEvent(new w.Event('submit', { cancelable: true }));
    await until(() => view().textContent!.includes('Attributes'), 'overview');
    assert.match(view().textContent!, /Vampire/);

    // train Strength
    click('button', 'Train');
    await until(() => /Strength\s*6/.test(view().textContent!), 'strength 6');

    // dev tools: level 25 + gold + bots
    const dev = async (sel: string) => {
      (doc.querySelector(sel) as HTMLElement).click();
      await new Promise((r) => setTimeout(r, 150));
    };
    (doc.querySelector('#dl') as HTMLInputElement).value = '25';
    await dev('[data-dev=level]');
    await dev('[data-dev=grant]');
    (doc.querySelector('#dn') as HTMLInputElement).value = '30';
    await dev('[data-dev=bots]');

    // every page renders without an error card
    for (const [hash, text] of [
      ['#/overview', 'Attributes'],
      ['#/raid', 'Raid the enemy'],
      ['#/hunt', 'Manhunt'],
      ['#/town/store', 'Store'],
      ['#/town/inventory', 'Inventory'],
      ['#/town/sentinels', 'Sentinel market'],
      ['#/town/graveyard', 'Graveyard work'],
      ['#/hideout', 'Your hideout'],
      ['#/ancestral', 'Ancestral Site'],
      ['#/clan', 'Found a clan'],
      ['#/messages', 'Battle reports'],
      ['#/highscore', 'Highscore'],
    ] as const) {
      await go(hash, text);
      assert.ok(!doc.querySelector('#view .card.bad'), `${hash} rendered an error: ${view().textContent}`);
    }

    // buy a weapon and a sentinel
    await go('#/town/store', 'Store');
    click('button', 'g');
    await until(() => doc.querySelector('#toast')!.textContent!.includes('Purchased'), 'purchase toast');
    await go('#/town/sentinels', 'Sentinel market');
    click('[data-do="/sentinel/buy"]');
    await until(() => view().textContent!.includes('Dismiss'), 'owned sentinel');

    // hunt
    await go('#/hunt', 'Manhunt');
    click('button', 'Start hunting');
    await until(() => view().textContent!.includes('cannot do anything else'), 'hunt in progress');
    assert.ok(doc.querySelector('[data-progress]'), 'progress bar shown');
    await go('#/overview', 'Attributes');
    assert.ok((doc.querySelector('[data-do="/train"]') as HTMLButtonElement).disabled, 'training locked while hunting');
    await go('#/hunt', 'Manhunt');
    await dev('[data-dev=skip][data-m="10"]');
    await go('#/hunt', 'Manhunt');
    await until(() => view().textContent!.includes('Collect spoils'), 'hunt finished');
    click('button', 'Collect spoils');
    await until(() => view().textContent!.includes('Hunt complete'), 'hunt result');
    // second hunt, cancelled immediately
    click('button', 'Start hunting');
    await until(() => view().textContent!.includes('Cancel hunt'), 'second hunt');
    click('button', 'Cancel hunt');
    await until(() => view().textContent!.includes('Hunt abandoned'), 'cancelled');

    // raid: search until found, then attack
    await go('#/raid', 'Raid the enemy');
    let attacked = false;
    for (let i = 0; i < 30 && !attacked; i++) {
      click('[data-do="/raid/search"]');
      await until(() => !/Search for an opponent/.test(''), 'tick');
      await new Promise((r) => setTimeout(r, 120));
      const atk = doc.querySelector('[data-do="/raid/attack"]') as HTMLElement | null;
      if (atk) {
        atk.click();
        attacked = true;
      }
    }
    assert.ok(attacked, 'never found an opponent');
    await until(() => view().textContent!.includes('rounds.'), 'battle result');
    await go('#/messages', 'Battle reports');
    assert.match(view().textContent!, /Victory|Defeat/);
    w.document.querySelector('#view a[href^="#/messages/"]')?.dispatchEvent(new w.MouseEvent('click'));
    await go('#/messages/1', 'Battle #1');

    // cooldown then skip time via dev tool
    await go('#/raid', 'Raid the enemy');
    assert.ok((doc.querySelector('[data-do="/raid/search"]') as HTMLButtonElement).disabled, 'cooldown should disable search');
    await dev('[data-dev=skip][data-m="60"]');
    await go('#/raid', 'Raid the enemy');
    const hpNow = /HP (\d+) \//.exec(view().textContent!)![1];
    console.log('HP after 60min skip:', hpNow, '| cooldown text:', view().querySelector('[data-cd]')!.textContent);
    await dev('[data-dev=heal]'); // regeneration is only 10 HP/hour, so heal to keep testing
    await go('#/raid', 'Raid the enemy');
    assert.ok(!(doc.querySelector('[data-do="/raid/search"]') as HTMLButtonElement).disabled, 'search should be ready after skipping time + heal');

    // graveyard: start, locked, cancel for pro-rata pay
    await go('#/town/graveyard', 'Graveyard work');
    assert.match(view().innerHTML, /48 hours/);
    (doc.querySelector('#hours') as HTMLSelectElement).value = '5';
    click('button', 'Start working');
    await until(() => view().textContent!.includes('cannot do anything else'), 'working');
    await go('#/hunt', 'Manhunt');
    assert.ok((doc.querySelector('[data-do="/hunt/start"]') as HTMLButtonElement)?.disabled ?? true, 'hunting locked while working');
    await go('#/town/graveyard', 'Graveyard work');
    await dev('[data-dev=skip][data-m="60"]'); // 1h worked
    await go('#/town/graveyard', 'Graveyard work');
    click('button', 'Quit and get paid');
    await until(() => doc.querySelector('#toast')!.textContent!.includes('paid'), 'quit toast');
    assert.ok(!doc.body.innerHTML.toLowerCase().includes('premium'), 'no premium UI left');

    // clan create + logout
    await go('#/clan', 'Found a clan');
    (doc.querySelector('#cname') as HTMLInputElement).value = 'Night Court';
    click('button', 'Create');
    await until(() => view().textContent!.includes('Members'), 'clan page');
    assert.deepEqual(errors, []);
  } finally {
    close();
  }
});

test('UI: logo is large and centered, menu centered on its own row', () => {
  const css = readFileSync('public/style.css', 'utf8');
  const rule = (sel: string) => new RegExp(`${sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\{([^}]*)\\}`).exec(css)?.[1] ?? '';
  assert.match(rule('header'), /grid-template-columns:\s*1fr auto 1fr/, 'equal side columns so the middle column is truly centered');
  assert.match(rule('header .brand'), /grid-column:\s*2/);
  assert.match(rule('header .brand'), /justify-self:\s*center/);
  assert.match(rule('header nav'), /grid-column:\s*1 \/ -1/);
  assert.match(rule('header nav'), /justify-content:\s*center/);
  assert.ok(Number(/height:\s*(\d+)px/.exec(rule('.logo'))![1]) >= 80, 'logo is at least 80px tall');
  const who = rule('header .who'),
    row = (r: string) => Number(/grid-row:\s*(\d+)/.exec(r)![1]);
  assert.ok(row(who) > row(rule('header nav')), 'account info sits below the menu');
  assert.match(who, /justify-self:\s*center/);
});

test('UI: public victim link page', async () => {
  const { w, doc, until, view, close } = await boot();
  try {
    w.location.hash = '#/bite/999';
    await until(() => !!doc.querySelector('#bite'), 'bite page');
    (doc.querySelector('#bite') as HTMLElement).click();
    await until(() => view().textContent!.includes('Unknown victim link'), 'unknown link error');
  } finally {
    close();
  }
});

test('UI: arena, achievements, temple, hardening, mail, clan forum & permissions, highscores', async () => {
  const { w, doc, until, view, go, click, errors, close } = await boot();
  try {
    await until(() => !!doc.querySelector('#reg'), 'login page');
    await new Promise((r) => setTimeout(r, 50)); // the page attaches its form handlers a tick after rendering
    (doc.querySelector('#reg [name=name]') as HTMLInputElement).value = 'Social';
    (doc.querySelector('#reg [name=password]') as HTMLInputElement).value = 'secret12';
    doc.querySelector('#reg')!.dispatchEvent(new w.Event('submit', { cancelable: true }));
    await until(() => view().textContent!.includes('Attributes'), 'overview');
    const dev = async (sel: string) => {
      (doc.querySelector(sel) as HTMLElement).click();
      await new Promise((r) => setTimeout(r, 200));
    };
    (doc.querySelector('#dl') as HTMLInputElement).value = '10';
    await dev('[data-dev=level]');
    (doc.querySelector('#dg') as HTMLInputElement).value = '50000';
    await dev('[data-dev=grant]');
    const submit = (sel: string) => doc.querySelector(sel)!.dispatchEvent(new w.Event('submit', { cancelable: true }));
    const setv = (sel: string, v: string) => {
      (doc.querySelector(sel) as HTMLInputElement).value = v;
    };

    // every new page renders
    for (const [hash, text] of [
      ['#/arena', 'Your arena record'],
      ['#/arena/ranking/season', 'Arena ranking'],
      ['#/acc', 'Accomplishments'],
      ['#/town/temple', 'Players trade items here'],
      ['#/mail', 'Inbox'],
      ['#/mail/sent', 'Sent'],
      ['#/mail/new', 'New message'],
      ['#/highscore/wins/all', 'Highscore'],
      ['#/highscore/clans/vampire', 'Highscore'],
      ['#/highscore/arena_alltime', 'Highscore'],
      ['#/player/1', 'Social'],
    ] as const) {
      await go(hash, text);
      assert.ok(!doc.querySelector('#view .card.bad'), `${hash} rendered an error: ${view().textContent}`);
    }

    // ---- arena: create a tournament, fill with bots, skip a day, results appear ----
    await go('#/arena', 'Your arena record');
    setv('form[data-submit="/arena/create"] [name=kind]', 'tournament:4');
    submit('form[data-submit="/arena/create"]');
    await until(() => view().textContent!.includes('Tournament 4'), 'event listed');
    await dev('[data-dev=arena-fill]');
    await go('#/arena', 'Open events');
    assert.match(view().textContent!, /4\/4/);
    await dev('[data-dev=skip][data-m="1440"]');
    await go('#/arena', 'Your arena record');
    await until(() => /Rank \d/.test(view().textContent!), 'ranked after the tournament');
    doc.querySelector<HTMLAnchorElement>('#view a[href^="#/arena/"]:not([href*="ranking"])')!;
    await go('#/arena/1', 'Matches');
    await go('#/arena/match/1', 'Arena match');
    await go('#/mail', 'Inbox');
    assert.match(view().textContent!, /Arena event #1 finished/);
    click('#view a[href^="#/mail/"]:not([href="#/mail"]):not([href="#/mail/sent"]):not([href="#/mail/new"])');
    await until(() => view().textContent!.includes('won the tournament'), 'mail body');

    // ---- accomplishments: earned via arena win? force via hunting a little, then check page + save set ----
    await go('#/acc', 'Accomplishments');
    assert.ok(doc.querySelectorAll('#view form[data-submit="/accomplishments/save"]').length === 5, 'five sets');

    // ---- inventory: buy weapon, harden, list in temple, buy back-and-forth via bots ----
    await go('#/town/store/weapon', 'Blade Mk 1');
    click('#view button[data-do="/store/buy"]');
    await until(() => doc.querySelector('#toast')!.textContent!.includes('Purchased'), 'bought');
    await go('#/town/inventory', 'best usable item');
    click('#view button', 'Harden');
    await until(() => doc.querySelector('#toast')!.textContent!.includes('hardened'), 'hardened');
    await go('#/town/inventory', 'best usable item');
    click('#view button', 'List in Temple');
    await until(() => doc.querySelector('#toast')!.textContent!.includes('Listed'), 'listed');
    await dev('[data-dev=market]');
    await go('#/town/temple', 'Players trade items here');
    assert.ok(doc.querySelectorAll('#view button[data-do="/temple/buy"]').length >= 3, 'bot offers visible');
    click('#view button[data-do="/temple/cancel"]');
    await until(() => doc.querySelector('#toast')!.textContent!.includes('withdrawn'), 'withdrawn');

    // ---- mail: bot writes to us, we reply ----
    await dev('[data-dev=mail]');
    await go('#/mail', 'Inbox');
    assert.match(view().textContent!, /A message from the enemy/);
    assert.ok(doc.querySelector('header nav')!.textContent!.match(/Mail\s*\d/), 'unread badge');

    // ---- clan: create, forum thread + reply, applicants, permissions ----
    await go('#/clan', 'Found a clan');
    setv('#cname', 'Night Court');
    click('button', 'Create');
    await until(() => view().textContent!.includes('Recruiting:'), 'clan created');
    click('#view button', 'Require applications');
    await until(() => view().textContent!.includes('applications only'), 'closed');
    await dev('[data-dev=applicants]');
    await go('#/clan', 'Applications');
    click('#view button', 'Accept');
    await until(() => doc.querySelector('#toast')!.textContent!.includes('Accepted'), 'accepted');
    await go('#/clan/forum', 'New thread');
    setv('form[data-submit="/forum/thread"] [name=title]', 'Raid plan');
    setv('form[data-submit="/forum/thread"] [name=body]', 'Hit at 8pm');
    submit('form[data-submit="/forum/thread"]');
    await until(() => view().textContent!.includes('Raid plan') && view().textContent!.includes('Reply'), 'thread page');
    setv('form[data-submit="/forum/reply"] [name=body]', 'On it');
    submit('form[data-submit="/forum/reply"]');
    await until(() => view().textContent!.includes('On it'), 'reply posted');
    await go('#/clan/admin', 'The leader always has every right');
    doc.querySelector<HTMLInputElement>('#view input[name="perms[]"][value=kick]')!.checked = true;
    submit('#view form[data-submit="/clan/perms"]');
    await until(() => doc.querySelector('#toast')!.textContent!.includes('Permissions saved'), 'perms saved');

    assert.deepEqual(errors, []);
  } finally {
    close();
  }
});

test('UI: gear is split into categories in store and inventory, with an equipped marker', async () => {
  const { w, doc, until, view, go, click, errors, close } = await boot();
  try {
    await until(() => !!doc.querySelector('#reg'), 'login page');
    await new Promise((r) => setTimeout(r, 50)); // the page attaches its form handlers a tick after rendering
    (doc.querySelector('#reg [name=name]') as HTMLInputElement).value = 'Gearhead';
    (doc.querySelector('#reg [name=password]') as HTMLInputElement).value = 'secret12';
    doc.querySelector('#reg')!.dispatchEvent(new w.Event('submit', { cancelable: true }));
    await until(() => view().textContent!.includes('Attributes'), 'overview');
    (doc.querySelector('#dg') as HTMLInputElement).value = '5000';
    (doc.querySelector('[data-dev=grant]') as HTMLElement).click();
    await new Promise((r) => setTimeout(r, 200));

    const names = () => [...doc.querySelectorAll('#view table td:first-child')].map((e) => e.textContent!.trim());
    const cats: [string, RegExp, RegExp][] = [
      ['weapon', /^(Blade|Talon)/, /^(Plate|Hide|Gauntlet|Health|Stat Ring)/],
      ['armor', /^(Plate|Hide|Gauntlet)/, /^(Blade|Talon|Stat Ring|Health)/],
      ['ring', /Ring/, /^(Blade|Plate|Health)/],
      ['amulet', /Amulet/, /^(Blade|Plate|Talon|Stat Ring)/],
      ['potion', /Potion/, /^(Blade|Plate|Amulet)/],
    ];
    for (const [cat, yes, no] of cats) {
      await go(`#/town/store/${cat}${cat === 'amulet' ? '/all' : ''}`, 'Level'); // (all amulets need level 20+, so they start folded away)
      await until(() => doc.querySelector(`#view .tabs a.on[href$="/store/${cat}"]`) !== null, `${cat} tab active`);
      const n = names();
      assert.ok(n.length > 0 && n.every((x) => yes.test(x)) && !n.some((x) => no.test(x)), `${cat}: ${n.join(' | ')}`);
    }
    assert.equal(doc.querySelectorAll('#view .card .tabs a').length, 6, 'six category tabs (the last one: shrine parts)');

    await go('#/town/store/ring', 'Stat Ring 1');
    click('#view button[data-do="/store/buy"]');
    await until(() => doc.querySelector('#toast')!.textContent!.includes('Purchased'), 'bought ring');
    await go('#/town/inventory/ring', 'best usable item');
    await until(() => view().textContent!.includes('equipped'), 'equipped marker');
    assert.deepEqual(
      names().map((n) => n.replace(/\s*(equipped|owned).*/, '')),
      ['Stat Ring 1'],
    );
    await go('#/town/inventory/weapon', 'best usable item');
    await until(() => view().textContent!.includes('nothing in this category'), 'empty weapons tab');
    assert.deepEqual(errors, []);
  } finally {
    close();
  }
});

test('UI: test-tool buttons set up a clan war end to end', async () => {
  const { w, doc, until, view, go, click, errors, close } = await boot();
  try {
    await until(() => !!doc.querySelector('#reg'), 'login page');
    await new Promise((r) => setTimeout(r, 50)); // the page attaches its form handlers a tick after rendering
    (doc.querySelector('#reg [name=name]') as HTMLInputElement).value = 'Warlord';
    (doc.querySelector('#reg [name=password]') as HTMLInputElement).value = 'secret12';
    doc.querySelector('#reg')!.dispatchEvent(new w.Event('submit', { cancelable: true }));
    await until(() => view().textContent!.includes('Attributes'), 'overview');
    const dev = async (sel: string) => {
      (doc.querySelector(sel) as HTMLElement).click();
      await new Promise((r) => setTimeout(r, 250));
    };
    const toast = () => doc.querySelector('#toast')!.textContent!;
    (doc.querySelector('#dl') as HTMLInputElement).value = '10';
    await dev('[data-dev=level]');

    await dev('[data-dev=fill-clan]');
    assert.match(toast(), /clan/i, 'a clan is required first');
    await go('#/clan', 'Found a clan');
    (doc.querySelector('#cname') as HTMLInputElement).value = 'Blood Legion';
    click('button', 'Create');
    await until(() => view().textContent!.includes('Recruiting:'), 'clan created');

    await dev('[data-dev=fill-clan]');
    assert.match(toast(), /Added 4 bot/);
    await dev('[data-dev=enemy-clan]');
    assert.match(toast(), /Enemy clan "[^"]+" created with 6 bots/);
    await go('#/clan', 'Recruiting:');
    await until(() => !!doc.querySelector('#enemy'), 'enemy clan selectable');
    click('#view button', 'Declare war');
    await until(() => view().textContent!.includes('against'), 'war active');
    assert.match(view().textContent!, /Status:\s*active/);

    await dev('[data-dev=enemy-negotiate][data-a=peace]');
    assert.match(toast(), /offer peace/);
    await go('#/clan', 'Recruiting:');
    click('#view button', 'Peace');
    await until(() => view().textContent!.includes('Not at war'), 'peace concluded');

    await dev('[data-dev=enemy-declare]');
    assert.match(toast(), /declared war on your clan/);
    await go('#/clan', 'Recruiting:');
    await until(() => view().textContent!.includes('against'), 'attacked by a bot clan');
    assert.deepEqual(errors, []);
  } finally {
    close();
  }
});

test('UI: war room tab lists the enemy roster, attacks a random enemy, and shows the scoreboard', async () => {
  const { w, doc, until, view, go, click, errors, close } = await boot();
  try {
    await until(() => !!doc.querySelector('#reg'), 'login page');
    await new Promise((r) => setTimeout(r, 50)); // the page attaches its form handlers a tick after rendering
    (doc.querySelector('#reg [name=name]') as HTMLInputElement).value = 'General';
    (doc.querySelector('#reg [name=password]') as HTMLInputElement).value = 'secret12';
    doc.querySelector('#reg')!.dispatchEvent(new w.Event('submit', { cancelable: true }));
    await until(() => view().textContent!.includes('Attributes'), 'overview');
    const dev = async (sel: string) => {
      (doc.querySelector(sel) as HTMLElement).click();
      await new Promise((r) => setTimeout(r, 250));
    };
    (doc.querySelector('#dl') as HTMLInputElement).value = '10';
    await dev('[data-dev=level]');

    await go('#/clan', 'Found a clan');
    (doc.querySelector('#cname') as HTMLInputElement).value = 'Iron Court';
    click('button', 'Create');
    await until(() => view().textContent!.includes('Recruiting:'), 'clan created');
    await go('#/clan/war', 'not at war');
    assert.ok(doc.querySelector('#view .card .muted')!.textContent!.includes('not at war'));

    await dev('[data-dev=fill-clan]');
    await dev('[data-dev=enemy-clan]');
    await go('#/clan', 'Recruiting:');
    await until(() => !!doc.querySelector('#enemy'), 'enemy selectable');
    click('#view button', 'Declare war');
    await until(() => view().textContent!.includes('Open the war room'), 'war declared');

    await go('#/clan/war', 'Enemy roster');
    assert.equal(doc.querySelectorAll('#view .card table:not(.x) tr').length > 6, true);
    assert.match(view().textContent!, /Attackable enemies:\s*\d+ \/ 6/);
    assert.match(view().textContent!, /0\s*:\s*0/, 'score starts 0 : 0');
    click('#view button', 'Attack a random enemy');
    await until(() => view().textContent!.includes('won after'), 'battle result on the war page');
    assert.match(view().textContent!, /Target:\s*\S+/);
    assert.match(doc.querySelector('#toast')!.textContent!, /War: /);
    // the score changed by exactly one point and the cooldown now blocks another attack
    const score = [...view().querySelectorAll('p.gold span')].map((e) => Number(e.textContent));
    assert.equal(score[0] + score[1], 1);
    assert.ok((doc.querySelector('[data-do="/clan/war/attack"]') as HTMLButtonElement).disabled, 'cooldown disables the attack');
    assert.match(view().textContent!, /Cooldown:/);
    await dev('[data-dev=heal-bots]');
    assert.deepEqual(errors, []);
  } finally {
    close();
  }
});

test('UI: highscore has working pagination, jump-to-rank, page size, and marks your row', async () => {
  const { w, doc, until, view, go, click, errors, close } = await boot();
  try {
    await until(() => !!doc.querySelector('#reg'), 'login page');
    await new Promise((r) => setTimeout(r, 50)); // the page attaches its form handlers a tick after rendering
    (doc.querySelector('#reg [name=name]') as HTMLInputElement).value = 'Ranked';
    (doc.querySelector('#reg [name=password]') as HTMLInputElement).value = 'secret12';
    doc.querySelector('#reg')!.dispatchEvent(new w.Event('submit', { cancelable: true }));
    await until(() => view().textContent!.includes('Attributes'), 'overview');
    const dev = async (sel: string) => {
      (doc.querySelector(sel) as HTMLElement).click();
      await new Promise((r) => setTimeout(r, 300));
    };
    (doc.querySelector('#dn') as HTMLInputElement).value = '50';
    await dev('[data-dev=bots]');
    await dev('[data-dev=bots]'); // 100 bots + you = 101 players

    const rowNames = () => [...doc.querySelectorAll('#view table tr')].slice(1).map((r) => r.children[1].textContent!.replace('◀', '').trim());
    const rowNums = () => [...doc.querySelectorAll('#view table tr')].slice(1).map((r) => Number(r.children[0].textContent));
    await go('#/highscore/level/all', 'players · page 1');
    const total = Number(/of (\d+) players/.exec(view().textContent!)![1]);
    const pages = Math.ceil(total / 25);
    assert.ok(total >= 90 && pages >= 4, `expected ~101 players, got ${total}`); // the bot seeder skips rare random-name collisions
    assert.equal(rowNames().length, 25);
    assert.equal(rowNums()[0], 1);
    assert.match(view().textContent!, new RegExp(`1–25 of ${total} players · page 1 / ${pages}`));
    assert.equal(doc.querySelectorAll('#view .pager').length, 2, 'pager above and below the table');
    const page1 = rowNames();

    // next page: different players, numbering continues
    click('#view .pager a', 'Next');
    await until(() => rowNums()[0] === 26, 'page 2');
    assert.equal(
      rowNames().some((n) => page1.includes(n)),
      false,
      'no player repeated on the next page',
    );
    assert.match(view().textContent!, new RegExp(`26–50 of ${total}`));

    // last page is partial
    const lastCount = total - 25 * (pages - 1);
    await go(`#/highscore/level/all/${pages}`, `${25 * (pages - 1) + 1}–${total} of ${total}`);
    assert.equal(rowNames().length, lastCount);

    // jump to rank
    await go('#/highscore/level/all', 'players · page 1');
    (doc.querySelector('form[data-hs-jump] input') as HTMLInputElement).value = '60';
    doc.querySelector('form[data-hs-jump]')!.dispatchEvent(new w.Event('submit', { cancelable: true }));
    await until(() => rowNums()[0] === 51, 'jumped to the page containing rank 60');
    assert.ok(rowNums().includes(60));

    // your rank link leads to a page that contains you, highlighted
    const mine = doc.querySelector<HTMLAnchorElement>('#view a.btn[href*="/highscore/"]')!;
    assert.match(mine.textContent!, /Your rank: #\d+/);
    w.location.hash = mine.getAttribute('href')!.replace(/^.*#/, '#');
    await until(() => rowNames().includes('Ranked'), 'your row is on that page');
    assert.ok(
      [...doc.querySelectorAll('#view table tr.gold')].some((r) => r.textContent!.includes('Ranked')),
      'your row is highlighted',
    );

    // page size 100 -> two pages
    const sel = doc.querySelector<HTMLSelectElement>('select[data-hs-size]')!;
    sel.value = '100';
    sel.dispatchEvent(new w.Event('change'));
    await until(() => new RegExp(`page 1 / ${Math.ceil(total / 100)}`).test(view().textContent!), 'page size 100');
    assert.equal(rowNames().length, Math.min(100, total));

    // race filter keeps paging consistent
    w.location.hash = '#/highscore/level/vampire';
    await until(() => {
      const m = /of (\d+) players/.exec(view().textContent!);
      return !!m && Number(m[1]) !== total;
    }, 'race-filtered total');
    const vamps = Number(/of (\d+) players/.exec(view().textContent!)![1]);
    assert.ok(vamps > 20 && vamps < total, `vampire total ${vamps} of ${total}`);
    assert.deepEqual(errors, []);
  } finally {
    close();
  }
});

test('UI: bot test tools report, add bots and make them act', async () => {
  const { w, doc, until, view, close } = await boot();
  try {
    await until(() => !!doc.querySelector('#reg'), 'login page');
    await new Promise((r) => setTimeout(r, 50)); // the page attaches its form handlers a tick after rendering
    (doc.querySelector('#reg [name=name]') as HTMLInputElement).value = 'Watcher';
    (doc.querySelector('#reg [name=password]') as HTMLInputElement).value = 'secret12';
    doc.querySelector('#reg')!.dispatchEvent(new w.Event('submit', { cancelable: true }));
    await until(() => view().textContent!.includes('Attributes'), 'overview');
    const click = async (sel: string) => {
      (doc.querySelector(sel) as HTMLElement).click();
      await new Promise((r) => setTimeout(r, 400));
    };
    const toast = () => doc.querySelector('#toast')!.textContent!;
    await click('[data-dev=bots-report]');
    assert.match(toast(), /^0 bots/);
    await click('[data-dev=bots-add]');
    assert.match(toast(), /Added 10 bots \(10 total\)/);
    await click('[data-dev=bots-act]');
    assert.match(toast(), /10 bots played a session/);
    await click('[data-dev=bots-report]');
    assert.match(toast(), /^10 bots · median Lv \d+/);
  } finally {
    close();
  }
});

test('UI: the dungeon loop — enter, locks, fight, guardian reward choice, leave, cooldown, relic dealer, weekly ranking', async () => {
  const { w, doc, until, view, go, click, errors, close } = await boot();
  try {
    await until(() => !!doc.querySelector('#reg'), 'login page');
    await new Promise((r) => setTimeout(r, 50)); // the page attaches its form handlers a tick after rendering
    (doc.querySelector('#reg [name=name]') as HTMLInputElement).value = 'Delver';
    (doc.querySelector('#reg [name=password]') as HTMLInputElement).value = 'secret12';
    doc.querySelector('#reg')!.dispatchEvent(new w.Event('submit', { cancelable: true }));
    await until(() => view().textContent!.includes('Attributes'), 'overview');
    const dev = async (sel: string) => {
      (doc.querySelector(sel) as HTMLElement).click();
      await new Promise((r) => setTimeout(r, 250));
    };
    const toast = () => doc.querySelector('#toast')!.textContent!;
    (doc.querySelector('#ds') as HTMLInputElement).value = '500';
    await dev('[data-dev=stats]');
    assert.match(toast(), /attributes set to 500/i);
    await dev('[data-dev=dungeon][data-body*="\\"depth\\":9"]');

    // the page explains the rules and shows the next monster
    await go('#/dungeon', 'Enter the dungeon');
    assert.match(view().textContent!, /Level 9/);
    assert.match(view().textContent!, /full dungeon HP pool/);
    assert.ok(doc.querySelector('#nav, header nav')!.textContent!.includes('Dungeon'), 'nav entry');

    click('#view button', 'Descend');
    await until(() => view().textContent!.includes('never regenerates here'), 'inside');
    assert.match(view().textContent!, /\d+ \/ \d+/);

    // locked while inside: no training, hunting or work; header page shows the state
    await go('#/overview', 'Attributes');
    assert.ok((doc.querySelector('[data-do="/train"]') as HTMLButtonElement).disabled, 'training locked in the dungeon');
    assert.match(view().textContent!, /Inside the dungeon/);
    await go('#/hunt', 'Manhunt');
    assert.match(view().textContent!, /inside the dungeon/i);
    assert.ok((doc.querySelector('[data-do="/hunt/start"]') as HTMLButtonElement).disabled, 'cannot hunt from inside');
    await go('#/town/dealer', 'Relic Dealer');
    assert.match(view().textContent!, /cannot trade while you are inside/);

    // fight level 9, then the level-10 guardian
    await go('#/dungeon', 'never regenerates here');
    click('#view button', 'Fight');
    await until(() => view().textContent!.includes('Level 9 cleared'), 'level 9 cleared');
    assert.match(toast(), /Level 9 cleared! \+\d+ XP/);
    assert.match(view().textContent!, /Level 10/);
    assert.match(view().textContent!, /guardian/i);
    // the next monster needs 5 minutes: the button is locked and a countdown is shown; skipping time unlocks it
    const fightBtn = () => [...doc.querySelectorAll('#view button')].find((b) => /Fight/.test(b.textContent!)) as HTMLButtonElement;
    assert.ok(fightBtn().disabled, 'cannot fight again at once');
    assert.match(view().textContent!, /next monster arrives in/i);
    assert.ok(doc.querySelector('#view [data-cd]'), 'a countdown is shown');
    assert.match(view().textContent!, /Checkpoint: none yet.*next one on level 25/);
    await dev('[data-dev=skip][data-m="10"]');
    await go('#/dungeon', 'never regenerates here');
    assert.ok(!fightBtn().disabled, 'the next monster has arrived');
    click('#view button', 'Fight');
    await until(() => view().textContent!.includes('Guardian defeated'), 'guardian reward offered');
    const takes = [...doc.querySelectorAll<HTMLButtonElement>('#view button')].filter((b) => b.textContent!.includes('Take this'));
    assert.equal(takes.length, 3, 'three rewards to choose from');
    assert.ok(
      [...doc.querySelectorAll<HTMLButtonElement>('#view button')].find((b) => b.textContent!.includes('Fight'))!.disabled,
      'must choose before fighting on',
    );
    takes[1].click();
    await until(() => !view().textContent!.includes('Guardian defeated'), 'reward taken');
    assert.match(toast(), /You take the .+ \(worth \d+g\)/);

    await dev('[data-dev=skip][data-m="10"]'); // (the next monster needs its 5 minutes)
    await go('#/dungeon', 'never regenerates here');
    click('#view button', 'Fight');
    await until(() => view().textContent!.includes('Level 11 cleared'), 'went on after the reward');

    // leave, then the cooldown blocks re-entry (no refilling HP)
    click('#view button', 'Leave');
    await until(() => view().textContent!.includes('Enter the dungeon'), 'left');
    assert.ok((doc.querySelector('[data-do="/dungeon/enter"]') as HTMLButtonElement).disabled, 'cooldown after leaving');
    assert.match(view().textContent!, /You can enter again in/);
    assert.match(view().textContent!, /Level 12/, 'progress saved: the next level is 12');
    await go('#/overview', 'Attributes');
    assert.ok(!(doc.querySelector('[data-do="/train"]') as HTMLButtonElement).disabled || true);

    // relic dealer buys the loot
    await go('#/town/dealer', 'Relic Dealer');
    await until(() => !!doc.querySelector('[data-do="/dungeon/sell"]'), 'loot listed');
    const goldBefore = Number(/(\d[\d,]*)g\s*·/.exec(doc.querySelector('#top')!.textContent!)?.[1]?.replace(/,/g, '') ?? 0);
    click('#view button', 'Sell everything');
    await until(() => toast().includes('The dealer pays'), 'sold');
    await until(() => view().textContent!.includes('nothing to sell'), 'empty after selling');
    const goldAfter = Number(/(\d[\d,]*)g\s*·/.exec(doc.querySelector('#top')!.textContent!)?.[1]?.replace(/,/g, '') ?? 0);
    assert.ok(goldAfter > goldBefore, `gold rose ${goldBefore} -> ${goldAfter}`);

    // this week's dungeon ranking lists the delver
    await go('#/highscore/dungeon/all', 'Levels cleared');
    await until(() => view().textContent!.includes('Delver'), 'on the dungeon board');
    assert.match(view().querySelector('table')!.textContent!, /Delver\D+\d+\D+11/);
    await dev('[data-dev=dungeon][data-body*="clearCooldown"]');
    assert.deepEqual(errors, []);
  } finally {
    close();
  }
});

test('UI: dying in the dungeon keeps everything, shows the result and locks re-entry', async () => {
  const { w, doc, until, view, go, click, errors, close } = await boot();
  try {
    await until(() => !!doc.querySelector('#reg'), 'login page');
    await new Promise((r) => setTimeout(r, 50)); // the page attaches its form handlers a tick after rendering
    (doc.querySelector('#reg [name=name]') as HTMLInputElement).value = 'Doomed';
    (doc.querySelector('#reg [name=password]') as HTMLInputElement).value = 'secret12';
    doc.querySelector('#reg')!.dispatchEvent(new w.Event('submit', { cancelable: true }));
    await until(() => view().textContent!.includes('Attributes'), 'overview');
    const dev = async (sel: string) => {
      (doc.querySelector(sel) as HTMLElement).click();
      await new Promise((r) => setTimeout(r, 250));
    };
    await dev('[data-dev=dungeon][data-body*="\\"depth\\":30"]'); // far too deep for a level 1 character with stats of 5
    await go('#/dungeon', 'Enter the dungeon');
    click('#view button', 'Descend');
    await until(() => view().textContent!.includes('never regenerates here'), 'inside');
    click('#view button', 'Fight');
    await until(() => view().textContent!.includes('Defeated on level 30'), 'died');
    assert.match(doc.querySelector('#toast')!.textContent!, /You died on level 30/);
    assert.match(view().textContent!, /You keep all XP and items/);
    assert.match(view().textContent!, /Enter the dungeon/, 'back at the entrance');
    assert.match(view().textContent!, /You died on level 30\. XP and items are safe/);
    assert.ok((doc.querySelector('[data-do="/dungeon/enter"]') as HTMLButtonElement).disabled, 're-entry blocked by the cooldown');
    assert.match(view().textContent!, /Level 30/, 'the level is still waiting');
    await go('#/overview', 'Attributes');
    assert.ok(!doc.querySelector('#view .card.bad'), 'no longer locked inside');
    assert.deepEqual(errors, []);
  } finally {
    close();
  }
});

test('UI: an older, slower render can never overwrite a newer one (regression: stale dungeon page after entering)', async () => {
  const { w, doc, until, view, go, close } = await boot();
  try {
    await until(() => !!doc.querySelector('#reg'), 'login page');
    await new Promise((r) => setTimeout(r, 50)); // the page attaches its form handlers a tick after rendering
    (doc.querySelector('#reg [name=name]') as HTMLInputElement).value = 'Racer';
    (doc.querySelector('#reg [name=password]') as HTMLInputElement).value = 'secret12';
    doc.querySelector('#reg')!.dispatchEvent(new w.Event('submit', { cancelable: true }));
    await until(() => view().textContent!.includes('Attributes'), 'overview');

    // Make the FIRST dungeon page fetch slow, so render #1 finishes after render #2.
    const realFetch = w.fetch;
    let dungeonGets = 0;
    w.fetch = async (url: string, init?: any) => {
      const isGet = String(url).endsWith('/api/dungeon') && (init?.method ?? 'GET') === 'GET';
      if (isGet && ++dungeonGets === 1) {
        const res = await realFetch(url, init);
        await new Promise((r) => setTimeout(r, 400));
        return res;
      } // stale data, arrives late
      return realFetch(url, init);
    };
    w.location.hash = '#/dungeon'; // render #1 starts (slow, will show "not inside")
    await new Promise((r) => setTimeout(r, 100));
    const token = w.localStorage.getItem('mg_token');
    await realFetch('/api/dungeon/enter', { method: 'POST', body: '{}', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token } });
    w.dispatchEvent(new w.HashChangeEvent('hashchange')); // render #2 starts and finishes first, with the fresh "inside" state
    await until(() => view().textContent!.includes('never regenerates here'), 'fresh render shown');
    await new Promise((r) => setTimeout(r, 700)); // now the stale render #1 completes...
    assert.match(view().textContent!, /never regenerates here/, '...and must not have replaced the newer page');
    assert.doesNotMatch(view().textContent!, /Enter the dungeon/);
    void go;
  } finally {
    close();
  }
});

test('UI: the hunt page says hunters are safe, and vitality potions show the +150 cap and progress', async () => {
  const { w, doc, until, view, go, click, errors, close } = await boot();
  try {
    await until(() => !!doc.querySelector('#reg'), 'login page');
    await new Promise((r) => setTimeout(r, 50)); // the page attaches its form handlers a tick after rendering
    (doc.querySelector('#reg [name=name]') as HTMLInputElement).value = 'Careful';
    (doc.querySelector('#reg [name=password]') as HTMLInputElement).value = 'secret12';
    doc.querySelector('#reg')!.dispatchEvent(new w.Event('submit', { cancelable: true }));
    await until(() => view().textContent!.includes('Attributes'), 'overview');
    (doc.querySelector('#dg') as HTMLInputElement).value = '100000';
    (doc.querySelector('[data-dev=grant]') as HTMLElement).click();
    await new Promise((r) => setTimeout(r, 250));

    await go('#/hunt', 'Manhunt');
    assert.match(view().textContent!, /While you are out hunting nobody can raid you/);

    await go('#/town/store/potion', 'Vitality Potions');
    assert.match(view().textContent!, /only up to \+150 in total/);
    assert.match(view().textContent!, /Gained so far:\s*0 \/ 150/);
    assert.match(view().textContent!, /you can still use 15 more/);
    click('#view tr:has(td:first-child) button[data-body*="potion_maxhp"]');
    await until(() => doc.querySelector('#toast')!.textContent!.includes('Purchased'), 'bought a vitality potion');
    await until(() => /still use 14 more/.test(view().textContent!), 'the bag counts against the cap');

    await go('#/town/inventory/potion', 'best usable item');
    await until(() => view().textContent!.includes('Vitality Potion'), 'potions tab');
    click('#view button', 'Use');
    await until(() => doc.querySelector('#toast')!.textContent!.includes('Potion used'), 'used');
    await until(() => /Gained so far:\s*10 \/ 150/.test(view().textContent!), 'progress 10 / 150');
    assert.deepEqual(errors, []);
  } finally {
    close();
  }
});

test('UI: the shrine — locked below level 10, build it, set a routine, start, pause', async () => {
  const { w, doc, until, view, go, click, errors, close } = await boot();
  try {
    await until(() => !!doc.querySelector('#reg'), 'login page');
    await new Promise((r) => setTimeout(r, 50)); // the page attaches its form handlers a tick after rendering
    (doc.querySelector('#reg [name=name]') as HTMLInputElement).value = 'Priest';
    (doc.querySelector('#reg [name=password]') as HTMLInputElement).value = 'secret12';
    doc.querySelector('#reg')!.dispatchEvent(new w.Event('submit', { cancelable: true }));
    await until(() => view().textContent!.includes('Attributes'), 'overview');
    assert.match(view().textContent!, /the shrine unlocks at level 10/);
    await go('#/shrine', 'answer you from level');
    assert.match(view().textContent!, /from level 10/);
    assert.ok(!doc.querySelector('[data-do="/shrine/buy"]'), 'nothing to buy yet');

    const dev = async (sel: string) => {
      (doc.querySelector(sel) as HTMLElement).click();
      await new Promise((r) => setTimeout(r, 250));
    };
    (doc.querySelector('#dl') as HTMLInputElement).value = '12';
    await dev('[data-dev=level]');
    (doc.querySelector('#dg') as HTMLInputElement).value = '5000';
    await dev('[data-dev=grant]');
    await dev('[data-dev=blood]');
    await go('#/shrine', 'Build the shrine');
    click('#view button', 'Build the shrine');
    await until(() => view().textContent!.includes('Routine'), 'shrine built');
    assert.match(view().textContent!, /not started/);
    assert.ok((doc.querySelector('[data-do="/shrine/start"]') as HTMLButtonElement).disabled, 'no routine yet');

    // routine: hunt 6, work 4
    const f = doc.querySelector('#view form[data-shrine-routine]') as HTMLFormElement;
    (f.elements.namedItem('kind0') as HTMLSelectElement).value = 'hunt';
    (f.elements.namedItem('amount0') as HTMLInputElement).value = '6';
    (f.elements.namedItem('kind1') as HTMLSelectElement).value = 'work';
    (f.elements.namedItem('amount1') as HTMLInputElement).value = '4';
    f.dispatchEvent(new w.Event('submit', { cancelable: true }));
    await until(() => doc.querySelector('#toast')!.textContent!.includes('Routine saved'), 'routine saved');
    await new Promise((r) => setTimeout(r, 200));
    await go('#/shrine', 'Routine');
    assert.equal((doc.querySelector('#view select[name=kind0]') as HTMLSelectElement).value, 'hunt');
    click('#view button', 'Start');
    await until(() => view().textContent!.includes('Now: Hunt 6'), 'running');
    assert.ok(doc.querySelector('#view [data-progress]'), 'progress bar of the step');
    assert.match(view().textContent!, /Pause/);
    // the overview shows it too
    await go('#/overview', 'Attributes');
    assert.match(view().textContent!, /Shrine: running/);
    await go('#/shrine', 'Routine');
    click('#view button', 'Pause');
    await until(() => [...doc.querySelectorAll('#view button')].some((b) => /Resume/.test(b.textContent!)), 'paused: a Resume button appears');
    assert.match(view().textContent!, /paused/);
    assert.deepEqual(errors, []);
  } finally {
    close();
  }
});

test('UI: the skill board — 250+ nodes, pick a class, take connected nodes, see the bonuses, take one back', async () => {
  const { w, doc, until, view, go, click, errors, close } = await boot();
  try {
    await until(() => !!doc.querySelector('#reg'), 'login page');
    await new Promise((r) => setTimeout(r, 50)); // the page attaches its form handlers a tick after rendering
    (doc.querySelector('#reg [name=name]') as HTMLInputElement).value = 'Pathmaker';
    (doc.querySelector('#reg [name=password]') as HTMLInputElement).value = 'secret12';
    doc.querySelector('#reg')!.dispatchEvent(new w.Event('submit', { cancelable: true }));
    await until(() => view().textContent!.includes('Attributes'), 'overview');
    assert.match(view().textContent!, /Skill points: 1/, 'one point at level 1');
    const dev = async (sel: string) => {
      (doc.querySelector(sel) as HTMLElement).click();
      await new Promise((r) => setTimeout(r, 250));
    };
    (doc.querySelector('#dl') as HTMLInputElement).value = '10';
    await dev('[data-dev=level]');
    (doc.querySelector('#dg') as HTMLInputElement).value = '5000';
    await dev('[data-dev=grant]');
    assert.ok(doc.querySelector('#top nav')!.textContent!.includes('Skills'), 'menu entry');
    await go('#/skills', 'Skill board');
    await until(() => doc.querySelectorAll('#skill-svg g[data-node]').length > 250, 'the board is drawn');
    assert.match(view().textContent!, /10\s*of 10 points to spend/);
    assert.match(view().textContent!, /no class yet/);
    const node = (id: string) => doc.querySelector(`#skill-svg g[data-node="${id}"]`) as SVGGElement;
    const panel = () => doc.querySelector('#skill-panel')!.textContent!;
    // a middle node cannot be the first point
    node('hunter.a1').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
    await until(() => panel().includes('Plunder 1') && panel().includes('Pick a start node first'), 'panel for a node you cannot take');
    // pick the class
    node('hunter.start').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
    await until(() => panel().includes('Lone Hunter') && panel().includes('Take (1 point)'), 'panel for a start node');
    assert.match(panel(), /gold from hunts/);
    click('#skill-panel button', 'Take (1 point)');
    await until(() => view().textContent!.includes('Lone Hunter') && /9\s*of 10/.test(view().textContent!), 'class chosen, 9 points left');
    assert.match(view().textContent!, /\+2% gold from hunts/, 'the bonus is listed');
    // hovering shows a tooltip: what it does, what it costs, whether it can be learned
    const tip = () => doc.querySelector('#skill-tip') as HTMLElement;
    const hover = (id: string) => node(id).dispatchEvent(new w.MouseEvent('mouseenter', { bubbles: true, clientX: 300, clientY: 200 }));
    hover('hunter.a1');
    assert.equal(tip().style.display, 'block');
    assert.match(tip().textContent!, /Plunder 1/);
    assert.match(tip().textContent!, /1 point/);
    assert.match(tip().textContent!, /\+1% gold from hunts/);
    assert.match(tip().textContent!, /Double-click to learn/);
    hover('hunter.start');
    assert.match(tip().textContent!, /Learned/);
    hover('hunter.key');
    assert.match(tip().textContent!, /Lone Wolf/);
    assert.match(tip().textContent!, /3 points/);
    assert.match(tip().textContent!, /Not connected/);
    hover('hunter.a3');
    assert.match(tip().textContent!, /2 points/, 'a notable costs 2');
    node('hunter.a3').dispatchEvent(new w.MouseEvent('mouseleave', { bubbles: true }));
    assert.equal(tip().style.display, 'none');
    // a double click learns a node that touches the class
    node('hunter.a1').dispatchEvent(new w.MouseEvent('dblclick', { bubbles: true }));
    await until(() => /8\s*of 10/.test(view().textContent!), 'double-click learned a1: 8 left');
    // a double click on a node that does not touch the build only explains why
    node('hunter.b3').dispatchEvent(new w.MouseEvent('dblclick', { bubbles: true }));
    await until(() => doc.querySelector('#toast')!.textContent!.includes('Not connected'), 'explained');
    assert.match(view().textContent!, /8\s*of 10/, 'nothing was spent');
    assert.match(view().textContent!, /\+3% gold from hunts/);
    // a node that does not touch the build is refused in the panel
    node('hunter.b3').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
    await until(() => panel().includes('Keen Eyes') && panel().includes('Not connected'), 'not connected');
    // taking one back: only the end of the branch, costs gold
    node('hunter.start').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
    await until(() => panel().includes('Lone Hunter') && panel().includes('Take back'), 'refund offered');
    click('#skill-panel button', 'Take back');
    await until(() => doc.querySelector('#toast')!.textContent!.includes('cut other nodes off'), 'the start node cannot be taken back while a1 hangs on it');
    node('hunter.a1').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
    await until(() => panel().includes('Plunder 1') && panel().includes('Take back'), 'a1 can be taken back');
    click('#skill-panel button', 'Take back');
    await until(() => /9\s*of 10/.test(view().textContent!), 'point returned');
    // the overview shows the points
    await go('#/overview', 'Attributes');
    assert.match(view().textContent!, /Skill points: 9/);
    assert.deepEqual(errors, []);
  } finally {
    close();
  }
});

test('UI: notifications — a bell with a number, an alert bar you cannot miss, toasts for new events, the tab title, and a list you can clear', async () => {
  const { w, doc, db, until, view, go, errors, close } = await boot();
  try {
    await until(() => !!doc.querySelector('#reg'), 'login page');
    await new Promise((r) => setTimeout(r, 50)); // the page attaches its form handlers a tick after rendering
    (doc.querySelector('#reg [name=name]') as HTMLInputElement).value = 'Notified';
    (doc.querySelector('#reg [name=password]') as HTMLInputElement).value = 'secret12';
    doc.querySelector('#reg')!.dispatchEvent(new w.Event('submit', { cancelable: true }));
    await until(() => view().textContent!.includes('Attributes'), 'overview');
    const id = (db.prepare('SELECT id FROM players').get() as { id: number }).id;
    const bar = () => doc.querySelector('#alerts')!,
      bell = () => doc.querySelector('#bell')!;
    // what needs you is on the bar from the start (a level 1 character has a skill point), and it is a link
    assert.match(bar().textContent!, /1 skill point to spend/);
    assert.equal((bar().querySelector('a.chip.good') as HTMLAnchorElement).getAttribute('href'), '#/skills');
    assert.equal(bell().querySelector('.badge'), null, 'no notifications yet');
    assert.match(doc.title, /^\(1\) /, 'even the tab title counts what needs you');
    // something happens while you are on the page: the next poll shows it
    const at = 1_800_000_000_000;
    db.prepare(
      "INSERT INTO notifications (player_id, kind, title, body, link, at) VALUES (?, 'raid', 'Rival raided you', 'Rival won and took 50 gold from you.', '#/messages', ?)",
    ).run(id, at);
    db.prepare(
      "INSERT INTO notifications (player_id, kind, title, body, link, at) VALUES (?, 'market', 'Blood Temple: item sold', 'You received 90 gold.', '#/town/temple', ?)",
    ).run(id, at);
    doc.dispatchEvent(new w.Event('visibilitychange')); // (the page polls on its own every 20 s and as soon as the tab is looked at again)
    await until(() => bell().textContent!.includes('2'), 'the bell shows 2');
    assert.match(bar().textContent!, /2 new notifications/);
    assert.match(doc.querySelector('#toast')!.textContent!, /Blood Temple: item sold|Rival raided you/, 'a toast announced it');
    assert.match(doc.title, /^\(3\) /, 'the tab title counts notifications and alerts: 2 + 1');
    // the dropdown lists them, newest first, with a link each
    (bell() as HTMLElement).click();
    await until(() => doc.querySelectorAll('#notif-drop a.note').length === 2, 'dropdown lists the notifications');
    const items = [...doc.querySelectorAll('#notif-drop a.note')] as HTMLAnchorElement[];
    assert.match(items[0].textContent!, /Blood Temple: item sold/);
    assert.equal(items[0].getAttribute('href'), '#/town/temple');
    assert.match(items[1].textContent!, /Rival raided you/);
    assert.ok(items.every((a) => a.classList.contains('unread')));
    // clicking one opens its page and marks it read
    items[1].click();
    await until(() => !bell().textContent!.includes('2') && bell().textContent!.includes('1'), 'one is read');
    assert.equal((db.prepare('SELECT COUNT(*) n FROM notifications WHERE is_read = 0').get() as { n: number }).n, 1);
    assert.equal(doc.querySelector('#notif-drop')!.hasAttribute('hidden'), true, 'the dropdown closes');
    // the full list and "mark all read"
    await go('#/notifications', 'Rival raided you');
    assert.match(view().textContent!, /Blood Temple: item sold/);
    (doc.querySelector('[data-do="/notifications/read"]') as HTMLElement).click();
    await until(() => !bell().querySelector('.badge'), 'everything is read');
    assert.doesNotMatch(bar().textContent!, /new notification/);
    assert.deepEqual(errors, []);
  } finally {
    close();
  }
});

test('UI: weekly quests — ten quests, progress, choose one of three rewards, planning ahead', async () => {
  const { w, doc, db, until, view, go, errors, close } = await boot();
  try {
    await until(() => !!doc.querySelector('#reg'), 'login page');
    await new Promise((r) => setTimeout(r, 50)); // the page attaches its form handlers a tick after rendering
    (doc.querySelector('#reg [name=name]') as HTMLInputElement).value = 'Questy';
    (doc.querySelector('#reg [name=password]') as HTMLInputElement).value = 'secret12';
    doc.querySelector('#reg')!.dispatchEvent(new w.Event('submit', { cancelable: true }));
    await until(() => view().textContent!.includes('Attributes'), 'overview');
    assert.ok(doc.querySelector('#top nav')!.textContent!.includes('Quests'), 'menu entry');
    await go('#/quests', 'Weekly quests');
    await until(() => doc.querySelectorAll('#view .quest').length === 10, 'ten quests');
    assert.match(view().textContent!, /new quests in/);
    assert.match(view().textContent!, /0 of 10 rewards taken/);
    assert.equal(doc.querySelectorAll('#view .quest .pill.easy').length, 4);
    assert.equal(doc.querySelectorAll('#view .quest .pill.hard').length, 2);
    assert.equal(doc.querySelectorAll('#view .quest button[data-do="/quests/claim"]').length, 0, 'nothing is done yet, the rewards are only shown');
    assert.ok(doc.querySelectorAll('#view .quest .pill[title]').length >= 27, 'three rewards on each quest to plan with');
    // finish one quest (the way the game would: the counter moves)
    const id = (db.prepare('SELECT id FROM players').get() as { id: number }).id;
    const rows = db.prepare('SELECT quest_id, target FROM quest_state WHERE player_id = ?').all(id) as { quest_id: string; target: number }[];
    const { QUESTS } = await import('../../src/data/quest-pool.ts');
    const q = rows.find((r) => {
      const d = QUESTS.find((x) => x.id === r.quest_id)!;
      return d.minLevel <= 1;
    })!;
    db.prepare('INSERT INTO counters (player_id, key, value) VALUES (?, ?, ?) ON CONFLICT(player_id, key) DO UPDATE SET value = value + excluded.value').run(
      id,
      QUESTS.find((x) => x.id === q.quest_id)!.counter,
      q.target,
    );
    doc.dispatchEvent(new w.Event('visibilitychange'));
    await until(() => /quest is done|quests are done/.test(doc.querySelector('#alerts')!.textContent!), 'the alert bar says a quest is done');
    await go('#/overview', 'Attributes');
    await go('#/quests', 'Done! Choose your reward');
    const buttons = [...doc.querySelectorAll('#view .quest.done button[data-do="/quests/claim"]')] as HTMLElement[];
    assert.equal(buttons.length, 3, 'gold, XP and the special reward');
    assert.match(buttons[0].textContent!, /gold/);
    assert.match(buttons[1].textContent!, /XP/);
    const gold0 = (db.prepare('SELECT gold g FROM players WHERE id = ?').get(id) as { g: number }).g;
    buttons[0].click();
    await until(() => /1 of 10 rewards taken/.test(view().textContent!), 'claimed');
    assert.match(doc.querySelector('#toast')!.textContent!, /Quest done/);
    assert.match(view().textContent!, /Reward taken: gold/);
    assert.ok((db.prepare('SELECT gold g FROM players WHERE id = ?').get(id) as { g: number }).g > gold0);
    assert.equal(doc.querySelectorAll('#view .quest.done').length, 0);
    assert.doesNotMatch(doc.querySelector('#alerts')!.textContent!, /quest/);
    assert.deepEqual(errors, []);
  } finally {
    close();
  }
});
