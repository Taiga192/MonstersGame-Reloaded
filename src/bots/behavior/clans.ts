import type { DB } from '../../db/core.ts';
import { CFG, HOUR } from '../../core/config.ts';
import { randInt } from '../../core/rng.ts';
import * as clan from '../../game/social/clan.ts';
import * as forum from '../../game/social/forum.ts';
import { loadPlayer, type Player } from '../../game/character/player.ts';
import { clanName } from '../names.ts';
import { type Persona } from '../personas.ts';
import { attempt, ok, type Ctx } from '../context.ts';

export function clanNames(db: DB) {
  return new Set((db.prepare('SELECT name FROM clans').all() as { name: string }[]).map((c) => c.name.toLowerCase()));
}

export const WELCOME = [
  'Welcome to the clan! Be active, hit the enemy race and donate a little when you can.',
  'New recruits: introduce yourselves here. Raid targets and war plans go in this section.',
  "Rules: no idling, no leaving mid-war, respect each other. Let's climb the highscore!",
];
export const WAR_TALK = [
  'War is on. Everybody attack from the war room whenever your cooldown is ready!',
  'They declared war on us. Show them what we are made of. Attack every time your cooldown is ready.',
  'We took the fight to them. Keep hitting, every point counts.',
];

export function social(ctx: Ctx, id: number, persona: Persona, note: (a: string) => void) {
  const { db, now, rng } = ctx;
  const p = loadPlayer(db, id, now);
  if (p.level < CFG.clanMinLevel) return;

  if (!p.clan_id) {
    if (persona.social >= 0.7 && rng() < 0.4) {
      const cid = attempt(() => clan.createClan(db, id, clanName(rng, clanNames(db)), now));
      if (cid) {
        note('founded clan');
        if (rng() < 0.3) attempt(() => clan.setRecruiting(db, id, false, now));
        attempt(() => forum.createThread(db, id, 'Welcome', WELCOME[randInt(rng, 0, WELCOME.length - 1)], now));
      }
    } else if (rng() < 0.5) seekClan(ctx, p, note);
    return;
  }

  const c = db.prepare('SELECT * FROM clans WHERE id = ?').get(p.clan_id) as
    { id: number; leader_id: number; treasury: number; domicile_level: number; is_open: number } | undefined;
  if (!c) return;
  // donate only while the clan still needs money for its next domicile level (a treasury nobody can use is a gold black hole)
  const upkeep = CFG.clanUpgradeCost(c.domicile_level);
  if (p.gold > 1500 && c.treasury < upkeep && rng() < 0.15) {
    const amt = Math.min(Math.floor(p.gold * 0.1), upkeep - c.treasury);
    if (amt > 0 && ok(() => clan.donate(db, id, amt, now))) note(`donate ${amt}`);
  }
  if (c.leader_id !== id) return;
  leaderDuties(ctx, id, p, c, persona, note);
}

export function seekClan(ctx: Ctx, p: Player, note: (a: string) => void) {
  const { db, now, rng } = ctx;
  const rows = db
    .prepare(
      `SELECT c.id, c.is_open, c.domicile_level, (SELECT COUNT(*) FROM players m WHERE m.clan_id = c.id) AS members
       FROM clans c WHERE c.race = ?`,
    )
    .all(p.race) as { id: number; is_open: number; domicile_level: number; members: number }[];
  const options = rows.filter((c) => c.members < CFG.clanBaseSlots + c.domicile_level * CFG.clanSlotsPerLevel && !clan.activeWarFor(db, c.id));
  if (!options.length) return;
  // clans with a few members attract more: weight by members + 1
  let x = rng() * options.reduce((s, c) => s + c.members + 1, 0),
    chosen = options[0];
  for (const c of options) {
    x -= c.members + 1;
    if (x < 0) {
      chosen = c;
      break;
    }
  }
  const done = chosen.is_open
    ? ok(() => clan.joinClan(db, p.id, chosen.id, now))
    : ok(() => clan.applyToClan(db, p.id, chosen.id, 'Active player, looking for a clan!', now));
  if (done) note(chosen.is_open ? 'joined clan' : 'applied to clan');
}

export function leaderDuties(
  ctx: Ctx,
  id: number,
  p: Player,
  c: { id: number; treasury: number; domicile_level: number },
  persona: Persona,
  note: (a: string) => void,
) {
  const { db, now, rng } = ctx;
  // applications: accept most
  for (const a of (attempt(() => clan.listApplications(db, id, now)) ?? []) as { player_id: number }[]) {
    if (ok(() => clan.decideApplication(db, id, a.player_id, rng() < 0.9, now))) note('reviewed application');
  }
  const members = (db.prepare('SELECT COUNT(*) n FROM players WHERE clan_id = ?').get(c.id) as { n: number }).n;
  const cap = CFG.clanBaseSlots + c.domicile_level * CFG.clanSlotsPerLevel;
  // recruiting: pull a clanless bot of the same race in (an "invite" that was accepted)
  if (members < cap && rng() < 0.3 && !clan.activeWarFor(db, c.id)) {
    // candidates in a stable order, picked with the seeded generator (SQL RANDOM() would break reproducibility)
    const pool = db
      .prepare(`SELECT id FROM players WHERE is_bot = 1 AND clan_id IS NULL AND race = ? AND level >= ? AND id != ? ORDER BY id LIMIT 40`)
      .all(p.race, CFG.clanMinLevel, id) as { id: number }[];
    const cand = pool.length ? pool[randInt(rng, 0, pool.length - 1)] : undefined;
    if (cand) {
      const open = (db.prepare('SELECT is_open FROM clans WHERE id = ?').get(c.id) as { is_open: number }).is_open;
      const done = open
        ? ok(() => clan.joinClan(db, cand.id, c.id, now))
        : ok(() => {
            clan.applyToClan(db, cand.id, c.id, 'Invited by the leader', now);
            clan.decideApplication(db, id, cand.id, true, now);
          });
      if (done) note('recruited a member');
    }
  }
  // a bigger domicile when the treasury allows it and we are nearly full
  if (members >= cap - 2 && c.treasury >= CFG.clanUpgradeCost(c.domicile_level) && ok(() => clan.upgradeDomicile(db, id, now))) note('domicile upgrade');

  const war = clan.activeWarFor(db, c.id);
  if (!war) {
    if (members >= CFG.warMinAttackers && persona.raid > 0.3 && rng() < 0.004) {
      const all = db
        .prepare(`SELECT c2.id FROM clans c2 WHERE c2.race != ? AND (SELECT COUNT(*) FROM players m WHERE m.clan_id = c2.id) >= ? ORDER BY c2.id`)
        .all(p.race, CFG.warMinAttackers) as { id: number }[];
      const targets = all
        .map((t) => ({ t, k: rng() }))
        .sort((a, b) => a.k - b.k)
        .slice(0, 8)
        .map((x) => x.t); // seeded shuffle
      for (const t of targets) {
        if (clan.activeWarFor(db, t.id)) continue;
        if (attempt(() => clan.declareWar(db, id, t.id, now)) !== undefined) {
          note('declared war');
          attempt(() => forum.createThread(db, id, 'WAR', WAR_TALK[randInt(rng, 0, WAR_TALK.length - 1)], now));
          break;
        }
      }
    }
    return;
  }
  // negotiating: accept a pending offer from the other side, or offer peace once the war has dragged on
  const age = now - war.started_at;
  if (war.peace_offer_by && war.peace_offer_by !== c.id && rng() < 0.6) {
    if (attempt(() => clan.offerPeace(db, id, now)) !== undefined) note('accepted peace');
    return;
  }
  if (age > 36 * HOUR && rng() < 0.15 && attempt(() => clan.offerPeace(db, id, now)) !== undefined) note('offered peace');
}
