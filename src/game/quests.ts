/**
 * Weekly quests for one character. The week's set comes from src/quests.ts (the same for everybody); here: the snapshot of the
 * counters at the start of the week (progress = counter now - counter then), the target a character got for its level, and claiming.
 * A week starts on Monday 00:00 UTC (like the dungeon week); whatever was not claimed is gone with it.
 */
import { CFG } from '../config.ts';
import type { DB } from '../db-core.ts';
import { assert } from '../errors.ts';
import { QUEST_BY_ID, rewardsFor, targetFor, textFor, weeklySet, type Quest, type RewardOptions } from '../quests.ts';
import { tankSize } from './blood.ts';
import { weekOf } from './dungeon.ts';
import { notify } from './notify.ts';
import { awardXp, loadPlayer } from './player.ts';

const meta = (db: DB, k: string) => (db.prepare('SELECT value FROM meta WHERE key = ?').get(k) as { value: string } | undefined)?.value;
const setMeta = (db: DB, k: string, v: string) => db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(k, v);

/** Start a new quest week when the old one is over: snapshot every counter, forget old claims, tell the humans. Cheap when nothing changed. */
export function ensureWeek(db: DB, now: number) {
  const week = weekOf(now), cur = meta(db, 'quest_week');
  if (cur === String(week)) return;
  db.prepare('DELETE FROM quest_base').run(); db.prepare('DELETE FROM quest_state').run();
  db.prepare('INSERT INTO quest_base (player_id, key, value) SELECT player_id, key, value FROM counters').run();
  if (!meta(db, 'quest_seed')) setMeta(db, 'quest_seed', String((Math.floor(now / 1000) * 2654435761) >>> 0)); // fixed for the life of this world
  setMeta(db, 'quest_week', String(week));
  if (cur !== undefined) db.prepare("INSERT INTO notifications (player_id, kind, title, body, link, at) SELECT id, 'quests', 'New weekly quests', 'A fresh set of quests is waiting. Pick your rewards, they grow with your level.', '#/quests', ? FROM players WHERE is_bot = 0").run(now);
}

export function weekQuests(db: DB, now: number): Quest[] {
  ensureWeek(db, now);
  return weeklySet(weekOf(now), Number(meta(db, 'quest_seed') ?? 0));
}

const counterNow = (db: DB, id: number, key: string) => ((db.prepare('SELECT value FROM counters WHERE player_id = ? AND key = ?').get(id, key) as { value: number } | undefined)?.value ?? 0);
const counterThen = (db: DB, id: number, key: string) => ((db.prepare('SELECT value FROM quest_base WHERE player_id = ? AND key = ?').get(id, key) as { value: number } | undefined)?.value ?? 0);

export interface QuestView {
  id: string; title: string; text: string; tier: string; category: string; minLevel: number; locked: boolean;
  target: number; progress: number; done: boolean; claimed: string | null; rewards: RewardOptions;
}

/** The week's quests with this character's progress. Targets are fixed when the character first looks at the week. */
export function questState(db: DB, id: number, now: number) {
  const quests = weekQuests(db, now), p = loadPlayer(db, id, now);
  const rows = new Map((db.prepare('SELECT quest_id, target, reward FROM quest_state WHERE player_id = ?').all(id) as { quest_id: string; target: number; reward: string | null }[]).map((r) => [r.quest_id, r]));
  const out: QuestView[] = quests.map((q) => {
    let row = rows.get(q.id);
    if (!row) {
      const target = targetFor(q, p.level);
      db.prepare('INSERT INTO quest_state (player_id, quest_id, target) VALUES (?,?,?)').run(id, q.id, target);
      row = { quest_id: q.id, target, reward: null };
    }
    const progress = Math.max(0, counterNow(db, id, q.counter) - counterThen(db, id, q.counter));
    return {
      id: q.id, title: q.title, text: textFor(q, row.target), tier: q.tier, category: q.category, minLevel: q.minLevel, locked: p.level < q.minLevel,
      target: row.target, progress: Math.min(progress, row.target), done: progress >= row.target, claimed: row.reward, rewards: rewardsFor(q, p.level, CFG.xpToNext(p.level)),
    };
  });
  const week = weekOf(now);
  return { week, endsAt: week * 7 * 24 * 3600_000 + 7 * 24 * 3600_000 + 4 * 24 * 3600_000, quests: out, claimed: out.filter((q) => q.claimed).length, ready: out.filter((q) => q.done && !q.claimed && !q.locked).length };
}

/** How many finished quests are waiting to be claimed (for the alert bar). */
export const readyCount = (db: DB, id: number, now: number) => questState(db, id, now).ready;

/** Claim a finished quest: `choice` is "gold", "xp" or "special". The rewards are worked out from the level the character has NOW. */
export function claim(db: DB, id: number, questId: unknown, choice: unknown, now: number) {
  assert(typeof questId === 'string' && QUEST_BY_ID.has(questId), 'bad_quest', 'There is no such quest');
  assert(choice === 'gold' || choice === 'xp' || choice === 'special', 'bad_choice', 'Choose gold, xp or the special reward');
  const st = questState(db, id, now);
  const q = st.quests.find((x) => x.id === questId);
  assert(q, 'not_this_week', 'That quest is not offered this week', 404);
  assert(!q.locked, 'locked', `This quest unlocks at level ${q.minLevel}`);
  assert(!q.claimed, 'claimed', 'You already took the reward for this quest');
  assert(q.done, 'not_done', `Not finished yet: ${q.progress} of ${q.target}`);
  const r = q.rewards;
  let text: string;
  if (choice === 'gold') { db.prepare('UPDATE players SET gold = gold + ? WHERE id = ?').run(r.gold, id); text = `${r.gold} gold`; }
  else if (choice === 'xp') { const g = awardXp(db, id, r.xp, now); text = `${g.xpGained} XP${g.levelsGained ? ' (level up!)' : ''}`; }
  else {
    const s = r.special;
    if (s.kind === 'blood') db.prepare('UPDATE players SET blood = MIN(?, blood + ?) WHERE id = ?').run(tankSize(db, id), s.amount, id);
    else if (s.kind === 'potions') for (let i = 0; i < s.amount; i++) db.prepare('INSERT INTO inventory (player_id, item_key, bought_at) VALUES (?, ?, ?)').run(id, 'potion_heal', now);
    else db.prepare("INSERT INTO dungeon_loot (player_id, name, value, depth, milestone, found_at) VALUES (?, 'Reward relic', ?, 1, 0, ?)").run(id, s.amount, now);
    text = s.label;
  }
  db.prepare('UPDATE quest_state SET reward = ? WHERE player_id = ? AND quest_id = ?').run(choice, id, questId);
  return { quest: q.title, choice, text };
}
