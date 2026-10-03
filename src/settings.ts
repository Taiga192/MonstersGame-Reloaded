/**
 * Runtime tuning (admin page). Every number in here can be changed without touching the code; changes are stored in the
 * database (table `settings`, only values that differ from config.ts) and survive restarts. A world wipe keeps them.
 *
 * The engine reads `CFG.something` at call time, so applying a setting just writes the value into CFG. One process serves one
 * world, so the global CFG is the world's configuration. `applySettings(db)` (called when the API starts) first restores the
 * defaults and then applies the stored overrides, so a database without overrides always plays with the defaults.
 */
import { CFG, HOUR, MIN } from './config.ts';
import type { DB } from './db-core.ts';
import { GameError } from './errors.ts';

type NumKey = { [K in keyof typeof CFG]: (typeof CFG)[K] extends number ? K : never }[keyof typeof CFG];

export interface Tunable {
  key: NumKey;
  label: string;
  group: string;
  /** stored value = shown value x scale (durations are stored in ms and shown in minutes or hours) */
  scale: number;
  unit: string;
  /** limits in the SHOWN unit */
  min: number; max: number;
  int?: boolean;
  help?: string;
}

const t = (group: string, key: NumKey, label: string, min: number, max: number, o: { scale?: number; unit?: string; int?: boolean; help?: string } = {}): Tunable =>
  ({ group, key, label, min, max, scale: o.scale ?? 1, unit: o.unit ?? '', int: o.int, help: o.help });
const minutes = { scale: MIN, unit: 'min' }, hours = { scale: HOUR, unit: 'h' };

export const TUNABLES: Tunable[] = [
  t('Rates', 'rateXp', 'XP multiplier (all sources)', 0.1, 1000, { help: '1 = normal, 5 = five times as much XP from hunting, raids, the dungeon...' }),
  t('Rates', 'rateGold', 'Gold multiplier (hunting, work, relic dealer, bites)', 0.1, 1000, { help: 'Gold taken from other players in raids is not multiplied.' }),
  t('Rates', 'rateLevelXp', 'XP needed per level (x)', 0.05, 100, { help: 'Below 1 = levels come faster, above 1 = slower.' }),

  t('Cooldowns', 'attackCooldown', 'Raid cooldown', 0, 24 * 60, minutes),
  t('Cooldowns', 'sameOpponentWindow', 'Same-opponent window', 1, 24 * 14, hours),
  t('Cooldowns', 'postBattleProtection', 'Protection after losing a raid', 0, 24 * 60, minutes),
  t('Cooldowns', 'searchValidity', 'A found raid target stays valid for', 1, 24 * 60, minutes),
  t('Cooldowns', 'huntPortion', 'Hunt portion length', 1, 24 * 60, minutes),
  t('Cooldowns', 'huntBudget', 'Hunting time per day', 0.1, 24, hours),
  t('Cooldowns', 'workMaxHours', 'Longest graveyard shift (hours)', 1, 24 * 14, { int: true, unit: 'h' }),
  t('Cooldowns', 'ancestralCooldown', 'Ancestral Site cooldown', 0, 24 * 30, hours),
  t('Cooldowns', 'dungeonCooldown', 'Dungeon cooldown (after leaving or dying)', 0, 24 * 30, hours),
  t('Cooldowns', 'dungeonFightCooldown', 'Dungeon: wait after beating a monster', 0, 24 * 60, { ...minutes, help: 'Must stay shorter than the idle limit. 0 = no wait.' }),
  t('Cooldowns', 'dungeonIdleLimit', 'Dungeon idle limit', 1, 24 * 60, minutes),
  t('Cooldowns', 'arenaMinRegistration', 'Arena: shortest registration time', 1, 24 * 60, minutes),
  t('Cooldowns', 'arenaMaxRegistration', 'Arena: longest registration time', 1, 24 * 30, hours),
  t('Cooldowns', 'templeListingDays', 'Blood Temple listing runs for (days)', 1, 365, { int: true, unit: 'days' }),

  t('Combat', 'hitsToKill', 'Hits to defeat an equal opponent', 1, 1000, { int: true }),
  t('Combat', 'stealMin', 'Raid: minimum share of gold stolen', 0, 1),
  t('Combat', 'stealMax', 'Raid: maximum share of gold stolen', 0, 1),
  t('Combat', 'sameOpponentMax', 'Raids per opponent per window', 1, 100, { int: true }),
  t('Combat', 'sameOpponentMaxWar', 'War attacks per opponent per window', 1, 100, { int: true }),
  t('Combat', 'levelRangeForSearch', 'Raid search: level range', 1, 1000, { int: true }),
  t('Combat', 'hpRegenPerHour', 'Health regeneration per hour', 0, 100000),

  t('Progression', 'startGold', 'Starting gold', 0, 1e9, { int: true }),
  t('Progression', 'startMaxHp', 'Starting max health', 1, 1e6, { int: true }),
  t('Progression', 'startStat', 'Starting value of every attribute', 1, 1000, { int: true, help: 'Only affects characters created afterwards.' }),
  t('Progression', 'levelUpMaxHp', 'Max health per level', 0, 10000, { int: true }),
  t('Progression', 'levelUpHeal', 'Health restored on level up', 0, 100000, { int: true }),
  t('Progression', 'vitalityGain', 'Max health per Vitality Potion', 0, 100000, { int: true }),
  t('Progression', 'vitalityCap', 'Max health gainable from potions in total', 0, 1e6, { int: true }),
  t('Progression', 'recruitLevel', 'Recruit bonus: level the recruit must reach', 1, 1000, { int: true }),
  t('Progression', 'recruitGold', 'Recruit bonus: gold', 0, 1e9, { int: true }),
  t('Progression', 'recruitXp', 'Recruit bonus: XP', 0, 1e6, { int: true }),
  t('Progression', 'sentinelMinLevel', 'Sentinel: minimum level', 1, 1000, { int: true }),
  t('Progression', 'ancestralMinLevel', 'Ancestral Site: minimum level', 1, 1000, { int: true }),
  t('Progression', 'ancestralStatPerLevel', 'Ancestral skill: attribute per level', 0, 1000, { int: true }),
  t('Progression', 'hardenMax', 'Weapon hardening: maximum level', 0, 100, { int: true }),
  t('Progression', 'hardenBonusPerLevel', 'Weapon hardening: Strength per level', 0, 1000, { int: true }),

  t('Economy', 'biteGoldMin', 'Victim link: minimum gold per bite', 0, 1e6, { int: true }),
  t('Economy', 'biteGoldMax', 'Victim link: maximum gold per bite', 0, 1e6, { int: true }),
  t('Economy', 'templeFee', 'Blood Temple: fee on every sale', 0, 1),
  t('Economy', 'templeMaxListings', 'Blood Temple: listings per player', 1, 1000, { int: true }),
  t('Economy', 'mailPerHour', 'Mails a player may send per hour', 1, 10000, { int: true }),

  t('Arena', 'arenaMinLevel', 'Arena: minimum level', 1, 1000, { int: true }),
  t('Arena', 'arenaDailyStartHourUtc', 'Arena: daily start hour (UTC)', 0, 23, { int: true }),
  t('Arena', 'arenaWinPoints', 'Arena: points for a win', 0, 100000, { int: true }),
  t('Arena', 'arenaLossPoints', 'Arena: points for a loss', 0, 100000, { int: true }),
  t('Arena', 'arenaDecayPerDay', 'Arena: daily decay of points', 0, 1),

  t('Dungeon', 'dungeonDropChance', 'Dungeon: chance of a drop per victory', 0, 1),
  t('Dungeon', 'dungeonCheckpoint', 'Dungeon: a checkpoint every N levels', 1, 1000, { int: true, help: 'Reaching it keeps you on that level after the weekly reset.' }),
  t('Dungeon', 'dungeonMilestone', 'Dungeon: a guardian every N levels', 1, 1000, { int: true }),
  t('Dungeon', 'dungeonRewardOptions', 'Dungeon: reward choices after a guardian', 1, 10, { int: true }),

  t('Shrine', 'shrineLevel', 'Shrine: unlocked at level', 1, 1000, { int: true }),
  t('Shrine', 'shrinePrice', 'Shrine: price in the NPC shop (gold)', 0, 1e9, { int: true }),
  t('Shrine', 'shrineBaseEfficiency', 'Shrine: efficiency without upgrades', 0.05, 1, { help: 'Share of a manual hour that an automated hour pays (0.6 = 60 %).' }),
  t('Shrine', 'shrineEfficiencyPerUpgrade', 'Shrine: efficiency per upgrade', 0, 0.5),
  t('Shrine', 'shrineMaxEfficiency', 'Shrine: best possible efficiency', 0.05, 1, { help: 'Reached with all 6 upgrades. Keep it clearly below 1 (manual play).' }),
  t('Shrine', 'shrineTankPerTier', 'Shrine: Blood Chalice tank size per tier', 0, 100000, { int: true }),
  t('Shrine', 'shrineSlotsPerTier', 'Shrine: Bone Altar steps per tier', 0, 5, { int: true }),
  t('Shrine', 'shrineBloodBonus', 'Shrine: Idol II extra blood gathered', 0, 10),
  t('Shrine', 'componentDropLargeTown', 'Shrine part: chance per large town hunted', 0, 1),
  t('Shrine', 'componentDropGuardian', 'Shrine part: chance when a guardian falls', 0, 1),
  t('Shrine', 'shrineSlots', 'Shrine: steps in the routine', 1, 10, { int: true }),
  t('Shrine', 'shrineBloodPerHour', 'Shrine: blood per automated hour', 0.1, 1000),
  t('Shrine', 'shrineTank', 'Shrine: blood tank size', 1, 100000, { int: true, help: 'Also the longest the shrine can run unattended.' }),
  t('Shrine', 'bloodPerHuntPortion', 'Blood gathered per hunt portion', 0, 1000),
  t('Shrine', 'bloodPerWorkHour', 'Blood gathered per hour of graveyard work', 0, 1000),
  t('Shrine', 'bloodPerRaid', 'Blood gathered per raid', 0, 1000),
  t('Shrine', 'bloodPerDungeonFight', 'Blood gathered per dungeon fight', 0, 1000),
  t('Shrine', 'shrineRaidLossCap', 'Raid: most gold taken from a player whose shrine runs', 0, 1, { help: 'Share of that player\'s gold. Automated players have no protection from raids, only this cap.' }),
  t('Skills', 'skillPointsPerLevel', 'Skill points per level', 0, 10, { int: true, help: 'A lower value after points were spent resets nobody: players keep what they took until they respec.' }),
  t('Skills', 'skillCostNotable', 'Skill points a notable costs', 1, 20, { int: true }),
  t('Skills', 'skillCostKeystone', 'Skill points a keystone costs', 1, 20, { int: true }),
  t('Skills', 'skillRefundCostPerLevel', 'Taking back one skill node: gold per level', 0, 100000, { int: true }),
  t('Skills', 'skillRespecCostPerLevel', 'Resetting the whole board: gold per level', 0, 100000, { int: true }),
  t('Clans', 'clanMinLevel', 'Clan: minimum level', 1, 1000, { int: true }),
  t('Clans', 'clanBaseSlots', 'Clan: base member slots', 1, 1000, { int: true }),
  t('Clans', 'clanSlotsPerLevel', 'Clan: extra slots per domicile level', 0, 1000, { int: true }),
  t('Clans', 'warMinAttackers', 'Clan war: members needed', 1, 1000, { int: true }),
  t('Clans', 'warSkillBand', 'Clan war: skill band for random targets', 0, 10),
];

export const TUNABLE_BY_KEY = new Map<string, Tunable>(TUNABLES.map((x) => [x.key, x]));
/** what config.ts says, captured once at startup */
const DEFAULTS = new Map<string, number>(TUNABLES.map((x) => [x.key, CFG[x.key] as number]));

const round = (v: number) => Math.round(v * 1e9) / 1e9;
const shown = (x: Tunable, raw: number) => round(raw / x.scale);

/** Check one value typed by an admin and turn it into the stored unit. Throws a 400 for anything that is not a sane number. */
export function parseValue(key: unknown, value: unknown): { tunable: Tunable; raw: number } {
  const tun = typeof key === 'string' ? TUNABLE_BY_KEY.get(key) : undefined; // (a Map: "constructor" and "__proto__" are simply unknown)
  if (!tun) throw new GameError('bad_setting', 'Unknown setting', 400);
  const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN;
  if (!Number.isFinite(n)) throw new GameError('bad_value', `${tun.label}: please enter a number`, 400);
  if (n < tun.min || n > tun.max) throw new GameError('bad_value', `${tun.label}: must be between ${tun.min} and ${tun.max}${tun.unit ? ' ' + tun.unit : ''}`, 400);
  return { tunable: tun, raw: tun.int ? Math.round(n * tun.scale) : round(n * tun.scale) };
}

function setCfg(key: string, raw: number) { (CFG as Record<string, unknown>)[key] = raw; }

/** Put every tunable back to config.ts and then apply what the database says. Called when a world starts. */
export function applySettings(db: DB) {
  for (const [k, v] of DEFAULTS) setCfg(k, v);
  for (const r of db.prepare('SELECT key, value FROM settings').all() as { key: string; value: number }[]) {
    const tun = TUNABLE_BY_KEY.get(r.key);
    if (tun && Number.isFinite(r.value)) setCfg(r.key, r.value); // (a stored value that was valid when written is not re-checked against newer limits)
  }
}

/** Change one setting (persisted and active immediately). */
export function setSetting(db: DB, key: unknown, value: unknown) {
  const { tunable, raw } = parseValue(key, value);
  if (tunable.key === 'stealMin' && raw > CFG.stealMax) throw new GameError('bad_value', 'The minimum share cannot be above the maximum', 400);
  if (tunable.key === 'stealMax' && raw < CFG.stealMin) throw new GameError('bad_value', 'The maximum share cannot be below the minimum', 400);
  if (tunable.key === 'biteGoldMin' && raw > CFG.biteGoldMax) throw new GameError('bad_value', 'The minimum cannot be above the maximum', 400);
  if (tunable.key === 'biteGoldMax' && raw < CFG.biteGoldMin) throw new GameError('bad_value', 'The maximum cannot be below the minimum', 400);
  if (tunable.key === 'dungeonFightCooldown' && raw >= CFG.dungeonIdleLimit) throw new GameError('bad_value', 'The wait between fights must be shorter than the idle limit (otherwise every run would end while waiting)', 400);
  if (tunable.key === 'dungeonIdleLimit' && raw <= CFG.dungeonFightCooldown) throw new GameError('bad_value', 'The idle limit must be longer than the wait between fights', 400);
  if (tunable.key === 'arenaMinRegistration' && raw > CFG.arenaMaxRegistration) throw new GameError('bad_value', 'The shortest time cannot be longer than the longest', 400);
  if (tunable.key === 'arenaMaxRegistration' && raw < CFG.arenaMinRegistration) throw new GameError('bad_value', 'The longest time cannot be shorter than the shortest', 400);
  if (raw === DEFAULTS.get(tunable.key)) db.prepare('DELETE FROM settings WHERE key = ?').run(tunable.key);
  else db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(tunable.key, raw);
  setCfg(tunable.key, raw);
  return { key: tunable.key, value: shown(tunable, raw) };
}

export function resetSetting(db: DB, key: unknown) {
  const tun = typeof key === 'string' ? TUNABLE_BY_KEY.get(key) : undefined;
  if (!tun) throw new GameError('bad_setting', 'Unknown setting', 400);
  db.prepare('DELETE FROM settings WHERE key = ?').run(tun.key);
  setCfg(tun.key, DEFAULTS.get(tun.key)!);
}

export function resetAllSettings(db: DB) { db.prepare('DELETE FROM settings').run(); applySettings(db); }

/** Ready-made worlds. Values are in the SHOWN unit (minutes, hours ...). */
export const PRESETS: Record<string, { label: string; description: string; values: Record<string, number> }> = {
  normal: { label: 'Normal', description: 'Everything as defined in config.ts.', values: {} },
  double: { label: 'Double XP and gold weekend', description: 'Twice the XP and gold, everything else unchanged.', values: { rateXp: 2, rateGold: 2 } },
  speed: {
    label: 'Speed server (5x)', description: 'Five times the XP and gold, short cooldowns, faster hunting and regeneration. A full world in days instead of months.',
    values: { rateXp: 5, rateGold: 5, attackCooldown: 2, postBattleProtection: 15, sameOpponentWindow: 3, huntPortion: 2, huntBudget: 6, ancestralCooldown: 4, dungeonCooldown: 4, dungeonFightCooldown: 1, dungeonIdleLimit: 30, arenaMinRegistration: 2, hpRegenPerHour: 50 },
  },
};

export function applyPreset(db: DB, name: unknown) {
  const p = typeof name === 'string' && Object.hasOwn(PRESETS, name) ? PRESETS[name] : undefined;
  if (!p) throw new GameError('bad_preset', 'Unknown preset', 400);
  const parsed = Object.entries(p.values).map(([k, v]) => parseValue(k, v)); // validate everything before changing anything
  db.prepare('DELETE FROM settings').run();
  applySettings(db);
  for (const { tunable, raw } of parsed) if (raw !== DEFAULTS.get(tunable.key)) db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run(tunable.key, raw);
  applySettings(db);
  return p.label;
}

/** Everything the admin page needs to draw the settings tables. */
export function describeSettings(db: DB) {
  const stored = new Set((db.prepare('SELECT key FROM settings').all() as { key: string }[]).map((r) => r.key));
  return TUNABLES.map((x) => ({
    key: x.key, label: x.label, group: x.group, unit: x.unit, min: x.min, max: x.max, int: !!x.int, help: x.help ?? '',
    value: shown(x, CFG[x.key] as number), default: shown(x, DEFAULTS.get(x.key)!), changed: stored.has(x.key),
  }));
}

