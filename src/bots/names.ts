import type { Rng } from '../core/rng.ts';
import { randInt } from '../core/rng.ts';

const A = [
  'Dark',
  'Night',
  'Blood',
  'Moon',
  'Shadow',
  'Grim',
  'Iron',
  'Ash',
  'Crimson',
  'Frost',
  'Storm',
  'Raven',
  'Wolf',
  'Bone',
  'Ember',
  'Silent',
  'Hollow',
  'Wild',
  'Cold',
  'Black',
  'Pale',
  'Rust',
  'Thorn',
  'Dusk',
  'Grey',
  'Vex',
  'Nox',
  'Kael',
  'Mor',
  'Zar',
];
const B = [
  'fang',
  'claw',
  'howl',
  'bane',
  'walker',
  'born',
  'thorn',
  'hunter',
  'blade',
  'mane',
  'wing',
  'heart',
  'bite',
  'shade',
  'reaper',
  'stalker',
  'song',
  'fist',
  'eye',
  'sworn',
  'gaze',
  'lord',
  'maw',
  'crow',
  'storm',
  'thar',
  'wyn',
  'gor',
  'dris',
  'lith',
];
const FIRST = [
  'Kaelthar',
  'Morrigan',
  'Ragnar',
  'Selene',
  'Lilith',
  'Fenrir',
  'Vesper',
  'Drusilla',
  'Lycan',
  'Carmilla',
  'Talbot',
  'Nyx',
  'Ulric',
  'Isolde',
  'Bram',
  'Sable',
  'Corvin',
  'Ilse',
  'Garrick',
  'Vera',
  'Lucan',
  'Mira',
  'Dorian',
  'Ysolde',
  'Rurik',
  'Astrid',
  'Cassian',
  'Lena',
  'Viktor',
  'Sasha',
];

/** Plausible, unique player names in a few different "styles" (fantasy name, gamer handle, name+number). Always 3-20 chars. */
export function playerName(rng: Rng, taken: Set<string>): string {
  for (let i = 0; i < 200; i++) {
    const style = rng();
    let n: string;
    const a = A[randInt(rng, 0, A.length - 1)],
      b = B[randInt(rng, 0, B.length - 1)];
    if (style < 0.3) n = FIRST[randInt(rng, 0, FIRST.length - 1)];
    else if (style < 0.6) n = a + b;
    else if (style < 0.75) n = `${a}${b}${randInt(rng, 1, 99)}`;
    else if (style < 0.85) n = `${a.toLowerCase()}_${b}`;
    else if (style < 0.93) n = `${FIRST[randInt(rng, 0, FIRST.length - 1)]}${randInt(rng, 1, 999)}`;
    else n = `xX${a}${b}Xx`;
    if (i > 40) n += randInt(rng, 1, 9999); // ran out of plain combinations
    n = n.slice(0, 20);
    if (n.length >= 3 && !taken.has(n.toLowerCase())) {
      taken.add(n.toLowerCase());
      return n;
    }
  }
  throw new Error('could not generate a unique bot name');
}

const CA = ['Shadow', 'Crimson', 'Iron', 'Night', 'Blood', 'Ash', 'Grim', 'Frost', 'Black', 'Silver', 'Dread', 'Wild', 'Moon', 'Dusk', 'Ebon'];
const CB = ['Pack', 'Court', 'Covenant', 'Legion', 'Brood', 'Hunt', 'Order', 'Fangs', 'Hand', 'Guard', 'Clan', 'Circle', 'Wardens', 'Reavers', 'Kin'];

export function clanName(rng: Rng, taken: Set<string>): string {
  for (let i = 0; i < 100; i++) {
    let n = `${CA[randInt(rng, 0, CA.length - 1)]} ${CB[randInt(rng, 0, CB.length - 1)]}`;
    if (i > 15) n += ` ${randInt(rng, 2, 99)}`;
    if (!taken.has(n.toLowerCase())) {
      taken.add(n.toLowerCase());
      return n;
    }
  }
  throw new Error('could not generate a unique clan name');
}
