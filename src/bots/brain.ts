/**
 * The bot "brain": one call = one play session. Bots use the very same game services as players, so they can never
 * do anything a human could not (no cheating, no rule drift). Invalid attempts are just refused by the rules (GameError).
 * What a bot does in each area lives in behavior/*.ts; shared helpers and types in context.ts.
 */
import { MIN } from '../core/config.ts';
import { randInt } from '../core/rng.ts';
import * as shrine from '../game/world/shrine.ts';
import * as questsApi from '../game/world/quests.ts';
import * as eco from '../game/world/economy.ts';
import { isBusy, isHunting, isWorking, loadPlayer, isInDungeon } from '../game/character/player.ts';
import { PERSONAS } from './personas.ts';
import { attempt, huntLeft, isNight, ok, type BotRow, type Ctx, type SessionResult } from './context.ts';
import { shrineAway } from './behavior/shrine.ts';
import { maintain } from './behavior/shopping.ts';
import { longActivity, raid } from './behavior/activities.ts';
import { social } from './behavior/clans.ts';
import { arenaTurn } from './behavior/arena.ts';
import { dungeonContinue, dungeonTurn } from './behavior/dungeon.ts';
export type { Ctx, BotRow, SessionResult } from './context.ts';

export function runSession(ctx: Ctx, bot: BotRow): SessionResult {
  const { db, now, rng } = ctx;
  const persona = PERSONAS[bot.persona] ?? PERSONAS.balanced;
  const id = bot.player_id;
  const actions: string[] = [];
  const note = (a: string) => actions.push(a);

  questsApi.ensureWeek(db, now); // a new quest week starts before anything counts in it

  // 1) collect anything that finished while the bot was away
  let p = loadPlayer(db, id, now);
  if (p.hunt_started && !isHunting(p, now)) {
    const r = attempt(() => eco.collectHunt(db, id, now, rng));
    if (r) note(`hunt +${r.xp}xp +${r.gold}g`);
  }
  if (p.work_started && !isWorking(p, now)) {
    const r = attempt(() => eco.collectWork(db, id, now));
    if (r) note(`work +${r.wages}g`);
  }
  shrine.settle(db, id, now, rng); // what the shrine did while the bot was away
  shrine.pause(db, id, now, rng); // now the bot plays by hand
  p = loadPlayer(db, id, now);
  if (isInDungeon(p, now)) {
    // a run in progress: one fight whenever the wait between fights is over; nothing else is possible while inside
    const next = dungeonContinue(ctx, id, note);
    if (next != null) return { nextAt: next, sessionsLeft: bot.sessions_left, actions };
    p = loadPlayer(db, id, now);
  }
  if (isBusy(p, now)) return { nextAt: Math.max(p.hunt_until ?? 0, p.work_until ?? 0) + randInt(rng, 1, 8) * MIN, sessionsLeft: bot.sessions_left, actions };

  // 2) maintenance and spending, then social life
  maintain(ctx, id, persona, note);
  social(ctx, id, persona, note);
  arenaTurn(ctx, id, persona, note);
  const inside = isNight(now, bot.tz) ? null : dungeonTurn(ctx, id, persona, note); // (nobody starts a dungeon run at 3 am: the bots sleep)
  if (inside != null) return { nextAt: inside, sessionsLeft: bot.sessions_left, actions }; // entered the dungeon: stays there until the run ends

  // 3) the main activity of this session
  let sessionsLeft = bot.sessions_left - 1;
  raid(ctx, id, persona, note);
  p = loadPlayer(db, id, now);
  const goAway = sessionsLeft <= 0 || (isNight(now, bot.tz) && rng() < 0.7);
  let started = false,
    shrineAwayFor = 0;
  if (!isBusy(p, now)) {
    if (goAway && shrineAway(ctx, id, persona, note)) {
      shrineAwayFor = randInt(rng, 240, 600);
      started = true;
    } else if (goAway) started = longActivity(ctx, p, persona, isNight(now, bot.tz), note);
    else if (persona.hunt > 0.5 && huntLeft(p, now) >= 30 * MIN && rng() < persona.hunt * 0.45)
      started = ok(() => eco.startHunt(db, id, randInt(rng, 2, 4), now)) && (note('short hunt'), true);
  }
  if (goAway) sessionsLeft = randInt(rng, persona.sessions[0], persona.sessions[1]);

  // 4) schedule the next session
  p = loadPlayer(db, id, now);
  let nextAt: number;
  if (shrineAwayFor)
    nextAt = now + shrineAwayFor * MIN * persona.tempo; // the shrine works, the bot is away
  else if (isBusy(p, now)) nextAt = Math.max(p.hunt_until ?? 0, p.work_until ?? 0) + randInt(rng, 1, 8) * MIN;
  else if (goAway && !started)
    nextAt = now + (isNight(now, bot.tz) ? randInt(rng, 300, 540) : randInt(rng, 60, 240)) * MIN * persona.tempo; // logged out: sleeping at night, otherwise a few hours
  else nextAt = now + randInt(rng, 16, 40) * MIN * persona.tempo;
  return { nextAt, sessionsLeft, actions };
}
