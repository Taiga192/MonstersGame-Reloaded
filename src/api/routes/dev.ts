/** Test tools (gold, levels, time skip, spawning bots and enemies). Only registered when the server runs with a movable clock, never in production. */
import type { Api } from '../context.ts';
import { maxHpBonus } from '../../game/character/skills.ts';
import { tankSize } from '../../game/world/blood.ts';
import * as arena from '../../game/combat/arena.ts';
import { CFG } from '../../core/config.ts';
import {
  botsActNow,
  botsAdd,
  botsReport,
  devDungeon,
  enemyDeclaresWar,
  enemyNegotiates,
  fillArena,
  fillMyClan,
  healBots,
  seedApplicants,
  seedBots,
  seedEnemyClan,
  seedMail,
  seedMarket,
} from '../dev-tools.ts';

export function devRoutes(api: Api, devClock: { offset: number }) {
  const { app, db, now, rng, act } = api;
  const dev = (path: string, fn: (id: number, b: Record<string, any>) => unknown) =>
    app.post(
      `/api/dev/${path}`,
      act((id, b) => fn(id, b)),
    );
  dev('grant', (id, b) => {
    db.prepare('UPDATE players SET gold = gold + ? WHERE id = ?').run(Number(b.gold) || 0, id);
  });
  dev('level', (id, b) => {
    const lv = Math.max(1, Math.min(200, Number(b.level) || 1));
    db.prepare('UPDATE players SET level = ?, xp = 0, max_hp = ?, hp = ?, hp_at = ? WHERE id = ?').run(
      lv,
      CFG.startMaxHp + (lv - 1) * CFG.levelUpMaxHp + maxHpBonus(db, id),
      CFG.startMaxHp + (lv - 1) * CFG.levelUpMaxHp + maxHpBonus(db, id),
      now(),
      id,
    );
  });
  dev('blood', (id) => {
    db.prepare('UPDATE players SET blood = ? WHERE id = ?').run(tankSize(db, id), id);
  });
  dev('heal', (id) => {
    db.prepare('UPDATE players SET hp = max_hp, hp_at = ? WHERE id = ?').run(now(), id);
  });
  dev('skip', (_id, b) => {
    devClock.offset += Math.max(0, Number(b.minutes) || 0) * 60_000;
    arena.tick(db, now(), rng);
    return { serverNow: now() };
  });
  dev('bots', (id, b) => {
    const p = db.prepare('SELECT level FROM players WHERE id = ?').get(id) as { level: number };
    return { created: seedBots(db, now(), rng, Math.min(50, Number(b.count) || 10), p.level) };
  });
  dev('arena-fill', (id) => fillArena(db, id, now(), rng));
  dev('market', () => {
    seedMarket(db, now(), rng);
  });
  dev('applicants', (id) => {
    seedApplicants(db, id, now(), rng);
  });
  dev('mail', (id) => {
    seedMail(db, id, now(), rng);
  });
  dev('enemy-clan', (id) => seedEnemyClan(db, id, now(), rng));
  dev('fill-clan', (id) => fillMyClan(db, id, now(), rng));
  dev('enemy-declare', (id) => enemyDeclaresWar(db, id, now(), rng));
  dev('heal-bots', () => healBots(db, now()));
  dev('dungeon', (id, b) => devDungeon(db, id, now(), b));
  dev('stats', (id, b) => {
    const n = Math.max(1, Math.min(100000, Number(b.value) || 5));
    db.prepare('UPDATE players SET str = ?, def = ?, agi = ?, sta = ?, dex = ? WHERE id = ?').run(n, n, n, n, n, id);
    return { message: `All attributes set to ${n}` };
  });
  dev('bots-report', () => botsReport(db, now()));
  dev('bots-act', () => botsActNow(db, now(), rng));
  dev('bots-add', (_id, b) => botsAdd(db, Number(b.count) || 10, now(), rng));
  dev('enemy-negotiate', (id, b) => enemyNegotiates(db, id, String(b.action), now()));
  app.get('/api/dev', (c) => c.json({ enabled: true }));
}
