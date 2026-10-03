// Generates docs/assets-manifest.json + docs/ASSETS.md (art bible, filenames, sizes, prompts) and prints progress.
//   node scripts/assets.ts            write docs + show have/missing per group
//   node scripts/assets.ts --missing  also list every missing file
import { mkdirSync, writeFileSync } from 'node:fs';
import { ACCOMPLISHMENTS, ANCESTRAL, CFG, ITEMS, SENTINELS } from '../src/config.ts';
import { listAssets } from '../src/assets.ts';
import { GUARDIANS, MONSTERS } from '../src/dungeon-data.ts';

export type Kind = 'icon' | 'scene' | 'plain' | 'tile' | 'badge' | 'backdrop';
export interface Asset { id: string; group: string; priority: 1 | 2 | 3; w: number; h: number; transparent: boolean; subject: string; prompt: string; used: string; kind: Kind }

// ---------- art bible ----------
const STYLE = 'dark gothic fantasy, painterly digital illustration, deep crimson and violet palette with warm amber highlights, moody rim lighting, rich detail, cohesive game art style, no text, no watermark, no signature';
const ICON = 'single centered subject, isolated on a transparent background, slight three-quarter view, soft top-left lighting, clean silhouette readable at 64px, game inventory icon';
const SCENE = 'wide cinematic composition, atmospheric depth, empty calmer area on the left for a title overlay';
const TILE = 'single fixed establishing shot, whole subject visible and centered, atmospheric depth, no title space needed';
const BADGE = 'flat front-facing symmetrical emblem or graphic, isolated on a transparent background, bold readable silhouette, clean shapes that still read at small sizes, no perspective';
const BACKDROP = 'dark, low-contrast full-bleed backdrop with no strong focal point in the center, so page text stays readable on top';
const NEG = 'text, letters, watermark, logo, frame, border, blurry, low quality, extra limbs, cropped subject, photo, 3d render';

const assets: Asset[] = [];
function add(group: string, id: string, w: number, h: number, transparent: boolean, subject: string, priority: 1 | 2 | 3, used: string, kind: Kind = transparent ? 'icon' : 'scene') {
  const tech = { icon: ICON, scene: SCENE, tile: TILE, badge: BADGE, backdrop: BACKDROP, plain: 'seamless tileable texture, subtle, low contrast so text stays readable on top' }[kind];
  assets.push({ id, group, priority, w, h, transparent, subject, used, kind, prompt: `${subject}. ${tech}. ${STYLE}.` });
}

// ---------- brand & backgrounds (priority 1: makes the page feel alive) ----------
add('Brand', 'brand/logo', 640, 160, true, 'Game logo emblem: a bat wing and wolf claw crossing behind a crescent moon, wordless emblem (text is added by the page), horizontal composition', 1, 'Header (replaces the text title)', 'badge');
add('Brand', 'brand/favicon', 256, 256, true, 'Simple bold emblem of a crescent moon with a bat silhouette, high contrast, works at 32px', 1, 'Browser tab icon', 'badge');
add('Brand', 'brand/hero', 1600, 900, false, 'A vampire and a werewolf facing each other across a moonlit gothic town street, dramatic full moon, fog', 1, 'Login screen hero');
add('Backgrounds', 'bg/site', 1920, 1080, false, 'Very dark moody night sky with distant gothic rooftops silhouette and faint mist, almost black, low detail near the center', 1, 'Whole page background (fixed)', 'backdrop');
add('Backgrounds', 'bg/header', 1920, 160, false, 'Narrow strip of a night skyline with a crescent moon and drifting bats, very dark', 1, 'Header bar background', 'backdrop');
add('Backgrounds', 'bg/card', 512, 512, false, 'Dark worn parchment or stone texture, tileable, low contrast', 2, 'Panel/card texture (optional, tileable)', 'plain');
add('Backgrounds', 'bg/vampire', 1920, 1080, false, 'Vampire realm backdrop: gothic castle spires, blood-red moon, bats, deep crimson mist', 2, 'Page background for vampire characters', 'backdrop');
add('Backgrounds', 'bg/werewolf', 1920, 1080, false, 'Werewolf realm backdrop: misty pine forest, huge amber full moon, claw marks, warm amber fog', 2, 'Page background for werewolf characters', 'backdrop');
add('Backgrounds', 'ui/divider', 800, 32, true, 'Thin ornamental gothic divider line with a small central bat or moon motif', 3, 'Section divider (optional)', 'badge');

// ---------- races ----------
for (const [r, d] of [['vampire', 'an elegant, pale, sharp-featured vampire lord with glowing red eyes and a high-collared dark coat'], ['werewolf', 'a powerful snarling werewolf mid-transformation with amber eyes, torn clothes and scarred fur']] as const) {
  add('Races', `races/${r}`, 512, 512, true, `Character portrait, bust shot of ${d}`, 1, 'Overview, profile, register form', 'icon');
  add('Races', `races/${r}_emblem`, 128, 128, true, `Small heraldic emblem for the ${r} race`, 2, 'Badges, lists', 'badge');
}

// ---------- page banners (wide, one per page/tab) ----------
const banners: [string, string][] = [
  ['login', 'Gothic gates opening onto a moonlit street, a vampire silhouette on one side and wolf eyes glowing on the other'],
  ['overview', 'A lone hunter standing on a rooftop overlooking a moonlit gothic city'],
  ['raid', 'Dark alley ambush, claws and fangs clashing in moonlight, motion blur'],
  ['hunt', 'Predator stalking through foggy village streets at night, lantern light in the distance'],
  ['store', 'A dim gothic merchant stall with weapons, armor and glowing potions on display'],
  ['inventory', 'An open ornate chest overflowing with gothic weapons, rings and potions'],
  ['temple', 'A blood temple altar with candles and an ornate bazaar of relics offered for trade'],
  ['sentinels', 'A pack of monstrous guardian creatures waiting in a stone hall'],
  ['graveyard', 'A moonlit graveyard with a gravedigger, crooked headstones and a shovel'],
  ['hideout', 'A fortified gothic hideout on a hill with walls, path and gloomy trees'],
  ['ancestral', 'Glowing ancestral spirits emerging from an ancient standing-stone circle'],
  ['arena', 'A blood-stained stone colosseum at night, roaring crowd silhouettes and torches'],
  ['achievements', 'A trophy hall with banners, medals and glowing relics'],
  ['clan', 'A war council table with maps and banners inside a dark castle hall'],
  ['dungeon', 'A torch-lit stone archway descending into a vast dark dungeon, glowing eyes in the shadows, ancient chains and bones'],
  ['dealer', 'A shady relic dealer’s counter in a candlelit cellar, glittering trinkets, gold scales and a hooded merchant'],
  ['war', 'A war room: a general’s table with a map, banners of two clans, a raven and torches, tension before battle'],
  ['forum', 'A candlelit study desk with scrolls, quills and sealed letters'],
  ['mail', 'A raven carrying a sealed letter across a moonlit sky'],
  ['reports', 'A war table with battle reports, daggers and a blood-stained map'],
  ['highscore', 'A grand hall of fame with carved names, statues and a towering throne'],
  ['profile', 'A dark portrait gallery with candles'],
  ['bite', 'A lone frightened villager on a foggy road at night, seen from a predator eye view'],
  ['skills', 'A vast night sky of glowing constellations connected by thin lines of light, like a map of destinies above a gothic city'],
  ['shrine', 'A moss-covered blood shrine in a dark forest clearing at dusk, candles, bones and a glowing basin of crimson liquid'],
];
for (const [k, s] of banners) add('Banners', `banners/${k}`, 1200, 240, false, s, k === 'login' || k === 'overview' || k === 'raid' || k === 'hunt' ? 1 : 2, `Top banner of the ${k} page`);

// ---------- navigation & UI icons ----------
const nav: [string, string][] = [['overview', 'a hooded figure bust'], ['raid', 'crossed dagger and claw'], ['hunt', 'a glowing predator eye'], ['dungeon', 'a torch-lit archway leading down into darkness'], ['town', 'a gothic house with a lantern'],
  ['hideout', 'a fortified tower'], ['ancestral', 'a glowing standing stone'], ['arena', 'crossed swords over a round arena'], ['acc', 'a trophy medal'],
  ['skills', 'a glowing constellation of connected stars'], ['clan', 'a war banner on a pole'], ['mail', 'a sealed envelope with a wax seal'], ['messages', 'a battle report scroll'], ['highscore', 'a crown']];
for (const [k, s] of nav) add('Navigation icons', `nav/${k}`, 64, 64, true, `Menu icon: ${s}`, 1, 'Header menu');
const stat: [string, string][] = [['str', 'a clenched fist'], ['def', 'a shield'], ['agi', 'a winged boot'], ['sta', 'a beating heart in armor'], ['dex', 'a magnifying eye']];
for (const [k, s] of stat) add('Stat & resource icons', `icons/stat_${k}`, 64, 64, true, `Stat icon: ${s}`, 1, 'Attributes table');
for (const [k, s] of [['loot', 'a glittering jeweled relic (a trophy dropped by a dungeon monster)'], ['gold', 'a small pile of gold coins'], ['hp', 'a red heart'], ['xp', 'a glowing star crystal'], ['level', 'an ornate level badge'], ['clock', 'a gothic hourglass'], ['trophy', 'a trophy cup'], ['sword', 'a single sword']] as const)
  add('Stat & resource icons', `icons/${k}`, 64, 64, true, `Resource icon: ${s}`, 1, 'Status displays');
for (let i = 0; i < 5; i++) add('Stat & resource icons', `icons/moon_${i}`, 64, 64, true, `Moon phase icon, phase ${i + 1} of 5 from new moon (${i}) to full moon (${i === 4 ? 'full' : i === 0 ? 'dark' : 'partial'})`, 2, 'Arena win-rate trend');
for (let r = 1; r <= 10; r++) add('Arena', `ranks/rank_${r}`, 128, 128, true, `Rank ${r} emblem, ${r === 1 ? 'the single legendary crown-and-wings emblem, gold' : r <= 3 ? 'gold ornate' : r <= 6 ? 'silver' : 'bronze'} heraldic badge, higher rank looks grander`, 2, 'Arena rank badge', 'badge');
add('Arena', 'ranks/unranked', 128, 128, true, 'Plain grey unranked badge with a question mark', 3, 'Arena, unranked', 'badge');
add('Arena', 'arena/duel', 128, 128, true, 'Two crossed swords', 3, 'Duel events', 'badge');
add('Arena', 'arena/tournament', 128, 128, true, 'A tournament bracket trophy', 3, 'Tournament events', 'badge');
add('Clan', 'clan/emblem', 256, 256, true, 'Generic clan banner emblem, a shield with a bat and wolf, blank field for player customization', 3, 'Default clan emblem', 'badge');
add('UI', 'ui/working', 256, 256, true, 'A gravedigger silhouette with a shovel', 3, 'Busy state: working');
add('UI', 'ui/hunting', 256, 256, true, 'A prowling predator silhouette', 3, 'Busy state: hunting');
add('UI', 'ui/empty', 256, 256, true, 'An empty coffin, sad and dusty, for empty lists', 3, 'Empty states');

// ---------- hunting scenes ----------
for (const [k, s] of [['village', 'A tiny sleepy village of a few thatched huts at night, a lit window'], ['small_town', 'A modest walled town with a church, market square and lit windows'], ['large_town', 'A large bustling gothic city with towers, bridges and thousands of lights']] as const)
  add('Hunting', `hunt/${k}`, 600, 300, false, s, 1, 'Hunt page and hunt results', 'tile');
add('Hunting', 'hunt/nothing', 600, 300, false, 'Empty foggy street, the trail has gone cold', 3, 'Failed hunt portion', 'tile');

// ---------- item icons (generated from the catalog) ----------
// 25 materials, from rusty iron to world-ending: the look of gear tier N (one tier every 4 levels)
const MATERIAL = ['rusted iron', 'plain steel', 'tempered steel', 'silvered', 'runed', 'crimson-etched', 'obsidian', 'moonlit silver', 'hellforged', 'bone-white', 'blood-quenched', 'shadow-forged', 'starmetal', 'dragonbone', 'abyssal black', 'eclipse-lit', 'ember-veined', 'frost-wrought', 'storm-bound', 'soul-bound', 'wraith-touched', 'sunless', 'titanic', 'godslayer', 'world-ending'];
const SHAPE: Record<string, string[]> = {
  Blade: ['shortsword', 'sword', 'falchion', 'longsword', 'broadsword', 'greatsword', 'claymore'], Plate: ['breastplate', 'cuirass', 'chest armor', 'war plate', 'knight armor', 'bastion plate'],
  Hide: ['pelt cloak', 'leather jerkin', 'studded vest', 'hide armor', 'beast-hide coat', 'fang-adorned mantle'], Talon: ['curved dagger', 'claw blade', 'stiletto', 'hooked talon', 'twin knives'], Gauntlet: ['gauntlet', 'clawed glove', 'armored fist', 'spiked bracer'],
};
const RING_MAT = ['bronze', 'iron', 'silver', 'gold', 'black gold with a gemstone', 'crimson relic metal with a glowing gem', 'moonstone', 'obsidian', 'bone and gold', 'star-silver', 'blood-ruby', 'abyssal', 'sunstone', 'void-glass'];
const PART = { chalice: 'an ornate chalice for blood on a stand', altar: 'a small altar of carved bone with candles', idol: 'a carved wooden idol of a hunting beast with glowing eyes' };
for (const it of ITEMS) {
  const m = /^itm_(Blade|Plate|Hide|Talon|Gauntlet)_(\d+)$/.exec(it.key);
  const rk = /^ring_(stat|battle|hunt)_(\d+)$/.exec(it.key);
  const part = /^shrine_(chalice|altar|idol)_(\d)$/.exec(it.key);
  const might = /^amulet_might_(\d+)$/.exec(it.key);
  let s: string;
  if (m) { const shapes = SHAPE[m[1]]; const t = +m[2] - 1; s = `${MATERIAL[t]} ${shapes[t % shapes.length]}, ${m[1] === 'Blade' || m[1] === 'Talon' ? 'weapon' : m[1] === 'Gauntlet' ? 'hand armor' : 'body armor'}, tier ${t + 1} of 25: ${t < 8 ? 'plain and worn' : t < 16 ? 'finely made with gothic details' : 'ornate, glowing, legendary'}`; }
  else if (rk) s = `${RING_MAT[+rk[2] - 1]} ring, ${{ stat: 'engraved with a stylized eye and wing motif', battle: 'shaped like a grasping claw around a gold coin', hunt: 'set with a tracking eye gem' }[rk[1] as 'stat']}`;
  else if (might) s = `heavy ${MATERIAL[(+might[1] - 1) * 4 + 3]} amulet of might on a thick chain, tier ${might[1]} of 6, a clenched fist motif`;
  else if (part) s = `${PART[part[1] as 'chalice']}, ${part[2] === '1' ? 'simple and worn' : 'ornate, with a faint crimson glow'}`;
  else if (it.key === 'amulet_perfection') s = 'flawless crystal amulet in gold filigree radiating pale light';
  else if (it.key === 'amulet_healing') s = 'green-gem amulet on a silver chain glowing softly';
  else if (it.key === 'potion_heal') s = 'round glass flask of glowing red healing potion with a cork';
  else if (it.key === 'potion_maxhp') s = 'ornate glass vial of golden-green vitality elixir with a swirling glow';
  else s = it.name;
  add('Items', `items/${it.key}`, 256, 256, true, `${it.name}: ${s}`, 2, `Store, inventory, temple (${it.slot})`);
}
for (const [k, s] of [['weapon', 'crossed swords'], ['armor', 'a chest plate'], ['ring', 'a jeweled ring'], ['amulet', 'an amulet on a chain'], ['potion', 'a potion flask'], ['component', 'a blood chalice (shrine parts)']] as const)
  add('Items', `items/cat_${k}`, 64, 64, true, `Category icon: ${s}`, 1, 'Store and inventory category tabs');

// ---------- sentinels ----------
const SENT: Record<string, string> = {
  Hound: 'a lean black guard hound with glowing eyes', 'Rat Swarm': 'a churning swarm of large red-eyed rats', Bat: 'a giant fanged bat with spread wings', Crow: 'a huge one-eyed crow', 'Wolf Pup': 'a snarling wolf pup with oversized paws',
  Raven: 'a spectral raven wreathed in shadow', Jackal: 'a scarred desert jackal', Boar: 'a tusked armored boar', Ghoul: 'a hunched pale ghoul with long claws', Warg: 'a monstrous warg with bristling fur',
  Skeleton: 'an armored skeleton warrior with a rusty blade', Zombie: 'a shambling stitched zombie', Gargoyle: 'a stone gargoyle crouched, cracking open', Imp: 'a small mischievous horned imp with fire in its hands', Banshee: 'a wailing translucent banshee',
  Wraith: 'a hooded wraith with a torn cloak of smoke', Harpy: 'a fierce harpy with talons and feathered wings', Hellhound: 'a burning hellhound with molten cracks', Troll: 'a moss-covered hulking troll', Ogre: 'a brutish ogre with a spiked club',
  Wyvern: 'a two-legged wyvern with a barbed tail', Golem: 'a rune-carved stone golem', Minotaur: 'a bull-headed minotaur with a great axe', Specter: 'a pale flickering specter', Chimera: 'a lion-goat-serpent chimera',
  Basilisk: 'a giant crowned basilisk serpent with glowing eyes', Manticore: 'a winged manticore with a scorpion tail', Revenant: 'a vengeful armored revenant with burning eyes', Wendigo: 'an antlered emaciated wendigo', Lich: 'a robed lich with a crystal staff',
  Cerberus: 'a three-headed hound of the underworld', Hydra: 'a many-headed swamp hydra', Juggernaut: 'a colossal iron-plated juggernaut', Behemoth: 'a mountain-sized behemoth beast', Phantom: 'a towering shadowy phantom knight',
  Djinn: 'a smoky djinn with burning eyes', Kraken: 'a tentacled kraken rising from dark water', Leviathan: 'a serpentine leviathan with glowing scales', Dragon: 'a great crimson dragon coiled, roaring', Archdemon: 'a horned archdemon wreathed in hellfire, the ultimate guardian',
};
for (const s of SENTINELS) add('Sentinels', `sentinels/${s.key}`, 512, 512, true, `Guardian creature "${s.name}": ${SENT[s.name] ?? s.name}, menace increases with tier ${s.key.replace('sen_', '')} of 40`, 2, 'Sentinel market and owned sentinel', 'icon');

// ---------- skill board ----------
add('Skill board', 'skills/board_bg', 1600, 1600, false, 'Background of the skill board: a vast dark night sky with faint nebulae and a very subtle circular pattern in the middle, low contrast so glowing dots and lines stay readable on top', 2, 'Skill board page', 'scene');
for (const [k, s] of [['hunter', 'a predator eye over a village roof'], ['warrior', 'a blood-red war helm'], ['shadow', 'a dagger dissolving into smoke'], ['delver', 'a torch in a dark archway'], ['warden', 'a heavy iron shield'], ['artisan', 'a gravedigger shovel crossed with a hammer'], ['acolyte', 'a chalice of blood']] as const)
  add('Skill board', `skills/region_${k}`, 128, 128, true, `Emblem of the "${k}" skill region: ${s}`, 2, 'Skill board legend', 'badge');

// ---------- hideout ----------
const HIDE: Record<string, { label: string; stages: string[] }> = {
  surroundings: { label: 'Hideout surroundings', stages: ['bare trampled ground with weeds', 'dead shrubs and twisted trees', 'overgrown garden with crooked gravestones', 'thorny hedges and fog', 'ravens on iron lanterns and glowing mushrooms', 'cursed grove with bone totems', 'moonlit sacred grove with statues and drifting mist'] },
  path: { label: 'Hideout path', stages: ['a muddy footpath', 'a packed dirt track', 'a gravel road with torches', 'a cobblestone road', 'a wide flagstone avenue with lanterns', 'a grand avenue lined with statues'] },
  wall: { label: 'Hideout wall', stages: ['a rickety wooden fence', 'a sturdy palisade', 'a low stone wall', 'a tall stone wall with iron spikes', 'a battlemented wall with towers', 'a massive fortress wall with braziers and gargoyles'] },
  building: { label: 'Hideout building', stages: ['a crude hut', 'a wooden cabin', 'a stone cottage', 'a timber-framed house', 'a fortified manor', 'a gothic mansion with towers', 'a castle keep', 'a vast gothic fortress-cathedral'] },
};
for (const [comp, max] of Object.entries(CFG.hideoutMax)) {
  const h = HIDE[comp];
  for (let lv = 1; lv <= max; lv++) {
    const stage = h.stages[Math.min(h.stages.length - 1, Math.floor(((lv - 1) / max) * h.stages.length))];
    add('Hideout', `hideout/${comp}_${lv}`, 512, 384, false, `${h.label}, level ${lv} of ${max}: ${stage}. Same camera angle and composition as every level of this series, each level clearly richer than the previous one`, 3, `Hideout page (${comp} level ${lv})`, 'tile');
  }
}

// ---------- dungeon monsters (ten depth tiers, levels 1-10, 11-20, ...) ----------
MONSTERS.forEach((row, t) => {
  add('Dungeon', `dungeon/monster_${t + 1}`, 512, 512, true, `Dungeon monster for levels ${t * 10 + 1}-${t * 10 + 10} (tier ${t + 1} of 10, ${t === 0 ? 'weak' : t < 4 ? 'dangerous' : t < 7 ? 'terrifying' : 'nightmarish'}): a representative of ${row.join(', ')}`, 2, 'Dungeon page (ordinary monster of that depth)', 'icon');
  add('Dungeon', `dungeon/guardian_${t + 1}`, 512, 512, true, `Dungeon guardian "${GUARDIANS[t]}", boss of level ${(t + 1) * 10}: an imposing, larger and more elaborate creature than the tier ${t + 1} monsters, with a distinct menacing silhouette`, 2, 'Dungeon page (guardian of that depth)', 'icon');
});

// ---------- ancestral, accomplishments ----------
for (const race of ['vampire', 'werewolf'] as const)
  for (const a of ANCESTRAL[race]) add('Ancestral', `ancestral/${a.key}`, 128, 128, true, `Ability icon "${a.name}" for ${race}s (boosts ${a.stat.toUpperCase()})`, 3, 'Ancestral site');
add('Ancestral', 'ancestral/site', 600, 300, false, 'Glowing ancestor spirit rising from ancient stones', 3, 'Ancestral challenge', 'tile');
for (const a of ACCOMPLISHMENTS) add('Accomplishments', `accomplishments/${a.key}`, 128, 128, true, `Achievement medal "${a.name}" (${a.desc})`, 3, 'Achievements page', 'badge');

// ---------- output ----------
const have = listAssets('public');
const missing = (a: Asset) => !(a.id in have);
mkdirSync('docs', { recursive: true });
writeFileSync('docs/assets-manifest.json', JSON.stringify(assets, null, 2));

const groups = [...new Set(assets.map((a) => a.group))];
let md = `# Art asset list\n\nGenerated by \`node scripts/assets.ts\` (do not edit by hand; edit the generator). **${assets.length} images.** Put each file at \`public/assets/<id>.<ext>\` (png, jpg, webp, svg or avif; extension is free, name is exact). The game picks new files up on the next page load and falls back to text/emoji for anything missing.\n\n`;
md += `## Art bible (paste before every prompt / bake into your style model)\n\n- **Style:** ${STYLE}\n- **Icons:** ${ICON}\n- **Scenes/banners:** ${SCENE}\n- **Negative prompt:** ${NEG}\n\n`;
md += `**Workflow tips:** 1) make 6-10 hero images first (logo, hero, one banner, 2 portraits, 3 icons) and lock the look; 2) train a style model (Scenario / Leonardo LoRA) or feed them as references (Flux.2 multi-reference / Midjourney --sref); 3) generate each group in one session with the same settings; 4) export icons with a transparent background at the listed size (generate larger and downscale).\n\n**Priority:** 1 = makes the page feel alive (do first), 2 = core content, 3 = polish.\n\n`;
for (const g of groups) {
  const list = assets.filter((a) => a.group === g);
  md += `## ${g} (${list.length})\n\n| Done | Priority | File | Size | Alpha | Used for | Subject / prompt |\n|---|---|---|---|---|---|---|\n`;
  for (const a of list) md += `| ${missing(a) ? '☐' : '✅'} | ${a.priority} | \`${a.id}\` | ${a.w}×${a.h} | ${a.transparent ? 'yes' : 'no'} | ${a.used} | ${a.prompt.replace(/\|/g, '/')} |\n`;
  md += '\n';
}
writeFileSync('docs/ASSETS.md', md);


// ---------- copy-paste prompts for an image-generating chat AI ----------
const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : a);
const ratio = (a: Asset) => { const g = gcd(a.w, a.h); const r = `${a.w / g}:${a.h / g}`; return r.length <= 7 ? r : `${(a.w / a.h).toFixed(1)}:1`; };
const KIND_CODE: Record<Kind, string> = { icon: 'ICON', scene: 'BANNER', tile: 'TILE', plain: 'TEXTURE', badge: 'BADGE', backdrop: 'BACKDROP' };
const numbered = assets.map((a, i) => ({ ...a, n: i + 1 }));
const wanted = process.argv.includes('--missing') ? numbered.filter(missing) : numbered;
const line = (a: (typeof numbered)[number]) => `${String(a.n).padStart(3, '0')} | ${a.id} | ${a.w}x${a.h} (${ratio(a)}) | ${KIND_CODE[a.kind]} | ${a.subject}`;

const HEADER = `You are the art director and illustrator for a browser RPG called MONSTERSGAME-RELOADED: a dark gothic war between Vampires and Werewolves (text-based PvP game with raids, hunting, a graveyard, an arena and clans). I need a complete, visually consistent set of game images from you. Read everything below first, then start.

# 1. ART BIBLE (applies to EVERY image, never deviate)
- Style: ${STYLE}.
- Look: one shared world. Same palette (deep crimson, violet, near-black, warm amber highlights), same painterly brushwork, same soft top-left key light with cool rim light, same level of detail. An image from item 001 and item 259 must look like the same artist made them on the same day.
- Absolutely no text, letters, numbers, logos, watermarks, signatures or UI frames inside any image (the game adds text itself).
- Avoid: ${NEG}.
- Vampires = pale, elegant, crimson and black, gothic architecture. Werewolves = rugged, amber and grey-brown, forest and moonlight. Neutral things use the shared dark violet look.

# 2. IMAGE TYPES (the TYPE column in the list below tells you which rules apply)
- ICON: ${ICON}. Isolated object/creature, centered, fills about 80% of the frame, no ground shadow, no background. If you cannot output a real transparent background, use a perfectly flat, solid pure magenta (#FF00FF) background with no gradient, no shadow and no magenta anywhere in the subject, so it can be keyed out.
- BANNER: ${SCENE}. Full-bleed scene, no transparency.
- TILE: ${TILE}. Full-bleed scene, no transparency. Images that belong to a numbered series (for example hideout levels) must keep the SAME camera angle, framing and composition, and each step must clearly look richer/grander than the one before.
- BADGE: ${BADGE}. Logos, emblems, rank badges, medals and dividers. Use the same magenta (#FF00FF) rule as ICON if real transparency is impossible.
- BACKDROP: ${BACKDROP}. Full-bleed, no transparency.
- TEXTURE: seamless tileable texture, subtle, low contrast so text stays readable on top. Full-bleed.

# 3. SIZES
Each item lists a target size and aspect ratio. Use exactly that aspect ratio if you can. If your tool only supports certain ratios, use the closest one (for very wide banners use the widest available and keep the important content in the central band so I can crop). Generate at the highest resolution available; I will downscale.

# 4. HOW WE WORK (very important)
- There are ${wanted.length} images in the list below. You cannot do them all in one reply, so work in batches: produce exactly 8 images per reply, in list order, then stop and wait for me to type "next".
- For every image, write one line first: "FILE: <file id> (<number>)" and then the image. The file id is the exact filename I will save it under.
- Do not ask me questions, do not summarize, do not explain your choices. Just produce the batch, then one final line: "Done up to <number>. Type next."
- Before item 001 create nothing else. Start immediately with item 001 after reading this.
- Consistency check: after every 32 images, silently re-read section 1 and correct any drift in palette, lighting or brushwork.
- If I write "redo <number or file id>" regenerate just that image, keeping the same subject but a fresh take. If I write "again from <number>" continue from that number.
- The first images (brand logo, hero and race portraits) set the look for everything else. Keep referring back to them for character designs (the vampire and the werewolf must always be the same two individuals wherever they appear).

# 5. THE LIST
Format: NUMBER | FILE ID | TARGET SIZE (ASPECT) | TYPE | SUBJECT
`;
const FOOTER = '\nStart now with the first item in the list.\n';
mkdirSync('docs/prompts/by-group', { recursive: true });
writeFileSync('docs/prompts/MASTER.md', HEADER + wanted.map(line).join('\n') + '\n' + FOOTER);
let gi = 0;
for (const g of groups) {
  gi++;
  const list = wanted.filter((a) => a.group === g);
  if (!list.length) continue;
  const slug = g.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  writeFileSync(`docs/prompts/by-group/${String(gi).padStart(2, '0')}-${slug}.md`, HEADER.replace(/There are \d+ images in the list below\./, `There are ${list.length} images in the list below (group: ${g}).`) + list.map(line).join('\n') + '\n' + FOOTER);
}
const csv = (v: string) => `"${v.replace(/"/g, '""')}"`;
writeFileSync('docs/prompts/prompts.csv', 'number,file,width,height,transparent,prompt,negative_prompt\n' + wanted.map((a) => [a.n, csv(a.id), a.w, a.h, a.transparent, csv(a.prompt), csv(NEG)].join(',')).join('\n') + '\n');
const done = assets.filter((a) => !missing(a)).length;
console.log(`Wrote docs/ASSETS.md and docs/assets-manifest.json: ${assets.length} images needed, ${done} present.\n`);
for (const g of groups) { const l = assets.filter((a) => a.group === g); console.log(`  ${g.padEnd(24)} ${String(l.filter((a) => !missing(a)).length).padStart(3)}/${l.length}`); }
for (const p of [1, 2, 3] as const) { const l = assets.filter((a) => a.priority === p); console.log(`  priority ${p}: ${l.filter((a) => !missing(a)).length}/${l.length}`); }
const extra = Object.keys(have).filter((k) => !assets.some((a) => a.id === k));
if (extra.length) console.log(`\nFiles in public/assets that no asset uses (typos?): ${extra.join(', ')}`);
console.log(`\nPrompts: docs/prompts/MASTER.md (${wanted.length} images), docs/prompts/by-group/*.md, docs/prompts/prompts.csv`);
if (process.argv.includes('--missing')) console.log('\nMissing:\n' + assets.filter(missing).map((a) => `  [p${a.priority}] ${a.id}  ${a.w}x${a.h}`).join('\n'));
