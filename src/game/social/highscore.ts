import type { DB } from '../../db/core.ts';
import { assert } from '../../core/errors.ts';
import { arenaStatus, ranking, seasonKey } from '../combat/arena.ts';
import { accomplishmentStatus } from '../character/accomplishments.ts';
import { weekOf } from '../world/dungeon.ts';

export const HIGHSCORE_TYPES = ['level', 'wins', 'loot', 'hunter', 'worker', 'dungeon', 'arena_season', 'arena_alltime', 'clans'] as const;
export type HighscoreType = (typeof HIGHSCORE_TYPES)[number];
export const PAGE_SIZES = [25, 50, 100] as const;
const NO_LIMIT = 1_000_000;

const counterBoard = (key: string) =>
  `SELECT p.id, p.name, p.race, p.level, p.xp, p.clan_id, c.value AS value FROM counters c JOIN players p ON p.id = c.player_id WHERE c.key = '${key}' AND c.value > 0`;

/**
 * Highscore variants, filterable by race and paged. Ordering is fully deterministic (ties are broken by level, then
 * by id) so a player can never appear on two pages, or on none, between two page loads. `playerId` adds "your rank".
 */
export function highscore(db: DB, o: { type: string; race?: string; page?: number; size?: number; playerId?: number }, now: number) {
  assert((HIGHSCORE_TYPES as readonly string[]).includes(o.type), 'bad_type', `Unknown highscore: ${HIGHSCORE_TYPES.join(', ')}`);
  const race = o.race === 'vampire' || o.race === 'werewolf' ? o.race : null;
  const size = (PAGE_SIZES as readonly number[]).includes(Number(o.size)) ? Number(o.size) : PAGE_SIZES[0];
  const raceSql = (alias: string) => (race ? `AND ${alias}.race = '${race}'` : '');
  const meClan = o.playerId
    ? ((db.prepare('SELECT clan_id FROM players WHERE id = ?').get(o.playerId) as { clan_id: number | null } | undefined)?.clan_id ?? null)
    : null;

  // 1) the complete ordered list of ids (this defines rank and total) ...
  let ids: number[];
  const meId = o.type === 'clans' ? meClan : (o.playerId ?? null);
  const finish = (rows: any[], extra: object = {}) => {
    const total = ids.length,
      pages = Math.max(1, Math.ceil(total / size));
    const page = Math.min(Math.max(0, Math.floor(Number(o.page) || 0)), pages - 1);
    const at = meId == null ? -1 : ids.indexOf(meId);
    return {
      type: o.type,
      race: race ?? 'all',
      page,
      pages,
      pageSize: size,
      total,
      myRank: at >= 0 ? at + 1 : null,
      myPage: at >= 0 ? Math.floor(at / size) : null,
      ...extra,
      rows: rows.slice(page * size, (page + 1) * size),
    };
  };

  if (o.type === 'clans') {
    const sql = `SELECT c.id, c.name, c.race, COUNT(p.id) AS members, COALESCE(SUM(p.level), 0) AS value
                   FROM clans c LEFT JOIN players p ON p.clan_id = c.id WHERE 1 = 1 ${raceSql('c')} GROUP BY c.id ORDER BY value DESC, members DESC, c.id ASC`;
    const rows = db.prepare(sql).all() as any[];
    ids = rows.map((r) => r.id);
    return finish(rows);
  }
  if (o.type === 'arena_season' || o.type === 'arena_alltime') {
    let rows = ranking(db, o.type === 'arena_season' ? 'season' : 'alltime', now, NO_LIMIT) as any[];
    if (race) rows = rows.filter((r) => r.race === race);
    ids = rows.map((r) => r.id);
    return finish(
      rows.map((r) => ({ ...r, value: Math.round(r.points) })),
      { season: seasonKey(now) },
    );
  }
  const sql = {
    level: `SELECT p.id, p.name, p.race, p.level, p.xp, p.clan_id, p.xp AS value FROM players p WHERE 1 = 1 ${raceSql('p')}`,
    wins: `SELECT p.id, p.name, p.race, p.level, p.xp, p.clan_id, p.wins AS value FROM players p WHERE p.wins > 0 ${raceSql('p')}`,
    loot: `${counterBoard('gold_stolen')} ${raceSql('p')}`,
    hunter: `${counterBoard('hunt_portions')} ${raceSql('p')}`,
    worker: `${counterBoard('work_hours')} ${raceSql('p')}`,
    // this week's dungeon ladder: levels cleared; the player who got there first ranks higher
    dungeon: `SELECT p.id, p.name, p.race, p.level, p.xp, p.clan_id, d.depth - 1 AS value, d.reached_at AS reached FROM dungeon d JOIN players p ON p.id = d.player_id WHERE d.week = ${weekOf(now)} AND d.kills > 0 ${raceSql('p')}`,
  }[o.type as 'level' | 'wins' | 'loot' | 'hunter' | 'worker' | 'dungeon'];
  // the level board ranks by level first, then XP; the others by their value, then level
  const order =
    o.type === 'level' ? 'level DESC, xp DESC, id ASC' : o.type === 'dungeon' ? 'value DESC, reached ASC, id ASC' : 'value DESC, level DESC, id ASC';
  const rows = db.prepare(`SELECT * FROM (${sql}) ORDER BY ${order}`).all() as any[];
  ids = rows.map((r) => r.id);
  const clanNames = new Map((db.prepare('SELECT id, name FROM clans').all() as { id: number; name: string }[]).map((c) => [c.id, c.name]));
  return finish(rows.map((r) => ({ ...r, clan: r.clan_id ? clanNames.get(r.clan_id) : null })));
}

/** Public profile: never exposes gold, HP or stats. */
export function profile(db: DB, id: number, now: number) {
  const p = db.prepare('SELECT id, name, race, level, wins, losses, clan_id, created_at FROM players WHERE id = ?').get(id) as any;
  assert(p, 'not_found', 'Player not found', 404);
  const clan = p.clan_id ? db.prepare('SELECT id, name FROM clans WHERE id = ?').get(p.clan_id) : null;
  const arena = arenaStatus(db, id, now);
  const acc = accomplishmentStatus(db, id)
    .filter((a) => a.tier > 0)
    .map((a) => ({ name: a.name, tier: a.tier, maxTier: a.maxTier }));
  const dg = db.prepare('SELECT week, depth, best_ever FROM dungeon WHERE player_id = ?').get(id) as
    { week: number; depth: number; best_ever: number } | undefined;
  return {
    id: p.id,
    name: p.name,
    race: p.race,
    level: p.level,
    wins: p.wins,
    losses: p.losses,
    joined: p.created_at,
    clan,
    dungeon: { week: dg && dg.week === weekOf(now) ? dg.depth - 1 : 0, bestEver: dg?.best_ever ?? 0 },
    arena: { rank: arena.rank, points: arena.points, trend: arena.trend, titles: arena.titles },
    accomplishments: acc,
  };
}
