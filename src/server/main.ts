import { serve } from '@hono/node-server';
import { createApp } from './create-app.ts';
import { ensureBots, tickBots } from '../bots/runner.ts';
import { dirname, join } from 'node:path';
import { backupDatabase } from './backup.ts';
import { openDb, tx } from '../db/node.ts';
import { purgeExpiredSessions } from '../game/character/auth.ts';
import * as arena from '../game/combat/arena.ts';

process.umask(0o077); // files this process creates (database, backups) are private to its user
const db = openDb(process.env.DB_PATH ?? 'monsters.db');
const devMode = process.env.NODE_ENV !== 'production';
const devClock = devMode ? { offset: 0 } : undefined; // dev panel can fast-forward the game clock
const now = () => Date.now() + (devClock?.offset ?? 0);
// ---- public-server protections (see DEPLOY.md) ----
const list = (v?: string) =>
  (v ?? '')
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);
const num = (v: string | undefined, d: number) => (v !== undefined && v !== '' && Number.isFinite(Number(v)) ? Number(v) : d);
const security = {
  registrationCode: process.env.REGISTRATION_CODE || undefined, // set it on a private server: only people who know it can register
  corsOrigins: list(process.env.CORS_ORIGINS), // e.g. "https://*.itch.zone,https://me.github.io"; empty = same origin only
  trustProxy: process.env.TRUST_PROXY === '1', // behind Fly / Railway / nginx: use their X-Forwarded-For for rate limiting
  limits:
    process.env.RATE_LIMIT === '0'
      ? (false as const)
      : {
          register: { windowMs: 60 * 60_000, max: num(process.env.RATE_REGISTER_PER_HOUR, 5) },
          login: { windowMs: 10 * 60_000, max: num(process.env.RATE_LOGIN_PER_10MIN, 20) },
          api: { windowMs: 60_000, max: num(process.env.RATE_API_PER_MIN, 600) },
          authGlobal: { windowMs: 60_000, max: num(process.env.RATE_AUTH_GLOBAL_PER_MIN, 120) },
        },
};
// (after an admin wipe the bots are gone: start fresh ones. BOTS is declared below; the callback only runs later)
const app = createApp({
  db,
  now,
  rng: Math.random,
  devClock,
  security,
  onWipe: () => {
    if (BOTS > 0) ensureBots(db, BOTS, now(), Math.random);
  },
});
const port = Number(process.env.PORT ?? 3000);

// ---- automated players (BOTS=0 disables) ----
const BOTS = Number(process.env.BOTS ?? 100);
const botOpts = {
  humans: process.env.BOTS_RAID_HUMANS !== '0', // bots may raid real players...
  humanRaidChance: Number(process.env.BOTS_HUMAN_RAID_CHANCE ?? 0.3), // ...but only this share of the time they find one
};
if (BOTS > 0) {
  // Bots start exactly like new players: level 1, 5 in every attribute, no history. Their first sessions are spread over the next ~2 hours.
  const created = ensureBots(db, BOTS, now(), Math.random);
  if (created) console.log(`Created ${created} bots at level 1.`);
  setInterval(() => {
    try {
      const r = tickBots(db, now(), Math.random, botOpts);
      if (r.errors) console.error(`[bots] ${r.errors} session error(s)`);
    } catch (e) {
      console.error(e);
    }
  }, 20_000);
}

setInterval(() => {
  try {
    tx(db, () => arena.tick(db, now(), Math.random));
  } catch (e) {
    console.error(e);
  }
}, 30_000);
// ---- automatic backups (the database is the only thing that matters) ----
const dbPath = process.env.DB_PATH ?? 'monsters.db';
const backupDir = process.env.BACKUP_DIR ?? join(dirname(dbPath), 'backups');
const backupEveryHours = num(process.env.BACKUP_EVERY_HOURS, 6),
  backupKeep = num(process.env.BACKUP_KEEP, 28);
const backup = (why: string) => {
  try {
    console.log(`[backup] ${why}: ${backupDatabase(db, backupDir, backupKeep)}`);
  } catch (e) {
    console.error('[backup] failed', e);
  }
};
if (backupEveryHours > 0) setInterval(() => backup('scheduled'), backupEveryHours * 3_600_000);

// Listen on the loopback interface only unless told otherwise: a reverse proxy (Caddy/nginx) is the public face and does TLS.
// (Inside Docker set HOST=0.0.0.0 and publish the port on 127.0.0.1 only.)
const host = process.env.HOST ?? '127.0.0.1';
const server = serve({ fetch: app.fetch, port, hostname: host }, () =>
  console.log(
    `MonstersGame-Reloaded API on http://${host === '0.0.0.0' ? 'localhost' : host}:${port}${BOTS > 0 ? ` (${BOTS} bots active)` : ''}${security.corsOrigins.length ? `, CORS for ${security.corsOrigins.join(', ')}` : ''}`,
  ),
);

// slow or stalled clients must not be able to hold connections open forever
const http = server as unknown as { requestTimeout: number; headersTimeout: number; keepAliveTimeout: number; maxRequestsPerSocket: number };
http.requestTimeout = 30_000;
http.headersTimeout = 20_000;
http.keepAliveTimeout = 5_000;
http.maxRequestsPerSocket = 1000;

// expired login sessions are removed once a day
setInterval(() => {
  try {
    const n = tx(db, () => purgeExpiredSessions(db, now()));
    if (n) console.log(`[sessions] removed ${n} expired`);
  } catch (e) {
    console.error(e);
  }
}, 24 * 3_600_000);

// ---- clean shutdown: stop accepting requests, take a last backup, close the database ----
let closing = false;
for (const sig of ['SIGINT', 'SIGTERM'] as const)
  process.on(sig, () => {
    if (closing) return;
    closing = true;
    console.log(`${sig}: shutting down`);
    server.close();
    if (backupEveryHours > 0) backup('final');
    try {
      db.close();
    } catch {
      /* already closed */
    }
    process.exit(0);
  });
