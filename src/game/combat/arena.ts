import { CFG, DAY_MS, MAIN_STATS, type Stat } from '../../core/config.ts';
import type { DB } from '../../db/core.ts';
import { assert } from '../../core/errors.ts';
import type { Rng } from '../../core/rng.ts';
import { bump } from '../character/counters.ts';
import { simulate } from './combat.ts';
import { systemMail } from '../social/mail.ts';
import { battleStats, loadPlayer, type Stats } from '../character/player.ts';

// ---------- helpers ----------
export const skillAverage = (p: { str: number; def: number; agi: number; sta: number; dex: number }) => (p.str + p.def + p.agi + p.sta + p.dex) / 5;
const strengthOf = (s: Stats) => MAIN_STATS.reduce((a, k) => a + s[k], 0);
export const seasonKey = (now: number) => new Date(now).toISOString().slice(0, 7); // YYYY-MM (UTC)

/** Next 21:00 UTC strictly after `t`. */
export function nextStart(t: number) {
  const d = new Date(t);
  const at = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), CFG.arenaDailyStartHourUtc);
  return at > t ? at : at + DAY_MS;
}

const decayed = (points: number, at: number, now: number) => points * Math.pow(1 - CFG.arenaDecayPerDay, Math.max(0, now - at) / DAY_MS);

interface EventRow {
  id: number;
  kind: 'duel' | 'tournament';
  creator_id: number;
  size: number;
  deviation: number;
  fee: number;
  with_eq: number;
  with_sen: number;
  with_anc: number;
  base_skill: number;
  deadline: number;
  status: 'open' | 'full' | 'done' | 'cancelled';
  full_at: number | null;
  start_at: number | null;
  created_at: number;
  winner_id: number | null;
}
const getEvent = (db: DB, id: number) => {
  const e = db.prepare('SELECT * FROM arena_events WHERE id = ?').get(id) as EventRow | undefined;
  assert(e, 'not_found', 'Arena event not found', 404);
  return e;
};
const entryCount = (db: DB, id: number) => (db.prepare('SELECT COUNT(*) n FROM arena_entries WHERE event_id = ?').get(id) as { n: number }).n;
const inActiveEvent = (db: DB, playerId: number) =>
  db.prepare("SELECT e.id FROM arena_entries a JOIN arena_events e ON e.id = a.event_id WHERE a.player_id = ? AND e.status IN ('open','full')").get(playerId);

// ---------- create / join / leave ----------
export interface CreateOpts {
  kind: 'duel' | 'tournament';
  size?: number;
  deviation: number;
  fee: number;
  withEq?: boolean;
  withSen?: boolean;
  withAnc?: boolean;
  registrationMinutes: number;
}

export function createEvent(db: DB, playerId: number, o: CreateOpts, now: number) {
  const p = loadPlayer(db, playerId, now);
  assert(p.level >= CFG.arenaMinLevel, 'level_too_low', `The arena requires level ${CFG.arenaMinLevel}`);
  assert(o.kind === 'duel' || o.kind === 'tournament', 'bad_kind', 'Duel or tournament');
  const size = o.kind === 'duel' ? 2 : Number(o.size);
  assert(o.kind === 'duel' || CFG.arenaTournamentSizes.includes(size), 'bad_size', `Tournament size must be one of ${CFG.arenaTournamentSizes.join(', ')}`);
  assert(Number.isInteger(o.deviation) && o.deviation >= 0 && o.deviation <= 100, 'bad_deviation', 'Skill deviation must be 0-100 %');
  assert(Number.isInteger(o.fee) && o.fee >= 0 && o.fee <= 1_000_000, 'bad_fee', 'Invalid entry fee');
  const reg = Number(o.registrationMinutes) * 60_000;
  assert(reg >= CFG.arenaMinRegistration && reg <= CFG.arenaMaxRegistration, 'bad_deadline', 'Registration must last 10 minutes to 3 days');
  assert(!inActiveEvent(db, playerId), 'already_entered', 'You are already registered in another event');
  const id = Number(
    db
      .prepare(
        `INSERT INTO arena_events (kind, creator_id, size, deviation, fee, with_eq, with_sen, with_anc, base_skill, deadline, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(o.kind, playerId, size, o.deviation, o.fee, +!!o.withEq, +!!o.withSen, +!!o.withAnc, skillAverage(p), now + reg, now).lastInsertRowid,
  );
  enter(db, id, playerId, now);
  return { id };
}

/** Snapshot stats at registration: gear changes afterwards do not matter, potions never count. */
function enter(db: DB, eventId: number, playerId: number, now: number) {
  const e = getEvent(db, eventId);
  const p = loadPlayer(db, playerId, now);
  assert(p.gold >= e.fee, 'no_gold', `The entry fee is ${e.fee} gold`);
  const stats = battleStats(db, p, {
    ancestral: !!e.with_anc && p.level >= CFG.ancestralMinLevel,
    equipment: !!e.with_eq,
    sentinels: !!e.with_sen,
    potion: false,
  });
  db.prepare('UPDATE players SET gold = gold - ? WHERE id = ?').run(e.fee, playerId);
  db.prepare('INSERT INTO arena_entries (event_id, player_id, stats, max_hp, skill, strength) VALUES (?,?,?,?,?,?)').run(
    eventId,
    playerId,
    JSON.stringify(stats),
    p.max_hp,
    skillAverage(p),
    strengthOf(stats),
  );
  bump(db, playerId, 'arena_joined');
  if (entryCount(db, eventId) >= e.size)
    db.prepare("UPDATE arena_events SET status = 'full', full_at = ?, start_at = ? WHERE id = ?").run(now, nextStart(now), eventId);
}

export function joinEvent(db: DB, playerId: number, eventId: number, now: number) {
  const e = getEvent(db, eventId);
  const p = loadPlayer(db, playerId, now);
  assert(e.status === 'open' && now < e.deadline, 'closed', 'Registration is closed');
  assert(p.level >= CFG.arenaMinLevel, 'level_too_low', `The arena requires level ${CFG.arenaMinLevel}`);
  assert(!inActiveEvent(db, playerId), 'already_entered', 'You are already registered in an event');
  const range = (e.base_skill * e.deviation) / 100;
  assert(
    Math.abs(skillAverage(p) - e.base_skill) <= range + 1e-9,
    'out_of_range',
    `Your skill average (${skillAverage(p).toFixed(1)}) is outside ${(e.base_skill - range).toFixed(1)}–${(e.base_skill + range).toFixed(1)}`,
  );
  enter(db, eventId, playerId, now);
}

const refund = (db: DB, e: EventRow) => {
  for (const r of db.prepare('SELECT player_id FROM arena_entries WHERE event_id = ?').all(e.id) as { player_id: number }[])
    db.prepare('UPDATE players SET gold = gold + ? WHERE id = ?').run(e.fee, r.player_id);
};

export function leaveEvent(db: DB, playerId: number, eventId: number) {
  const e = getEvent(db, eventId);
  assert(e.status === 'open' || e.status === 'full', 'closed', 'This event already started');
  assert(e.creator_id !== playerId, 'is_creator', 'The creator must cancel the event instead');
  assert(db.prepare('DELETE FROM arena_entries WHERE event_id = ? AND player_id = ?').run(eventId, playerId).changes, 'not_entered', 'You are not registered');
  db.prepare('UPDATE players SET gold = gold + ? WHERE id = ?').run(e.fee, playerId);
  db.prepare("UPDATE arena_events SET status = 'open', full_at = NULL, start_at = NULL WHERE id = ?").run(eventId);
}

export function cancelEvent(db: DB, playerId: number, eventId: number, now: number, reason = 'The creator cancelled the event.') {
  const e = getEvent(db, eventId);
  assert(e.creator_id === playerId, 'not_creator', 'Only the creator can cancel', 403);
  assert(e.status === 'open' || e.status === 'full', 'closed', 'This event already started');
  cancelInternal(db, e, now, reason);
}
function cancelInternal(db: DB, e: EventRow, now: number, reason: string) {
  refund(db, e);
  db.prepare("UPDATE arena_events SET status = 'cancelled' WHERE id = ?").run(e.id);
  for (const r of db.prepare('SELECT player_id FROM arena_entries WHERE event_id = ?').all(e.id) as { player_id: number }[])
    systemMail(db, r.player_id, `Arena event #${e.id} cancelled`, `${reason} Your entry fee of ${e.fee} gold was refunded.`, now, {
      kind: 'arena',
      link: '#/arena',
    });
}

// ---------- running events ----------
function addPoints(db: DB, playerId: number, pts: number, won: boolean, now: number) {
  const row = db.prepare('SELECT points, at FROM arena_points WHERE player_id = ?').get(playerId) as { points: number; at: number } | undefined;
  const total = (row ? decayed(row.points, row.at, now) : 0) + pts;
  db.prepare(
    'INSERT INTO arena_points (player_id, points, at) VALUES (?,?,?) ON CONFLICT(player_id) DO UPDATE SET points = excluded.points, at = excluded.at',
  ).run(playerId, total, now);
  db.prepare(
    `INSERT INTO arena_season (season, player_id, points, wins, losses) VALUES (?,?,?,?,?)
     ON CONFLICT(season, player_id) DO UPDATE SET points = points + excluded.points, wins = wins + excluded.wins, losses = losses + excluded.losses`,
  ).run(seasonKey(now), playerId, pts, +won, +!won);
}

/** Beating a stronger side is worth more, beating a weaker one less; the same scaling applies to consolation points. */
export function matchPoints(winnerStrength: number, loserStrength: number) {
  const ratio = loserStrength / winnerStrength; // > 1 means an upset
  return {
    win: Math.round(CFG.arenaWinPoints * Math.min(2, Math.max(0.5, ratio))),
    loss: Math.round(CFG.arenaLossPoints * Math.min(1.5, Math.max(0.5, winnerStrength / loserStrength))),
  };
}

function runEvent(db: DB, e: EventRow, now: number, rng: Rng) {
  type Ent = { player_id: number; stats: Stats; max_hp: number; strength: number; name: string };
  const rows = db
    .prepare('SELECT a.player_id, a.stats, a.max_hp, a.strength, p.name FROM arena_entries a JOIN players p ON p.id = a.player_id WHERE a.event_id = ?')
    .all(e.id) as any[];
  let field: Ent[] = rows.map((r) => ({ ...r, stats: JSON.parse(r.stats) as Stats }));
  for (let i = field.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [field[i], field[j]] = [field[j], field[i]];
  }
  let round = 0;
  while (field.length > 1) {
    round++;
    const next: Ent[] = [];
    const eliminatedPlace = field.length / 2 + 1; // losers of a field of 8 share place 5, of 4 place 3, the final's loser place 2
    for (let i = 0; i < field.length; i += 2) {
      const a = field[i],
        b = field[i + 1];
      if (!b) {
        next.push(a);
        continue;
      }
      const res = simulate(
        { name: a.name, stats: a.stats, hp: a.max_hp, maxHp: a.max_hp },
        { name: b.name, stats: b.stats, hp: b.max_hp, maxHp: b.max_hp },
        rng,
      );
      const [w, l] = res.winner === 'a' ? [a, b] : [b, a];
      db.prepare('INSERT INTO arena_matches (event_id, round, a_id, b_id, winner_id, rounds, log, at) VALUES (?,?,?,?,?,?,?,?)').run(
        e.id,
        round,
        a.player_id,
        b.player_id,
        w.player_id,
        res.rounds,
        JSON.stringify(res.log),
        now,
      );
      const pts = matchPoints(w.strength, l.strength);
      addPoints(db, w.player_id, pts.win, true, now);
      addPoints(db, l.player_id, pts.loss, false, now);
      bump(db, w.player_id, 'arena_wins');
      db.prepare('UPDATE arena_entries SET place = ? WHERE event_id = ? AND player_id = ?').run(Math.floor(eliminatedPlace), e.id, l.player_id);
      next.push(w);
    }
    field = next;
  }
  const champ = field[0];
  db.prepare('UPDATE arena_entries SET place = 1 WHERE event_id = ? AND player_id = ?').run(e.id, champ.player_id);
  db.prepare("UPDATE arena_events SET status = 'done', winner_id = ? WHERE id = ?").run(champ.player_id, e.id);

  // payouts: duel winner takes the pool (twice one fee); tournaments split it winner/finalist
  const pool = e.fee * e.size;
  const payouts = new Map<number, number>();
  if (e.kind === 'duel') payouts.set(champ.player_id, pool);
  else {
    const finalist = db.prepare('SELECT player_id FROM arena_entries WHERE event_id = ? AND place = 2').get(e.id) as { player_id: number };
    payouts.set(champ.player_id, Math.floor(pool * CFG.tournamentPayout[0]));
    payouts.set(finalist.player_id, Math.floor(pool * CFG.tournamentPayout[1]));
  }
  for (const [pid, gold] of payouts) db.prepare('UPDATE players SET gold = gold + ? WHERE id = ?').run(gold, pid);
  for (const r of rows as { player_id: number }[]) {
    const place = (db.prepare('SELECT place FROM arena_entries WHERE event_id = ? AND player_id = ?').get(e.id, r.player_id) as { place: number }).place;
    const gold = payouts.get(r.player_id) ?? 0;
    systemMail(
      db,
      r.player_id,
      `Arena event #${e.id} finished`,
      `${champ.name} won the ${e.kind}. You placed #${place}.${gold ? ` You won ${gold} gold.` : ''} Match logs are in the arena.`,
      now,
      { kind: 'arena', link: '#/arena' },
    );
  }
}

/** Advance time-based state: expire unfilled events, start full ones at 9 PM, close past seasons. Safe to call often. */
export function tick(db: DB, now: number, rng: Rng) {
  for (const e of db.prepare("SELECT * FROM arena_events WHERE status = 'open' AND deadline <= ?").all(now) as unknown as EventRow[])
    cancelInternal(db, e, now, 'Not enough participants registered before the deadline.');
  for (const e of db.prepare("SELECT * FROM arena_events WHERE status = 'full' AND start_at <= ? ORDER BY start_at").all(now) as unknown as EventRow[])
    runEvent(db, e, now, rng);
  const current = seasonKey(now);
  for (const { season } of db.prepare('SELECT DISTINCT season FROM arena_season WHERE season < ?').all(current) as { season: string }[]) {
    if (db.prepare('SELECT 1 FROM arena_titles WHERE season = ?').get(season)) continue;
    const top = db.prepare('SELECT player_id FROM arena_season WHERE season = ? ORDER BY points DESC, wins DESC LIMIT 3').all(season) as {
      player_id: number;
    }[];
    top.forEach((r, i) => {
      db.prepare('INSERT OR IGNORE INTO arena_titles (season, place, player_id) VALUES (?,?,?)').run(season, i + 1, r.player_id);
      systemMail(db, r.player_id, `Arena season ${season}: rank #${i + 1}`, `You finished season ${season} in place ${i + 1} and earned a title.`, now, {
        kind: 'arena',
        link: '#/arena',
      });
    });
  }
}

// ---------- read models ----------
export function listEvents(db: DB, playerId: number, now: number) {
  const rows = db
    .prepare(
      `SELECT e.*, p.name AS creator, (SELECT COUNT(*) FROM arena_entries a WHERE a.event_id = e.id) AS entries,
            EXISTS(SELECT 1 FROM arena_entries a WHERE a.event_id = e.id AND a.player_id = ?) AS joined
       FROM arena_events e JOIN players p ON p.id = e.creator_id
      WHERE e.status IN ('open','full') OR (e.status = 'done' AND EXISTS (SELECT 1 FROM arena_matches m WHERE m.event_id = e.id AND m.at > ?))
      ORDER BY e.status = 'done', e.deadline`,
    )
    .all(playerId, now - 2 * DAY_MS) as any[];
  return rows;
}

export function eventDetail(db: DB, eventId: number) {
  const e = getEvent(db, eventId);
  const entries = db
    .prepare(
      'SELECT a.player_id, p.name, a.skill, a.strength, a.place FROM arena_entries a JOIN players p ON p.id = a.player_id WHERE a.event_id = ? ORDER BY a.place IS NULL, a.place',
    )
    .all(eventId);
  const matches = db
    .prepare(
      `SELECT m.id, m.round, m.rounds, m.winner_id, m.a_id, m.b_id, a.name AS a_name, b.name AS b_name
       FROM arena_matches m JOIN players a ON a.id = m.a_id JOIN players b ON b.id = m.b_id WHERE m.event_id = ? ORDER BY m.id`,
    )
    .all(eventId);
  return { ...e, entries, matches };
}

export function matchLog(db: DB, matchId: number) {
  const m = db.prepare('SELECT * FROM arena_matches WHERE id = ?').get(matchId) as { log: string } | undefined;
  assert(m, 'not_found', 'Match not found', 404);
  return { ...m, log: JSON.parse(m.log) };
}

/** Current (decayed) all-time points for everybody with any. */
function allPoints(db: DB, now: number) {
  return (db.prepare('SELECT player_id, points, at FROM arena_points').all() as { player_id: number; points: number; at: number }[])
    .map((r) => ({ player_id: r.player_id, points: decayed(r.points, r.at, now) }))
    .sort((a, b) => b.points - a.points || a.player_id - b.player_id);
}

export const MOON = ['🌑', '🌒', '🌓', '🌔', '🌕'];

export function arenaStatus(db: DB, playerId: number, now: number) {
  const all = allPoints(db, now);
  const mine = all.find((r) => r.player_id === playerId)?.points ?? 0;
  const th = CFG.arenaRankThresholds; // ranks 10..2
  let rank: number | null = null;
  if (mine >= th[0]) {
    const idx = th.filter((t) => mine >= t).length;
    rank = 11 - idx;
  } // 1 threshold reached -> rank 10 ... all 9 -> rank 2
  if (rank === 2 && all[0]?.player_id === playerId) rank = 1; // rank 1 exists once per world
  const m30 = db.prepare('SELECT winner_id FROM arena_matches WHERE (a_id = ? OR b_id = ?) AND at > ?').all(playerId, playerId, now - 30 * DAY_MS) as {
    winner_id: number;
  }[];
  const wins = m30.filter((m) => m.winner_id === playerId).length;
  const ratio = m30.length ? wins / m30.length : null;
  const trend = ratio === null ? null : MOON[Math.min(4, Math.floor(ratio * 5))];
  const season = db.prepare('SELECT points, wins, losses FROM arena_season WHERE season = ? AND player_id = ?').get(seasonKey(now), playerId) ?? {
    points: 0,
    wins: 0,
    losses: 0,
  };
  const titles = db.prepare('SELECT season, place FROM arena_titles WHERE player_id = ? ORDER BY season DESC').all(playerId);
  return {
    points: Math.round(mine),
    rank,
    trend,
    matches30: m30.length,
    wins30: wins,
    season: seasonKey(now),
    seasonScore: season,
    titles,
    current: inActiveEvent(db, playerId) ?? null,
  };
}

export function ranking(db: DB, kind: 'season' | 'alltime', now: number, limit = 50) {
  if (kind === 'alltime')
    return allPoints(db, now)
      .slice(0, limit)
      .map((r) => ({ ...(db.prepare('SELECT id, name, race, level FROM players WHERE id = ?').get(r.player_id) as object), points: Math.round(r.points) }));
  return db
    .prepare(
      `SELECT p.id, p.name, p.race, p.level, s.points, s.wins, s.losses FROM arena_season s JOIN players p ON p.id = s.player_id
      WHERE s.season = ? ORDER BY s.points DESC, s.wins DESC, p.id ASC LIMIT ?`,
    )
    .all(seasonKey(now), limit);
}

export type { Stat };
