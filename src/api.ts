import { Hono, type Context, type MiddlewareHandler } from 'hono';
import { botsActNow, botsAdd, botsReport, devDungeon, healBots, enemyDeclaresWar, enemyNegotiates, fillArena, fillMyClan, seedApplicants, seedEnemyClan, seedBots, seedMail, seedMarket } from './dev.ts';
import { ACC_SET_SIZE, ACC_SETS, ACCOMPLISHMENTS, ANCESTRAL, CFG, ITEMS, SENTINELS, type Stat } from './config.ts';
import { tx, type DB } from './db-core.ts';
import { GameError } from './errors.ts';
import type { Rng } from './rng.ts';
import * as auth from './game/auth.ts';
import * as admin from './game/admin.ts';
import * as shrine from './game/shrine.ts';
import * as skills from './game/skills.ts';
import * as quests from './game/quests.ts';
import * as notes from './game/notify.ts';
import { alertsFor } from './game/alerts.ts';
import { maxHpBonus, pointsTotal } from './game/skills.ts';
import { boardForClient } from './skills.ts';
import { discounted, modsOf } from './game/mods.ts';
import { tankSize } from './game/blood.ts';
import { applyPreset, applySettings, describeSettings, PRESETS, resetAllSettings, resetSetting, setSetting } from './settings.ts';
import { LoginGuard } from './game/lockout.ts';
import { cleanBody, pageNumber } from './game/validate.ts';
import * as acc from './game/accomplishments.ts';
import * as arena from './game/arena.ts';
import * as clan from './game/clan.ts';
import * as dungeon from './game/dungeon.ts';
import * as forum from './game/forum.ts';
import * as hs from './game/highscore.ts';
import * as mail from './game/mail.ts';
import * as temple from './game/temple.ts';
import * as war from './game/war.ts';
import * as eco from './game/economy.ts';
import * as raid from './game/raid.ts';
import { attackCooldownOf, assertFree, battleStats, equipmentLoadout, vitalityRoom, hideoutTotal, loadPlayer, ownedItems, sentinelBonus } from './game/player.ts';

export interface Deps {
  db: DB; now: () => number; rng: Rng; devClock?: { offset: number };
  /** which art files exist (extension-less key -> file + version); the Node server scans a folder, the browser build ships a list */
  assets?: () => Record<string, { file: string; v: number }>;
  /** runs before every /api route (CORS, rate limits, body size limit on a public server) */
  middleware?: MiddlewareHandler[];
  /** runs before EVERY route, static files included (security headers) */
  globalMiddleware?: MiddlewareHandler[];
  /** when set, registering needs this code (private servers) */
  registrationCode?: string;
  /** stable identifier of the caller for anonymous features (victim link); on a server this must come from the connection, never from a request header */
  clientKey?: (c: Context) => string;
  /** single player (the browser-only build): the one human is always an admin. Multiplayer: only players with the is_admin flag. */
  singlePlayer?: boolean;
  /** called after the admin wiped the world (the server creates fresh bots) */
  onWipe?: () => void;
}

/** The whole game API as a Web-standard Hono app: it runs on Node, in a Web Worker in the browser, or anywhere else. */
export function createApi({ db, now, rng, devClock, assets, middleware = [], globalMiddleware = [], registrationCode, clientKey, singlePlayer = false, onWipe }: Deps) {
  const app = new Hono();
  for (const mw of globalMiddleware) app.use('*', mw); // (middleware only wraps routes that are registered AFTER it)
  for (const mw of middleware) app.use('/api/*', mw);
  const guard = new LoginGuard();
  applySettings(db); // the world's tuned numbers (admin page) are active from the first request

  app.onError((e, c) => {
    if (e instanceof GameError) return c.json({ error: e.code, message: e.message }, e.status as 400);
    // a field of the wrong type (missing, null, boolean, list...) that reached a query: the client's mistake, not ours
    if (e instanceof TypeError && /bound to SQLite/i.test(e.message)) return c.json({ error: 'bad_request', message: 'A field has the wrong type' }, 400);
    console.error(e);
    return c.json({ error: 'internal', message: 'Internal error' }, 500);
  });

  const bearer = (c: Context) => c.req.header('authorization')?.replace(/^Bearer /, '');
  const me = (c: Context) => auth.playerForToken(db, bearer(c), now());
  /** JSON body through the input firewall (an empty or unparsable body counts as {} and fails the handler's own validation). */
  const body = async (c: Context) => cleanBody(await c.req.json().catch(() => ({})));
  /** Authenticated action wrapped in a transaction. */
  // Activities that need the character's full attention: a running shrine stops first (one thing at a time, and no automated
  // hunting while you raid). Everything else (shopping, mail, clan, market ...) can be done with the shrine running.
  const MANUAL = new Set(['/api/hunt/start', '/api/work/start', '/api/dungeon/enter', '/api/raid/search', '/api/raid/attack', '/api/clan/war/attack',
    '/api/arena/create', '/api/arena/join', '/api/ancestral/challenge']);
  const act = <T>(fn: (id: number, b: Record<string, any>, c: Context) => T) => async (c: Context) => {
    const id = me(c); const b = await body(c);
    return c.json(tx(db, () => {
      quests.ensureWeek(db, now()); // a new quest week starts before any counter moves in it
      shrine.settle(db, id, now(), rng); // what the shrine did while you were away is paid before anything else happens
      if (MANUAL.has(c.req.path)) shrine.pause(db, id, now(), rng);
      return fn(id, b, c);
    }) ?? { ok: true });
  };

  // ---- public ----

  // Which art files exist (extension-less key -> file + mtime). The frontend only renders images that are present.
  app.get('/api/assets', (c) => c.json(assets?.() ?? {}));
  app.get('/api/catalog', (c) => c.json({ items: ITEMS, sentinels: SENTINELS, ancestral: ANCESTRAL, hideoutMax: CFG.hideoutMax,
    accomplishments: ACCOMPLISHMENTS.map(({ key, name, desc, tiers }) => ({ key, name, desc, tiers })), accSets: ACC_SETS, accSetSize: ACC_SET_SIZE,
    shrineLevel: CFG.shrineLevel, shrineTankPerTier: CFG.shrineTankPerTier, shrineSlotsPerTier: CFG.shrineSlotsPerTier, shrineBloodBonus: CFG.shrineBloodBonus, shrineEfficiencyPerUpgrade: CFG.shrineEfficiencyPerUpgrade, shrineRaidLossCap: CFG.shrineRaidLossCap, huntPortionMs: CFG.huntPortion, hardenMax: CFG.hardenMax, hardenBonus: CFG.hardenBonusPerLevel, vitalityCap: CFG.vitalityCap, vitalityGain: CFG.vitalityGain, templeFee: CFG.templeFee, arenaSizes: CFG.arenaTournamentSizes, arenaMinLevel: CFG.arenaMinLevel,
    arenaStartHourUtc: CFG.arenaDailyStartHourUtc, registrationRequired: !!registrationCode, passwordMin: CFG.passwordMin, passwordMax: CFG.passwordMax }));
  app.post('/api/register', async (c) => {
    const b = await body(c);
    if (registrationCode && !auth.secretMatches(b.code, registrationCode)) throw new GameError('bad_code', 'A registration code is required to create an account on this server', 403);
    const id = tx(db, () => auth.register(db, { name: b.name, password: b.password, race: b.race, referrerId: b.referrerId }, now()));
    return c.json({ id }, 201);
  });
  app.post('/api/logout', (c) => { auth.logout(db, bearer(c)); return c.json({ ok: true }); });
  app.post('/api/login', async (c) => {
    const b = await body(c);
    guard.check(b.name, now()); // 429 while this account is locked by too many failed attempts
    try { const r = auth.login(db, b.name, b.password, now()); guard.ok(b.name); return c.json(r); }
    catch (e) { if (e instanceof GameError && e.code === 'bad_login') guard.fail(b.name, now()); throw e; }
  });
  app.post('/api/password', act((id, b, c) => auth.changePassword(db, id, b.current, b.next, bearer(c), now())));
  app.post('/api/bite/:id', async (c) => {
    // the visitor is identified by the connection (see node-app.ts), never by a header the client can set to anything
    const visitor = clientKey ? clientKey(c) : 'local';
    return c.json(tx(db, () => eco.bite(db, Number(c.req.param('id')), visitor, now(), rng)));
  });
  // public; a valid login token additionally returns "your rank / your page"
  app.get('/api/highscore', (c) => {
    let playerId: number | undefined;
    try { playerId = me(c); } catch { /* anonymous is fine */ }
    return c.json(tx(db, () => hs.highscore(db, { type: c.req.query('type') ?? 'level', race: c.req.query('race'), page: pageNumber(c.req.query('page')), size: Number(c.req.query('size') ?? 25), playerId }, now())));
  });
  app.get('/api/players/:id', (c) => c.json(hs.profile(db, Number(c.req.param('id')), now())));

  // ---- character ----
  app.get('/api/me', (c) => {
    const id = me(c);
    return c.json(tx(db, () => {
      const t = now(); quests.ensureWeek(db, t); shrine.settle(db, id, t, rng); const p = loadPlayer(db, id, t);
      const { pass_hash: _, ...pub } = p;
      return {
        ...pub, blood: Math.floor(p.blood * 10) / 10, bloodMax: tankSize(db, id), shrine: (db.prepare('SELECT status FROM shrine WHERE player_id = ?').get(id) as { status: string } | undefined)?.status ?? null,
        unreadNotifications: notes.unreadCount(db, id), notificationCursor: notes.latestId(db, id), questsReady: quests.readyCount(db, id, t), alerts: alertsFor(db, id, t),
        skillMods: modsOf(p), skillPoints: Math.max(0, pointsTotal(p.level) - skills.usedPoints(db, id)),
        isAdmin: admin.isAdmin(db, id, singlePlayer), hp: Math.floor(p.hp), serverNow: t, xpToNext: CFG.xpToNext(p.level),
        attackReadyAt: p.last_attack_at + attackCooldownOf(p),
        found: p.found_target && t - p.found_at <= CFG.searchValidity
          ? db.prepare('SELECT id, name, level, race FROM players WHERE id = ?').get(p.found_target) : null,
        huntMinutesLeft: (CFG.huntBudget - (p.hunt_day === Math.floor(t / 86_400_000) ? p.hunt_used : 0)) / 60000,
        vitalityRoom: vitalityRoom(db, p), unreadMail: mail.unreadCount(db, id), arenaTitles: db.prepare('SELECT season, place FROM arena_titles WHERE player_id = ? ORDER BY season DESC').all(id),
        ancestralReadyAt: p.ancestral_at + CFG.ancestralCooldown, ancestralFee: discounted(CFG.ancestralFee(p.ancestral_wins), p, 'ancestralFee'),
        ancestralSlots: CFG.ancestralSlots(p.level),
        sentinelOwned: db.prepare('SELECT * FROM sentinels WHERE player_id = ?').get(id) ?? null,
        clan: p.clan_id ? db.prepare('SELECT id, name, domicile_level, treasury, leader_id FROM clans WHERE id = ?').get(p.clan_id) : null,
        sentinelTrainCosts: (() => { const s = db.prepare('SELECT t_atk, t_def, t_sta FROM sentinels WHERE player_id = ?').get(id) as any;
          return s ? { atk: CFG.sentinelTrainCost(s.t_atk), def: CFG.sentinelTrainCost(s.t_def), sta: CFG.sentinelTrainCost(s.t_sta) } : null; })(),
        hideoutCosts: Object.fromEntries(Object.keys(CFG.hideoutMax).map((k) => [k, CFG.hideoutCost(k, ((db.prepare(`SELECT ${k} v FROM hideouts WHERE player_id = ?`).get(id) as any).v) + 1)])),
        battleStats: battleStats(db, p, { ancestral: p.level >= CFG.ancestralMinLevel }),
        loadout: equipmentLoadout(db, p), sentinel: sentinelBonus(db, id),
        inventory: ownedItems(db, id).map((o) => ({ id: o.id, key: o.def.key, name: o.def.name, slot: o.def.slot, hardening: o.hardening, equipped: equipmentLoadout(db, p).equipped.includes(o.id) })),
        hideout: db.prepare('SELECT surroundings, path, wall, building FROM hideouts WHERE player_id = ?').get(id), hideoutTotal: hideoutTotal(db, id),
        ancestralSkills: db.prepare('SELECT skill_key, level FROM ancestral_skills WHERE player_id = ?').all(id),
        nextTrainCosts: Object.fromEntries((['str', 'def', 'agi', 'sta', 'dex'] as Stat[]).map((s) => [s, discounted(CFG.trainCost(p[s]), p, 'trainDiscount')])),
      };
    }));
  });
  app.get('/api/messages', (c) => {
    const id = me(c);
    return c.json(db.prepare(
      `SELECT b.id, b.at, b.winner_id, b.gold, b.rounds, b.war_id, a.name attacker, d.name defender
         FROM battles b JOIN players a ON a.id = b.attacker_id JOIN players d ON d.id = b.defender_id
        WHERE b.attacker_id = ? OR b.defender_id = ? ORDER BY b.at DESC LIMIT 50`).all(id, id));
  });
  app.get('/api/battles/:id', (c) => {
    const uid = me(c);
    // only the two fighters may read a battle's round-by-round log (404 for everyone else, so ids cannot be probed)
    const r = db.prepare('SELECT * FROM battles WHERE id = ? AND (attacker_id = ? OR defender_id = ?)').get(Number(c.req.param('id')), uid, uid) as { log: string } | undefined;
    if (!r) throw new GameError('not_found', 'No such battle', 404);
    return c.json({ ...r, log: JSON.parse(r.log) });
  });

  app.post('/api/train', act((id, b) => eco.trainStat(db, id, b.stat, now())));
  app.post('/api/store/buy', act((id, b) => eco.buyItem(db, id, b.key, now())));
  app.post('/api/inventory/sell', act((id, b) => eco.sellItem(db, id, b.inventoryId, now())));
  app.post('/api/inventory/use', act((id, b) => eco.usePotion(db, id, b.inventoryId, now())));
  app.post('/api/sentinel/buy', act((id, b) => eco.buySentinel(db, id, b.key, now())));
  app.post('/api/sentinel/train', act((id, b) => eco.trainSentinel(db, id, b.attr, now())));
  app.post('/api/sentinel/dismiss', act((id) => eco.dismissSentinel(db, id)));
  app.post('/api/hideout/upgrade', act((id, b) => eco.upgradeHideout(db, id, b.component, now())));
  app.post('/api/hunt/start', act((id, b) => eco.startHunt(db, id, b.portions ?? 1, now())));
  app.post('/api/hunt/collect', act((id) => eco.collectHunt(db, id, now(), rng)));
  app.post('/api/hunt/cancel', act((id) => eco.cancelHunt(db, id, now(), rng)));
  app.post('/api/work/start', act((id, b) => eco.startWork(db, id, b.hours, now())));
  app.post('/api/work/collect', act((id) => eco.collectWork(db, id, now())));
  app.post('/api/work/cancel', act((id) => eco.cancelWork(db, id, now())));
  app.post('/api/ancestral/challenge', act((id) => eco.ancestralChallenge(db, id, now(), rng)));

  // ---- notifications and the alert bar ----
  app.get('/api/notifications', (c) => { const id = me(c); return c.json({ items: notes.listNotifications(db, id, Number(c.req.query('limit') ?? 50)), unread: notes.unreadCount(db, id) }); });
  // the page asks this every few seconds: what is new since the last notification it saw, how many are unread, what needs doing
  app.get('/api/notifications/poll', (c) => {
    const id = me(c);
    return c.json(tx(db, () => { const t = now(); quests.ensureWeek(db, t); shrine.settle(db, id, t, rng); return { serverNow: t, unread: notes.unreadCount(db, id), items: notes.newerThan(db, id, Number(c.req.query('after'))), alerts: alertsFor(db, id, t) }; }));
  });
  app.post('/api/notifications/read', act((id, b) => { notes.markRead(db, id, b); return { unread: notes.unreadCount(db, id) }; }));

  // ---- weekly quests ----
  app.get('/api/quests', (c) => { const id = me(c); return c.json(tx(db, () => quests.questState(db, id, now()))); });
  app.post('/api/quests/claim', act((id, b) => quests.claim(db, id, b.quest, b.choice, now())));

  // ---- skill board: passive bonuses, 1 point per level ----
  app.get('/api/skills/board', (c) => c.json(boardForClient())); // the same for everybody
  app.get('/api/skills', (c) => { const id = me(c); return c.json(tx(db, () => skills.skillState(db, id, now()))); });
  app.post('/api/skills/allocate', act((id, b) => { skills.allocate(db, id, b.node, now()); return skills.skillState(db, id, now()); }));
  app.post('/api/skills/refund', act((id, b) => { skills.refund(db, id, b.node, now()); return skills.skillState(db, id, now()); }));
  app.post('/api/skills/respec', act((id) => { skills.respec(db, id, now()); return skills.skillState(db, id, now()); }));

  // ---- shrine: automation of hunting and work ----
  app.get('/api/shrine', (c) => { const id = me(c); return c.json(tx(db, () => { shrine.settle(db, id, now(), rng); return shrine.shrineState(db, id, now()); })); });
  app.post('/api/shrine/buy', act((id) => shrine.buyShrine(db, id, now())));
  app.post('/api/shrine/routine', act((id, b) => shrine.setRoutine(db, id, b.steps, now(), rng)));
  app.post('/api/shrine/start', act((id) => shrine.start(db, id, now(), rng)));
  app.post('/api/shrine/install', act((id, b) => shrine.installPart(db, id, b.inventoryId, now(), rng)));
  app.post('/api/shrine/remove', act((id, b) => shrine.removePart(db, id, b.kind, now(), rng)));
  app.post('/api/shrine/pause', act((id) => shrine.pause(db, id, now(), rng)));

  // ---- raid ----
  app.post('/api/raid/search', act((id) => raid.searchOpponent(db, id, now(), rng)));
  app.post('/api/raid/attack', act((id, b) => raid.attack(db, id, b.targetId, now(), rng)));

  // ---- clans ----
  app.get('/api/clans', (c) => c.json(db.prepare(
    'SELECT c.id, c.name, c.race, c.domicile_level, (SELECT COUNT(*) FROM players p WHERE p.clan_id = c.id) members FROM clans c ORDER BY members DESC').all()));
  app.post('/api/clan/create', act((id, b) => ({ id: clan.createClan(db, id, b.name, now()) })));
  app.post('/api/clan/join', act((id, b) => clan.joinClan(db, id, b.clanId, now())));
  app.post('/api/clan/leave', act((id) => clan.leaveClan(db, id, now())));
  app.post('/api/clan/kick', act((id, b) => clan.kickMember(db, id, b.playerId, now())));
  app.post('/api/clan/donate', act((id, b) => clan.donate(db, id, b.amount, now())));
  app.post('/api/clan/upgrade', act((id) => clan.upgradeDomicile(db, id, now())));
  app.post('/api/clan/war/declare', act((id, b) => ({ warId: clan.declareWar(db, id, b.clanId, now()) })));
  app.post('/api/clan/war/peace', act((id) => ({ result: clan.offerPeace(db, id, now()) })));
  app.post('/api/clan/war/ceasefire', act((id) => ({ result: clan.offerCeasefire(db, id, now()) })));
  app.post('/api/clan/war/capitulate', act((id) => clan.capitulate(db, id, now())));
  // War room: roster of enemy war members with attackability, scoreboard, and the random war attack
  app.get('/api/clan/war', (c) => {
    const id = me(c);
    return c.json(tx(db, () => {
      const t = now(); const ctx = war.warOf(db, id);
      if (!ctx) return { war: null };
      const { targets } = war.warRoster(db, id, t);
      const names = Object.fromEntries((db.prepare('SELECT id, name FROM clans WHERE id IN (?, ?)').all(ctx.myClan, ctx.enemyClan) as { id: number; name: string }[]).map((x) => [x.id, x.name]));
      const p = loadPlayer(db, id, t);
      return { war: ctx.war, myClan: { id: ctx.myClan, name: names[ctx.myClan] }, enemyClan: { id: ctx.enemyClan, name: names[ctx.enemyClan] }, targets, scoreboard: war.warScoreboard(db, ctx.war.id),
        attackReadyAt: p.last_attack_at + attackCooldownOf(p), skillBand: CFG.warSkillBand, maxHits: CFG.sameOpponentMaxWar };
    }));
  });
  app.post('/api/clan/war/attack', act((id) => war.warAttack(db, id, now(), rng)));
  app.get('/api/clan/war/:id/stats', (c) => {
    const uid = me(c), warId = Number(c.req.param('id'));
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
    const perms = Object.fromEntries((db.prepare('SELECT player_id, perms FROM clan_perms WHERE clan_id = ?').all(p.clan_id) as any[]).map((r) => [r.player_id, JSON.parse(r.perms)]));
    return c.json({ ...info, capacity: clan.clanCapacity(info), members: members.map((m: any) => ({ ...m, perms: m.id === info.leader_id ? [...clan.CLAN_PERMS] : perms[m.id] ?? [] })),
      war, enemy, upgradeCost: CFG.clanUpgradeCost(info.domicile_level), myPerms: clan.permsOf(db, id), allPerms: clan.CLAN_PERMS });
  });


  // ---- clan admin / applications / forum ----
  app.post('/api/clan/apply', act((id, b) => clan.applyToClan(db, id, b.clanId, b.message, now())));
  app.get('/api/clan/applications', (c) => { const id = me(c); return c.json(tx(db, () => clan.listApplications(db, id, now()))); });
  app.post('/api/clan/application', act((id, b) => clan.decideApplication(db, id, b.playerId, !!b.accept, now())));
  app.post('/api/clan/recruiting', act((id, b) => clan.setRecruiting(db, id, !!b.open, now())));
  app.post('/api/clan/perms', act((id, b) => clan.setPerms(db, id, b.playerId, b.perms, now())));
  app.get('/api/forum', (c) => { const id = me(c); return c.json(tx(db, () => forum.listThreads(db, id, now()))); });
  app.get('/api/forum/:id', (c) => { const id = me(c); return c.json(tx(db, () => forum.getThread(db, id, Number(c.req.param('id')), pageNumber(c.req.query('page')), now()))); });
  app.post('/api/forum/thread', act((id, b) => forum.createThread(db, id, b.title, b.body, now())));
  app.post('/api/forum/reply', act((id, b) => forum.reply(db, id, b.threadId, b.body, now())));
  app.post('/api/forum/flag', act((id, b) => forum.setFlag(db, id, b.threadId, b.flag, !!b.value, now())));
  app.post('/api/forum/delete', act((id, b) => forum.deletePost(db, id, b.postId, now())));

  // ---- accomplishments ----
  app.get('/api/accomplishments', (c) => { const id = me(c); return c.json({ status: acc.accomplishmentStatus(db, id), sets: acc.getSets(db, id), bonus: acc.accomplishmentBonus(db, id) }); });
  app.post('/api/accomplishments/save', act((id, b) => { assertFree(loadPlayer(db, id, now()), now()); acc.saveSet(db, id, b.slot, b.keys); }));
  app.post('/api/accomplishments/activate', act((id, b) => { assertFree(loadPlayer(db, id, now()), now()); acc.activateSet(db, id, b.slot); }));

  // ---- arena ----
  const arenaTick = () => tx(db, () => arena.tick(db, now(), rng));
  app.get('/api/arena', (c) => { const id = me(c); arenaTick(); return c.json({ status: arena.arenaStatus(db, id, now()), events: arena.listEvents(db, id, now()) }); });
  app.get('/api/arena/event/:id', (c) => { me(c); arenaTick(); return c.json(arena.eventDetail(db, Number(c.req.param('id')))); });
  app.get('/api/arena/match/:id', (c) => { me(c); return c.json(arena.matchLog(db, Number(c.req.param('id')))); });
  app.get('/api/arena/ranking', (c) => { me(c); return c.json(arena.ranking(db, c.req.query('kind') === 'alltime' ? 'alltime' : 'season', now())); });
  app.post('/api/arena/create', act((id, b) => arena.createEvent(db, id, b as any, now())));
  app.post('/api/arena/join', act((id, b) => arena.joinEvent(db, id, b.eventId, now())));
  app.post('/api/arena/leave', act((id, b) => arena.leaveEvent(db, id, b.eventId)));
  app.post('/api/arena/cancel', act((id, b) => arena.cancelEvent(db, id, b.eventId, now())));

  // ---- dungeon ----
  app.get('/api/dungeon', (c) => { const id = me(c); return c.json(tx(db, () => dungeon.dungeonState(db, id, now()))); });
  app.post('/api/dungeon/enter', act((id) => dungeon.enterDungeon(db, id, now())));
  app.post('/api/dungeon/fight', act((id) => dungeon.fight(db, id, now(), rng)));
  app.post('/api/dungeon/leave', act((id) => dungeon.leaveDungeon(db, id, now())));
  app.post('/api/dungeon/reward', act((id, b) => dungeon.chooseReward(db, id, Number(b.index), now())));
  app.post('/api/dungeon/sell', act((id, b) => dungeon.sellLoot(db, id, b.lootId === 'all' || b.lootId == null ? 'all' : Number(b.lootId), now())));

  // ---- Blood Temple (player market) + weapon hardening ----
  app.get('/api/temple', (c) => { const id = me(c); return c.json(tx(db, () => temple.browse(db, id, now()))); });
  app.post('/api/temple/list', act((id, b) => temple.listItem(db, id, b.inventoryId, b.price, now())));
  app.post('/api/temple/cancel', act((id, b) => temple.cancelListing(db, id, b.listingId, now())));
  app.post('/api/temple/buy', act((id, b) => temple.buyListing(db, id, b.listingId, now())));
  app.post('/api/inventory/harden', act((id, b) => eco.hardenWeapon(db, id, b.inventoryId, now())));

  // ---- mail ----
  app.get('/api/mail', (c) => { const id = me(c); const page = pageNumber(c.req.query('page')); return c.json(c.req.query('box') === 'sent' ? mail.sentbox(db, id, page) : mail.inbox(db, id, page)); });
  app.get('/api/mail/:id', (c) => { const id = me(c); return c.json(tx(db, () => mail.readMail(db, id, Number(c.req.param('id')), now()))); });
  app.post('/api/mail/send', act((id, b) => mail.sendMail(db, id, b.to, b.subject, b.body, now())));
  app.post('/api/mail/delete', act((id, b) => mail.deleteMail(db, id, b.mailId)));

  // ---- admin (single player: always; multiplayer: players with the is_admin flag, which is set by hand in the database) ----
  const adminId = (c: Context) => {
    const id = me(c);
    if (!admin.isAdmin(db, id, singlePlayer)) throw new GameError('forbidden', 'Administrators only', 403);
    return id;
  };
  const adminAct = <T>(fn: (id: number, b: Record<string, any>) => T) => async (c: Context) => {
    const id = adminId(c); const b = await body(c);
    return c.json(tx(db, () => fn(id, b)) ?? { ok: true });
  };
  /** dangerous actions need the admin's password again on a public server (a stolen login token alone must not be enough) */
  const sure = (id: number, b: Record<string, any>) => { if (!singlePlayer) auth.confirmPassword(db, id, b.password); };
  const settingsView = () => ({ singlePlayer, settings: describeSettings(db), presets: Object.entries(PRESETS).map(([key, p]) => ({ key, label: p.label, description: p.description })),
    world: admin.overview(db, now()), playerFields: admin.PLAYER_FIELDS });
  app.get('/api/admin', (c) => { adminId(c); return c.json(tx(db, settingsView)); });
  app.post('/api/admin/setting', adminAct((id, b) => { const r = setSetting(db, b.key, b.value); admin.log(db, id, 'setting', `${r.key} = ${r.value}`, now()); return r; }));
  app.post('/api/admin/setting/reset', adminAct((id, b) => { resetSetting(db, b.key); admin.log(db, id, 'setting.reset', String(b.key), now()); }));
  app.post('/api/admin/settings/reset', adminAct((id) => { resetAllSettings(db); admin.log(db, id, 'settings.reset', 'all settings back to the defaults', now()); }));
  app.post('/api/admin/preset', adminAct((id, b) => { const label = applyPreset(db, b.name); admin.log(db, id, 'preset', label, now()); return { preset: label }; }));
  app.post('/api/admin/announce', adminAct((id, b) => admin.announce(db, id, b.subject, b.body, now())));
  app.get('/api/admin/players', (c) => { adminId(c); return c.json(admin.listPlayers(db, { q: c.req.query('q'), who: c.req.query('who'), page: Math.max(1, pageNumber(c.req.query('page'))) })); });
  app.get('/api/admin/player/:id', (c) => { adminId(c); return c.json(admin.playerDetail(db, Number(c.req.param('id')))); });
  app.post('/api/admin/player', adminAct((id, b) => { if (b.field === 'is_admin') sure(id, b); admin.setPlayerField(db, id, b.id, b.field, b.value, singlePlayer, now()); }));
  app.post('/api/admin/player/give', adminAct((id, b) => admin.giveItem(db, id, b.id, b.key, now())));
  app.post('/api/admin/player/release', adminAct((id, b) => admin.release(db, id, b.id, now())));
  app.post('/api/admin/player/password', adminAct((id, b) => {
    sure(id, b); auth.adminSetPassword(db, b.id, b.newPassword);
    admin.log(db, id, 'player.password', `new password for player ${Number(b.id)}`, now());
  }));
  app.post('/api/admin/player/delete', adminAct((id, b) => { sure(id, b); admin.deletePlayer(db, id, b.id, now()); }));
  app.post('/api/admin/wipe', async (c) => {
    const id = adminId(c); const b = await body(c);
    if (b.confirm !== 'WIPE') throw new GameError('not_confirmed', 'Type WIPE to confirm', 400);
    const r = tx(db, () => { sure(id, b); return admin.wipeWorld(db, id, b.mode, now()); });
    onWipe?.();
    return c.json(r);
  });

  // ---- dev tools (testing only) ----
  if (devClock) {
    const dev = (path: string, fn: (id: number, b: Record<string, any>) => unknown) =>
      app.post(`/api/dev/${path}`, act((id, b) => fn(id, b)));
    dev('grant', (id, b) => {
      db.prepare('UPDATE players SET gold = gold + ? WHERE id = ?').run(Number(b.gold) || 0, id);
    });
    dev('level', (id, b) => {
      const lv = Math.max(1, Math.min(200, Number(b.level) || 1));
      db.prepare('UPDATE players SET level = ?, xp = 0, max_hp = ?, hp = ?, hp_at = ? WHERE id = ?')
        .run(lv, CFG.startMaxHp + (lv - 1) * CFG.levelUpMaxHp + maxHpBonus(db, id), CFG.startMaxHp + (lv - 1) * CFG.levelUpMaxHp + maxHpBonus(db, id), now(), id);
    });
    dev('blood', (id) => { db.prepare('UPDATE players SET blood = ? WHERE id = ?').run(tankSize(db, id), id); });
    dev('heal', (id) => { db.prepare('UPDATE players SET hp = max_hp, hp_at = ? WHERE id = ?').run(now(), id); });
    dev('skip', (_id, b) => { devClock.offset += Math.max(0, Number(b.minutes) || 0) * 60_000; arena.tick(db, now(), rng); return { serverNow: now() }; });
    dev('bots', (id, b) => {
      const p = db.prepare('SELECT level FROM players WHERE id = ?').get(id) as { level: number };
      return { created: seedBots(db, now(), rng, Math.min(50, Number(b.count) || 10), p.level) };
    });
    dev('arena-fill', (id) => fillArena(db, id, now(), rng));
    dev('market', () => { seedMarket(db, now(), rng); });
    dev('applicants', (id) => { seedApplicants(db, id, now(), rng); });
    dev('mail', (id) => { seedMail(db, id, now(), rng); });
    dev('enemy-clan', (id) => seedEnemyClan(db, id, now(), rng));
    dev('fill-clan', (id) => fillMyClan(db, id, now(), rng));
    dev('enemy-declare', (id) => enemyDeclaresWar(db, id, now(), rng));
    dev('heal-bots', () => healBots(db, now()));
    dev('dungeon', (id, b) => devDungeon(db, id, now(), b));
    dev('stats', (id, b) => { const n = Math.max(1, Math.min(100000, Number(b.value) || 5)); db.prepare('UPDATE players SET str = ?, def = ?, agi = ?, sta = ?, dex = ? WHERE id = ?').run(n, n, n, n, n, id); return { message: `All attributes set to ${n}` }; });
    dev('bots-report', () => botsReport(db, now()));
    dev('bots-act', () => botsActNow(db, now(), rng));
    dev('bots-add', (_id, b) => botsAdd(db, Number(b.count) || 10, now(), rng));
    dev('enemy-negotiate', (id, b) => enemyNegotiates(db, id, String(b.action), now()));
    app.get('/api/dev', (c) => c.json({ enabled: true }));
  }

  return app;
}
