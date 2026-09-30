import type { DB } from './db-core.ts';
import { CFG } from './config.ts';
import { GameError } from './errors.ts';
import { registerBot } from './game/auth.ts';
import { randInt, type Rng } from './rng.ts';

const NAMES = ['Nosferatu', 'Lilith', 'Fenrir', 'Morrigan', 'Lycan', 'Carmilla', 'Ragnar', 'Selene', 'Greyback', 'Vesper',
  'Talbot', 'Drusilla', 'Moonfang', 'Ashborn', 'Sanguine', 'Howler', 'Crimson', 'Bloodmoon', 'Dusk', 'Ironpaw'];

/** Create test opponents around a given level. Bots never act; they just get raided. */
export function seedBots(db: DB, now: number, rng: Rng, count: number, aroundLevel = 1) {
  const created: string[] = [];
  for (let i = 0; i < count; i++) {
    const name = `${NAMES[randInt(rng, 0, NAMES.length - 1)]}${randInt(rng, 10, 999)}`;
    let id: number;
    try { id = registerBot(db, name, i % 2 ? 'vampire' : 'werewolf', now); } catch { continue; }
    const level = Math.max(1, aroundLevel + randInt(rng, -3, 3));
    const base = CFG.startStat + Math.round((level - 1) * 1.5);
    const j = () => Math.max(CFG.startStat, base + randInt(rng, -2, 2));
    const maxHp = CFG.startMaxHp + (level - 1) * CFG.levelUpMaxHp;
    db.prepare('UPDATE players SET level=?, str=?, def=?, agi=?, sta=?, dex=?, max_hp=?, hp=?, gold=? WHERE id=?')
      .run(level, j(), j(), j(), j(), j(), maxHp, maxHp, randInt(rng, 50, 400) * level, id);
    created.push(name);
  }
  return created;
}

// ---------- extra helpers so a lone tester can exercise multiplayer features ----------
import { ITEMS } from './config.ts';
import { applyToClan, activeWarFor, capitulate, createClan, declareWar, joinClan, offerCeasefire, offerPeace } from './game/clan.ts';
import { joinEvent } from './game/arena.ts';
import { systemMail, sendMail } from './game/mail.ts';
import { listItem } from './game/temple.ts';

function newBot(db: DB, now: number, rng: Rng, race: 'vampire' | 'werewolf', tag: string) {
  for (let i = 0; i < 20; i++) {
    const name = `${NAMES[randInt(rng, 0, NAMES.length - 1)]}${randInt(rng, 10, 9999)}`;
    try { return { id: registerBot(db, name, race, now), name }; } catch { /* name taken, retry */ }
  }
  throw new Error('could not create bot');
}

/** Fill the tester's open arena event with bots that copy the tester's stats (so they are inside the skill band). */
export function fillArena(db: DB, playerId: number, now: number, rng: Rng) {
  const ev = db.prepare("SELECT e.* FROM arena_entries a JOIN arena_events e ON e.id = a.event_id WHERE a.player_id = ? AND e.status = 'open'").get(playerId) as any;
  if (!ev) throw new GameError('dev', 'You are not registered in an open arena event');
  const me = db.prepare('SELECT level, str, def, agi, sta, dex, max_hp FROM players WHERE id = ?').get(playerId) as any;
  let added = 0;
  while ((db.prepare('SELECT COUNT(*) n FROM arena_entries WHERE event_id = ?').get(ev.id) as { n: number }).n < ev.size) {
    const bot = newBot(db, now, rng, added % 2 ? 'vampire' : 'werewolf', 'arena');
    db.prepare('UPDATE players SET level=?, str=?, def=?, agi=?, sta=?, dex=?, max_hp=?, hp=?, gold=? WHERE id=?')
      .run(me.level, me.str, me.def, me.agi, me.sta, me.dex, me.max_hp, me.max_hp, ev.fee + 1000, bot.id);
    joinEvent(db, bot.id, ev.id, now);
    added++;
  }
  return { added };
}

/** Three bots each list an item in the Blood Temple. */
export function seedMarket(db: DB, now: number, rng: Rng) {
  const pool = ITEMS.filter((i) => i.slot === 'weapon' || i.slot === 'armor' || i.slot === 'ring').slice(0, 30);
  for (let i = 0; i < 3; i++) {
    const bot = newBot(db, now, rng, i % 2 ? 'vampire' : 'werewolf', 'market');
    const item = pool[randInt(rng, 0, pool.length - 1)];
    const inv = Number(db.prepare('INSERT INTO inventory (player_id, item_key, bought_at, hardening) VALUES (?,?,?,?)').run(bot.id, item.key, now, randInt(rng, 0, item.slot === 'weapon' ? 3 : 0)).lastInsertRowid);
    listItem(db, bot.id, inv, Math.max(1, Math.round(item.price * (0.6 + rng() * 0.8))), now);
  }
}

export function seedApplicants(db: DB, playerId: number, now: number, rng: Rng) {
  const me = db.prepare('SELECT clan_id, race FROM players WHERE id = ?').get(playerId) as { clan_id: number | null; race: 'vampire' | 'werewolf' };
  if (!me.clan_id) throw new GameError('dev', 'Join or create a clan first');
  for (let i = 0; i < 2; i++) {
    const bot = newBot(db, now, rng, me.race, 'applicant');
    db.prepare('UPDATE players SET level = 5 WHERE id = ?').run(bot.id);
    applyToClan(db, bot.id, me.clan_id, 'Hello! I would like to join your clan.', now);
  }
}

export function seedMail(db: DB, playerId: number, now: number, rng: Rng) {
  const bot = newBot(db, now, rng, 'werewolf', 'mail');
  sendMail(db, bot.id, (db.prepare('SELECT name FROM players WHERE id = ?').get(playerId) as { name: string }).name, 'A message from the enemy', 'Your days are numbered, vampire.', now);
  systemMail(db, playerId, 'Welcome, tester', 'This is a system message.', now);
}

// ---------- clan war helpers ----------
type Me = { level: number; str: number; def: number; agi: number; sta: number; dex: number; max_hp: number; race: 'vampire' | 'werewolf'; clan_id: number | null };
const loadMe = (db: DB, id: number) => db.prepare('SELECT level, str, def, agi, sta, dex, max_hp, race, clan_id FROM players WHERE id = ?').get(id) as Me;

/** Give a bot roughly the tester's strength (+-10 %) so raids against it are meaningful. */
function likeMe(db: DB, botId: number, me: Me, rng: Rng, spread = 0.1) {
  const j = (v: number) => Math.max(CFG.startStat, Math.round(v * (1 - spread + rng() * spread * 2)));
  db.prepare('UPDATE players SET level=?, str=?, def=?, agi=?, sta=?, dex=?, max_hp=?, hp=?, hp_at=?, gold=? WHERE id=?')
    .run(Math.max(5, me.level), j(me.str), j(me.def), j(me.agi), j(me.sta), j(me.dex), me.max_hp, me.max_hp, Date.now(), randInt(rng, 100, 600) * Math.max(1, me.level), botId);
}

const CLAN_A = ['Shadow', 'Crimson', 'Iron', 'Night', 'Blood', 'Ash', 'Grim', 'Frost'], CLAN_B = ['Pack', 'Court', 'Covenant', 'Legion', 'Brood', 'Hunt', 'Order', 'Fangs'];
function botClan(db: DB, me: Me, race: 'vampire' | 'werewolf', now: number, rng: Rng, members: number) {
  const leader = newBot(db, now, rng, race, 'clan');
  likeMe(db, leader.id, me, rng);
  let clanId = 0, name = '';
  for (let i = 0; i < 30 && !clanId; i++) {
    name = `${CLAN_A[randInt(rng, 0, CLAN_A.length - 1)]} ${CLAN_B[randInt(rng, 0, CLAN_B.length - 1)]} ${randInt(rng, 2, 99)}`;
    try { clanId = createClan(db, leader.id, name, now); } catch { /* name taken */ }
  }
  if (!clanId) throw new GameError('dev', 'Could not create a bot clan');
  for (let i = 1; i < members; i++) { const b = newBot(db, now, rng, race, 'clan'); likeMe(db, b.id, me, rng); joinClan(db, b.id, clanId, now); }
  return { clanId, name, leaderId: leader.id };
}

/** An enemy-race clan with `members` bots (default 6, enough to satisfy the 5-member war rule). */
export function seedEnemyClan(db: DB, playerId: number, now: number, rng: Rng, members = 6) {
  const me = loadMe(db, playerId);
  const c = botClan(db, me, me.race === 'vampire' ? 'werewolf' : 'vampire', now, rng, members);
  return { message: `Enemy clan "${c.name}" created with ${members} bots. Declare war on it from the Clan page.`, clan: c.name };
}

/** Bring the tester's own clan up to `target` members with same-race bots (the leader needs 5 to declare war). */
export function fillMyClan(db: DB, playerId: number, now: number, rng: Rng, target = 5) {
  const me = loadMe(db, playerId);
  if (!me.clan_id) throw new GameError('dev', 'Create or join a clan first');
  let added = 0;
  while ((db.prepare('SELECT COUNT(*) n FROM players WHERE clan_id = ?').get(me.clan_id) as { n: number }).n < target) {
    const b = newBot(db, now, rng, me.race, 'ally');
    likeMe(db, b.id, me, rng);
    joinClan(db, b.id, me.clan_id, now);
    added++;
  }
  return { message: added ? `Added ${added} bot member(s) to your clan` : `Your clan already has ${target}+ members` };
}

/** A new enemy bot clan declares war on the tester's clan (to test being the defender). */
export function enemyDeclaresWar(db: DB, playerId: number, now: number, rng: Rng) {
  const me = loadMe(db, playerId);
  if (!me.clan_id) throw new GameError('dev', 'Create or join a clan first');
  if (activeWarFor(db, me.clan_id)) throw new GameError('dev', 'Your clan is already at war');
  const c = botClan(db, me, me.race === 'vampire' ? 'werewolf' : 'vampire', now, rng, 6);
  declareWar(db, c.leaderId, me.clan_id, now);
  return { message: `"${c.name}" declared war on your clan!` };
}

/** The enemy leader makes or accepts a negotiation move: peace | ceasefire | capitulate. */
export function enemyNegotiates(db: DB, playerId: number, action: string, now: number) {
  const me = loadMe(db, playerId);
  const war = me.clan_id ? activeWarFor(db, me.clan_id) : undefined;
  if (!war) throw new GameError('dev', 'Your clan is not at war');
  const enemyClan = db.prepare('SELECT id, name, leader_id FROM clans WHERE id = ?').get(war.aggressor_id === me.clan_id ? war.defender_id : war.aggressor_id) as { id: number; name: string; leader_id: number };
  const isBot = (db.prepare('SELECT is_bot FROM players WHERE id = ?').get(enemyClan.leader_id) as { is_bot: number }).is_bot === 1;
  if (!isBot) throw new GameError('dev', 'The enemy clan is led by a real player, not a bot');
  if (action === 'peace') return { message: `${enemyClan.name}: ${offerPeace(db, enemyClan.leader_id, now) === 'peace' ? 'peace agreed, the war is over' : 'they offer peace: accept it from your Clan page'}` };
  if (action === 'ceasefire') return { message: `${enemyClan.name}: ${offerCeasefire(db, enemyClan.leader_id, now) === 'ceasefire' ? 'ceasefire agreed' : 'they offer a ceasefire: accept it from your Clan page'}` };
  if (action === 'capitulate') { capitulate(db, enemyClan.leader_id, now); return { message: `${enemyClan.name} capitulated. Victory!` }; }
  throw new GameError('dev', 'Unknown action');
}

/** Fully heal every bot, so war/raid targets are not stuck at low HP while testing. */
export function healBots(db: DB, now: number) {
  const r = db.prepare('UPDATE players SET hp = max_hp, hp_at = ?, work_until = NULL, hunt_until = NULL WHERE is_bot = 1').run(now);
  return { message: `Healed ${r.changes} bots` };
}

// ---------- automated bots: test tools ----------
import { botReport, ensureBots, tickBots } from './bots/runner.ts';

export function botsReport(db: DB, now: number) {
  const r = botReport(db, now);
  return { message: `${r.bots} bots · median Lv ${r.level.median} (max ${r.level.max}) · ${r.clans.total} clans (${r.clans.inClan} members) · ${r.wars.active} active wars · ${r.battles.last24h} battles/24h · ${r.arena.open} open arena events · market: ${r.market.open} offers, ${r.market.sold} sold · dungeon: ${r.dungeon.delvers} delvers, deepest ${r.dungeon.deepest} · ${r.busy.working} working, ${r.busy.hunting} hunting`, report: r };
}

/** Let every bot play a session right now. */
export function botsActNow(db: DB, now: number, rng: Rng) {
  db.prepare('UPDATE bots SET next_at = ?').run(now);
  const r = tickBots(db, now, rng, {}, 500);
  return { message: `${r.ran} bots played a session${r.errors ? `, ${r.errors} errors` : ''}` };
}

export function botsAdd(db: DB, n: number, now: number, rng: Rng) {
  const have = (db.prepare('SELECT COUNT(*) n FROM bots').get() as { n: number }).n;
  const made = ensureBots(db, have + Math.max(1, Math.min(200, n)), now, rng);
  return { message: `Added ${made} bots (${have + made} total)` };
}

import { dungeonState } from './game/dungeon.ts';

/** Test tool: set this week's dungeon depth and/or clear the re-entry cooldown (and end a running dungeon session). */
export function devDungeon(db: DB, playerId: number, now: number, o: { depth?: number; clearCooldown?: boolean; leave?: boolean }) {
  dungeonState(db, playerId, now); // makes sure the row exists and the week is current
  if (o.depth != null) db.prepare('UPDATE dungeon SET depth = ?, reached_at = ?, best_ever = MAX(best_ever, ?) WHERE player_id = ?').run(Math.max(1, Math.floor(o.depth)), now, Math.max(0, Math.floor(o.depth) - 1), playerId);
  if (o.leave) { db.prepare('UPDATE dungeon SET active = 0 WHERE player_id = ?').run(playerId); db.prepare('UPDATE players SET dungeon_until = NULL WHERE id = ?').run(playerId); }
  if (o.clearCooldown) db.prepare('UPDATE dungeon SET cooldown_until = 0 WHERE player_id = ?').run(playerId);
  return { message: `Dungeon${o.depth != null ? `: next level is now ${o.depth}` : ''}${o.clearCooldown ? ', cooldown cleared' : ''}${o.leave ? ', session ended' : ''}` };
}
