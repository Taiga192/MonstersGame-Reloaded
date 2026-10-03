import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CFG, DAY_MS, HOUR, MIN } from '../../src/core/config.ts';
import { openDb, type DB } from '../../src/db/node.ts';
import { GameError } from '../../src/core/errors.ts';
import { clanName, playerName } from '../../src/bots/names.ts';
import { PERSONAS, personaForIndex } from '../../src/bots/personas.ts';
import { botReport, ensureBots, tickBots, fastForward } from '../../src/bots/runner.ts';
import * as auth from '../../src/game/character/auth.ts';
import { loadPlayer } from '../../src/game/character/player.ts';
import { seeded } from '../../src/core/rng.ts';

const T0 = Date.UTC(2027, 0, 15, 12, 0, 0); // noon UTC
const one = (db: DB, sql: string, ...a: any[]) => db.prepare(sql).get(...a) as any;
const set = (db: DB, id: number, sql: string) => db.prepare(`UPDATE players SET ${sql} WHERE id = ?`).run(id);

test('names: unique, valid for the game, varied', () => {
  const rng = seeded(1),
    taken = new Set<string>();
  const names = Array.from({ length: 400 }, () => playerName(rng, taken));
  assert.equal(new Set(names.map((n) => n.toLowerCase())).size, 400);
  assert.ok(
    names.every((n) => /^[A-Za-z0-9_\-]{3,20}$/.test(n)),
    names.find((n) => !/^[A-Za-z0-9_\-]{3,20}$/.test(n)),
  );
  const styles = new Set(names.map((n) => (/^xX/.test(n) ? 'xx' : /_/.test(n) ? 'snake' : /\d$/.test(n) ? 'num' : 'plain')));
  assert.ok(styles.size >= 3, 'several naming styles');
  const c = new Set<string>();
  const clans = Array.from({ length: 60 }, () => clanName(rng, c));
  assert.equal(new Set(clans).size, 60);
  assert.ok(clans.every((n) => /^[A-Za-z0-9 _\-]{3,24}$/.test(n)));
});

test('personas: exactly 25/25/15/10/20/5 for every block of 100 bots', () => {
  const count: Record<string, number> = {};
  for (let i = 0; i < 100; i++) count[personaForIndex(i).key] = (count[personaForIndex(i).key] ?? 0) + 1;
  assert.deepEqual(count, { brawler: 25, hunter: 25, worker: 15, leader: 10, balanced: 20, casual: 5 });
  for (const p of Object.values(PERSONAS)) assert.ok(p.sessions[0] <= p.sessions[1] && p.tempo > 0);
});

test('ensureBots: creates them quickly, idempotently, staggered; bots cannot log in', () => {
  const db = openDb(),
    rng = seeded(2);
  const t = Date.now();
  assert.equal(ensureBots(db, 100, T0, rng), 100);
  assert.ok(Date.now() - t < 3000, 'no expensive password hashing');
  assert.equal(ensureBots(db, 100, T0, rng), 0);
  assert.equal(ensureBots(db, 120, T0, rng), 20, 'only the missing ones are added');
  assert.equal(one(db, 'SELECT COUNT(*) n FROM players WHERE is_bot = 1').n, 120);
  assert.equal(one(db, 'SELECT COUNT(*) n FROM hideouts').n, 120);
  const spread = one(db, 'SELECT MIN(next_at) a, MAX(next_at) b FROM bots');
  assert.ok(spread.b - spread.a > 30 * MIN, 'first sessions are staggered');
  const name = one(db, 'SELECT name FROM players LIMIT 1').name;
  assert.throws(
    () => auth.login(db, name, '!', T0),
    (e: any) => e instanceof GameError && e.code === 'bad_login',
  );
  assert.throws(
    () => auth.login(db, name, '', T0),
    (e: any) => e instanceof GameError && e.code === 'bad_login',
  );
});

test('tickBots only runs bots that are due and always schedules the next session in the future', () => {
  const db = openDb(),
    rng = seeded(3);
  ensureBots(db, 20, T0, rng);
  db.prepare('UPDATE bots SET next_at = ?').run(T0 + 5 * HOUR);
  assert.equal(tickBots(db, T0, rng).ran, 0);
  db.prepare('UPDATE bots SET next_at = ? WHERE player_id IN (SELECT player_id FROM bots LIMIT 7)').run(T0 - MIN);
  const r = tickBots(db, T0, rng);
  assert.equal(r.ran, 7);
  assert.equal(r.errors, 0);
  assert.equal(one(db, 'SELECT COUNT(*) n FROM bots WHERE next_at <= ?', T0).n, 0, 'nobody is scheduled in the past');
  assert.equal(one(db, 'SELECT SUM(sessions) n FROM bots').n, 7);
});

/** One bot with a chosen persona and state, ready to play at T0. */
function loneBot(persona: string, sql = '', seed = 5) {
  const db = openDb(),
    rng = seeded(seed);
  ensureBots(db, 1, T0, rng);
  const id = one(db, 'SELECT player_id id FROM bots').id as number;
  db.prepare('UPDATE bots SET persona = ?, next_at = ?, tz = 0, sessions_left = 4').run(persona, T0 - MIN);
  db.prepare('INSERT INTO dungeon (player_id, week, reached_at, cooldown_until) VALUES (?, 0, 0, 9000000000000000)').run(id); // keep this scenario out of the dungeon (its loot would change what the bot buys)
  if (sql) set(db, id, sql);
  return { db, rng, id };
}

test('a bot with gold spends it: trains attributes, buys gear, keeps a reserve', () => {
  const { db, rng, id } = loneBot('brawler', 'gold = 3000, level = 12');
  const before = loadPlayer(db, id, T0);
  tickBots(db, T0, rng);
  const after = loadPlayer(db, id, T0);
  assert.ok(after.gold < before.gold, 'spent gold');
  assert.ok(after.gold >= 40, 'kept a reserve');
  assert.ok(after.str + after.def + after.agi + after.sta + after.dex > 25, 'trained');
  assert.ok(one(db, 'SELECT COUNT(*) n FROM inventory WHERE player_id = ?', id).n >= 1, 'bought gear');
});

test('a bot at level 5+ buys a sentinel, and later upgrades it', () => {
  const { db, rng, id } = loneBot('balanced', 'gold = 400, level = 6');
  tickBots(db, T0, rng);
  const first = one(db, 'SELECT sentinel_key k FROM sentinels WHERE player_id = ?', id);
  assert.ok(first, 'owns a sentinel');
  set(db, id, 'gold = 60000, level = 40');
  db.prepare('UPDATE bots SET next_at = ?').run(T0 + HOUR);
  tickBots(db, T0 + 2 * HOUR, rng);
  const second = one(db, 'SELECT sentinel_key k FROM sentinels WHERE player_id = ?', id);
  assert.notEqual(second.k, first.k, 'upgraded to a better sentinel');
});

test('going away: a bot at the end of its online window starts a long hunt, work shift, or idles logged-out', () => {
  const kinds = new Set<string>();
  for (let seed = 1; seed <= 40; seed++) {
    const { db, rng, id } = loneBot('balanced', 'gold = 500, level = 5', seed);
    db.prepare('UPDATE bots SET sessions_left = 1').run(); // this is the last session of the window
    tickBots(db, T0, rng);
    const p = loadPlayer(db, id, T0);
    const next = one(db, 'SELECT next_at n, sessions_left s FROM bots').n as number;
    assert.ok(next > T0 + MIN);
    if (p.hunt_until && p.hunt_until > T0) {
      kinds.add('hunt');
      assert.ok(next >= p.hunt_until, 'wakes up after the hunt ends');
    } else if (p.work_until && p.work_until > T0) {
      kinds.add('work');
      assert.ok(next >= p.work_until);
    } else {
      kinds.add('idle');
      assert.ok(next >= T0 + 60 * MIN, 'idle for at least an hour');
    }
    assert.ok(one(db, 'SELECT sessions_left s FROM bots').s >= 1, 'a new online window was rolled');
  }
  assert.deepEqual([...kinds].sort(), ['hunt', 'idle', 'work'], 'all three away modes occur');
});

test('bots sleep at night (local time) instead of playing every 20 minutes', () => {
  const { db, rng } = loneBot('brawler', 'gold = 500, level = 5');
  const night = Date.UTC(2027, 0, 16, 3, 0, 0); // 03:00 local with tz 0
  db.prepare('UPDATE bots SET next_at = ?, sessions_left = 9').run(night - MIN);
  set(db, 1, `hp = max_hp, hp_at = ${night}`);
  tickBots(db, night, rng);
  assert.ok(one(db, 'SELECT next_at n FROM bots').n > night, 'scheduled');
  // over many nights: mostly long gaps (>=2h) rather than the 16-40 min daytime rhythm
  let long = 0;
  for (let seed = 1; seed <= 30; seed++) {
    const b = loneBot('brawler', 'gold = 500, level = 5', seed);
    b.db.prepare('UPDATE bots SET next_at = ?, sessions_left = 9').run(night - MIN);
    tickBots(b.db, night, b.rng);
    if (one(b.db, 'SELECT next_at n FROM bots').n - night >= 2 * HOUR) long++;
  }
  assert.ok(long >= 18, `only ${long}/30 slept at night`);
});

test('leader bots found clans, other bots join them, leaders accept applications', () => {
  const db = openDb(),
    rng = seeded(11);
  ensureBots(db, 40, T0, rng);
  db.prepare('UPDATE players SET level = 6, gold = 300').run();
  for (let i = 0; i < 40; i++) tickBots(db, T0 + i * 30 * MIN, rng, { humans: false }, 200);
  const clans = one(db, 'SELECT COUNT(*) n FROM clans').n;
  assert.ok(clans >= 2, `clans founded: ${clans}`);
  assert.ok(one(db, 'SELECT COUNT(*) n FROM players WHERE clan_id IS NOT NULL').n >= clans + 5, 'followers joined');
  // every clan is led by a leader-persona bot and has its leader as a member
  const rows = db.prepare('SELECT c.id, c.leader_id, b.persona FROM clans c JOIN bots b ON b.player_id = c.leader_id').all() as any[];
  assert.equal(rows.length, clans);
  assert.ok(
    rows.every((r) => PERSONAS[r.persona].social >= 0.7),
    'only clan-minded personas found clans',
  );
  assert.ok(rows.every((r) => one(db, 'SELECT clan_id c FROM players WHERE id = ?', r.leader_id).c === r.id));
  assert.equal(one(db, 'SELECT COUNT(*) n FROM forum_threads').n >= 1, true, 'leaders open a welcome thread');
});

test('bots leave real players alone when humanRaidChance is 0 (and can hit them when it is 1)', () => {
  for (const [chance, expectHits] of [
    [0, false],
    [1, true],
  ] as const) {
    const db = openDb(),
      rng = seeded(21);
    ensureBots(db, 30, T0, rng);
    const human = auth.register(db, { name: 'HumanPlayer', password: 'secret12', race: 'vampire' }, T0);
    db.prepare('UPDATE players SET level = 5, str = 20, def = 20, agi = 20, sta = 20, max_hp = 150, hp = 150 WHERE id = ?').run(human);
    db.prepare("UPDATE players SET level = 5, str = 40, def = 40, agi = 40, sta = 40, max_hp = 150, hp = 150 WHERE is_bot = 1 AND race = 'werewolf'").run();
    db.prepare("UPDATE bots SET persona = 'brawler'").run();
    for (let i = 0; i < 60; i++) {
      db.prepare('UPDATE players SET hp = max_hp, hp_at = ? WHERE is_bot = 1').run(T0 + i * 20 * MIN);
      tickBots(db, T0 + i * 20 * MIN, rng, { humans: true, humanRaidChance: chance }, 200);
    }
    const hits = one(db, 'SELECT COUNT(*) n FROM battles WHERE defender_id = ? OR attacker_id = ?', human, human).n;
    if (expectHits) assert.ok(hits > 0, 'with chance 1 the human gets raided sometimes');
    else assert.equal(hits, 0, `human was raided ${hits}x`);
  }
});

test('fast-forward simulation: replays days with bots only, never touches real players, no time travel', () => {
  const db = openDb(),
    rng = seeded(31);
  const human = auth.register(db, { name: 'HumanPlayer', password: 'secret12', race: 'werewolf' }, T0);
  db.prepare('UPDATE players SET hp = 90, hp_at = ?, gold = 777 WHERE id = ?').run(T0, human);
  ensureBots(db, 40, T0, rng);
  fastForward(db, 5, T0, rng, { stepMin: 30 });
  const h = loadPlayer(db, human, T0);
  assert.equal(h.gold, 777);
  assert.equal(h.wins + h.losses, 0);
  assert.equal(one(db, 'SELECT COUNT(*) n FROM battles WHERE attacker_id = ? OR defender_id = ?', human, human).n, 0);
  const b = one(db, 'SELECT MIN(at) a, MAX(at) z FROM battles');
  assert.ok(b.a >= T0 - 5 * DAY_MS && b.z <= T0, 'battle history lies inside the replayed window');
  const r = botReport(db, T0);
  assert.ok(r.battles.total > 50 && r.level.max > 1 && r.errors === 0, JSON.stringify(r.battles));
  assert.ok(one(db, 'SELECT MIN(hp) m FROM players WHERE is_bot = 1').m >= 1, 'HP never went negative from time travel');
});

test('simulation invariants over 8 days: rules hold, world stays sane', () => {
  const db = openDb(),
    rng = seeded(1);
  ensureBots(db, 60, T0, rng);
  fastForward(db, 8, T0, rng);
  const r = botReport(db, T0);
  assert.equal(r.errors, 0);
  assert.ok(r.clans.total >= 2 && r.clans.inClan >= 10, `clans ${JSON.stringify(r.clans)}`);
  assert.ok(r.battles.total > 500, `battles ${r.battles.total}`);
  assert.ok(r.arena.done >= 1, 'arena events were played');
  assert.ok(r.market.sold >= 1 && r.market.volume > 0, `bots trade in the Blood Temple: ${JSON.stringify(r.market)}`);
  assert.equal(r.mail, 0, 'nothing is mailed to bots');
  assert.equal(one(db, 'SELECT COUNT(*) n FROM temple_listings WHERE price < 1').n, 0);
  assert.ok(r.level.median >= 5 && r.level.max <= 60, `levels ${JSON.stringify(r.level)}`);
  assert.ok(r.gold.max < 100_000, `gold stays sane, max ${r.gold.max}`);
  // hard invariants of the data model
  assert.equal(one(db, 'SELECT COUNT(*) n FROM players WHERE gold < 0').n, 0, 'no negative gold');
  assert.equal(one(db, 'SELECT COUNT(*) n FROM players WHERE hp < 0 OR hp > max_hp + 0.001').n, 0, 'HP in range');
  assert.equal(
    one(db, 'SELECT COUNT(*) n FROM clans c WHERE NOT EXISTS (SELECT 1 FROM players p WHERE p.id = c.leader_id AND p.clan_id = c.id)').n,
    0,
    'every leader belongs to their clan',
  );
  assert.equal(
    one(
      db,
      `SELECT COUNT(*) n FROM clans c WHERE (SELECT COUNT(*) FROM players p WHERE p.clan_id = c.id) > ${CFG.clanBaseSlots} + c.domicile_level * ${CFG.clanSlotsPerLevel}`,
    ).n,
    0,
    'no clan exceeds its domicile capacity',
  );
  assert.equal(one(db, 'SELECT COUNT(*) n FROM battles WHERE attacker_id = defender_id').n, 0);
  assert.equal(
    one(db, 'SELECT COUNT(*) n FROM battles b JOIN players a ON a.id = b.attacker_id JOIN players d ON d.id = b.defender_id WHERE a.race = d.race').n,
    0,
    'only cross-race raids',
  );
  assert.equal(one(db, 'SELECT COUNT(*) n FROM players WHERE is_bot = 1 AND work_until > ? AND hunt_until > ?', T0, T0).n, 0, 'nobody works and hunts at once');
  // deterministic: same seed, same world
  const db2 = openDb(),
    rng2 = seeded(1);
  ensureBots(db2, 60, T0, rng2);
  fastForward(db2, 8, T0, rng2);
  assert.deepEqual(botReport(db2, T0), r, 'the simulation is reproducible from the seed');
});

test('bots delve: enter, fight one level per wait, claim guardian rewards, sell loot, and a run always ends (they never sit inside forever)', () => {
  const db = openDb(),
    rng = seeded(41);
  ensureBots(db, 1, T0, rng);
  const id = one(db, 'SELECT player_id id FROM bots').id as number;
  db.prepare("UPDATE bots SET persona = 'brawler', tz = 12, sessions_left = 99").run();
  set(db, id, 'level = 30, str = 90, def = 90, agi = 90, sta = 90, dex = 90, max_hp = 300, hp = 300, gold = 0');
  let t = T0,
    wasInside = false,
    maxStreak = 0,
    streak = 0,
    guardianRewards = 0;
  const inside = () => {
    const u = one(db, 'SELECT dungeon_until u FROM players WHERE id = ?', id).u;
    return u !== null && u > t;
  };
  for (let i = 0; i < 6 * 288; i++) {
    // six days in 5-minute steps
    set(db, id, `hp = max_hp, hp_at = ${t}`);
    tickBots(db, t, rng, { humans: false });
    if (inside()) {
      wasInside = true;
      streak++;
      maxStreak = Math.max(maxStreak, streak);
    } else streak = 0;
    t += 5 * MIN;
  }
  const d = one(db, 'SELECT * FROM dungeon WHERE player_id = ?', id);
  assert.ok(wasInside, 'the bot spent time inside');
  assert.ok(maxStreak >= 6, `a run lasts many waits, not one visit (${maxStreak} steps in a row)`);
  assert.ok(maxStreak < 6 * 288, 'but it always ends (dying), the bot is not stuck inside');
  assert.ok(d.runs >= 3 && d.runs <= 6, `about one run per day over six days: ${d.runs}`);
  assert.ok(d.best_ever > 15, `went deep: best ever ${d.best_ever}`);
  assert.equal(d.pending === null || d.active === 1, true, 'no guardian reward left unclaimed outside a run');
  const soldOrHeld = one(db, 'SELECT COUNT(*) n FROM dungeon_loot WHERE player_id = ?', id).n as number;
  assert.ok(soldOrHeld < 14, `loot is regularly sold to the dealer (${soldOrHeld} items held)`);
  assert.ok(one(db, 'SELECT gold g FROM players WHERE id = ?', id).g > 0, 'earned gold from loot');
  void guardianRewards;
});

test('a hunting or working bot does not enter the dungeon (one thing at a time)', () => {
  const db = openDb(),
    rng = seeded(42);
  ensureBots(db, 1, T0, rng);
  const id = one(db, 'SELECT player_id id FROM bots').id as number;
  db.prepare("UPDATE bots SET persona = 'brawler', next_at = ?").run(T0 - MIN);
  set(db, id, `hunt_started = ${T0 - MIN}, hunt_until = ${T0 + HOUR}, hunt_portions = 6`);
  tickBots(db, T0, rng, { humans: false });
  assert.equal(one(db, 'SELECT COUNT(*) n FROM dungeon WHERE player_id = ? AND runs > 0', id).n, 0);
});

test('dungeon world invariants over a simulated fortnight incl. two weekly wipes', () => {
  const db = openDb(),
    rng = seeded(1);
  ensureBots(db, 60, T0, rng);
  fastForward(db, 14, T0, rng);
  const r = botReport(db, T0);
  assert.equal(r.errors, 0);
  assert.ok(r.dungeon.delvers >= 30, `delvers ${JSON.stringify(r.dungeon)}`);
  assert.ok(r.dungeon.deepest >= 15 && r.dungeon.deepest < 200, `deepest ${r.dungeon.deepest}`);
  assert.ok(r.dungeon.inside < 30, `a few bots may be in the middle of a run (they stay inside between fights), not half of them: ${r.dungeon.inside}`);
  assert.ok(one(db, 'SELECT COUNT(*) n FROM dungeon_weekly').n > 0, 'past weeks were archived by the weekly reset');
  assert.equal(one(db, 'SELECT COUNT(*) n FROM dungeon WHERE depth < 1 OR hp < 0 OR (active = 1 AND hp <= 0)').n, 0, 'no nonsense rows');
  assert.equal(one(db, 'SELECT COUNT(*) n FROM dungeon_loot WHERE value < 1').n, 0);
  assert.equal(one(db, 'SELECT COUNT(*) n FROM dungeon WHERE week != ?', Math.floor((T0 - 4 * DAY_MS) / (7 * DAY_MS))).n <= 60, true);
  // the lock and the run state always agree
  assert.equal(
    one(db, 'SELECT COUNT(*) n FROM players p JOIN dungeon d ON d.player_id = p.id WHERE d.active = 0 AND p.dungeon_until > ?', T0).n,
    0,
    'nobody is locked without an active run',
  );
});

test('fresh bots start exactly like new players: level 1, 5 everywhere, start gold, no history at all', () => {
  const db = openDb(),
    rng = seeded(77);
  ensureBots(db, 100, T0, rng);
  const bots = db
    .prepare('SELECT level, xp, gold, str, def, agi, sta, dex, wins, losses, clan_id, max_hp, hp, created_at FROM players WHERE is_bot = 1')
    .all() as any[];
  assert.equal(bots.length, 100);
  for (const b of bots) {
    assert.deepEqual([b.level, b.xp, b.gold, b.str, b.def, b.agi, b.sta, b.dex, b.wins, b.losses, b.clan_id], [1, 0, CFG.startGold, 5, 5, 5, 5, 5, 0, 0, null]);
    assert.equal(b.max_hp, CFG.startMaxHp);
    assert.equal(b.hp, CFG.startMaxHp);
    assert.equal(b.created_at, T0);
  }
  for (const t of [
    'battles',
    'clans',
    'clan_wars',
    'arena_events',
    'temple_listings',
    'inventory',
    'sentinels',
    'counters',
    'dungeon',
    'dungeon_loot',
    'forum_threads',
  ]) {
    assert.equal(one(db, `SELECT COUNT(*) n FROM ${t}`).n, 0, `${t} starts empty`);
  }
  // nobody acts before their first scheduled session, and those are spread over the first two hours
  assert.equal(tickBots(db, T0 - MIN, rng).ran, 0);
  const spread = one(db, 'SELECT MIN(next_at) a, MAX(next_at) b FROM bots');
  assert.ok(spread.a >= T0 && spread.b <= T0 + 120 * MIN, 'first sessions lie within the first two hours');
});

test('the server never fast-forwards or replays bot history', async () => {
  const { readFileSync } = await import('node:fs');
  const server = readFileSync('src/server/main.ts', 'utf8');
  assert.equal(/fastForward|warmUp|WARMUP/i.test(server), false, 'src/server/main.ts must not simulate history for bots');
  assert.match(server, /ensureBots\(/, 'but it does create the bots');
});

test('bots spend their skill points along a plan: a class from their favourite region, one connected build, keystones only where it suits', async () => {
  const { isConnected, NODE_BY_ID, REGIONS: regions } = await import('../../src/data/skill-board.ts');
  const { pointsFor } = await import('../../src/game/character/skills.ts');
  const db = openDb(),
    rng = seeded(61);
  ensureBots(db, 60, T0, rng);
  fastForward(db, 25, T0, rng);
  const bots = db.prepare('SELECT b.persona, p.id, p.level, p.skill_start FROM bots b JOIN players p ON p.id = b.player_id').all() as {
    persona: string;
    id: number;
    level: number;
    skill_start: string | null;
  }[];
  const stats = new Map<string, { n: number; regions: Map<string, number> }>();
  let withBoard = 0;
  for (const b of bots) {
    const nodes = (db.prepare('SELECT node_id FROM skills WHERE player_id = ?').all(b.id) as { node_id: string }[]).map((r) => r.node_id);
    const spent = pointsFor(nodes);
    assert.ok(spent <= b.level, `${b.persona}: ${spent} points spent at level ${b.level}`);
    if (!nodes.length) continue;
    withBoard++;
    assert.ok(isConnected(new Set(nodes), b.skill_start ?? undefined), 'the build is one connected piece');
    assert.equal(NODE_BY_ID.get(b.skill_start!)!.kind, 'origin', 'the class is a start node');
    assert.ok(spent >= b.level - 3, `a bot spends its points (a notable or keystone may wait for more): ${spent} of ${b.level}`);
    const s = stats.get(b.persona) ?? { n: 0, regions: new Map() };
    stats.set(b.persona, s);
    s.n++;
    for (const id of nodes) {
      const r = NODE_BY_ID.get(id)!.region;
      s.regions.set(r, (s.regions.get(r) ?? 0) + 1);
      if (NODE_BY_ID.get(id)!.kind === 'keystone') assert.equal(b.persona, 'hunter', 'only the hunter persona takes a keystone');
    }
  }
  assert.ok(withBoard >= 50, `most bots have a board: ${withBoard}`);
  const favourite = (persona: string) =>
    [...(stats.get(persona)?.regions ?? [])].filter(([r]) => regions.some((x) => x.key === r)).sort((a, z) => z[1] - a[1])[0]?.[0];
  assert.equal(favourite('brawler'), 'warrior');
  assert.equal(favourite('hunter'), 'hunter');
  assert.equal(favourite('worker'), 'artisan');
  assert.equal(favourite('leader'), 'warden');
  assert.equal(favourite('casual'), 'acolyte');
});
