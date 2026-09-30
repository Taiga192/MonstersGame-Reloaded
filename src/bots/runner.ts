import { DAY_MS, MIN } from '../config.ts';
import { tx, type DB } from '../db-core.ts';
import { randInt, type Rng } from '../rng.ts';
import * as arena from '../game/arena.ts';
import { registerBot } from '../game/auth.ts';
import { runSession, type BotRow, type Ctx } from './brain.ts';
import { playerName } from './names.ts';
import { personaForIndex } from './personas.ts';

export interface BotOptions {
  /** may bots raid real (human) players at all? */
  humans?: boolean;
  /** when they do search and find a human: chance to actually attack (keeps real players from being farmed) */
  humanRaidChance?: number;
}

/** Make sure at least `count` bots exist; returns how many were created. New bots start staggered over the next ~2 hours. */
export function ensureBots(db: DB, count: number, now: number, rng: Rng): number {
  const have = (db.prepare('SELECT COUNT(*) n FROM bots').get() as { n: number }).n;
  if (have >= count) return 0;
  const taken = new Set((db.prepare('SELECT name FROM players').all() as { name: string }[]).map((r) => r.name.toLowerCase()));
  return tx(db, () => {
    for (let i = have; i < count; i++) {
      const persona = personaForIndex(i);
      const id = registerBot(db, playerName(rng, taken), i % 2 ? 'vampire' : 'werewolf', now);
      db.prepare('INSERT INTO bots (player_id, persona, next_at, tz, sessions_left) VALUES (?,?,?,?,?)')
        .run(id, persona.key, now + randInt(rng, 0, 120) * MIN, randInt(rng, -11, 12), randInt(rng, persona.sessions[0], persona.sessions[1]));
    }
    return count - have;
  });
}

/** Let every bot whose turn has come play one session. Returns how many played. */
export function tickBots(db: DB, now: number, rng: Rng, opts: BotOptions = {}, max = 80): { ran: number; errors: number } {
  const due = db.prepare('SELECT player_id, persona, tz, sessions_left FROM bots WHERE next_at <= ? ORDER BY next_at LIMIT ?').all(now, max) as unknown as BotRow[];
  const ctx: Ctx = { db, now, rng, humans: opts.humans ?? true, humanRaidChance: opts.humanRaidChance ?? 0.3 };
  let errors = 0;
  for (const bot of due) {
    try {
      tx(db, () => {
        const r = runSession(ctx, bot);
        db.prepare('UPDATE bots SET next_at = ?, sessions_left = ?, sessions = sessions + 1 WHERE player_id = ?').run(Math.max(r.nextAt, now + MIN), r.sessionsLeft, bot.player_id);
      });
    } catch (e) {
      errors++;
      console.error(`[bots] session failed for bot ${bot.player_id} (${bot.persona}):`, e);
      db.prepare('UPDATE bots SET next_at = ?, errors = errors + 1 WHERE player_id = ?').run(now + 30 * MIN, bot.player_id); // back off, do not loop
    }
  }
  return { ran: due.length, errors };
}

/**
 * SIMULATION TOOL (tests and scripts/simulate.ts only; the server never calls this): replays `days` of virtual time ending
 * at `now`, with bots only interacting with each other. Used to check behaviour and balance over weeks in seconds.
 */
export function fastForward(db: DB, days: number, now: number, rng: Rng, opts: { stepMin?: number; onProgress?: (day: number, days: number) => void } = {}) {
  const step = (opts.stepMin ?? 15) * MIN, start = now - days * DAY_MS;
  // the world is being replayed from `start`: move bot timestamps back so nothing lies in the "future" (which would
  // make HP regeneration run backwards) and spread their first sessions over the first hours
  db.prepare('UPDATE bots SET next_at = ? + (next_at - ?)').run(start, now);
  db.prepare('UPDATE players SET hp_at = ?, created_at = ? WHERE is_bot = 1').run(start, start);
  let lastDay = -1;
  for (let t = start; t <= now; t += step) {
    tickBots(db, t, rng, { humans: false }, 400);
    tx(db, () => arena.tick(db, t, rng));
    const d = Math.min(days - 1, Math.floor((t - start) / DAY_MS));
    if (d !== lastDay) { lastDay = d; opts.onProgress?.(d, days); }
  }
}

/** Summary of the bot world (used by the test tools and the simulation script). */
export function botReport(db: DB, now: number) {
  const q = (sql: string, ...a: any[]) => db.prepare(sql).get(...a) as any;
  const levels = (db.prepare('SELECT level FROM players WHERE is_bot = 1 ORDER BY level').all() as { level: number }[]).map((r) => r.level);
  const pct = (p: number) => levels[Math.min(levels.length - 1, Math.floor(levels.length * p))] ?? 0;
  const gold = (db.prepare('SELECT gold FROM players WHERE is_bot = 1 ORDER BY gold').all() as { gold: number }[]).map((r) => r.gold);
  const byPersona = db.prepare('SELECT b.persona, COUNT(*) n, ROUND(AVG(p.level), 1) level, ROUND(AVG(p.gold)) gold, SUM(p.wins) wins FROM bots b JOIN players p ON p.id = b.player_id GROUP BY b.persona ORDER BY n DESC').all();
  const dayAgo = now - DAY_MS;
  return {
    bots: levels.length,
    level: { min: levels[0] ?? 0, p25: pct(0.25), median: pct(0.5), p75: pct(0.75), p95: pct(0.95), max: levels[levels.length - 1] ?? 0 },
    gold: { median: gold[gold.length >> 1] ?? 0, max: gold[gold.length - 1] ?? 0, total: gold.reduce((a, b) => a + b, 0) },
    clans: { total: q('SELECT COUNT(*) n FROM clans').n, biggest: q('SELECT COALESCE(MAX(m), 0) n FROM (SELECT COUNT(*) m FROM players WHERE clan_id IS NOT NULL GROUP BY clan_id)').n, inClan: q('SELECT COUNT(*) n FROM players WHERE is_bot = 1 AND clan_id IS NOT NULL').n },
    wars: { active: q("SELECT COUNT(*) n FROM clan_wars WHERE status != 'ended'").n, total: q('SELECT COUNT(*) n FROM clan_wars').n },
    battles: { total: q('SELECT COUNT(*) n FROM battles').n, last24h: q('SELECT COUNT(*) n FROM battles WHERE at > ?', dayAgo).n, war: q('SELECT COUNT(*) n FROM battles WHERE war_id IS NOT NULL').n },
    arena: { events: q('SELECT COUNT(*) n FROM arena_events').n, done: q("SELECT COUNT(*) n FROM arena_events WHERE status = 'done'").n, open: q("SELECT COUNT(*) n FROM arena_events WHERE status = 'open'").n },
    market: {
      open: q("SELECT COUNT(*) n FROM temple_listings WHERE status = 'open'").n, sold: q("SELECT COUNT(*) n FROM temple_listings WHERE status = 'sold'").n,
      unsold: q("SELECT COUNT(*) n FROM temple_listings WHERE status IN ('expired','cancelled')").n, volume: q("SELECT COALESCE(SUM(price), 0) n FROM temple_listings WHERE status = 'sold'").n,
    },
    mail: q('SELECT COUNT(*) n FROM mail').n,
    dungeon: { inside: q('SELECT COUNT(*) n FROM players WHERE is_bot = 1 AND dungeon_until > ?', now).n, deepest: q('SELECT COALESCE(MAX(depth) - 1, 0) n FROM dungeon').n, delvers: q('SELECT COUNT(*) n FROM dungeon WHERE depth > 1').n, runs: q('SELECT COALESCE(SUM(runs), 0) n FROM dungeon').n, loot: q('SELECT COUNT(*) n FROM dungeon_loot').n },
    busy: { hunting: q('SELECT COUNT(*) n FROM players WHERE is_bot = 1 AND hunt_until > ?', now).n, working: q('SELECT COUNT(*) n FROM players WHERE is_bot = 1 AND work_until > ?', now).n },
    sessions: q('SELECT COALESCE(SUM(sessions), 0) n FROM bots').n, errors: q('SELECT COALESCE(SUM(errors), 0) n FROM bots').n,
    byPersona,
  };
}
