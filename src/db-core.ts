/**
 * Browser-safe database core: the minimal interface the game engine needs, the schema, migrations and transactions.
 * The engine only ever talks to this interface, so it runs unchanged on node:sqlite (server, tests) and on SQLite compiled
 * to WebAssembly (the browser build for GitHub Pages).
 */
export interface Statement {
  get(...params: any[]): any;
  all(...params: any[]): any[];
  run(...params: any[]): { changes: number | bigint; lastInsertRowid: number | bigint };
}
export interface DB {
  prepare(sql: string): Statement;
  exec(sql: string): void;
  /** true while a BEGIN ... COMMIT is open (used to nest transactions with savepoints) */
  readonly isTransaction: boolean;
  /** release the database (server shutdown) */
  close(): void;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS players (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  pass_hash TEXT NOT NULL,
  race TEXT NOT NULL CHECK (race IN ('vampire','werewolf')),
  level INTEGER NOT NULL DEFAULT 1,
  xp INTEGER NOT NULL DEFAULT 0,
  gold INTEGER NOT NULL DEFAULT 0,
  hp REAL NOT NULL,
  hp_at INTEGER NOT NULL,
  max_hp INTEGER NOT NULL,
  str INTEGER NOT NULL, def INTEGER NOT NULL, agi INTEGER NOT NULL, sta INTEGER NOT NULL, dex INTEGER NOT NULL,
  last_attack_at INTEGER NOT NULL DEFAULT 0,
  found_target INTEGER, found_at INTEGER NOT NULL DEFAULT 0,
  hunt_day INTEGER NOT NULL DEFAULT 0, hunt_used INTEGER NOT NULL DEFAULT 0,
  hunt_started INTEGER, hunt_until INTEGER, hunt_portions INTEGER,
  dungeon_until INTEGER,
  work_started INTEGER, work_until INTEGER, work_hours INTEGER,
  ancestral_at INTEGER NOT NULL DEFAULT 0, ancestral_wins INTEGER NOT NULL DEFAULT 0,
  potion_stat_until INTEGER NOT NULL DEFAULT 0,
  vitality_hp INTEGER NOT NULL DEFAULT 0,
  referrer_id INTEGER REFERENCES players(id), referral_paid INTEGER NOT NULL DEFAULT 0,
  clan_id INTEGER, clan_role TEXT,
  wins INTEGER NOT NULL DEFAULT 0, losses INTEGER NOT NULL DEFAULT 0,
  is_bot INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, player_id INTEGER NOT NULL REFERENCES players(id), created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS inventory (
  id INTEGER PRIMARY KEY, player_id INTEGER NOT NULL REFERENCES players(id), item_key TEXT NOT NULL, bought_at INTEGER NOT NULL,
  hardening INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS inv_player ON inventory(player_id);
CREATE TABLE IF NOT EXISTS sentinels (
  id INTEGER PRIMARY KEY, player_id INTEGER NOT NULL REFERENCES players(id), sentinel_key TEXT NOT NULL,
  t_atk INTEGER NOT NULL DEFAULT 0, t_def INTEGER NOT NULL DEFAULT 0, t_sta INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 0, spent INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS hideouts (
  player_id INTEGER PRIMARY KEY REFERENCES players(id),
  surroundings INTEGER NOT NULL DEFAULT 0, path INTEGER NOT NULL DEFAULT 0, wall INTEGER NOT NULL DEFAULT 0, building INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS ancestral_skills (
  player_id INTEGER NOT NULL REFERENCES players(id), skill_key TEXT NOT NULL, level INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (player_id, skill_key)
);
CREATE TABLE IF NOT EXISTS clans (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE COLLATE NOCASE, race TEXT NOT NULL,
  leader_id INTEGER NOT NULL, domicile_level INTEGER NOT NULL DEFAULT 0, treasury INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL,
  is_open INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS clan_wars (
  id INTEGER PRIMARY KEY, aggressor_id INTEGER NOT NULL, defender_id INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'active', -- active | ceasefire | ended
  started_at INTEGER NOT NULL, ended_at INTEGER, end_reason TEXT,
  peace_offer_by INTEGER, ceasefire_offer_by INTEGER
);
CREATE TABLE IF NOT EXISTS clan_war_members (war_id INTEGER NOT NULL, player_id INTEGER NOT NULL, clan_id INTEGER NOT NULL, PRIMARY KEY (war_id, player_id));
CREATE INDEX IF NOT EXISTS clan_war_members_player ON clan_war_members(player_id, war_id); -- every raid asks "are these two at war?"
CREATE TABLE IF NOT EXISTS battles (
  id INTEGER PRIMARY KEY, attacker_id INTEGER NOT NULL, defender_id INTEGER NOT NULL, winner_id INTEGER NOT NULL,
  gold INTEGER NOT NULL, xp_attacker INTEGER NOT NULL, xp_defender INTEGER NOT NULL,
  war_id INTEGER, kind TEXT NOT NULL DEFAULT 'raid', at INTEGER NOT NULL, rounds INTEGER NOT NULL, log TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS battles_pair ON battles(attacker_id, defender_id, at);
CREATE INDEX IF NOT EXISTS battles_def ON battles(defender_id, at);
-- automated players: persona + schedule. Bots are ordinary rows in the players table (is_bot = 1) and use the same game services.
CREATE TABLE IF NOT EXISTS bots (
  player_id INTEGER PRIMARY KEY REFERENCES players(id), persona TEXT NOT NULL, next_at INTEGER NOT NULL,
  tz INTEGER NOT NULL DEFAULT 0, sessions_left INTEGER NOT NULL DEFAULT 4, sessions INTEGER NOT NULL DEFAULT 0, errors INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS bots_next ON bots(next_at);
-- dungeon (not in the original game): one row per player, reset weekly; loot persists until sold
CREATE TABLE IF NOT EXISTS dungeon (
  player_id INTEGER PRIMARY KEY REFERENCES players(id),
  week INTEGER NOT NULL, depth INTEGER NOT NULL DEFAULT 1, reached_at INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 0, hp INTEGER NOT NULL DEFAULT 0, max_hp INTEGER NOT NULL DEFAULT 0,
  last_at INTEGER NOT NULL DEFAULT 0, cooldown_until INTEGER NOT NULL DEFAULT 0,
  kills INTEGER NOT NULL DEFAULT 0, deaths INTEGER NOT NULL DEFAULT 0, runs INTEGER NOT NULL DEFAULT 0,
  xp_week INTEGER NOT NULL DEFAULT 0, pending TEXT, best_ever INTEGER NOT NULL DEFAULT 0,
  ready_at INTEGER NOT NULL DEFAULT 0, checkpoint INTEGER NOT NULL DEFAULT 1 -- next fight allowed at / level the week starts on
);
CREATE TABLE IF NOT EXISTS dungeon_loot (
  id INTEGER PRIMARY KEY, player_id INTEGER NOT NULL REFERENCES players(id), name TEXT NOT NULL, value INTEGER NOT NULL,
  depth INTEGER NOT NULL, milestone INTEGER NOT NULL DEFAULT 0, found_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS dungeon_loot_player ON dungeon_loot(player_id);
CREATE TABLE IF NOT EXISTS dungeon_weekly (week INTEGER NOT NULL, player_id INTEGER NOT NULL, depth INTEGER NOT NULL, PRIMARY KEY (week, player_id));
CREATE TABLE IF NOT EXISTS counters (player_id INTEGER NOT NULL, key TEXT NOT NULL, value INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (player_id, key));
CREATE TABLE IF NOT EXISTS acc_sets (player_id INTEGER NOT NULL, slot INTEGER NOT NULL, keys TEXT NOT NULL DEFAULT '[]', active INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (player_id, slot));

CREATE TABLE IF NOT EXISTS arena_events (
  id INTEGER PRIMARY KEY, kind TEXT NOT NULL, creator_id INTEGER NOT NULL, size INTEGER NOT NULL, deviation INTEGER NOT NULL, fee INTEGER NOT NULL,
  with_eq INTEGER NOT NULL, with_sen INTEGER NOT NULL, with_anc INTEGER NOT NULL, base_skill REAL NOT NULL,
  deadline INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'open', -- open | full | done | cancelled
  full_at INTEGER, start_at INTEGER, created_at INTEGER NOT NULL, winner_id INTEGER
);
CREATE TABLE IF NOT EXISTS arena_entries (
  event_id INTEGER NOT NULL, player_id INTEGER NOT NULL, stats TEXT NOT NULL, max_hp INTEGER NOT NULL, skill REAL NOT NULL, strength REAL NOT NULL,
  place INTEGER, PRIMARY KEY (event_id, player_id)
);
CREATE TABLE IF NOT EXISTS arena_matches (
  id INTEGER PRIMARY KEY, event_id INTEGER NOT NULL, round INTEGER NOT NULL, a_id INTEGER NOT NULL, b_id INTEGER NOT NULL, winner_id INTEGER NOT NULL,
  rounds INTEGER NOT NULL, log TEXT NOT NULL, at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS arena_matches_time ON arena_matches(at);
CREATE TABLE IF NOT EXISTS arena_points (player_id INTEGER PRIMARY KEY, points REAL NOT NULL DEFAULT 0, at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS arena_season (season TEXT NOT NULL, player_id INTEGER NOT NULL, points REAL NOT NULL DEFAULT 0, wins INTEGER NOT NULL DEFAULT 0, losses INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (season, player_id));
CREATE TABLE IF NOT EXISTS arena_titles (season TEXT NOT NULL, place INTEGER NOT NULL, player_id INTEGER NOT NULL, PRIMARY KEY (season, place));

CREATE TABLE IF NOT EXISTS temple_listings (
  id INTEGER PRIMARY KEY, seller_id INTEGER NOT NULL, item_key TEXT NOT NULL, hardening INTEGER NOT NULL DEFAULT 0, price INTEGER NOT NULL,
  created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'open', buyer_id INTEGER, sold_at INTEGER
);
CREATE INDEX IF NOT EXISTS temple_open ON temple_listings(status, expires_at);

CREATE TABLE IF NOT EXISTS mail (
  id INTEGER PRIMARY KEY, from_id INTEGER, -- NULL = system
  to_id INTEGER NOT NULL, subject TEXT NOT NULL, body TEXT NOT NULL, sent_at INTEGER NOT NULL, read_at INTEGER,
  del_from INTEGER NOT NULL DEFAULT 0, del_to INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS mail_to ON mail(to_id, sent_at);

CREATE TABLE IF NOT EXISTS clan_perms (player_id INTEGER PRIMARY KEY, clan_id INTEGER NOT NULL, perms TEXT NOT NULL DEFAULT '[]');
CREATE TABLE IF NOT EXISTS clan_applications (clan_id INTEGER NOT NULL, player_id INTEGER NOT NULL, message TEXT NOT NULL DEFAULT '', at INTEGER NOT NULL, PRIMARY KEY (clan_id, player_id));
CREATE TABLE IF NOT EXISTS forum_threads (
  id INTEGER PRIMARY KEY, clan_id INTEGER NOT NULL, author_id INTEGER NOT NULL, title TEXT NOT NULL,
  pinned INTEGER NOT NULL DEFAULT 0, locked INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, last_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS forum_posts (id INTEGER PRIMARY KEY, thread_id INTEGER NOT NULL, author_id INTEGER NOT NULL, body TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS forum_posts_thread ON forum_posts(thread_id, id);

-- the shrine: automation of hunting and work (one row per player who bought it); animal blood is stored on the player
CREATE TABLE IF NOT EXISTS shrine (
  player_id INTEGER PRIMARY KEY REFERENCES players(id), level INTEGER NOT NULL DEFAULT 1, status TEXT NOT NULL DEFAULT 'off', -- off | running | paused | starved
  routine TEXT NOT NULL DEFAULT '[]', step INTEGER NOT NULL DEFAULT 0, step_at INTEGER NOT NULL DEFAULT 0, bought_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS skills (player_id INTEGER NOT NULL REFERENCES players(id), node_id TEXT NOT NULL, PRIMARY KEY (player_id, node_id));
CREATE TABLE IF NOT EXISTS shrine_components (player_id INTEGER NOT NULL REFERENCES players(id), kind TEXT NOT NULL, tier INTEGER NOT NULL, PRIMARY KEY (player_id, kind));
-- admin page: tuned numbers (only the ones that differ from config.ts), world facts, and an audit trail of what admins did
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value REAL NOT NULL);
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS admin_log (id INTEGER PRIMARY KEY, at INTEGER NOT NULL, admin_id INTEGER, admin_name TEXT NOT NULL, action TEXT NOT NULL, detail TEXT NOT NULL DEFAULT '');

CREATE TABLE IF NOT EXISTS bites (link_player INTEGER NOT NULL, visitor TEXT NOT NULL, day INTEGER NOT NULL, PRIMARY KEY (link_player, visitor, day));
`;

/** Create tables and apply migrations on an already opened database. Safe to call on every start. */
export function initSchema(db: DB) {
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);
  migrate(db);
}

let savepoints = 0;
/**
 * Run fn inside a transaction; rolls back on throw. Re-entrant: when already inside a transaction it uses a savepoint,
 * so a failure in the inner call undoes only the inner call's changes.
 */
export function tx<T>(db: DB, fn: () => T): T {
  if (db.isTransaction) {
    const name = `sp${++savepoints}`;
    db.exec(`SAVEPOINT ${name}`);
    try { const r = fn(); db.exec(`RELEASE ${name}`); return r; }
    catch (e) { db.exec(`ROLLBACK TO ${name}; RELEASE ${name}`); throw e; }
  }
  db.exec('BEGIN IMMEDIATE');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

/** Add columns introduced after a database file was first created. */
function migrate(db: DB) {
  const add = (table: string, column: string, type: string) => {
    const cols = new Set((db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name));
    if (!cols.has(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  };
  add('players', 'dungeon_until', 'INTEGER');
  add('players', 'vitality_hp', 'INTEGER NOT NULL DEFAULT 0');
  add('players', 'hunt_started', 'INTEGER'); add('players', 'hunt_until', 'INTEGER'); add('players', 'hunt_portions', 'INTEGER');
  add('inventory', 'hardening', 'INTEGER NOT NULL DEFAULT 0');
  add('clans', 'is_open', 'INTEGER NOT NULL DEFAULT 1');
  add('players', 'is_bot', 'INTEGER NOT NULL DEFAULT 0');
  add('dungeon', 'ready_at', 'INTEGER NOT NULL DEFAULT 0'); add('dungeon', 'checkpoint', 'INTEGER NOT NULL DEFAULT 1');
  add('players', 'blood', 'REAL NOT NULL DEFAULT 0');
  add('players', 'skill_mods', "TEXT NOT NULL DEFAULT '{}'"); add('players', 'skill_start', 'TEXT'); // summed skill board modifiers and the start node (the class)
  add('players', 'is_admin', 'INTEGER NOT NULL DEFAULT 0'); // multiplayer: set by hand (scripts/admin.ts); single player: everyone is admin anyway
  db.exec('DELETE FROM sessions WHERE length(token) != 64'); // sessions used to store the token itself (48 hex); now only its SHA-256 (64 hex)
}
