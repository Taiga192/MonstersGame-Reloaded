// Monte-Carlo balance check: node scripts/balance.ts
import { simulate } from '../src/game/combat/combat.ts';
import { seeded } from '../src/core/rng.ts';

const N = 4000;
const rng = seeded(42);
const fighter = (m: number, hp = 100) => ({ name: 'x', hp, maxHp: hp, stats: { str: 10 * m, def: 10 * m, agi: 10 * m, sta: 10 * m, dex: 10 } });
function rate(a: ReturnType<typeof fighter>, b: ReturnType<typeof fighter>) {
  let w = 0,
    rounds = 0;
  for (let i = 0; i < N; i++) {
    const r = simulate(a, b, rng);
    if (r.winner === 'a') w++;
    rounds += r.rounds;
  }
  return `${((w / N) * 100).toFixed(1)}% win, ${(rounds / N).toFixed(1)} rounds`;
}
console.log('equal stats, attacker strikes first:');
for (const [m, hp] of [
  [0.5, 100],
  [2, 150],
  [8, 300],
])
  console.log(`  stats x${m}, hp ${hp}:`, rate(fighter(m, hp), fighter(m, hp)));
console.log('attacker with stats x1.1 / x1.25 / x1.5 vs x1:');
for (const m of [1.1, 1.25, 1.5]) console.log(`  x${m}:`, rate(fighter(m), fighter(1)));
console.log('defender is x1.1 / x1.25 stronger:');
for (const m of [1.1, 1.25]) console.log(`  x${m}:`, rate(fighter(1), fighter(m)));
