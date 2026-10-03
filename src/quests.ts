/**
 * Weekly quests (NOT in the original game). A pool of 105 quests (35 families x 3 difficulties); every week 10 of them are drawn,
 * the same for everybody, by a random draw that only depends on the week number and the world's seed, so the set changes every Monday
 * and a server restart does not change it. Progress comes from the lifetime counters (see game/counters.ts): what a counter gained
 * since the start of the week. This file is pure data and rules; the database part is game/quests.ts.
 */
import { CFG } from './config.ts';
import { seeded, type Rng } from './rng.ts';

export type Tier = 'easy' | 'normal' | 'hard';
export const TIERS: Tier[] = ['easy', 'normal', 'hard'];
export type SpecialReward = 'blood' | 'potions' | 'loot';

export interface Family {
  key: string; counter: string; category: string; minLevel: number;
  /** quests that may be impossible for a while (no clan war running, nobody bites your link ...): at most 3 per week */
  conditional?: boolean;
  special: SpecialReward;
  titles: [string, string, string];
  text: (n: number) => string;
  /** how much it takes, for a character of this level (tier 0 easy, 1 normal, 2 hard) */
  target: (level: number, tier: number) => number;
}
export interface Quest { id: string; family: string; tier: Tier; title: string; category: string; counter: string; minLevel: number; special: SpecialReward; conditional: boolean }

const fixed = (a: [number, number, number]) => (_l: number, t: number) => a[t];
const per = (f: [number, number, number], base: (l: number) => number) => (l: number, t: number) => Math.max(1, Math.round(f[t] * base(l)));
const f = (n: number) => n.toLocaleString('en-US');

export const FAMILIES: Family[] = [
  // ---- hunting
  { key: 'hunt_portions', counter: 'hunt_portions', category: 'hunt', minLevel: 1, special: 'blood', titles: ['Night Prowler', 'Relentless Hunter', 'Apex of the Dark'], text: (n) => `Complete ${n} hunting portions`, target: fixed([12, 36, 90]) },
  { key: 'large_towns', counter: 'large_towns', category: 'hunt', minLevel: 1, special: 'blood', titles: ['Smoke on the Horizon', 'Burn the Big Ones', 'City Scourge'], text: (n) => `Hit ${n} large towns while hunting`, target: fixed([2, 5, 12]) },
  { key: 'hunt_gold', counter: 'hunt_gold', category: 'hunt', minLevel: 1, special: 'blood', titles: ['Pillaged Pockets', 'Fat Purses', 'The Great Plunder'], text: (n) => `Plunder ${f(n)} gold while hunting`, target: per([0.08, 0.25, 0.5], (l) => 2520 * (1 + l / 10)) },
  // ---- graveyard
  { key: 'work_hours', counter: 'work_hours', category: 'work', minLevel: 1, special: 'blood', titles: ['A Few Graves', "Gravedigger's Week", 'Gravekeeper of the Night'], text: (n) => `Work ${n} hours in the graveyard`, target: fixed([6, 20, 48]) },
  { key: 'work_gold', counter: 'work_gold', category: 'work', minLevel: 1, special: 'blood', titles: ['Honest Wages', 'Full Pockets from Dirt', 'Grave Fortune'], text: (n) => `Earn ${f(n)} gold from graveyard work`, target: per([0.08, 0.25, 0.5], (l) => 147 * (5 + 2 * l)) },
  // ---- raids
  { key: 'raids', counter: 'raids', category: 'pvp', minLevel: 1, special: 'potions', titles: ['First Blood', 'Restless Claws', 'Bringer of Fear'], text: (n) => `Attack other players ${n} times`, target: fixed([3, 8, 20]) },
  { key: 'raids_won', counter: 'raids_won', category: 'pvp', minLevel: 1, special: 'potions', titles: ['Winning Streak', 'Victory Against the Odds', 'Unbeaten Predator'], text: (n) => `Win ${n} raids`, target: fixed([2, 6, 15]) },
  { key: 'gold_stolen', counter: 'gold_stolen', category: 'pvp', minLevel: 1, special: 'potions', titles: ['Light Fingers', "Bandit's Haul", 'Master Thief'], text: (n) => `Steal ${f(n)} gold in raids`, target: per([5, 20, 60], (l) => l + 5) },
  { key: 'defenses_won', counter: 'defenses_won', category: 'pvp', minLevel: 1, conditional: true, special: 'potions', titles: ['Hold the Door', 'Fortress Mind', 'They Shall Not Pass'], text: (n) => `Fight off ${n} raids against you`, target: fixed([1, 4, 10]) },
  // ---- clan wars
  { key: 'war_attacks', counter: 'war_attacks', category: 'war', minLevel: 3, conditional: true, special: 'potions', titles: ['Into the Fray', 'War Dog', 'Scourge of the Enemy Clan'], text: (n) => `Make ${n} attacks in a clan war`, target: fixed([2, 6, 14]) },
  { key: 'war_wins', counter: 'war_wins', category: 'war', minLevel: 3, conditional: true, special: 'potions', titles: ['Skirmish Victor', 'Battle Hardened', "Warlord's Pride"], text: (n) => `Win ${n} battles in a clan war`, target: fixed([1, 4, 10]) },
  // ---- dungeon
  { key: 'dungeon_levels', counter: 'dungeon_levels', category: 'dungeon', minLevel: 3, special: 'loot', titles: ['Down the Stairs', 'Deeper and Deeper', 'Edge of the Abyss'], text: (n) => `Clear ${n} dungeon levels`, target: fixed([3, 10, 25]) },
  { key: 'dungeon_runs', counter: 'dungeon_runs', category: 'dungeon', minLevel: 3, special: 'loot', titles: ['Torch in Hand', 'Daily Descent', 'A Week in the Dark'], text: (n) => `Go on ${n} dungeon runs`, target: fixed([1, 3, 5]) },
  { key: 'dungeon_guardians', counter: 'dungeon_guardians', category: 'dungeon', minLevel: 10, special: 'loot', titles: ['Door Warden Down', 'Guardian Hunter', 'Keystone Breaker'], text: (n) => `Defeat ${n} dungeon guardians`, target: fixed([1, 2, 4]) },
  { key: 'dungeon_gold', counter: 'dungeon_gold', category: 'dungeon', minLevel: 3, special: 'loot', titles: ['Relics for Sale', "Dealer's Favourite", 'Treasure Baron'], text: (n) => `Earn ${f(n)} gold selling dungeon loot`, target: per([3, 10, 25], (l) => l + 10) },
  // ---- arena and ancestral site
  { key: 'arena_wins', counter: 'arena_wins', category: 'arena', minLevel: 5, conditional: true, special: 'potions', titles: ['Crowd Pleaser', 'Arena Regular', 'Champion of the Pit'], text: (n) => `Win ${n} arena matches`, target: fixed([1, 3, 6]) },
  { key: 'arena_joined', counter: 'arena_joined', category: 'arena', minLevel: 5, conditional: true, special: 'potions', titles: ['Step into the Sand', 'Many Fights', 'Blood Sport'], text: (n) => `Take part in ${n} arena events`, target: fixed([1, 3, 6]) },
  { key: 'ancestral_wins', counter: 'ancestral_wins', category: 'ancestral', minLevel: 20, special: 'loot', titles: ['Whisper of Ancestors', 'Chosen Descendant', 'Voice of the Old Blood'], text: (n) => `Win ${n} challenges at the Ancestral Site`, target: fixed([1, 3, 5]) },
  // ---- shop, market, training
  { key: 'items_bought', counter: 'items_bought', category: 'economy', minLevel: 1, special: 'blood', titles: ['Shopping Trip', 'Armed to the Teeth', 'Tailor-Made'], text: (n) => `Buy ${n} items in the shop`, target: fixed([1, 3, 6]) },
  { key: 'items_sold', counter: 'items_sold', category: 'economy', minLevel: 1, special: 'blood', titles: ['Clear the Bag', 'Spring Cleaning', 'Pawn Shop'], text: (n) => `Sell ${n} items to the shop`, target: fixed([1, 3, 6]) },
  { key: 'temple_sales', counter: 'temple_sales', category: 'economy', minLevel: 3, special: 'loot', titles: ['Selling the Spare', 'Merchant of Blood', 'Market Baron'], text: (n) => `Sell ${n} items in the Blood Temple`, target: fixed([1, 3, 6]) },
  { key: 'temple_buys', counter: 'temple_buys', category: 'economy', minLevel: 3, special: 'loot', titles: ['Bargain Hunter', 'Shrewd Buyer', 'Collector'], text: (n) => `Buy ${n} items in the Blood Temple`, target: fixed([1, 2, 4]) },
  { key: 'train_points', counter: 'train_points', category: 'progress', minLevel: 1, special: 'blood', titles: ['Warm-Up', 'Sweat and Blood', 'Iron Discipline'], text: (n) => `Train your attributes ${n} times`, target: fixed([3, 10, 25]) },
  { key: 'hardenings', counter: 'hardenings', category: 'economy', minLevel: 5, special: 'loot', titles: ['Tempering', "Smith's Apprentice", 'Forge Fanatic'], text: (n) => `Harden weapons ${n} times`, target: fixed([1, 3, 6]) },
  { key: 'potions_used', counter: 'potions_used', category: 'economy', minLevel: 1, special: 'blood', titles: ['A Sip of Courage', "Alchemist's Test", 'Potion Master'], text: (n) => `Use ${n} potions`, target: fixed([1, 3, 6]) },
  { key: 'gold_earned', counter: 'gold_earned', category: 'economy', minLevel: 1, special: 'blood', titles: ['Honest Gold', 'Coin Maker', "Dragon's Hoard"], text: (n) => `Earn ${f(n)} gold from hunting, work and the dungeon`, target: per([0.15, 0.4, 0.75], (l) => 252 * (l + 5)) },
  // ---- progress
  { key: 'xp_gained', counter: 'xp_gained', category: 'progress', minLevel: 1, special: 'blood', titles: ['Learning by Doing', 'Seasoned', "Veteran's Week"], text: (n) => `Gain ${f(n)} XP`, target: per([0.5, 1.2, 2.5], (l) => CFG.xpToNext(l)) },
  { key: 'levels_gained', counter: 'levels_gained', category: 'progress', minLevel: 1, special: 'blood', titles: ['Step Up', 'Rising Fast', 'Meteoric'], text: (n) => `Gain ${n} level${n === 1 ? '' : 's'}`, target: fixed([1, 2, 3]) },
  { key: 'skill_nodes', counter: 'skill_nodes', category: 'progress', minLevel: 3, special: 'blood', titles: ['Choose a Path', 'Building the Build', 'Master Planner'], text: (n) => `Take ${n} skill nodes`, target: fixed([2, 5, 10]) },
  // ---- social
  { key: 'forum_posts', counter: 'forum_posts', category: 'social', minLevel: 3, conditional: true, special: 'blood', titles: ['Say Something', 'Clan Chatter', 'Voice of the Clan'], text: (n) => `Write ${n} clan forum posts`, target: fixed([1, 3, 8]) },
  { key: 'mails_sent', counter: 'mails_sent', category: 'social', minLevel: 1, special: 'blood', titles: ['Dear Friend', 'Pen Pal', 'Postmaster'], text: (n) => `Send ${n} mails to other players`, target: fixed([1, 3, 7]) },
  { key: 'clan_donated', counter: 'clan_donated', category: 'social', minLevel: 3, conditional: true, special: 'blood', titles: ['Pennies for the Clan', 'Generous Member', 'Pillar of the Treasury'], text: (n) => `Donate ${f(n)} gold to your clan`, target: per([3, 10, 30], (l) => l + 5) },
  { key: 'bites_received', counter: 'bites_received', category: 'social', minLevel: 1, conditional: true, special: 'blood', titles: ['A Nibble', 'Popular Prey', 'Feeding Frenzy'], text: (n) => `Get bitten ${n} times through your victim link`, target: fixed([1, 3, 6]) },
  // ---- shrine
  { key: 'shrine_steps', counter: 'shrine_steps', category: 'shrine', minLevel: 10, special: 'blood', titles: ['First Rites', 'Routine Devotion', 'Tireless Shrine'], text: (n) => `Let the shrine finish ${n} routine steps`, target: fixed([1, 4, 10]) },
  { key: 'blood_gathered', counter: 'blood_gathered', category: 'shrine', minLevel: 5, special: 'blood', titles: ['Drops of Blood', 'Filling the Chalice', 'River of Blood'], text: (n) => `Gather ${n} animal blood`, target: fixed([12, 40, 100]) },
];

export const QUESTS: Quest[] = FAMILIES.flatMap((fam) => TIERS.map((tier, i): Quest => ({
  id: `${fam.key}.${tier}`, family: fam.key, tier, title: fam.titles[i], category: fam.category, counter: fam.counter, minLevel: fam.minLevel, special: fam.special, conditional: !!fam.conditional,
})));
export const QUEST_BY_ID = new Map(QUESTS.map((q) => [q.id, q]));
export const FAMILY_BY_KEY = new Map(FAMILIES.map((x) => [x.key, x]));

/** What a quest asks of a character of this level, and the text for it. */
export const targetFor = (q: Quest, level: number) => FAMILY_BY_KEY.get(q.family)!.target(level, TIERS.indexOf(q.tier));
export const textFor = (q: Quest, target: number) => FAMILY_BY_KEY.get(q.family)!.text(target);

// ---------------------------------------------------------------- the weekly draw
const UNIVERSAL_MIN = 6; // at least this many quests of the week are open to a brand-new character
const MAX_CONDITIONAL = 3, MAX_PER_CATEGORY = 3;

function shuffle<T>(xs: T[], rng: Rng): T[] {
  const a = [...xs];
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

/**
 * The quests of a week: `count` different families (never two quests about the same thing), at least 6 that a new character can do,
 * at most 3 that depend on something that may not exist (a clan war, a bite on your link ...) and at most 3 from one category;
 * 40 % easy, 40 % normal, 20 % hard. The same week and seed always give the same quests.
 */
export function weeklySet(week: number, seed: number, count = CFG.questsPerWeek): Quest[] {
  const rng = seeded((Math.imul(week + 1, 0x9e3779b1) ^ Math.imul(seed | 0, 0x85ebca6b)) >>> 0);
  const n = Math.max(1, Math.min(FAMILIES.length, Math.floor(count)));
  const order = shuffle(FAMILIES, rng);
  const picked: Family[] = [], cats = new Map<string, number>();
  const ok = (fam: Family) => (cats.get(fam.category) ?? 0) < MAX_PER_CATEGORY && (!fam.conditional || picked.filter((p) => p.conditional).length < MAX_CONDITIONAL);
  const take = (fam: Family) => { picked.push(fam); cats.set(fam.category, (cats.get(fam.category) ?? 0) + 1); };
  for (const fam of order) if (picked.length < Math.min(UNIVERSAL_MIN, n) && fam.minLevel <= 3 && !fam.conditional && ok(fam)) take(fam);
  for (const fam of order) if (picked.length < n && !picked.includes(fam) && ok(fam)) take(fam);
  for (const fam of order) if (picked.length < n && !picked.includes(fam)) take(fam); // (only if the caps could not be met)
  const hard = Math.round(n * 0.2), easy = Math.round(n * 0.4), tiers = shuffle([...Array(easy).fill(0), ...Array(hard).fill(2), ...Array(Math.max(0, n - easy - hard)).fill(1)] as number[], rng);
  return picked.map((fam, i) => QUEST_BY_ID.get(`${fam.key}.${TIERS[tiers[i]]}`)!).sort((a, b) => TIERS.indexOf(a.tier) - TIERS.indexOf(b.tier) || a.category.localeCompare(b.category));
}

// ---------------------------------------------------------------- rewards
export interface RewardOptions { gold: number; xp: number; special: { kind: SpecialReward; amount: number; label: string } }

/** The three rewards a quest offers for a character of this level (they choose one). */
export function rewardsFor(q: Quest, level: number, xpToNext: number): RewardOptions {
  const t = TIERS.indexOf(q.tier), s = CFG.questRewardScale;
  const gold = Math.max(1, Math.round(([2, 4, 8][t] * level + [10, 20, 40][t]) * s));
  const xp = Math.max(1, Math.round(xpToNext * [0.03, 0.06, 0.12][t] * s));
  const amount = q.special === 'blood' ? Math.round([10, 20, 40][t] * s) : q.special === 'potions' ? Math.max(1, Math.round([1, 2, 4][t] * s)) : Math.round(gold * 1.4);
  const label = q.special === 'blood' ? `${amount} animal blood` : q.special === 'potions' ? `${amount} health potion${amount === 1 ? '' : 's'}` : `dungeon loot worth ${f(amount)} gold`;
  return { gold, xp, special: { kind: q.special, amount, label } };
}
