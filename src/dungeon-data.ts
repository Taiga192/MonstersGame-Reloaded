// Flavour tables for the dungeon: monsters per depth tier (10 levels each), guardians (every 10th level), loot and relics.

export const TIER_SIZE = 10;
export const tierOf = (depth: number) => Math.floor((depth - 1) / TIER_SIZE);

/** Ordinary monsters: five per tier, cycled by depth. Beyond the last tier the last row repeats (with ever stronger stats). */
export const MONSTERS: string[][] = [
  ['Cave Rat', 'Giant Spider', 'Bone Bat', 'Slime', 'Goblin Scout'],
  ['Skeleton Archer', 'Ghoul', 'Zombie', 'Cave Troll Cub', 'Crypt Crawler'],
  ['Wight', 'Gargoyle', 'Shadow Hound', 'Bog Witch', 'Iron Golem Shard'],
  ['Wraith', 'Ogre Brute', 'Harpy Matron', 'Blood Cultist', 'Stone Basilisk'],
  ['Revenant Knight', 'Vampire Spawn', 'Werewolf Outcast', 'Wyvern Hatchling', 'Bone Colossus'],
  ['Banshee Queen', 'Hellhound', 'Minotaur Warlord', 'Lich Acolyte', 'Chimera'],
  ['Pit Fiend', 'Dread Knight', 'Manticore', 'Abyssal Horror', 'Frost Giant'],
  ['Elder Wraith', 'Behemoth Spawn', 'Nightmare Steed', 'Void Stalker', 'Blood Golem'],
  ['Arch Lich', 'Dragon Whelp Prince', 'Kraken Spawn', 'Doom Herald', 'Phantom King'],
  ['Ancient Wyrm', 'Demon Lord', 'Leviathan', 'Titan of Ash', 'The Hollow God'],
];
/** One guardian per tier, met at levels 10, 20, 30 ... */
export const GUARDIANS = [
  'Gorrak the Gatekeeper', 'Mother Venomfang', 'The Crypt Warden', 'Ashbringer Vhal', 'Lord Ruinmaw',
  'Sister Nightwail', 'Baelgor the Unbroken', 'Old Deathless', 'Queen Umbralis', 'Nyx, Devourer of Weeks',
];

/** Drops: four per tier. Worth more the deeper they were found (value comes from the depth, not the name). */
export const LOOT: string[][] = [
  ['Cracked Fang', 'Rusty Locket', 'Bone Charm', 'Tin Signet'],
  ['Silver Button', 'Tarnished Goblet', 'Jade Bead', 'Old Coin Purse'],
  ['Onyx Pendant', 'Ivory Comb', 'Gilded Skull', 'Amber Brooch'],
  ['Ruby Shard', 'Silk Shroud', 'Gold Torque', 'Sapphire Tear'],
  ['Emerald Idol', 'Bloodstone Ring', 'Runed Chalice', 'Obsidian Mirror'],
  ['Dragon Scale', 'Moonstone Crown Shard', 'Wraith Lantern', 'Star Iron Ingot'],
  ['Demon Horn', 'Soulglass Orb', 'Diamond Eye', 'Phoenix Ash Urn'],
  ['Titan Bone Flute', 'Void Pearl', 'Sunfire Opal', 'Ancient Reliquary'],
  ['Crown of a Dead King', 'Heart of a Star', 'Angel Feather', 'Time-Frozen Rose'],
  ['Godsbane Fragment', 'Eternal Ember', 'World Serpent Scale', 'The Last Coin'],
];

/** Guardian rewards: pick one of three. */
export const RELICS: string[][] = [
  ['Guardian\'s Signet', 'Warden\'s Lantern', 'Goblin King\'s Tooth', 'Miner\'s Lucky Nugget'],
  ['Venom Queen\'s Crown', 'Silk Reliquary', 'Spider Silk Cloak', 'Jeweled Web'],
  ['Warden\'s Key Ring', 'Crypt Lord\'s Seal', 'Gilded Burial Mask', 'Silver Censer'],
  ['Vhal\'s Cinder Heart', 'Ashen Crown', 'Molten Ingot', 'Smoldering Idol'],
  ['Ruinmaw\'s Jawbone', 'Bloodforged Crest', 'Wolf-King Pelt', 'Trophy of the Pack'],
  ['Nightwail Locket', 'Banshee\'s Comb', 'Cursed Mirror', 'Veil of Sorrow'],
  ['Baelgor\'s Chain', 'Unbroken Shield Boss', 'Hellsteel Gauntlet', 'Brand of the Pit'],
  ['Deathless Amulet', 'Withered Crown', 'Bone Throne Shard', 'Ancient Death Mask'],
  ['Umbralis\' Diadem', 'Shadowsilk Gown', 'Crown of Whispers', 'Nightglass Scepter'],
  ['Devourer\'s Maw Jewel', 'Weekbreaker Idol', 'Crown of Ends', 'Nyx\'s Own Eye'],
];

const at = <T>(rows: T[][], depth: number) => rows[Math.min(rows.length - 1, tierOf(depth))];
export const monsterName = (depth: number) => (depth % TIER_SIZE === 0 ? GUARDIANS[Math.min(GUARDIANS.length - 1, tierOf(depth))] : at(MONSTERS, depth)[(depth - 1) % 5]);
export const lootRow = (depth: number) => at(LOOT, depth);
export const relicRow = (depth: number) => at(RELICS, depth);
