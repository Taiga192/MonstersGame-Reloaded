import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CFG, HOUR, MIN } from '../src/config.ts';
import { openDb } from '../src/db.ts';
import { fillMyClan, healBots, seedEnemyClan } from '../src/dev.ts';
import { GameError } from '../src/errors.ts';
import * as auth from '../src/game/auth.ts';
import * as clan from '../src/game/clan.ts';
import { loadPlayer } from '../src/game/player.ts';
import * as war from '../src/game/war.ts';
import { seeded } from '../src/rng.ts';

const T0 = 1_800_000_000_000;
const code = (fn: () => unknown) => { try { fn(); } catch (e) { return (e as GameError).code; } return 'none'; };

/** A strong tester with a 5-member clan at war with a 6-bot enemy clan. */
function setup(seed = 3) {
  const db = openDb();
  const rng = seeded(seed);
  const id = auth.register(db, { name: 'Tester', password: 'secret12', race: 'vampire' }, T0);
  db.prepare('UPDATE players SET level = 20, str = 80, def = 80, agi = 80, sta = 80, dex = 80, max_hp = 300, hp = 300, hp_at = ? WHERE id = ?').run(T0, id);
  clan.createClan(db, id, 'My Court', T0);
  fillMyClan(db, id, T0, rng);
  const enemy = seedEnemyClan(db, id, T0, rng);
  const target = (db.prepare('SELECT id FROM clans WHERE name = ?').get(enemy.clan) as { id: number }).id;
  const warId = clan.declareWar(db, id, target, T0);
  const enemyIds = (db.prepare('SELECT id FROM players WHERE clan_id = ?').all(target) as { id: number }[]).map((r) => r.id);
  return { db, rng, id, target, warId, enemyIds };
}
const heal = (db: ReturnType<typeof openDb>, id: number, t: number) => db.prepare('UPDATE players SET hp = max_hp, hp_at = ? WHERE id = ?').run(t, id);

test('war attack: needs a war, hits a random ENEMY war member, tags the battle with the war', () => {
  const { db, rng, id, warId, enemyIds } = setup();
  const lone = auth.register(db, { name: 'Loner', password: 'secret12', race: 'vampire' }, T0);
  assert.equal(code(() => war.warAttack(db, lone, T0, rng)), 'no_war');
  const r = war.warAttack(db, id, T0 + MIN, rng);
  assert.equal(r.warId, warId);
  assert.ok(enemyIds.includes(r.target.id), 'target belongs to the enemy clan');
  assert.equal((db.prepare('SELECT war_id FROM battles WHERE id = ?').get(r.battleId) as { war_id: number }).war_id, warId);
});

test('war attack: picks different people over time (randomised) and respects the raid cooldown', () => {
  const { db, rng, id, enemyIds } = setup(9);
  const hit = new Set<number>();
  let t = T0 + MIN;
  for (let i = 0; i < 6; i++) {
    heal(db, id, t);
    hit.add(war.warAttack(db, id, t, rng).target.id);
    if (i === 0) { heal(db, id, t + 5 * MIN); assert.equal(code(() => war.warAttack(db, id, t + 5 * MIN, rng)), 'cooldown'); }
    t += 16 * MIN;
  }
  assert.ok(hit.size >= 3, `expected several different targets, got ${hit.size}`);
  assert.ok([...hit].every((x) => enemyIds.includes(x)));
});

test('war attack only picks enemies within the skill band', () => {
  const { db, rng, id, enemyIds } = setup();
  // make all but one enemy far stronger than the tester
  const [keep, ...rest] = enemyIds;
  for (const e of rest) db.prepare('UPDATE players SET str = 400, def = 400, agi = 400, sta = 400, dex = 400 WHERE id = ?').run(e);
  db.prepare('UPDATE players SET str = 80, def = 80, agi = 80, sta = 80, dex = 80 WHERE id = ?').run(keep);
  const roster = war.warRoster(db, id, T0);
  assert.equal(roster.targets.filter((t) => t.status === 'available').length, 1);
  assert.equal(roster.targets.filter((t) => t.status === 'range').length, rest.length);
  for (let i = 0; i < 3; i++) {
    const t = T0 + MIN + i * 61 * MIN; // outside the 1 h protection
    heal(db, id, t); heal(db, keep, t);
    assert.equal(war.warAttack(db, id, t, rng).target.id, keep);
  }
});

test('war attack: 4 hits per enemy per 12h, then no_targets with a helpful reason', () => {
  const { db, rng, id, enemyIds } = setup();
  const [keep, ...rest] = enemyIds;
  for (const e of rest) db.prepare('UPDATE players SET str = 400, def = 400, agi = 400, sta = 400, dex = 400 WHERE id = ?').run(e);
  db.prepare('UPDATE players SET str = 80, def = 80, agi = 80, sta = 80, dex = 80 WHERE id = ?').run(keep);
  let t = T0 + MIN;
  for (let i = 0; i < CFG.sameOpponentMaxWar; i++) { heal(db, id, t); heal(db, keep, t); war.warAttack(db, id, t, rng); t += 61 * MIN; }
  heal(db, id, t); heal(db, keep, t);
  assert.equal(war.warRoster(db, id, t).targets.find((x) => x.id === keep)!.status, 'limit');
  try { war.warAttack(db, id, t, rng); assert.fail('should refuse'); } catch (e) { assert.equal((e as GameError).code, 'no_targets'); assert.match((e as GameError).message, /already hit 4x/); }
});

test('war roster statuses: wounded, protected after a hit, busy hunting', () => {
  const { db, rng, id, enemyIds } = setup();
  const [a, b] = enemyIds;
  db.prepare('UPDATE players SET hp = 10, hp_at = ? WHERE id = ?').run(T0, a);
  db.prepare('UPDATE players SET hunt_started = ?, hunt_until = ? WHERE id = ?').run(T0, T0 + HOUR, b);
  const st = (t: number, who: number) => war.warRoster(db, id, t).targets.find((x) => x.id === who)!.status;
  assert.equal(st(T0, a), 'low_hp');
  assert.equal(st(T0, b), 'busy');
  const r = war.warAttack(db, id, T0 + MIN, rng);
  heal(db, r.target.id, T0 + MIN); // a beaten target may be too wounded, which takes precedence; heal so protection is what remains
  const p = war.warRoster(db, id, T0 + 2 * MIN).targets.find((x) => x.id === r.target.id)!;
  assert.equal(p.status, 'protected');
  assert.ok(p.protectedUntil! > T0 + 2 * MIN);
});

test('war attack during a ceasefire resumes the war; after peace it is refused', () => {
  const { db, rng, id, target } = setup();
  assert.equal(clan.offerCeasefire(db, id, T0), 'offered');
  const enemyLeader = (db.prepare('SELECT leader_id FROM clans WHERE id = ?').get(target) as { leader_id: number }).leader_id;
  assert.equal(clan.offerCeasefire(db, enemyLeader, T0), 'ceasefire');
  assert.equal(clan.activeWarFor(db, (db.prepare('SELECT clan_id FROM players WHERE id = ?').get(id) as { clan_id: number }).clan_id)!.status, 'ceasefire');
  war.warAttack(db, id, T0 + MIN, rng);
  assert.equal(war.warOf(db, id)!.war.status, 'active', 'attacking ended the ceasefire');
  clan.offerPeace(db, id, T0 + 2 * MIN); clan.offerPeace(db, enemyLeader, T0 + 2 * MIN);
  assert.equal(war.warOf(db, id), null);
  assert.equal(code(() => war.warAttack(db, id, T0 + 20 * MIN, rng)), 'no_war');
});

test('scoreboard: points = battles won by each clan, member stats add up', () => {
  const { db, rng, id, warId, target } = setup(21);
  let t = T0 + MIN, fights = 0;
  for (let i = 0; i < 8; i++) { heal(db, id, t); healBots(db, t); war.warAttack(db, id, t, rng); fights++; t += 16 * MIN; } // enemies are healed too, so they stay attackable
  const sb = war.warScoreboard(db, warId);
  const myClan = (db.prepare('SELECT clan_id FROM players WHERE id = ?').get(id) as { clan_id: number }).clan_id;
  const mine = sb.clans.find((c: any) => c.clan_id === myClan) as any, enemy = sb.clans.find((c: any) => c.clan_id === target) as any;
  assert.equal(mine.points + enemy.points, fights, 'every battle awards exactly one point');
  assert.equal(mine.attacks, fights);
  const me = sb.members.find((m: any) => m.player_id === id) as any;
  assert.equal(me.attacks, fights);
  assert.equal(me.wins, mine.points, 'the tester is the only attacker, so their wins are the clan points (defence points are the enemy clan)');
  assert.equal(sb.members.length, 5 + 6);
  assert.equal(me.gold, mine.gold);
});

test('dev: heal bots restores wounded enemies', () => {
  const { db, id, enemyIds } = setup();
  db.prepare('UPDATE players SET hp = 3, hp_at = ? WHERE id = ?').run(T0, enemyIds[0]);
  assert.equal(war.warRoster(db, id, T0).targets.find((x) => x.id === enemyIds[0])!.status, 'low_hp');
  healBots(db, T0);
  assert.equal(war.warRoster(db, id, T0).targets.find((x) => x.id === enemyIds[0])!.status, 'available');
  assert.equal(loadPlayer(db, id, T0).id, id, 'real accounts (with a session) are untouched by design; tester has none here, so also healed');
});
