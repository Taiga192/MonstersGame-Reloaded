/** Clans, clan wars, the war room and clan administration. */
import type { Api } from '../context.ts';
import { tx } from '../../db/core.ts';
import { GameError } from '../../core/errors.ts';
import * as clan from '../../game/social/clan.ts';
import * as war from '../../game/combat/war.ts';
import { attackCooldownOf, loadPlayer } from '../../game/character/player.ts';
import { CFG } from '../../core/config.ts';

export function clanRoutes(api: Api) {
  const { app, db, now, rng, me, act } = api;
  app.get('/api/clans', (c) =>
    c.json(
      db
        .prepare(
          'SELECT c.id, c.name, c.race, c.domicile_level, (SELECT COUNT(*) FROM players p WHERE p.clan_id = c.id) members FROM clans c ORDER BY members DESC',
        )
        .all(),
    ),
  );
  app.post(
    '/api/clan/create',
    act((id, b) => ({ id: clan.createClan(db, id, b.name, now()) })),
  );
  app.post(
    '/api/clan/join',
    act((id, b) => clan.joinClan(db, id, b.clanId, now())),
  );
  app.post(
    '/api/clan/leave',
    act((id) => clan.leaveClan(db, id, now())),
  );
  app.post(
    '/api/clan/kick',
    act((id, b) => clan.kickMember(db, id, b.playerId, now())),
  );
  app.post(
    '/api/clan/donate',
    act((id, b) => clan.donate(db, id, b.amount, now())),
  );
  app.post(
    '/api/clan/upgrade',
    act((id) => clan.upgradeDomicile(db, id, now())),
  );
  app.post(
    '/api/clan/war/declare',
    act((id, b) => ({ warId: clan.declareWar(db, id, b.clanId, now()) })),
  );
  app.post(
    '/api/clan/war/peace',
    act((id) => ({ result: clan.offerPeace(db, id, now()) })),
  );
  app.post(
    '/api/clan/war/ceasefire',
    act((id) => ({ result: clan.offerCeasefire(db, id, now()) })),
  );
  app.post(
    '/api/clan/war/capitulate',
    act((id) => clan.capitulate(db, id, now())),
  );
  // War room: roster of enemy war members with attackability, scoreboard, and the random war attack
  app.get('/api/clan/war', (c) => {
    const id = me(c);
    return c.json(
      tx(db, () => {
        const t = now();
        const ctx = war.warOf(db, id);
        if (!ctx) return { war: null };
        const { targets } = war.warRoster(db, id, t);
        const names = Object.fromEntries(
          (db.prepare('SELECT id, name FROM clans WHERE id IN (?, ?)').all(ctx.myClan, ctx.enemyClan) as { id: number; name: string }[]).map((x) => [
            x.id,
            x.name,
          ]),
        );
        const p = loadPlayer(db, id, t);
        return {
          war: ctx.war,
          myClan: { id: ctx.myClan, name: names[ctx.myClan] },
          enemyClan: { id: ctx.enemyClan, name: names[ctx.enemyClan] },
          targets,
          scoreboard: war.warScoreboard(db, ctx.war.id),
          attackReadyAt: p.last_attack_at + attackCooldownOf(p),
          skillBand: CFG.warSkillBand,
          maxHits: CFG.sameOpponentMaxWar,
        };
      }),
    );
  });
  app.post(
    '/api/clan/war/attack',
    act((id) => war.warAttack(db, id, now(), rng)),
  );
  app.get('/api/clan/war/:id/stats', (c) => {
    const uid = me(c),
      warId = Number(c.req.param('id'));
    // only people who took part in that war (they are on its snapshotted roster) may see its detailed statistics
    if (!db.prepare('SELECT 1 FROM clan_war_members WHERE war_id = ? AND player_id = ?').get(warId, uid)) throw new GameError('not_found', 'No such war', 404);
    return c.json(war.warScoreboard(db, warId));
  });

  app.get('/api/clan/mine', (c) => {
    const id = me(c);
    const p = db.prepare('SELECT clan_id FROM players WHERE id = ?').get(id) as { clan_id: number | null };
    if (!p.clan_id) return c.json(null);
    const info = db.prepare('SELECT * FROM clans WHERE id = ?').get(p.clan_id) as any;
    const members = db.prepare('SELECT id, name, level, clan_role FROM players WHERE clan_id = ? ORDER BY level DESC').all(p.clan_id);
    const war = clan.activeWarFor(db, p.clan_id) as any;
    const enemy = war ? db.prepare('SELECT id, name FROM clans WHERE id = ?').get(war.aggressor_id === p.clan_id ? war.defender_id : war.aggressor_id) : null;
    const perms = Object.fromEntries(
      (db.prepare('SELECT player_id, perms FROM clan_perms WHERE clan_id = ?').all(p.clan_id) as any[]).map((r) => [r.player_id, JSON.parse(r.perms)]),
    );
    return c.json({
      ...info,
      capacity: clan.clanCapacity(info),
      members: members.map((m: any) => ({ ...m, perms: m.id === info.leader_id ? [...clan.CLAN_PERMS] : (perms[m.id] ?? []) })),
      war,
      enemy,
      upgradeCost: CFG.clanUpgradeCost(info.domicile_level),
      myPerms: clan.permsOf(db, id),
      allPerms: clan.CLAN_PERMS,
    });
  });

  // ---- clan admin / applications / forum ----
  app.post(
    '/api/clan/apply',
    act((id, b) => clan.applyToClan(db, id, b.clanId, b.message, now())),
  );
  app.get('/api/clan/applications', (c) => {
    const id = me(c);
    return c.json(tx(db, () => clan.listApplications(db, id, now())));
  });
  app.post(
    '/api/clan/application',
    act((id, b) => clan.decideApplication(db, id, b.playerId, !!b.accept, now())),
  );
  app.post(
    '/api/clan/recruiting',
    act((id, b) => clan.setRecruiting(db, id, !!b.open, now())),
  );
  app.post(
    '/api/clan/perms',
    act((id, b) => clan.setPerms(db, id, b.playerId, b.perms, now())),
  );
}
