// Balance / behaviour simulation: node scripts/simulate.ts [bots=100] [days=14] [seed=1]
// Runs the bot population in virtual time on an in-memory database and prints a report.
import { openDb } from '../src/db/node.ts';
import { botReport, ensureBots, fastForward } from '../src/bots/runner.ts';
import { seeded } from '../src/core/rng.ts';

const [bots, days, seed] = [Number(process.argv[2] ?? 100), Number(process.argv[3] ?? 14), Number(process.argv[4] ?? 1)];
const db = openDb();
const rng = seeded(seed);
const end = Date.UTC(2027, 0, 15, 12);
ensureBots(db, bots, end, rng); // created "now"; fastForward then replays the days before it
const t0 = Date.now();
fastForward(db, days, end, rng, { onProgress: (d) => process.stdout.write(`\rday ${d + 1}/${days}  (${((Date.now() - t0) / 1000).toFixed(0)}s)`) });
console.log(`\nsimulated ${bots} bots x ${days} days in ${((Date.now() - t0) / 1000).toFixed(1)}s\n`);
console.log(JSON.stringify(botReport(db, end), null, 2));
