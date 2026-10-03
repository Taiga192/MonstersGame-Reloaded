// All tunable numbers. [ASSUMED] values are approximations; the rest follow the official manual.

export type Race = 'vampire' | 'werewolf';
export type Stat = 'str' | 'def' | 'agi' | 'sta' | 'dex';
export const MAIN_STATS: Stat[] = ['str', 'def', 'agi', 'sta', 'dex'];

export const MIN = 60_000;
export const HOUR = 60 * MIN;
export const DAY_MS = 24 * HOUR;

export const CFG = {
  // ---- world rates (admin page): 1 = normal. Applied to every source of XP / PvE gold, so a "speed server" is one number ----
  rateXp: 1,
  rateGold: 1, // hunting, graveyard work, relic dealer, victim link (NOT gold taken from other players)
  rateLevelXp: 1, // scales the XP needed per level (below 1 = levels come faster)
  sessionMaxAge: 90 * 24 * 60 * 60 * 1000, // a login token stops working after 90 days
  passwordMin: 8,
  passwordMax: 128,
  loginLockThreshold: 10, // failed logins for ONE account within the window lock that account (from every address) ...
  loginLockWindow: 15 * MIN, // ... for the rest of the window: stops distributed password guessing
  biteDailyCap: 30, // victim link: at most this many bites per link per day, whatever the visitors do
  forumPostsPerHour: 20,
  startStat: 5,
  startGold: 100, // [ASSUMED]
  startMaxHp: 100, // [ASSUMED]
  hpRegenPerHour: 10,
  vitalityGain: 10, // permanent max HP per Vitality Potion
  vitalityCap: 150, // ...but at most this much in total from potions, so high level characters do not snowball
  hpLossThreshold: 10,
  hpProtectThreshold: 25,

  hitsToKill: 14, // [ASSUMED] hits to drop an equal opponent from full HP

  attackCooldown: 10 * MIN,
  sameOpponentWindow: 12 * HOUR,
  sameOpponentMax: 1,
  sameOpponentMaxWar: 4,
  postBattleProtection: HOUR,
  searchValidity: 5 * MIN, // [ASSUMED]
  levelRangeForSearch: 10, // [ASSUMED]
  stealMin: 0.05,
  stealMax: 0.1,

  // xp needed to advance from level L to L+1 [ASSUMED]
  xpToNext: (level: number): number => Math.max(1, Math.round(5 * level * CFG.rateLevelXp)),
  levelUpGold: (level: number) => level * 10, // [ASSUMED]
  levelUpMaxHp: 5, // [ASSUMED]
  levelUpHeal: 20, // "absorb some of enemy's health" [ASSUMED]

  trainCost: (value: number) => Math.max(1, value * value - 5),
  sentinelTrainCost: (pointsAlready: number) => (pointsAlready + 1) ** 2,

  huntBudget: 3 * HOUR, // per day
  huntPortion: 10 * MIN,
  // Each 10-minute portion of a hunt picks a target. Village/small/large chances 50/35/15 %.
  // The village is the base reward; towns add a bonus on top of it to BOTH xp and gold:
  // small town +100 % (x2), large town +250 % (x3.5). Village values are [ASSUMED] and scale with level (gold).
  huntVillage: { xp: 2, gold: [8, 15] as [number, number] },
  huntPlaces: [
    { key: 'village', chance: 0.5, bonus: 0 },
    { key: 'small_town', chance: 0.35, bonus: 1.0 },
    { key: 'large_town', chance: 0.15, bonus: 2.5 },
  ],
  huntGoldLevelScale: (level: number) => 1 + level / 10,
  huntFailChance: (dex: number) => Math.max(0.02, 0.15 - dex * 0.005),

  biteGoldMin: 1,
  biteGoldMax: 3,
  recruitLevel: 3,
  recruitGold: 50,
  recruitXp: 1,

  sentinelMinLevel: 5,
  ancestralMinLevel: 20,
  ancestralCooldown: 24 * HOUR,
  ancestralStatPerLevel: 5,
  ancestralSlots: (level: number) => (level >= 80 ? 4 : level >= 60 ? 3 : level >= 40 ? 2 : level >= 20 ? 1 : 0),
  ancestralFee: (wins: number) => 50 * (wins + 1) ** 2, // [ASSUMED] escalating

  workMaxHours: 48, // one shift, so players can go away for real life
  workWagePerHour: (level: number): number => (5 + level * 2) * CFG.rateGold, // [ASSUMED]

  hideoutMax: { surroundings: 7, path: 10, wall: 12, building: 23 } as Record<string, number>,
  hideoutCost: (comp: string, nextLevel: number) => { // [ASSUMED]
    const mult = { surroundings: 40, path: 30, wall: 60, building: 100 }[comp] ?? 50;
    return mult * nextLevel * nextLevel;
  },
  hideoutDefPerLevel: 1, // [ASSUMED]
  hideoutHideWeight: 2, // [ASSUMED]

  hardenMax: 10, // weapon hardening levels (paid in gold; blood crystals do not exist here)
  hardenBonusPerLevel: 2, // extra Strength per level
  hardenCost: (price: number, currentLevel: number) => Math.round(price * 0.25 * (currentLevel + 1)),

  templeFee: 0.05, // Blood Temple keeps 5 % of every sale
  templeListingDays: 7,
  templeMaxListings: 10,

  mailPerHour: 20,

  arenaMinLevel: 5,
  arenaDailyStartHourUtc: 21, // full events start at ~9 PM server time
  arenaMaxRegistration: 3 * 24 * HOUR,
  arenaMinRegistration: 10 * MIN,
  arenaWinPoints: 300,
  arenaLossPoints: 100,
  arenaDecayPerDay: 0.02, // all-time points shrink by 2 % per day
  arenaTournamentSizes: [4, 8, 16],
  // Points needed for rank 10 (lowest) ... rank 2. Rank 1 exists once: the top player who reached rank 2.
  arenaRankThresholds: [1, 300, 800, 1600, 2800, 4500, 7000, 10500, 15000],
  tournamentPayout: [0.7, 0.3], // winner / finalist share of the fee pool

  // ---- dungeon (an addition that is not in the original game) ----
  dungeonCooldown: 24 * HOUR, // after leaving OR dying: ONE run per day (also stops "leave and re-enter to refill HP" and free retries)
  dungeonFightCooldown: 2 * MIN, // after beating a monster you must wait before the next fight: stretches a run over time instead of over luck
  dungeonCheckpoint: 25, // every 25th level is a checkpoint: reaching it keeps you there after the weekly reset
  dungeonIdleLimit: 30 * MIN, // an inactive run ends by itself (progress kept), so the dungeon is not a safe house from raids
  dungeonDropChance: 0.25,
  dungeonMilestone: 10, // every 10th level is a guardian; beating it lets you choose 1 of 3 valuable rewards
  dungeonRewardOptions: 3,
  /** per-attribute strength of the monster on a level (guardians get x1.25). Tuned with scripts/dungeon-calibrate.ts */
  dungeonMonsterStat: (depth: number) => Math.round(1 + 0.95 * depth + 0.009 * depth * depth),
  dungeonMonsterHp: (depth: number) => 60 + 12 * depth, // only sets the scale of the damage the player deals
  dungeonXp: (depth: number) => Math.round(3 + 0.4 * depth), // a village pays 2, a large town 7; guardians pay x3
  dungeonLootValue: (depth: number) => Math.round(15 + 4 * depth ** 1.15),
  dungeonRelicMultiplier: [4, 8] as [number, number], // guardian rewards are worth 4-8x an ordinary drop of that depth

  // ---- the shrine (an addition that is not in the original game): automates hunting and work while you are away ----
  shrineLevel: 10, // unlocked at this level
  shrinePrice: 1500, // gold, from the NPC shop
  shrineBaseEfficiency: 0.6, // an automated hour pays this share of a manual one ...
  shrineEfficiencyPerUpgrade: 0.025, // ... plus this much for every upgrade (component tier) installed
  shrineMaxEfficiency: 0.75, // however many upgrades: automation always stays clearly weaker than playing
  shrineSlots: 3, // steps in the routine (an Altar adds more)
  shrineTankPerTier: 60, // Blood Chalice: tank size per tier
  shrineSlotsPerTier: 1, // Bone Altar: routine steps per tier
  shrineBloodBonus: 0.5, // Idol of the Hunt II: this much more blood gathered
  componentDropLargeTown: 0.006, // chance per large town hit while hunting to find a tier 2 shrine part
  componentDropGuardian: 0.1, // chance to find one when a dungeon guardian falls
  shrineBloodPerHour: 1, // fuel an automated hour costs (a manual hunt portion or work hour gathers 1: playing a little funds a lot of automation)
  shrineTank: 60, // blood the shrine can hold (also the cap on how long it can run unattended: 60 h at 1 per hour; Blood Chalices add more)
  bloodPerHuntPortion: 1, // animal blood gathered on the way by ANY manual action ...
  bloodPerWorkHour: 1,
  bloodPerRaid: 1,
  bloodPerDungeonFight: 1,
  shrineRaidLossCap: 0.03, // a raid takes at most this share of the gold of a player whose shrine is running (there is no protection while automated)

  // ---- skill board (an addition that is not in the original game), see src/skills.ts ----
  skillPointsPerLevel: 1,
  skillCostNotable: 2, // points a notable costs (start nodes, small nodes, hubs and arc nodes cost 1)
  skillCostKeystone: 3, // points a keystone costs: nobody can take half of the board
  skillRefundCostPerLevel: 10, // gold per level of the character for taking back ONE node (it has to be a node at the end of a branch)
  skillRespecCostPerLevel: 50, // gold per level for resetting the whole board (cheaper than refunding many nodes one by one)

  // ---- weekly quests (an addition that is not in the original game), see src/quests.ts ----
  questsPerWeek: 10,
  questRewardScale: 1, // multiplies every quest reward (gold, XP, blood, potions, loot)

  clanMinLevel: 3,
  clanBaseSlots: 10, // [ASSUMED]
  clanSlotsPerLevel: 5,
  clanUpgradeCost: (level: number) => 1000 * (level + 1), // [ASSUMED]
  warMinAttackers: 5,
  warSkillBand: 0.3, // war attacks pick enemies whose skill average is within +-30 % of yours [ASSUMED]

};

// ---------- catalogs [ASSUMED content; structure per manual] ----------

export type ItemSlot = 'weapon' | 'armor' | 'ring' | 'amulet' | 'potion' | 'component';
export type ComponentKind = 'chalice' | 'altar' | 'idol';
export interface ItemDef {
  key: string; name: string; slot: ItemSlot; minLevel: number; price: number;
  bonus: Partial<Record<Stat, number>>;
  ringKind?: 'stat' | 'battle' | 'hunt'; // rings only; best of each kind counts
  huntBonus?: number; goldBonus?: number; // hunt units / raid gold %
  potion?: 'heal' | 'stat' | 'maxhp';
  /** shrine part: installed in the shrine (not worn); every tier installed is one "upgrade" (+2.5 % efficiency) */
  component?: { kind: ComponentKind; tier: 1 | 2 };
  /** not sold by the NPC shop: found by playing or bought from other players */
  noShop?: boolean;
}

/**
 * A line of gear: one tier every 4 levels, so 25 tiers carry a character to level 97. Every line is its own equipment slot
 * (the best usable item of each line is worn automatically), so a new line adds a new kind of equipment.
 */
function ladder(slot: ItemSlot, base: string, stat: Stat, n: number, o: { perTier?: number; priceMul?: number; prefix?: string } = {}): ItemDef[] {
  const { perTier = 3, priceMul = 1, prefix = 'itm' } = o;
  return Array.from({ length: n }, (_, i) => {
    const tier = i + 1;
    return {
      key: `${prefix}_${base}_${tier}`, name: `${base} Mk ${tier}`, slot,
      minLevel: 1 + i * 4, price: tierPrice(30 * priceMul, tier),
      bonus: { [stat]: tier * perTier },
    };
  });
}

/**
 * Price of tier t: steep early (a new tier every 4 levels costs 2-3 days of income), flatter later, because income grows roughly
 * linearly with level (about 36 x level gold per day for an active character, measured with scripts/progress.ts) while a pure
 * power curve would put the top tiers out of reach of anybody who gets raided.
 */
const tierPrice = (base: number, t: number, knee = 10, exp1 = 2.2, exp2 = 1.35) => Math.round(base * (t <= knee ? t ** exp1 : knee ** exp1 * (t / knee) ** exp2));
const GEAR_TIERS = 25;
export const ITEMS: ItemDef[] = [
  ...ladder('weapon', 'Blade', 'str', GEAR_TIERS),
  ...ladder('armor', 'Plate', 'def', GEAR_TIERS),
  ...ladder('armor', 'Hide', 'sta', GEAR_TIERS),
  ...ladder('weapon', 'Talon', 'agi', GEAR_TIERS, { perTier: 2, priceMul: 0.9 }), // quick weapons: Agility
  ...ladder('armor', 'Gauntlet', 'dex', GEAR_TIERS, { perTier: 2, priceMul: 0.9 }), // Dexterity: finds prey and targets more easily
  // rings: only the best ring of each kind counts
  ...Array.from({ length: 14 }, (_, i): ItemDef => ({
    key: `ring_stat_${i + 1}`, name: `Stat Ring ${i + 1}`, slot: 'ring', ringKind: 'stat',
    minLevel: 1 + i * 7, price: tierPrice(200, i + 1, 4, 2, 1.7), bonus: { agi: (i + 1) * 2, dex: (i + 1) },
  })),
  ...Array.from({ length: 12 }, (_, i): ItemDef => ({
    key: `ring_battle_${i + 1}`, name: `Plunder Ring ${i + 1}`, slot: 'ring', ringKind: 'battle',
    minLevel: 1 + i * 8, price: tierPrice(200, i + 1, 4, 2, 1.7), bonus: {}, goldBonus: 0.01 * (i + 1),
  })),
  ...Array.from({ length: 12 }, (_, i): ItemDef => ({
    key: `ring_hunt_${i + 1}`, name: `Tracker Ring ${i + 1}`, slot: 'ring', ringKind: 'hunt',
    minLevel: 1 + i * 8, price: tierPrice(200, i + 1, 4, 2, 1.7), bonus: {}, huntBonus: i < 6 ? 10 * (i + 1) : 60 + 5 * (i - 5),
  })),
  // amulets of might: a late-game amulet line (Strength and Defence together)
  ...Array.from({ length: 6 }, (_, i): ItemDef => ({
    key: `amulet_might_${i + 1}`, name: `Amulet of Might ${i + 1}`, slot: 'amulet', minLevel: 20 + i * 15, price: tierPrice(700, i + 1, 3, 2.2, 1.5),
    bonus: { str: (i + 1) * 5, def: (i + 1) * 5 },
  })),
  { key: 'amulet_perfection', name: 'Amulet of Perfection', slot: 'amulet', minLevel: 30, price: 5000, bonus: {}, huntBonus: 9999 },
  { key: 'amulet_healing', name: 'Amulet of Healing', slot: 'amulet', minLevel: 30, price: 3000, bonus: {} },
  // shrine parts: tier 1 from the NPC shop (for everybody), tier 2 only found by playing (large towns, dungeon guardians) or traded
  ...(['chalice', 'altar', 'idol'] as const).flatMap((kind) => ([1, 2] as const).map((tier): ItemDef => ({
    key: `shrine_${kind}_${tier}`, name: `${{ chalice: 'Blood Chalice', altar: 'Bone Altar', idol: 'Idol of the Hunt' }[kind]} ${tier === 1 ? 'I' : 'II'}`, slot: 'component', minLevel: 10,
    price: tier === 1 ? 800 : 6000, bonus: {}, component: { kind, tier }, noShop: tier === 2,
  }))),
  { key: 'potion_heal', name: 'Health Potion', slot: 'potion', minLevel: 1, price: 40, bonus: {}, potion: 'heal' },
  { key: 'potion_maxhp', name: 'Vitality Potion', slot: 'potion', minLevel: 1, price: 500, bonus: {}, potion: 'maxhp' },
];
export const ITEM_BY_KEY = new Map(ITEMS.map((i) => [i.key, i]));

export interface SentinelDef { key: string; name: string; minLevel: number; price: number; atk: number; def: number; sta: number }
const SENTINEL_NAMES = [
  'Hound', 'Rat Swarm', 'Bat', 'Crow', 'Wolf Pup', 'Raven', 'Jackal', 'Boar', 'Ghoul', 'Warg',
  'Skeleton', 'Zombie', 'Gargoyle', 'Imp', 'Banshee', 'Wraith', 'Harpy', 'Hellhound', 'Troll', 'Ogre',
  'Wyvern', 'Golem', 'Minotaur', 'Specter', 'Chimera', 'Basilisk', 'Manticore', 'Revenant', 'Wendigo', 'Lich',
  'Cerberus', 'Hydra', 'Juggernaut', 'Behemoth', 'Phantom', 'Djinn', 'Kraken', 'Leviathan', 'Dragon', 'Archdemon',
  'Titan', 'Colossus', 'Nightmare', 'Horror', 'Abomination', 'Devourer', 'Overlord', 'World Eater',
];
export const SENTINELS: SentinelDef[] = SENTINEL_NAMES.map((name, i) => {
  const t = i + 1;
  return {
    key: `sen_${t}`, name, minLevel: t === 1 ? 5 : Math.min(100, 5 + Math.floor(t * 2)),
    price: tierPrice(50, t, 12, 2.1, 1.5), atk: t * 2 + 1, def: t * 2 + 1, sta: t * 2 + 1,
  };
});
export const SENTINEL_BY_KEY = new Map(SENTINELS.map((s) => [s.key, s]));

export const ANCESTRAL: Record<Race, { key: string; name: string; stat: Stat }[]> = {
  vampire: [
    { key: 'blood_rage', name: 'Blood Rage', stat: 'str' },
    { key: 'doppelganger', name: 'Doppelgänger', stat: 'agi' },
    { key: 'toughness', name: 'Toughness', stat: 'sta' },
    { key: 'stoneskin', name: 'Stoneskin', stat: 'def' },
  ],
  werewolf: [
    { key: 'barbaric_rage', name: 'Barbaric Rage', stat: 'str' },
    { key: 'reflexes', name: 'Reflexes', stat: 'agi' },
    { key: 'berserker', name: 'Berserker', stat: 'sta' },
    { key: 'fire', name: 'Fire', stat: 'def' },
  ],
};

// ---------- accomplishments ----------
export type AccBonus =
  | { kind: 'stat'; stat: Stat; per: number }
  | { kind: 'raidGold' | 'huntReward' | 'workWage'; per: number }; // per = fraction per tier (0.03 = +3 %)
export interface AccDef { key: string; name: string; desc: string; counter: string; tiers: number[]; bonus: AccBonus }
/** `counter: 'level'` reads the character level; every other counter is stored in the `counters` table. */
export const ACCOMPLISHMENTS: AccDef[] = [
  { key: 'raider', name: 'Raider', desc: 'Win raids', counter: 'raids_won', tiers: [5, 25, 100, 400, 1500], bonus: { kind: 'stat', stat: 'str', per: 1 } },
  { key: 'guardian', name: 'Guardian', desc: 'Defend successfully against raids', counter: 'defenses_won', tiers: [3, 15, 60, 250, 900], bonus: { kind: 'stat', stat: 'def', per: 1 } },
  { key: 'duelist', name: 'Duelist', desc: 'Win arena matches', counter: 'arena_wins', tiers: [1, 5, 20, 60, 200], bonus: { kind: 'stat', stat: 'agi', per: 1 } },
  { key: 'gravedigger', name: 'Gravedigger', desc: 'Work hours in the graveyard', counter: 'work_hours', tiers: [5, 24, 100, 400, 1200], bonus: { kind: 'stat', stat: 'sta', per: 1 } },
  { key: 'tracker', name: 'Tracker', desc: 'Complete hunting portions', counter: 'hunt_portions', tiers: [10, 60, 250, 800, 2500], bonus: { kind: 'stat', stat: 'dex', per: 1 } },
  { key: 'plunderer', name: 'Plunderer', desc: 'Steal gold in raids', counter: 'gold_stolen', tiers: [500, 5000, 50000, 250000, 1000000], bonus: { kind: 'raidGold', per: 0.02 } },
  { key: 'town_burner', name: 'Town Burner', desc: 'Hit large towns while hunting', counter: 'large_towns', tiers: [3, 15, 60, 200, 600], bonus: { kind: 'huntReward', per: 0.03 } },
  { key: 'undertaker', name: 'Undertaker', desc: 'Earn wages at the graveyard', counter: 'work_gold', tiers: [200, 2000, 15000, 100000, 500000], bonus: { kind: 'workWage', per: 0.03 } },
  { key: 'warlord', name: 'Warlord', desc: 'Win battles in clan wars', counter: 'war_wins', tiers: [3, 15, 60, 200, 600], bonus: { kind: 'stat', stat: 'str', per: 1 } },
  { key: 'ancestral', name: "Ancestors' Chosen", desc: 'Win at the Ancestral Site', counter: 'ancestral_wins', tiers: [1, 3, 7, 15, 30], bonus: { kind: 'stat', stat: 'sta', per: 1 } },
  { key: 'feeder', name: 'Feeder', desc: 'Be bitten through your victim link', counter: 'bites_received', tiers: [10, 50, 200, 1000, 5000], bonus: { kind: 'huntReward', per: 0.02 } },
  { key: 'delver', name: 'Delver', desc: 'Clear dungeon levels', counter: 'dungeon_levels', tiers: [10, 50, 150, 400, 1000], bonus: { kind: 'stat', stat: 'agi', per: 1 } },
  { key: 'veteran', name: 'Veteran', desc: 'Reach character levels', counter: 'level', tiers: [10, 25, 50, 80, 120], bonus: { kind: 'stat', stat: 'def', per: 1 } },
];
export const ACC_BY_KEY = new Map(ACCOMPLISHMENTS.map((a) => [a.key, a]));
export const ACC_SETS = 5; // sets per player
export const ACC_SET_SIZE = 5; // accomplishments per set
