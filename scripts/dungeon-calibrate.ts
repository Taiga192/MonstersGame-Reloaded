// How deep do characters get? node scripts/dungeon-calibrate.ts
// For characters with all four fighting stats = p: depth after ONE run (median, 90th percentile) and after many attempts.
import { CFG } from '../src/config.ts';
import { fightMonster, monsterAt } from '../src/game/dungeon.ts';
import { seeded } from '../src/rng.ts';

const rng = seeded(1);
const you = (p: number) => ({ str: p, def: p, agi: p, sta: p, dex: p });
const maxHp = 200;

/** One run from `start`: fight until dead. Returns the depth reached (next level to fight). */
function run(p: number, start: number) {
  let hp = maxHp, depth = start;
  for (let guard = 0; guard < 2000; guard++) {
    const r = fightMonster(you(p), hp, maxHp, monsterAt(depth), rng);
    if (!r.won) return depth;
    hp = r.hpLeft; depth++;
  }
  return depth;
}
const pct = (a: number[], q: number) => [...a].sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(a.length * q))];

console.log('p = each fighting stat; monsters: stat(d) = ' + CFG.dungeonMonsterStat.toString().replace(/\s+/g, ' '));
console.log('One dungeon run per day (24 h cooldown), so a week is at most 7 runs. Depth = levels cleared, saved between runs.');
console.log('   p | monster stat at parity depth | ONE run (from level 1): median  p90 | after 3 runs | after 7 runs (a full week) | after 14 runs (two weeks, no wipe)');
for (const p of [5, 8, 12, 20, 30, 50, 80, 120, 200, 300, 500]) {
  const single = Array.from({ length: 300 }, () => run(p, 1));
  const multi = (n: number) => { const ds: number[] = []; for (let k = 0; k < 20; k++) { let d = 1; for (let i = 0; i < n; i++) d = run(p, d); ds.push(d - 1); } return pct(ds, 0.5); };
  let parity = 1; while (CFG.dungeonMonsterStat(parity) < p) parity++;
  console.log(`${String(p).padStart(4)} | ${String(parity).padStart(4)}                         | ${String(pct(single, 0.5) - 1).padStart(6)}  ${String(pct(single, 0.9) - 1).padStart(4)}                  | ${String(multi(3)).padStart(4)}         | ${String(multi(7)).padStart(4)}                       | ${String(multi(14)).padStart(4)}`);
}
