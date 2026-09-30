import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MIN } from '../src/config.ts';
import { openDb } from '../src/db.ts';
import { enemyDeclaresWar, enemyNegotiates, fillMyClan, seedEnemyClan } from '../src/dev.ts';
import { GameError } from '../src/errors.ts';
import * as auth from '../src/game/auth.ts';
import * as clan from '../src/game/clan.ts';
import { loadPlayer } from '../src/game/player.ts';
import * as raid from '../src/game/raid.ts';
import { seeded } from '../src/rng.ts';

const T0 = 1_800_000_000_000;
const code = (fn: () => unknown) => { try { fn(); } catch (e) { return (e as GameError).code; } return 'none'; };

function me() {
  const db = openDb();
  const id = auth.register(db, { name: 'Tester', password: 'secret12', race: 'vampire' }, T0);
  db.prepare('UPDATE players SET level = 20, str = 60, def = 60, agi = 60, sta = 60, dex = 60, max_hp = 200, hp = 200 WHERE id = ?').run(id);
  return { db, id, rng: seeded(11) };
}
const members = (db: ReturnType<typeof openDb>, clanId: number) => (db.prepare('SELECT COUNT(*) n FROM players WHERE clan_id = ?').get(clanId) as { n: number }).n;

test('dev: enemy bot clan is created with 6 members of the other race, leader has all permissions', () => {
  const { db, id, rng } = me();
  const r = seedEnemyClan(db, id, T0, rng);
  const c = db.prepare('SELECT * FROM clans WHERE name = ?').get(r.clan) as { id: number; race: string; leader_id: number };
  assert.equal(c.race, 'werewolf');
  assert.equal(members(db, c.id), 6);
  assert.deepEqual(clan.permsOf(db, c.leader_id).sort(), [...clan.CLAN_PERMS].sort());
  // bots are comparable to the tester so raids are meaningful
  const bot = loadPlayer(db, c.leader_id, T0);
  assert.ok(bot.level >= 5 && Math.abs(bot.str - 60) <= 7, `bot str ${bot.str}`);
});

test('dev: fill my clan to 5, declare war on the enemy clan, then raid war targets 4x per 12h', () => {
  const { db, id, rng } = me();
  assert.equal(code(() => fillMyClan(db, id, T0, rng)), 'dev', 'needs a clan first');
  const mine = clan.createClan(db, id, 'My Court', T0);
  const enemy = seedEnemyClan(db, id, T0, rng);
  const target = (db.prepare('SELECT id FROM clans WHERE name = ?').get(enemy.clan) as { id: number }).id;
  assert.equal(code(() => clan.declareWar(db, id, target, T0)), 'too_small', 'a lone leader cannot declare war');
  fillMyClan(db, id, T0, rng);
  assert.equal(members(db, mine), 5);
  assert.match(fillMyClan(db, id, T0, rng).message, /already/);
  const warId = clan.declareWar(db, id, target, T0);
  assert.ok(warId > 0);
  // the war is in effect: a raid against a bot in the enemy clan is tagged with the war
  const t = T0 + MIN;
  db.prepare('UPDATE players SET hp = 200, hp_at = ? WHERE id = ?').run(t, id);
  let result: ReturnType<typeof raid.attack> | undefined;
  for (let i = 0; i < 60 && !result; i++) {
    const s = raid.searchOpponent(db, id, t, rng);
    if (s.found) result = raid.attack(db, id, s.target.id, t, rng);
  }
  assert.ok(result, 'found and attacked an enemy bot');
  assert.equal(result!.warId, warId);
});

test('dev: enemy declares war on my clan, and peace works from both directions', () => {
  const { db, id, rng } = me();
  assert.equal(code(() => enemyDeclaresWar(db, id, T0, rng)), 'dev', 'needs a clan');
  const mine = clan.createClan(db, id, 'My Court', T0);
  const r = enemyDeclaresWar(db, id, T0, rng);
  assert.match(r.message, /declared war on your clan/);
  const war = clan.activeWarFor(db, mine)!;
  assert.notEqual(war.aggressor_id, mine, 'the bot clan is the aggressor');
  assert.equal(code(() => enemyDeclaresWar(db, id, T0, rng)), 'dev', 'already at war');

  // enemy offers peace first -> I accept from the clan page
  assert.match(enemyNegotiates(db, id, 'peace', T0).message, /offer peace/);
  assert.equal(clan.offerPeace(db, id, T0), 'peace');
  assert.equal(clan.activeWarFor(db, mine), undefined);

  // I offer first -> the enemy accepts
  enemyDeclaresWar(db, id, T0, rng);
  assert.equal(clan.offerCeasefire(db, id, T0), 'offered');
  assert.match(enemyNegotiates(db, id, 'ceasefire', T0).message, /ceasefire agreed/);
  assert.equal(clan.activeWarFor(db, mine)!.status, 'ceasefire');
  assert.match(enemyNegotiates(db, id, 'capitulate', T0).message, /capitulated/);
  assert.equal(clan.activeWarFor(db, mine), undefined);
  assert.equal(code(() => enemyNegotiates(db, id, 'peace', T0)), 'dev', 'no war left');
  assert.equal(code(() => enemyNegotiates(db, id, 'dance', T0)), 'dev');
});
