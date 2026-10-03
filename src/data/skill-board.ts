/**
 * The skill board (NOT in the original game): 1 skill point per level buys passive bonuses on a board, Path of Exile style.
 *
 * - Seven regions (Hunter, Warrior, Shadow, Delver, Warden, Artisan, Acolyte), each with a start node (the "class"), three arms of
 *   ten nodes (small ones, and three notables per arm) and one keystone at the tip: a big bonus with a drawback.
 * - The first point must go on a start node (that is your class). After that a node can only be taken when it touches a node you
 *   already have. Hub nodes ring the centre and bridge nodes join neighbouring regions, so builds can reach into other regions.
 * - Everything is a "modifier" (a number under a key, see MODS). The game rules read the summed modifiers of a character; this file
 *   knows nothing about the database. The board is generated from a few tables below, so it is easy to rebalance.
 */

import { CFG } from '../core/config.ts';

export type ModKey =
  | 'str' | 'def' | 'agi' | 'sta' | 'dex' | 'strPct' | 'defPct' | 'agiPct' | 'staPct' | 'dexPct' | 'allPct' | 'maxHp' | 'hpRegen'
  | 'huntGold' | 'huntXp' | 'huntFail' | 'huntTown' | 'workWage'
  | 'raidGold' | 'raidShield' | 'raidCooldown'
  | 'dungeonXp' | 'dungeonLoot' | 'dungeonHp' | 'dungeonDrop'
  | 'xp' | 'gold' | 'shopDiscount' | 'sellBonus' | 'trainDiscount' | 'hardenDiscount' | 'templeFeeCut' | 'ancestralFee'
  | 'bloodGather' | 'shrineTank' | 'shrineFuel';
export type Mods = Partial<Record<ModKey, number>>;

/** How a modifier is written for the player. `flat`: +5 Strength; `pct`: +4 % (the number is 0.04); `pts`: percentage POINTS of a chance. */
export const MODS: Record<ModKey, { label: string; type: 'flat' | 'pct' | 'pts'; cap?: [number, number] }> = {
  str: { label: 'Strength', type: 'flat' }, def: { label: 'Defence', type: 'flat' }, agi: { label: 'Agility', type: 'flat' },
  sta: { label: 'Stamina', type: 'flat' }, dex: { label: 'Dexterity', type: 'flat' },
  strPct: { label: 'Strength', type: 'pct' }, defPct: { label: 'Defence', type: 'pct' }, agiPct: { label: 'Agility', type: 'pct' },
  staPct: { label: 'Stamina', type: 'pct' }, dexPct: { label: 'Dexterity', type: 'pct' }, allPct: { label: 'all attributes', type: 'pct' },
  maxHp: { label: 'maximum health', type: 'flat' }, hpRegen: { label: 'health regeneration', type: 'pct' },
  huntGold: { label: 'gold from hunts', type: 'pct' }, huntXp: { label: 'XP from hunts', type: 'pct' },
  huntFail: { label: 'chance that a hunt portion fails', type: 'pts', cap: [-0.12, 0.5] }, huntTown: { label: 'chance to hit a town instead of a village', type: 'pts', cap: [-0.2, 0.2] },
  workWage: { label: 'graveyard wages', type: 'pct' },
  raidGold: { label: 'gold stolen in raids', type: 'pct' }, raidShield: { label: 'less gold lost when you are raided', type: 'pct', cap: [-0.5, 0.6] },
  raidCooldown: { label: 'shorter raid cooldown', type: 'pct', cap: [-0.5, 0.5] },
  dungeonXp: { label: 'XP in the dungeon', type: 'pct' }, dungeonLoot: { label: 'value of dungeon loot', type: 'pct' }, dungeonHp: { label: 'dungeon health', type: 'pct' },
  dungeonDrop: { label: 'chance of a dungeon drop', type: 'pts', cap: [-0.25, 0.25] },
  xp: { label: 'all XP', type: 'pct' }, gold: { label: 'gold from hunts, work and dungeon loot', type: 'pct' },
  shopDiscount: { label: 'cheaper shop prices', type: 'pct', cap: [-0.5, 0.3] }, sellBonus: { label: 'more gold when selling to the shop', type: 'pct' },
  trainDiscount: { label: 'cheaper attribute training', type: 'pct', cap: [-0.5, 0.3] }, hardenDiscount: { label: 'cheaper weapon hardening', type: 'pct', cap: [-0.5, 0.5] },
  templeFeeCut: { label: 'lower Blood Temple fee', type: 'pct', cap: [-1, 0.6] }, ancestralFee: { label: 'cheaper Ancestral Site challenges', type: 'pct', cap: [-0.5, 0.5] },
  bloodGather: { label: 'animal blood gathered', type: 'pct' }, shrineTank: { label: 'shrine blood capacity', type: 'flat' }, shrineFuel: { label: 'less blood burned by the shrine', type: 'pct', cap: [-0.5, 0.5] },
};

export type NodeKind = 'origin' | 'small' | 'notable' | 'keystone' | 'hub' | 'bridge';
export interface SkillNode { id: string; name: string; kind: NodeKind; region: string; x: number; y: number; mods: Mods; links: string[] }
export interface Region { key: string; name: string; title: string; blurb: string; color: string; angle: number }

// ---------------------------------------------------------------- the design tables
interface ArmDef { label: string; small: Mods; /** alternate small bonus on every second small node (optional) */ small2?: Mods; notables: [string, Mods][] }
interface RegionDef { key: string; name: string; title: string; blurb: string; color: string; start: [string, Mods]; arms: [ArmDef, ArmDef, ArmDef]; keystone: [string, Mods, string] }

const REGION_DEFS: RegionDef[] = [
  { key: 'hunter', name: 'Hunter', title: 'Lone Hunter', color: '#5fbf7a', blurb: 'Gold and XP from hunting, fewer failed hunts, more towns.',
    start: ['Lone Hunter', { huntGold: 0.02, dex: 3 }],
    arms: [
      { label: 'Plunder', small: { huntGold: 0.01 }, notables: [['Village Raider', { huntGold: 0.04, dex: 3 }], ['Town Burner', { huntGold: 0.05, huntTown: 0.015 }], ['Merciless Looter', { huntGold: 0.06, gold: 0.02 }]] },
      { label: 'Tracking', small: { huntXp: 0.01 }, notables: [['Keen Eyes', { huntXp: 0.04, dex: 4 }], ['Born Hunter', { huntXp: 0.05, huntFail: -0.01 }], ['Apex Predator', { huntXp: 0.06, xp: 0.02 }]] },
      { label: 'Stalking', small: { dex: 2 }, small2: { huntFail: -0.005 }, notables: [['Silent Step', { dex: 6, huntFail: -0.02 }], ['Pathfinder', { huntTown: 0.03, dex: 4 }], ['Ghost of the Wilds', { huntFail: -0.03, agi: 5 }]] },
    ],
    keystone: ['Lone Wolf', { huntGold: 0.15, huntXp: 0.15, raidShield: -0.2 }, 'The wild feeds you well, but nobody watches your back.'] },
  { key: 'warrior', name: 'Warrior', title: 'Blood Knight', color: '#e0596b', blurb: 'Raw strength and plunder in raids.',
    start: ['Blood Knight', { str: 3, maxHp: 10 }],
    arms: [
      { label: 'Might', small: { str: 2 }, notables: [['Brutal Strikes', { str: 6, raidGold: 0.03 }], ['Slayer', { str: 8, strPct: 0.02 }], ["Titan's Grip", { strPct: 0.04, str: 5 }]] },
      { label: 'Conquest', small: { raidGold: 0.01 }, notables: [['Pillager', { raidGold: 0.05, str: 3 }], ['Warlord', { raidGold: 0.06, str: 4 }], ['Conqueror', { raidGold: 0.08, agi: 3 }]] },
      { label: 'Resolve', small: { maxHp: 10 }, small2: { sta: 2 }, notables: [['Thick Skin', { maxHp: 40, sta: 4 }], ['Battle Hardened', { maxHp: 50, def: 4 }], ['Unyielding', { maxHp: 60, staPct: 0.02 }]] },
    ],
    keystone: ['Berserker', { strPct: 0.2, defPct: -0.15 }, 'Hit first, hit hard, and never mind the wounds.'] },
  { key: 'shadow', name: 'Shadow', title: 'Night Stalker', color: '#b180e0', blurb: 'Speed, ambush and short cooldowns.',
    start: ['Night Stalker', { agi: 3, raidCooldown: 0.02 }],
    arms: [
      { label: 'Reflex', small: { agi: 2 }, notables: [['Quick Hands', { agi: 6, dex: 3 }], ['Blur', { agi: 8, agiPct: 0.02 }], ['Phantom Speed', { agiPct: 0.04, agi: 5 }]] },
      { label: 'Ambush', small: { raidCooldown: 0.01 }, notables: [['Opportunist', { raidCooldown: 0.04, raidGold: 0.02 }], ['Cutthroat', { raidCooldown: 0.05, agi: 4 }], ['Ambusher', { raidCooldown: 0.06, raidGold: 0.04 }]] },
      { label: 'Insight', small: { dex: 2 }, small2: { huntTown: 0.005 }, notables: [['Sharp Mind', { dex: 6, xp: 0.01 }], ['Dead Eye', { dex: 8, dexPct: 0.02 }], ["Predator's Sense", { huntTown: 0.02, dex: 5, xp: 0.02 }]] },
    ],
    keystone: ['Assassin', { agiPct: 0.2, defPct: -0.1, staPct: -0.1 }, 'Strike from the dark; do not be there when they strike back.'] },
  { key: 'delver', name: 'Delver', title: 'Dungeon Crawler', color: '#e6c04a', blurb: 'XP, loot and endurance in the dungeon.',
    start: ['Dungeon Crawler', { dungeonXp: 0.02, sta: 3 }],
    arms: [
      { label: 'Depth', small: { dungeonXp: 0.01 }, notables: [['Torchbearer', { dungeonXp: 0.04, sta: 3 }], ['Deep Diver', { dungeonXp: 0.05, dungeonHp: 0.02 }], ['Abyss Walker', { dungeonXp: 0.06, xp: 0.02 }]] },
      { label: 'Spoils', small: { dungeonLoot: 0.015 }, small2: { dungeonDrop: 0.005 }, notables: [['Treasure Sense', { dungeonLoot: 0.05, dungeonDrop: 0.01 }], ['Relic Hunter', { dungeonLoot: 0.06, gold: 0.02 }], ['Vault Breaker', { dungeonLoot: 0.08, dungeonDrop: 0.02 }]] },
      { label: 'Endurance', small: { dungeonHp: 0.015 }, small2: { sta: 2 }, notables: [['Steady Heart', { dungeonHp: 0.05, sta: 3 }], ['Cave Hardened', { dungeonHp: 0.06, def: 4 }], ['Undying Delver', { dungeonHp: 0.08, staPct: 0.02 }]] },
    ],
    keystone: ['Into the Abyss', { dungeonXp: 0.2, dungeonHp: 0.2, staPct: -0.08 }, 'The deeper, the better; the surface is for the weak.'] },
  { key: 'warden', name: 'Warden', title: 'Iron Warden', color: '#5a8fe0', blurb: 'Defence, health and keeping your gold.',
    start: ['Iron Warden', { def: 3, maxHp: 10 }],
    arms: [
      { label: 'Bulwark', small: { def: 2 }, notables: [['Shield Wall', { def: 6, sta: 3 }], ['Iron Skin', { def: 8, defPct: 0.02 }], ['Fortress', { defPct: 0.04, def: 5 }]] },
      { label: 'Vitality', small: { maxHp: 10 }, small2: { hpRegen: 0.03 }, notables: [['Hardy', { maxHp: 40, hpRegen: 0.1 }], ['Regeneration', { hpRegen: 0.2, maxHp: 30 }], ['Second Wind', { hpRegen: 0.3, staPct: 0.02 }]] },
      { label: 'Wardstone', small: { raidShield: 0.015 }, notables: [['Guarded Coin', { raidShield: 0.05, def: 3 }], ['Deep Pockets', { raidShield: 0.07, maxHp: 20 }], ['Untouchable', { raidShield: 0.1, def: 4 }]] },
    ],
    keystone: ['Unbreakable', { defPct: 0.15, staPct: 0.15, strPct: -0.15 }, 'Let them come. You are not going anywhere.'] },
  { key: 'artisan', name: 'Artisan', title: 'Gravekeeper', color: '#d18b2c', blurb: 'Wages, trade and cheaper upgrades.',
    start: ['Gravekeeper', { workWage: 0.02, sta: 3 }],
    arms: [
      { label: 'Wages', small: { workWage: 0.01 }, notables: [['Honest Work', { workWage: 0.04, sta: 3 }], ['Overtime', { workWage: 0.05, gold: 0.02 }], ['Master Gravedigger', { workWage: 0.07, xp: 0.01 }]] },
      { label: 'Trade', small: { sellBonus: 0.01 }, small2: { shopDiscount: 0.005 }, notables: [['Haggler', { shopDiscount: 0.03, sellBonus: 0.03 }], ['Silver Tongue', { sellBonus: 0.05, templeFeeCut: 0.1 }], ['Market Baron', { shopDiscount: 0.05, templeFeeCut: 0.2 }]] },
      { label: 'Craft', small: { trainDiscount: 0.005 }, small2: { hardenDiscount: 0.01 }, notables: [['Apprentice Smith', { hardenDiscount: 0.05, trainDiscount: 0.02 }], ['Forgemaster', { hardenDiscount: 0.08, trainDiscount: 0.03 }], ['Master of the Anvil', { trainDiscount: 0.05, hardenDiscount: 0.1 }]] },
    ],
    keystone: ['Golden Touch', { gold: 0.15, xp: -0.1 }, 'Gold sticks to your fingers; wisdom does not.'] },
  { key: 'acolyte', name: 'Acolyte', title: 'Blood Acolyte', color: '#c23a5a', blurb: 'The shrine: more blood, less fuel, more knowledge.',
    start: ['Blood Acolyte', { bloodGather: 0.05, shrineTank: 5 }],
    arms: [
      { label: 'Devotion', small: { bloodGather: 0.02 }, notables: [['Offering', { bloodGather: 0.08, xp: 0.01 }], ['Devotee', { bloodGather: 0.1, shrineTank: 5 }], ['Blood Sage', { bloodGather: 0.15, xp: 0.02 }]] },
      { label: 'Reservoir', small: { shrineTank: 3 }, notables: [['Deep Well', { shrineTank: 12, bloodGather: 0.03 }], ['Overflowing Chalice', { shrineTank: 18 }], ['Heart of the Shrine', { shrineTank: 25, shrineFuel: 0.05 }]] },
      { label: 'Thrift', small: { shrineFuel: 0.01 }, small2: { xp: 0.005 }, notables: [['Frugal Rites', { shrineFuel: 0.05, xp: 0.01 }], ['Efficient Ritual', { shrineFuel: 0.07, ancestralFee: 0.05 }], ['Silent Prayer', { shrineFuel: 0.1, xp: 0.02 }]] },
    ],
    keystone: ['Blood Pact', { bloodGather: 0.5, shrineFuel: 0.25, hpRegen: -0.3 }, 'Your blood belongs to the shrine; it heals slowly.'] },
];

/** Bridge nodes between neighbouring regions (three nodes each: small, notable, small). */
const BRIDGES: [string, Mods][][] = [
  [['Stalker\'s Eye', { dex: 2, huntFail: -0.005 }], ['Hunting Instinct', { huntGold: 0.03, agi: 4 }], ['Predator\'s Gait', { agi: 2, huntTown: 0.005 }]], // hunter - warrior
  [['Blood Scent', { str: 2, raidGold: 0.01 }], ['Savage Ambush', { raidGold: 0.04, raidCooldown: 0.03 }], ['Feral Speed', { agi: 2, raidCooldown: 0.01 }]], // warrior - shadow
  [['Cold Calculation', { dex: 2, xp: 0.005 }], ['Treasure Hunter', { dungeonLoot: 0.04, dex: 4 }], ['Silent Descent', { dungeonDrop: 0.005, agi: 2 }]], // shadow - delver
  [['Hard Won', { sta: 2, dungeonHp: 0.01 }], ['Stone Resolve', { dungeonHp: 0.04, def: 4 }], ['Cave Lore', { def: 2, dungeonXp: 0.01 }]], // delver - warden
  [['Old Debts', { def: 2, sellBonus: 0.01 }], ['Honest Coin', { raidShield: 0.03, workWage: 0.03 }], ['Sturdy Hands', { sta: 2, workWage: 0.01 }]], // warden - artisan
  [['Grave Offerings', { workWage: 0.01, bloodGather: 0.02 }], ['Rite of Plenty', { workWage: 0.03, shrineFuel: 0.03 }], ['Blood Ledger', { sellBonus: 0.01, shrineTank: 3 }]], // artisan - acolyte
  [['Wild Faith', { bloodGather: 0.02, dex: 2 }], ['Shrine of the Hunt', { bloodGather: 0.06, huntGold: 0.03 }], ['Quiet Devotion', { shrineTank: 3, huntXp: 0.01 }]], // acolyte - hunter
];
const HUB_MODS: Mods[] = [{ str: 1 }, { def: 1 }, { agi: 1 }, { sta: 1 }, { dex: 1 }, { maxHp: 5 }, { allPct: 0.005 }];

/**
 * Balance: bonuses to XP are scaled down so that a build full of them speeds levelling up by a limited amount (measured with
 * scripts/progress.ts, see docs/BALANCE.md). Gold, stats and everything else are used as written in the tables above.
 */
const XP_SCALE = 0.7;
const tune = (m: Mods): Mods => { const out: Mods = { ...m }; for (const k of ['huntXp', 'dungeonXp', 'xp'] as const) if (out[k] !== undefined) out[k] = Math.round(out[k]! * XP_SCALE * 10000) / 10000; return out; };

// ---------------------------------------------------------------- generating the board
const ARM_STEPS = 10; // nodes per arm; notables at 3, 6 and 10
const RINGS = [3, 6, 9]; // arm positions where neighbouring regions are joined by an arc
/** attribute nodes on the arcs: [modifier, name, amount at the inner ring]; the outer rings pay more */
const ARC_FILL: [ModKey, string, number][] = [['str', 'Brawn', 2], ['def', 'Guard', 2], ['agi', 'Grace', 2], ['sta', 'Vigor', 2], ['dex', 'Aim', 2], ['maxHp', 'Heart', 10]];
const ARC_FILL_SCALE = [1, 1.5, 2];
/** the notable in the middle of an arc (the tables in BRIDGES are small): bigger on the inner and outer rings, as written on the middle one */
const ARC_NOTABLE_SCALE = [2, 1, 2];
const scaleMods = (m: Mods, f: number): Mods => Object.fromEntries(Object.entries(m).map(([k, v]) => [k, MODS[k as ModKey].type === 'flat' ? Math.round(v! * f) : Math.round(v! * f * 10000) / 10000])) as Mods;
const NOTABLE_AT = [3, 6, 10];

export const REGIONS: Region[] = REGION_DEFS.map((d, i) => ({ key: d.key, name: d.name, title: d.title, blurb: d.blurb, color: d.color, angle: -90 + (i * 360) / REGION_DEFS.length }));
export const NODES: SkillNode[] = [];
export const NODE_BY_ID = new Map<string, SkillNode>();
export const ORIGINS: string[] = [];

(function build() {
  const add = (n: Omit<SkillNode, 'links'>) => { const node = { ...n, mods: tune(n.mods), links: [] as string[] }; NODES.push(node); NODE_BY_ID.set(n.id, node); return node; };
  const link = (a: string, b: string) => { const x = NODE_BY_ID.get(a)!, y = NODE_BY_ID.get(b)!; if (!x.links.includes(b)) x.links.push(b); if (!y.links.includes(a)) y.links.push(a); };
  const armId = (r: string, arm: number, i: number) => `${r}.${'abc'[arm]}${i}`;
  const unit = (deg: number) => [Math.cos((deg * Math.PI) / 180), Math.sin((deg * Math.PI) / 180)] as const;
  const round = (v: number) => Math.round(v * 10) / 10;

  REGION_DEFS.forEach((d, ri) => {
    const reg = REGIONS[ri], [ux, uy] = unit(reg.angle), [px, py] = [-uy, ux];
    const at = (radius: number, lateral: number) => [round(ux * radius + px * lateral), round(uy * radius + py * lateral)] as const;
    const [ox, oy] = at(150, 0);
    add({ id: `${d.key}.start`, name: d.start[0], kind: 'origin', region: d.key, x: ox, y: oy, mods: d.start[1] });
    ORIGINS.push(`${d.key}.start`);
    d.arms.forEach((arm, a) => {
      for (let i = 1; i <= ARM_STEPS; i++) {
        const [x, y] = at(150 + 46 * i, (a - 1) * 56);
        const nIdx = NOTABLE_AT.indexOf(i);
        const notable = nIdx >= 0 ? arm.notables[nIdx] : undefined;
        const smallNo = i - NOTABLE_AT.filter((n) => n < i).length; // 1-based among the small nodes of this arm
        const mods = notable ? notable[1] : arm.small2 && smallNo % 2 === 0 ? arm.small2 : arm.small;
        add({ id: armId(d.key, a, i), name: notable ? notable[0] : `${arm.label} ${smallNo}`, kind: notable ? 'notable' : 'small', region: d.key, x, y, mods });
        link(i === 1 ? `${d.key}.start` : armId(d.key, a, i - 1), armId(d.key, a, i));
      }
    });
    for (const i of [3, 6, 9]) { link(armId(d.key, 0, i), armId(d.key, 1, i)); link(armId(d.key, 1, i), armId(d.key, 2, i)); }
    const [kx, ky] = at(150 + 46 * (ARM_STEPS + 1), 0);
    add({ id: `${d.key}.key`, name: d.keystone[0], kind: 'keystone', region: d.key, x: kx, y: ky, mods: d.keystone[1] });
    for (let a = 0; a < 3; a++) link(armId(d.key, a, ARM_STEPS), `${d.key}.key`);
  });

  // hubs between the start nodes (the ring in the middle)
  REGION_DEFS.forEach((d, ri) => {
    const next = REGION_DEFS[(ri + 1) % REGION_DEFS.length], [hx, hy] = unit(REGIONS[ri].angle + 180 / REGION_DEFS.length);
    add({ id: `hub.${ri}`, name: 'Awakening', kind: 'hub', region: 'hub', x: round(hx * 85), y: round(hy * 85), mods: HUB_MODS[ri] });
    link(`${d.key}.start`, `hub.${ri}`); link(`hub.${ri}`, `${next.key}.start`);
  });

  // Arcs between neighbouring regions at three rings (inner, middle, outer): from the outer arm of one region to the first arm of
  // the next, along the circle. Plain attribute nodes fill the arc; the node in the middle of every arc is a notable that mixes the
  // two regions. This is what lets a build cross over into other regions instead of walking straight out along its own arms.
  REGION_DEFS.forEach((d, ri) => {
    const next = REGION_DEFS[(ri + 1) % REGION_DEFS.length];
    RINGS.forEach((step, ring) => {
      const from = NODE_BY_ID.get(armId(d.key, 2, step))!, to = NODE_BY_ID.get(armId(next.key, 0, step))!;
      const r1 = Math.hypot(from.x, from.y), r2 = Math.hypot(to.x, to.y);
      const a1 = Math.atan2(from.y, from.x);
      let da = Math.atan2(to.y, to.x) - a1; while (da > Math.PI) da -= 2 * Math.PI; while (da < -Math.PI) da += 2 * Math.PI;
      let n = Math.max(1, Math.floor(((r1 + r2) / 2 * Math.abs(da)) / 48) - 1);
      if (n % 2 === 0) n--; // an odd number, so there is a middle node
      const [mixName, mixMods] = BRIDGES[ri][ring];
      let prev = from.id;
      for (let k = 0; k < n; k++) {
        const t = (k + 1) / (n + 1), r = r1 + (r2 - r1) * t, ang = a1 + da * t, centre = k === (n - 1) / 2;
        const fill = ARC_FILL[(ri * 2 + ring + k) % ARC_FILL.length];
        const mods: Mods = centre ? scaleMods(mixMods, ARC_NOTABLE_SCALE[ring]) : { [fill[0]]: Math.round(fill[2] * ARC_FILL_SCALE[ring]) };
        const node = add({ id: `arc.${ri}.${ring}.${k}`, name: centre ? mixName : fill[1], kind: centre ? 'notable' : 'bridge', region: `${d.key}+${next.key}`, x: round(Math.cos(ang) * r), y: round(Math.sin(ang) * r), mods });
        link(prev, node.id); prev = node.id;
      }
      link(prev, to.id);
    });
  });
})();

// ---------------------------------------------------------------- reading the board
/** Skill points a node costs: start nodes and small ones 1, notables (the middle nodes) 2, keystones (the major nodes at the end) 3. */
export const nodeCost = (kind: NodeKind): number => (kind === 'keystone' ? CFG.skillCostKeystone : kind === 'notable' ? CFG.skillCostNotable : 1);

/** The summed modifiers of a set of nodes, kept inside the limits of MODS. Unknown ids are ignored. */
export function aggregate(ids: Iterable<string>): Mods {
  const sum: Mods = {};
  for (const id of ids) { const n = NODE_BY_ID.get(id); if (n) for (const [k, v] of Object.entries(n.mods)) sum[k as ModKey] = (sum[k as ModKey] ?? 0) + v!; }
  for (const [k, v] of Object.entries(sum)) {
    const cap = MODS[k as ModKey].cap;
    sum[k as ModKey] = Math.round((cap ? Math.min(cap[1], Math.max(cap[0], v!)) : v!) * 1e6) / 1e6;
  }
  return sum;
}

/** One modifier as text: "+4% gold from hunts", "-15% Defence", "+6 Strength". */
export function modText(key: ModKey, v: number): string {
  const m = MODS[key], sign = v < 0 ? '-' : '+', a = Math.abs(v);
  if (m.type === 'flat') return `${sign}${a} ${m.label}`;
  const pct = Math.round(a * 1000) / 10;
  if (key === 'huntFail' || key === 'huntTown' || key === 'dungeonDrop') return `${sign}${pct} percentage points ${m.label}`;
  return `${sign}${pct}% ${m.label}`;
}
export const nodeText = (n: SkillNode): string[] => (Object.entries(n.mods) as [ModKey, number][]).map(([k, v]) => modText(k, v));

/** True when every node in `ids` can be reached from the start node through nodes in `ids` (a build must stay in one piece). */
export function isConnected(ids: Set<string>, start: string | undefined): boolean {
  if (!ids.size) return true;
  if (!start || !ids.has(start)) return false;
  const seen = new Set([start]), queue = [start];
  while (queue.length) for (const n of NODE_BY_ID.get(queue.pop()!)!.links) if (ids.has(n) && !seen.has(n)) { seen.add(n); queue.push(n); }
  return seen.size === ids.size;
}

/** The region a build leans on most (for the title under the character's name), by number of nodes. */
export function dominantRegion(ids: Iterable<string>): Region | undefined {
  const count = new Map<string, number>();
  for (const id of ids) { const n = NODE_BY_ID.get(id); if (n && REGIONS.some((r) => r.key === n.region)) count.set(n.region, (count.get(n.region) ?? 0) + 1); }
  const best = [...count].sort((a, b) => b[1] - a[1])[0];
  return best && REGIONS.find((r) => r.key === best[0]);
}

/** What the browser needs to draw the board (static: the same for everybody). */
export const boardForClient = () => ({
  regions: REGIONS, origins: ORIGINS,
  nodes: NODES.map((n) => ({ id: n.id, name: n.name, kind: n.kind, cost: nodeCost(n.kind), region: n.region, x: n.x, y: n.y, links: n.links, text: nodeText(n) })),
});
