import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openDb, type DB } from '../../src/db/node.ts';
import { GameError } from '../../src/core/errors.ts';
import * as clan from '../../src/game/social/clan.ts';
import { bump } from '../../src/game/character/counters.ts';
import * as hs from '../../src/game/social/highscore.ts';

const T0 = 1_800_000_000_000;
const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    return (e as GameError).code;
  }
  return 'none';
};

let seq = 0;
/** Fast bulk insert (skips password hashing). Names are unique across calls. */
function bulk(db: DB, n: number, f: (i: number) => { race?: string; level?: number; xp?: number } = () => ({})) {
  const ins = db.prepare(
    `INSERT INTO players (name, pass_hash, race, level, xp, hp, hp_at, max_hp, str, def, agi, sta, dex, created_at)
     VALUES (?, 'x', ?, ?, ?, 100, ?, 100, 5, 5, 5, 5, 5, ?)`,
  );
  const ids: number[] = [];
  for (let i = 0; i < n; i++) {
    const p = f(i);
    ids.push(
      Number(ins.run(`Player${String(seq++).padStart(5, '0')}`, p.race ?? (i % 2 ? 'vampire' : 'werewolf'), p.level ?? 1, p.xp ?? 0, T0, T0).lastInsertRowid),
    );
  }
  return ids;
}
const idsOf = (r: { rows: { id: number }[] }) => r.rows.map((x) => x.id);

test('pagination: totals, page count, sizes, clamping', () => {
  const db = openDb();
  bulk(db, 130);
  const p0 = hs.highscore(db, { type: 'level' }, T0);
  assert.equal(p0.total, 130);
  assert.equal(p0.pages, 6);
  assert.equal(p0.pageSize, 25);
  assert.equal(p0.rows.length, 25);
  assert.equal(hs.highscore(db, { type: 'level', page: 5 }, T0).rows.length, 5, 'last page is partial');
  assert.equal(hs.highscore(db, { type: 'level', page: 99 }, T0).page, 5, 'page beyond the end clamps to the last page');
  assert.equal(hs.highscore(db, { type: 'level', page: -3 }, T0).page, 0);
  assert.equal(hs.highscore(db, { type: 'level', page: NaN }, T0).page, 0);
  assert.equal(hs.highscore(db, { type: 'level', size: 100 }, T0).pages, 2);
  assert.equal(hs.highscore(db, { type: 'level', size: 50 }, T0).rows.length, 50);
  assert.equal(hs.highscore(db, { type: 'level', size: 7 }, T0).pageSize, 25, 'unsupported page size falls back to 25');
  assert.equal(hs.highscore(db, { type: 'level', race: 'vampire' }, T0).total, 65);
  const empty = hs.highscore(openDb(), { type: 'level' }, T0);
  assert.deepEqual([empty.total, empty.pages, empty.rows.length, empty.page], [0, 1, 0, 0]);
});

test('ties never duplicate or lose players across pages (deterministic order)', () => {
  const db = openDb();
  const all = bulk(db, 130, () => ({ level: 10, xp: 3 })); // everybody identical
  const seen: number[] = [];
  for (let page = 0; page < 6; page++) seen.push(...idsOf(hs.highscore(db, { type: 'level', page }, T0)));
  assert.equal(seen.length, 130);
  assert.equal(new Set(seen).size, 130, 'no player twice');
  assert.deepEqual(
    [...seen].sort((a, b) => a - b),
    [...all].sort((a, b) => a - b),
    'no player missing',
  );
  assert.deepEqual(
    seen,
    [...Array(6).keys()].flatMap((page) => idsOf(hs.highscore(db, { type: 'level', page }, T0))),
    'same order on every load',
  );
});

test('level board orders by level then XP and shows the XP; other boards order by value then level', () => {
  const db = openDb();
  const [a, b, c, d] = bulk(
    db,
    4,
    (i) =>
      [
        { level: 5, xp: 90 },
        { level: 6, xp: 1 },
        { level: 6, xp: 40 },
        { level: 1, xp: 0 },
      ][i],
  );
  const r = hs.highscore(db, { type: 'level' }, T0);
  assert.deepEqual(idsOf(r), [c, b, a, d]);
  assert.deepEqual(
    r.rows.map((x: any) => x.value),
    [40, 1, 90, 0],
    'XP is reported (it used to be blank)',
  );
  bump(db, a, 'gold_stolen', 100);
  bump(db, b, 'gold_stolen', 100);
  bump(db, c, 'gold_stolen', 5);
  assert.deepEqual(idsOf(hs.highscore(db, { type: 'loot' }, T0)), [b, a, c], 'equal loot: higher level first');
});

test('your rank and your page (logged-in only), clan board highlights your clan', () => {
  const db = openDb();
  const ids = bulk(db, 80, (i) => ({ level: 100 - i })); // player i is rank i+1
  const r = hs.highscore(db, { type: 'level', playerId: ids[59] }, T0);
  assert.equal(r.myRank, 60);
  assert.equal(r.myPage, 2);
  assert.ok(idsOf(hs.highscore(db, { type: 'level', page: r.myPage! }, T0)).includes(ids[59]));
  assert.equal(hs.highscore(db, { type: 'level' }, T0).myRank, null, 'anonymous has no rank');
  assert.equal(hs.highscore(db, { type: 'wins', playerId: ids[0] }, T0).myRank, null, 'not on the wins board (0 wins)');
  assert.equal(hs.highscore(db, { type: 'level', race: 'vampire', playerId: ids[0] }, T0).myRank, null, 'filtered out by race');

  // 30 clans, own clan rank
  const leaders = bulk(db, 30, (i) => ({ level: 3 + i, race: 'vampire' }));
  const cids = leaders.map((id, i) => clan.createClan(db, id, `Clan ${i}`, T0));
  const mine = cids[7];
  const cr = hs.highscore(db, { type: 'clans', playerId: leaders[7] }, T0);
  assert.equal(cr.total, 30);
  assert.equal(cr.pages, 2);
  assert.equal(cr.myRank, 30 - 7, 'ranked by total member level');
  assert.equal((cr.rows as any[])[cr.myRank! - 1 - cr.page * cr.pageSize]?.id ?? mine, mine);
  assert.equal(hs.highscore(db, { type: 'clans', page: 1 }, T0).rows.length, 5);
});

test('arena boards are not capped at 500 and stay paged', () => {
  const db = openDb();
  const ids = bulk(db, 620);
  const ins = db.prepare('INSERT INTO arena_points (player_id, points, at) VALUES (?, ?, ?)');
  ids.forEach((id, i) => ins.run(id, 1000 - i, T0));
  const r = hs.highscore(db, { type: 'arena_alltime', size: 100, page: 6 }, T0);
  assert.equal(r.total, 620);
  assert.equal(r.pages, 7);
  assert.equal(r.rows.length, 20);
  assert.equal(hs.highscore(db, { type: 'arena_alltime', playerId: ids[600] }, T0).myRank, 601);
  assert.equal(
    code(() => hs.highscore(db, { type: 'nope' }, T0)),
    'bad_type',
  );
});
