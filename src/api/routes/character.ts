/** The logged-in character: its complete state, battle reports. */
import type { Api } from '../context.ts';
import { tx } from '../../db/core.ts';
import { GameError } from '../../core/errors.ts';
import * as admin from '../../game/admin/admin.ts';
import * as shrine from '../../game/world/shrine.ts';
import * as skills from '../../game/character/skills.ts';
import * as quests from '../../game/world/quests.ts';
import * as notes from '../../game/social/notify.ts';
import { alertsFor } from '../../game/social/alerts.ts';
import { pointsTotal } from '../../game/character/skills.ts';
import { discounted, modsOf } from '../../game/character/mods.ts';
import { tankSize } from '../../game/world/blood.ts';
import * as mail from '../../game/social/mail.ts';
import {
  attackCooldownOf,
  battleStats,
  equipmentLoadout,
  hideoutTotal,
  loadPlayer,
  ownedItems,
  sentinelBonus,
  vitalityRoom,
} from '../../game/character/player.ts';
import { CFG, type Stat } from '../../core/config.ts';

export function characterRoutes(api: Api) {
  const { app, db, now, rng, me, singlePlayer } = api;
  app.get('/api/me', (c) => {
    const id = me(c);
    return c.json(
      tx(db, () => {
        const t = now();
        quests.ensureWeek(db, t);
        shrine.settle(db, id, t, rng);
        const p = loadPlayer(db, id, t);
        const { pass_hash: _, ...pub } = p;
        return {
          ...pub,
          blood: Math.floor(p.blood * 10) / 10,
          bloodMax: tankSize(db, id),
          shrine: (db.prepare('SELECT status FROM shrine WHERE player_id = ?').get(id) as { status: string } | undefined)?.status ?? null,
          unreadNotifications: notes.unreadCount(db, id),
          notificationCursor: notes.latestId(db, id),
          questsReady: quests.readyCount(db, id, t),
          alerts: alertsFor(db, id, t),
          skillMods: modsOf(p),
          skillPoints: Math.max(0, pointsTotal(p.level) - skills.usedPoints(db, id)),
          isAdmin: admin.isAdmin(db, id, singlePlayer),
          hp: Math.floor(p.hp),
          serverNow: t,
          xpToNext: CFG.xpToNext(p.level),
          attackReadyAt: p.last_attack_at + attackCooldownOf(p),
          found:
            p.found_target && t - p.found_at <= CFG.searchValidity
              ? db.prepare('SELECT id, name, level, race FROM players WHERE id = ?').get(p.found_target)
              : null,
          huntMinutesLeft: (CFG.huntBudget - (p.hunt_day === Math.floor(t / 86_400_000) ? p.hunt_used : 0)) / 60000,
          vitalityRoom: vitalityRoom(db, p),
          unreadMail: mail.unreadCount(db, id),
          arenaTitles: db.prepare('SELECT season, place FROM arena_titles WHERE player_id = ? ORDER BY season DESC').all(id),
          ancestralReadyAt: p.ancestral_at + CFG.ancestralCooldown,
          ancestralFee: discounted(CFG.ancestralFee(p.ancestral_wins), p, 'ancestralFee'),
          ancestralSlots: CFG.ancestralSlots(p.level),
          sentinelOwned: db.prepare('SELECT * FROM sentinels WHERE player_id = ?').get(id) ?? null,
          clan: p.clan_id ? db.prepare('SELECT id, name, domicile_level, treasury, leader_id FROM clans WHERE id = ?').get(p.clan_id) : null,
          sentinelTrainCosts: (() => {
            const s = db.prepare('SELECT t_atk, t_def, t_sta FROM sentinels WHERE player_id = ?').get(id) as any;
            return s ? { atk: CFG.sentinelTrainCost(s.t_atk), def: CFG.sentinelTrainCost(s.t_def), sta: CFG.sentinelTrainCost(s.t_sta) } : null;
          })(),
          hideoutCosts: Object.fromEntries(
            Object.keys(CFG.hideoutMax).map((k) => [
              k,
              CFG.hideoutCost(k, (db.prepare(`SELECT ${k} v FROM hideouts WHERE player_id = ?`).get(id) as any).v + 1),
            ]),
          ),
          battleStats: battleStats(db, p, { ancestral: p.level >= CFG.ancestralMinLevel }),
          loadout: equipmentLoadout(db, p),
          sentinel: sentinelBonus(db, id),
          inventory: ownedItems(db, id).map((o) => ({
            id: o.id,
            key: o.def.key,
            name: o.def.name,
            slot: o.def.slot,
            hardening: o.hardening,
            equipped: equipmentLoadout(db, p).equipped.includes(o.id),
          })),
          hideout: db.prepare('SELECT surroundings, path, wall, building FROM hideouts WHERE player_id = ?').get(id),
          hideoutTotal: hideoutTotal(db, id),
          ancestralSkills: db.prepare('SELECT skill_key, level FROM ancestral_skills WHERE player_id = ?').all(id),
          nextTrainCosts: Object.fromEntries(
            (['str', 'def', 'agi', 'sta', 'dex'] as Stat[]).map((s) => [s, discounted(CFG.trainCost(p[s]), p, 'trainDiscount')]),
          ),
        };
      }),
    );
  });
  app.get('/api/messages', (c) => {
    const id = me(c);
    return c.json(
      db
        .prepare(
          `SELECT b.id, b.at, b.winner_id, b.gold, b.rounds, b.war_id, a.name attacker, d.name defender
         FROM battles b JOIN players a ON a.id = b.attacker_id JOIN players d ON d.id = b.defender_id
        WHERE b.attacker_id = ? OR b.defender_id = ? ORDER BY b.at DESC LIMIT 50`,
        )
        .all(id, id),
    );
  });
  app.get('/api/battles/:id', (c) => {
    const uid = me(c);
    // only the two fighters may read a battle's round-by-round log (404 for everyone else, so ids cannot be probed)
    const r = db.prepare('SELECT * FROM battles WHERE id = ? AND (attacker_id = ? OR defender_id = ?)').get(Number(c.req.param('id')), uid, uid) as
      { log: string } | undefined;
    if (!r) throw new GameError('not_found', 'No such battle', 404);
    return c.json({ ...r, log: JSON.parse(r.log) });
  });
}
