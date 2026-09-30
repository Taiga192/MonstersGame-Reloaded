import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CFG, DAY_MS, HOUR, MIN } from '../src/config.ts';
import { openDb, tx } from '../src/db.ts';
import { GameError } from '../src/errors.ts';
import { seeded } from '../src/rng.ts';
import * as acc from '../src/game/accomplishments.ts';
import * as arena from '../src/game/arena.ts';
import * as auth from '../src/game/auth.ts';
import * as clan from '../src/game/clan.ts';
import { bump } from '../src/game/counters.ts';
import * as eco from '../src/game/economy.ts';
import * as forum from '../src/game/forum.ts';
import * as hs from '../src/game/highscore.ts';
import * as mail from '../src/game/mail.ts';
import { battleStats, loadPlayer } from '../src/game/player.ts';
import * as temple from '../src/game/temple.ts';

const T0 = Date.UTC(2027, 0, 15, 8, 0, 0); // 08:00 UTC
function world() {
  const db = openDb();
  let n = 0;
  const mk = (race: 'vampire' | 'werewolf' = 'vampire', name = `pl${++n}`) => auth.register(db, { name, password: 'secret12', race }, T0);
  return { db, mk };
}
const code = (fn: () => unknown) => { try { fn(); } catch (e) { return (e as GameError).code; } return 'none'; };
const give = (db: ReturnType<typeof openDb>, id: number, sql: string) => db.prepare(`UPDATE players SET ${sql} WHERE id = ?`).run(id);

// ---------------- accomplishments ----------------
test('accomplishments: tiers from counters; only the ACTIVE set grants its bonus', () => {
  const { db, mk } = world();
  const id = mk();
  assert.equal(acc.accomplishmentStatus(db, id).find((a) => a.key === 'raider')!.tier, 0);
  bump(db, id, 'raids_won', 25); // tiers at 5, 25 -> tier 2
  assert.equal(acc.accomplishmentStatus(db, id).find((a) => a.key === 'raider')!.tier, 2);
  assert.equal(code(() => acc.saveSet(db, id, 0, ['duelist'])), 'not_earned');
  acc.saveSet(db, id, 1, ['raider']);
  const p = loadPlayer(db, id, T0);
  assert.equal(battleStats(db, p, { ancestral: false }).str, 5, 'no active set yet');
  acc.activateSet(db, id, 1);
  assert.equal(battleStats(db, p, { ancestral: false }).str, 5 + 2, 'raider tier 2 = +2 STR');
  acc.activateSet(db, id, 0); // empty set 0 active
  assert.equal(battleStats(db, p, { ancestral: false }).str, 5);
  assert.equal(code(() => acc.saveSet(db, id, 0, ['raider', 'raider'])), 'bad_set');
  assert.equal(code(() => acc.saveSet(db, id, 9, [])), 'bad_set');
});

test('accomplishments: level counter, and set holds at most 5', () => {
  const { db, mk } = world();
  const id = mk();
  give(db, id, 'level = 30');
  assert.equal(acc.accomplishmentStatus(db, id).find((a) => a.key === 'veteran')!.tier, 2);
  for (const k of ['raids_won', 'defenses_won', 'arena_wins', 'work_hours', 'hunt_portions', 'gold_stolen']) bump(db, id, k, 100000);
  assert.equal(code(() => acc.saveSet(db, id, 0, ['raider', 'guardian', 'duelist', 'gravedigger', 'tracker', 'plunderer'])), 'bad_set');
  acc.saveSet(db, id, 0, ['raider', 'guardian', 'duelist', 'gravedigger', 'tracker']);
});

test('raids and hunts feed accomplishment counters', async () => {
  const { db, mk } = world();
  const id = mk();
  eco.startHunt(db, id, 3, T0);
  eco.collectHunt(db, id, T0 + 30 * MIN, () => 0.99);
  const s = acc.accomplishmentStatus(db, id);
  assert.equal(s.find((a) => a.key === 'tracker')!.value, 3);
  assert.equal(s.find((a) => a.key === 'town_burner')!.value, 3);
});

// ---------------- hardening ----------------
test('weapon hardening: gold cost, +2 STR per level, max 10, weapons only', () => {
  const { db, mk } = world();
  const id = mk();
  give(db, id, 'gold = 1000000, level = 20');
  eco.buyItem(db, id, 'itm_Blade_1', T0);
  eco.buyItem(db, id, 'ring_stat_1', T0);
  const inv = db.prepare('SELECT id, item_key FROM inventory WHERE player_id = ?').all(id) as { id: number; item_key: string }[];
  const blade = inv.find((i) => i.item_key === 'itm_Blade_1')!.id;
  const ring = inv.find((i) => i.item_key === 'ring_stat_1')!.id;
  const before = battleStats(db, loadPlayer(db, id, T0), { ancestral: false }).str;
  assert.equal(code(() => eco.hardenWeapon(db, id, ring, T0)), 'not_weapon');
  const r = eco.hardenWeapon(db, id, blade, T0);
  assert.equal(r.cost, CFG.hardenCost(30, 0));
  assert.equal(battleStats(db, loadPlayer(db, id, T0), { ancestral: false }).str, before + CFG.hardenBonusPerLevel);
  for (let i = 1; i < CFG.hardenMax; i++) eco.hardenWeapon(db, id, blade, T0);
  assert.equal(code(() => eco.hardenWeapon(db, id, blade, T0)), 'maxed');
});

// ---------------- Blood Temple ----------------
test('Blood Temple: list, buy with 5% fee, hardening travels, expiry returns the item', () => {
  const { db, mk } = world();
  const seller = mk(), buyer = mk('werewolf');
  give(db, seller, 'gold = 100000'); give(db, buyer, 'gold = 10000, level = 5');
  eco.buyItem(db, seller, 'itm_Blade_1', T0);
  const inv = (db.prepare('SELECT id FROM inventory WHERE player_id = ?').get(seller) as { id: number }).id;
  eco.hardenWeapon(db, seller, inv, T0);
  const { id: listing } = temple.listItem(db, seller, inv, 1000, T0);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM inventory WHERE player_id = ?').get(seller)!.n, 0, 'item is escrowed');
  assert.equal(code(() => temple.buyListing(db, seller, listing, T0)), 'own_listing');
  const goldBefore = loadPlayer(db, seller, T0).gold;
  temple.buyListing(db, buyer, listing, T0 + MIN);
  assert.equal(loadPlayer(db, seller, T0).gold, goldBefore + 950);
  assert.equal(loadPlayer(db, buyer, T0).gold, 9000);
  assert.equal((db.prepare('SELECT hardening FROM inventory WHERE player_id = ?').get(buyer) as { hardening: number }).hardening, 1);
  assert.equal(code(() => temple.buyListing(db, buyer, listing, T0 + MIN)), 'not_found');
  assert.equal(mail.unreadCount(db, seller), 1, 'seller notified');

  // expiry
  const inv2 = (db.prepare('SELECT id FROM inventory WHERE player_id = ?').get(buyer) as { id: number }).id;
  temple.listItem(db, buyer, inv2, 5, T0 + 2 * MIN);
  assert.equal(temple.browse(db, seller, T0 + 8 * DAY_MS).length, 0);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM inventory WHERE player_id = ?').get(buyer)!.n, 1, 'returned to owner');
});

test('Blood Temple: validation and cancel', () => {
  const { db, mk } = world();
  const a = mk(), b = mk('werewolf');
  give(db, a, 'gold = 1000000'); give(db, b, 'gold = 100');
  eco.buyItem(db, a, 'potion_heal', T0);
  const inv = (db.prepare('SELECT id FROM inventory WHERE player_id = ?').get(a) as { id: number }).id;
  assert.equal(code(() => temple.listItem(db, a, inv, 0, T0)), 'bad_price');
  assert.equal(code(() => temple.listItem(db, b, inv, 10, T0)), 'not_owned');
  const { id } = temple.listItem(db, a, inv, 500, T0);
  assert.equal(code(() => temple.buyListing(db, b, id, T0)), 'no_gold');
  temple.cancelListing(db, a, id, T0);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM inventory WHERE player_id = ?').get(a)!.n, 1);
});

// ---------------- mail ----------------
test('mail: send, unread, read, soft delete, rate limit, system mail', () => {
  const { db, mk } = world();
  const a = mk('vampire', 'Alice'), b = mk('werewolf', 'Bob');
  assert.equal(code(() => mail.sendMail(db, a, 'Nobody', 's', 'b', T0)), 'no_recipient');
  assert.equal(code(() => mail.sendMail(db, a, 'Alice', 's', 'b', T0)), 'bad_recipient');
  assert.equal(code(() => mail.sendMail(db, a, 'Bob', '', 'b', T0)), 'bad_subject');
  const { id } = mail.sendMail(db, a, 'Bob', 'Hi', 'Want to raid together?', T0);
  assert.equal(mail.unreadCount(db, b), 1);
  assert.equal(code(() => mail.readMail(db, mk(), id, T0)), 'not_found'); // strangers cannot read
  assert.equal(mail.readMail(db, b, id, T0).body, 'Want to raid together?');
  assert.equal(mail.unreadCount(db, b), 0);
  assert.equal(mail.inbox(db, b).length, 1);
  mail.deleteMail(db, b, id);
  assert.equal(mail.inbox(db, b).length, 0);
  assert.equal(mail.sentbox(db, a).length, 1, 'sender keeps their copy');
  mail.systemMail(db, b, 'Notice', 'x', T0);
  assert.equal((mail.inbox(db, b)[0] as any).from_name, 'System');
  for (let i = 0; i < CFG.mailPerHour - 1; i++) mail.sendMail(db, a, 'Bob', 's', 'b', T0 + i);
  assert.equal(code(() => mail.sendMail(db, a, 'Bob', 's', 'b', T0 + 100)), 'rate_limited');
  mail.sendMail(db, a, 'Bob', 's', 'b', T0 + 2 * HOUR); // window passed
});

// ---------------- clan permissions / applications / forum ----------------
function clanWorld() {
  const w = world();
  const leader = w.mk(), officer = w.mk(), grunt = w.mk(), other = w.mk(), outsider = w.mk('werewolf');
  w.db.prepare('UPDATE players SET level = 5').run();
  const cid = clan.createClan(w.db, leader, 'Night Court', T0);
  for (const id of [officer, grunt]) clan.joinClan(w.db, id, cid, T0);
  return { ...w, leader, officer, grunt, other, outsider, cid };
}

test('clan permissions: delegated rights work, others are refused', () => {
  const { db, leader, officer, grunt, cid } = clanWorld();
  assert.equal(code(() => clan.kickMember(db, officer, grunt, T0)), 'no_permission');
  assert.equal(code(() => clan.setPerms(db, officer, grunt, ['kick'], T0)), 'not_leader');
  assert.equal(code(() => clan.setPerms(db, leader, officer, ['fly'], T0)), 'bad_perm');
  clan.setPerms(db, leader, officer, ['kick', 'recruit'], T0);
  assert.deepEqual(clan.permsOf(db, officer).sort(), ['kick', 'recruit']);
  assert.equal(code(() => clan.kickMember(db, officer, leader, T0)), 'bad_target');
  clan.kickMember(db, officer, grunt, T0);
  assert.equal(loadPlayer(db, grunt, T0).clan_id, null);
  // officers cannot kick other officers; only the leader can
  clan.joinClan(db, grunt, cid, T0); clan.setPerms(db, leader, grunt, ['forum'], T0);
  assert.equal(code(() => clan.kickMember(db, officer, grunt, T0)), 'no_permission');
  clan.kickMember(db, leader, grunt, T0);
  assert.deepEqual(clan.permsOf(db, grunt), []);
});

test('closed clans need an application that a recruiter approves', () => {
  const { db, leader, officer, other, outsider, cid } = clanWorld();
  clan.setRecruiting(db, leader, false, T0);
  assert.equal(code(() => clan.joinClan(db, other, cid, T0)), 'clan_closed');
  assert.equal(code(() => clan.applyToClan(db, outsider, cid, 'hi', T0)), 'wrong_race');
  clan.applyToClan(db, other, cid, 'let me in', T0);
  assert.equal(code(() => clan.listApplications(db, officer, T0)), 'no_permission');
  assert.equal(clan.listApplications(db, leader, T0).length, 1);
  clan.setPerms(db, leader, officer, ['recruit'], T0);
  clan.decideApplication(db, officer, other, true, T0);
  assert.equal(loadPlayer(db, other, T0).clan_id, cid);
  assert.equal(clan.listApplications(db, leader, T0).length, 0);
  assert.equal(mail.unreadCount(db, other), 1);
});

test('clan forum: members only, lock/pin need the forum permission, deleting the first post removes the thread', () => {
  const { db, leader, officer, grunt, outsider } = clanWorld();
  assert.equal(code(() => forum.listThreads(db, outsider, T0)), 'no_clan');
  const { id } = forum.createThread(db, grunt, 'Targets', 'Hit Bob123 at 8pm', T0);
  forum.reply(db, officer, id, 'ok', T0 + 1);
  assert.equal((forum.listThreads(db, leader, T0)[0] as any).replies, 1);
  assert.equal(code(() => forum.setFlag(db, officer, id, 'locked', true, T0)), 'no_permission');
  clan.setPerms(db, leader, officer, ['forum'], T0);
  forum.setFlag(db, officer, id, 'locked', true, T0);
  assert.equal(code(() => forum.reply(db, grunt, id, 'still here', T0)), 'locked');
  forum.reply(db, officer, id, 'mods may post in locked threads', T0);
  forum.setFlag(db, officer, id, 'pinned', true, T0);
  const t2 = forum.createThread(db, leader, 'Newer thread', 'x', T0 + 10).id;
  assert.equal((forum.listThreads(db, leader, T0)[0] as any).id, id, 'pinned thread first');
  const posts = (forum.getThread(db, grunt, id, 0, T0) as any).posts;
  assert.equal(posts.length, 3);
  assert.equal(code(() => forum.deletePost(db, grunt, posts[1].id, T0)), 'no_permission');
  forum.deletePost(db, officer, posts[1].id, T0);
  forum.deletePost(db, grunt, posts[0].id, T0); // author deletes the first post -> whole thread
  assert.equal(code(() => forum.getThread(db, grunt, id, 0, T0)), 'not_found');
  assert.equal(forum.listThreads(db, grunt, T0).length, 1);
  assert.ok(t2);
});

// ---------------- highscore ----------------
test('highscore variants, race filter, clans, profiles', () => {
  const { db, mk } = world();
  const a = mk('vampire', 'Aaa'), b = mk('werewolf', 'Bbb'), c = mk('vampire', 'Ccc');
  give(db, a, 'level = 10'); give(db, b, 'level = 12, wins = 5'); give(db, c, 'level = 10, xp = 4');
  bump(db, a, 'gold_stolen', 900); bump(db, c, 'gold_stolen', 100);
  const names = (r: any) => r.rows.map((x: any) => x.name);
  assert.deepEqual(names(hs.highscore(db, { type: 'level' }, T0)), ['Bbb', 'Ccc', 'Aaa']);
  assert.deepEqual(names(hs.highscore(db, { type: 'level', race: 'vampire' }, T0)), ['Ccc', 'Aaa']);
  assert.deepEqual(names(hs.highscore(db, { type: 'wins' }, T0)), ['Bbb']);
  assert.deepEqual(names(hs.highscore(db, { type: 'loot' }, T0)), ['Aaa', 'Ccc']);
  assert.equal(code(() => hs.highscore(db, { type: 'nope' }, T0)), 'bad_type');
  give(db, a, 'level = 10'); give(db, a, 'level = 10');
  clan.createClan(db, a, 'Alphas', T0);
  const clans = hs.highscore(db, { type: 'clans' }, T0).rows as any[];
  assert.equal(clans[0].name, 'Alphas'); assert.equal(clans[0].value, 10);
  const prof = hs.profile(db, a, T0) as any;
  assert.equal(prof.clan.name, 'Alphas'); assert.equal(prof.gold, undefined); assert.equal(prof.hp, undefined);
});

// ---------------- arena ----------------
function arenaWorld(count: number) {
  const w = world();
  const ids = Array.from({ length: count }, (_, i) => w.mk(i % 2 ? 'vampire' : 'werewolf'));
  w.db.prepare('UPDATE players SET level = 10, gold = 10000').run();
  return { ...w, ids };
}
const duelOpts = { kind: 'duel' as const, deviation: 30, fee: 100, registrationMinutes: 60 };

test('arena duel: fee escrow, range check, starts at 9 PM UTC, winner takes the pool', () => {
  const { db, ids } = arenaWorld(3);
  const [a, b, c] = ids;
  db.prepare('UPDATE players SET str = 100 WHERE id = ?').run(c); // way outside a 30 % band
  const { id } = arena.createEvent(db, a, duelOpts, T0);
  assert.equal(loadPlayer(db, a, T0).gold, 9900);
  assert.equal(code(() => arena.createEvent(db, a, duelOpts, T0)), 'already_entered');
  assert.equal(code(() => arena.joinEvent(db, c, id, T0)), 'out_of_range');
  arena.joinEvent(db, b, id, T0);
  assert.equal(db.prepare('SELECT status FROM arena_events WHERE id = ?').get(id)!.status, 'full');
  arena.tick(db, T0 + 2 * HOUR, seeded(1)); // 10:00 - too early
  assert.equal(db.prepare('SELECT status FROM arena_events WHERE id = ?').get(id)!.status, 'full');
  arena.tick(db, Date.UTC(2027, 0, 15, 21, 0, 1), seeded(1));
  const ev = arena.eventDetail(db, id) as any;
  assert.equal(ev.status, 'done');
  assert.equal(ev.matches.length, 1);
  const golds = [a, b].map((x) => loadPlayer(db, x, T0).gold).sort((x, y) => x - y);
  assert.deepEqual(golds, [9900, 10100], 'winner nets +100, loser -100 (pool of 200)');
  assert.equal(mail.unreadCount(db, a), 1);
  // real character state is untouched by arena fights
  assert.equal(loadPlayer(db, a, T0).wins, 0);
  const st = arena.arenaStatus(db, ev.winner_id, Date.UTC(2027, 0, 15, 21, 0, 2));
  assert.ok(st.points >= CFG.arenaWinPoints * 0.5 && st.rank !== null);
  assert.ok(st.trend);
});

test('arena: deadline without enough players cancels and refunds; leaving refunds; creator must cancel', () => {
  const { db, ids } = arenaWorld(3);
  const [a, b] = ids;
  const { id } = arena.createEvent(db, a, { ...duelOpts, registrationMinutes: 30 }, T0);
  arena.tick(db, T0 + 10 * MIN, seeded(1));
  assert.equal(db.prepare('SELECT status FROM arena_events WHERE id = ?').get(id)!.status, 'open');
  assert.equal(code(() => arena.leaveEvent(db, a, id)), 'is_creator');
  arena.tick(db, T0 + 31 * MIN, seeded(1));
  assert.equal(db.prepare('SELECT status FROM arena_events WHERE id = ?').get(id)!.status, 'cancelled');
  assert.equal(loadPlayer(db, a, T0).gold, 10000, 'fee refunded');
  assert.equal(code(() => arena.joinEvent(db, b, id, T0 + 31 * MIN)), 'closed');

  const e2 = arena.createEvent(db, a, duelOpts, T0 + HOUR).id;
  arena.joinEvent(db, b, e2, T0 + HOUR);
  arena.leaveEvent(db, b, e2);
  assert.equal(loadPlayer(db, b, T0).gold, 10000);
  assert.equal(db.prepare('SELECT status FROM arena_events WHERE id = ?').get(e2)!.status, 'open');
  arena.cancelEvent(db, a, e2, T0 + HOUR);
  assert.equal(loadPlayer(db, a, T0).gold, 10000);
});

test('arena tournament: 4 players, 3 matches, 70/30 payout, places and stat snapshots', () => {
  const { db, ids } = arenaWorld(4);
  const { id } = arena.createEvent(db, ids[0], { kind: 'tournament', size: 4, deviation: 50, fee: 200, registrationMinutes: 120 }, T0);
  assert.equal(code(() => arena.createEvent(db, ids[1], { kind: 'tournament', size: 5, deviation: 50, fee: 0, registrationMinutes: 60 }, T0)), 'bad_size');
  for (const p of ids.slice(1)) arena.joinEvent(db, p, id, T0);
  // gear bought AFTER registering must not count: snapshot was taken at sign-up
  arena.tick(db, Date.UTC(2027, 0, 15, 21, 30), seeded(3));
  const ev = arena.eventDetail(db, id) as any;
  assert.equal(ev.matches.length, 3);
  assert.deepEqual(ev.entries.map((e: any) => e.place).sort((x: number, y: number) => x - y), [1, 2, 3, 3]);
  const total = ids.reduce((s, p) => s + loadPlayer(db, p, T0).gold, 0);
  assert.equal(total, 40000, 'no gold created or lost (800 pool fully paid out)');
  const winner = loadPlayer(db, ev.winner_id, T0).gold;
  assert.equal(winner, 10000 - 200 + 560);
});

test('arena: only options that are switched on are counted in the snapshot; potions never', () => {
  const { db, ids } = arenaWorld(2);
  const [a, b] = ids;
  eco.buyItem(db, a, 'itm_Blade_1', T0);
  give(db, a, 'potion_stat_until = ' + (T0 + HOUR));
  const noEq = arena.createEvent(db, a, { ...duelOpts, withEq: false }, T0).id;
  arena.cancelEvent(db, a, noEq, T0);
  const withEq = arena.createEvent(db, a, { ...duelOpts, withEq: true }, T0).id;
  const s = (id: number) => JSON.parse((db.prepare('SELECT stats FROM arena_entries WHERE event_id = ? AND player_id = ?').get(id, a) as { stats: string }).stats);
  assert.equal(s(noEq).str, 5);
  assert.equal(s(withEq).str, 5 + 3);
  assert.ok(b);
});

test('arena points: upsets pay more, decay over time, seasons close with titles', () => {
  const strong = arena.matchPoints(200, 100), upset = arena.matchPoints(100, 200);
  assert.ok(upset.win > strong.win);
  assert.ok(Math.abs(strong.win - 150) < 1 && upset.win === 600);

  const { db, ids } = arenaWorld(2);
  const [a, b] = ids;
  const e = arena.createEvent(db, a, duelOpts, T0).id;
  arena.joinEvent(db, b, e, T0);
  const startAt = Date.UTC(2027, 0, 15, 21, 5);
  arena.tick(db, startAt, seeded(2));
  const fresh = arena.arenaStatus(db, a, startAt).points;
  const later = arena.arenaStatus(db, a, startAt + 30 * DAY_MS).points;
  assert.ok(later < fresh * 0.6 && later > fresh * 0.5, `decay ${fresh} -> ${later}`);
  // season rolls over on Feb 1st -> January top 3 get titles
  arena.tick(db, Date.UTC(2027, 1, 2), seeded(2));
  const titles = db.prepare("SELECT place FROM arena_titles WHERE season = '2027-01' ORDER BY place").all() as { place: number }[];
  assert.deepEqual(titles.map((t) => t.place), [1, 2]);
  assert.equal(arena.arenaStatus(db, a, Date.UTC(2027, 1, 2)).titles.length, 1);
});

test('arena rank: rank 1 exists only once', () => {
  const { db, ids } = arenaWorld(3);
  for (const id of ids) db.prepare('INSERT INTO arena_points (player_id, points, at) VALUES (?,?,?)').run(id, 20000, T0);
  const ranks = ids.map((id) => arena.arenaStatus(db, id, T0).rank).sort();
  assert.deepEqual(ranks, [1, 2, 2]);
  const low = arenaWorld(1);
  assert.equal(arena.arenaStatus(low.db, low.ids[0], T0).rank, null, 'unranked without points');
});
