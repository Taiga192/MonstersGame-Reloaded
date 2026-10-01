// Progression report: node scripts/progress.ts [days=60] [bots=100] [seed=1] [every=5]
// Replays the bots in virtual time and prints, every few days, how far they got (levels, gold, where the XP and gold come from).
import { openDb } from '../src/db.ts';
import { ensureBots, fastForward } from '../src/bots/runner.ts';
import { seeded } from '../src/rng.ts';
import { CFG } from '../src/config.ts';

// SIM_SET="dungeonCheckpoint=100000,rateXp=2" tries a setting without touching config.ts (values in the config's own unit, e.g. milliseconds)
for (const kv of (process.env.SIM_SET ?? '').split(',').filter(Boolean)) { const [k, v] = kv.split('='); (CFG as Record<string, unknown>)[k] = Number(v); }
const [days, bots, seed, every] = [Number(process.argv[2] ?? 60), Number(process.argv[3] ?? 100), Number(process.argv[4] ?? 1), Number(process.argv[5] ?? 5)];
const db = openDb(process.env.SIM_DB || ':memory:'), rng = seeded(seed), end = Date.UTC(2027, 0, 15, 12);
ensureBots(db, bots, end, rng);
const all = (sql: string) => db.prepare(sql).all() as any[];
const pct = (xs: number[], p: number) => xs[Math.min(xs.length - 1, Math.floor(xs.length * p))] ?? 0;
const t0 = Date.now();
console.log('day | level p10 p50 p90 max | gold p50 max | battles | dungeon best | counters (sum over bots)');
fastForward(db, days, end, rng, { stepMin: Number(process.env.SIM_STEP ?? 5), // 5 minutes: as fine as the dungeon's wait between fights
  
  onProgress: (d) => {
    if (d % every !== 0 && d !== days - 1) return;
    const lv = all('SELECT level FROM players WHERE is_bot = 1 ORDER BY level').map((r) => r.level);
    const gold = all('SELECT gold FROM players WHERE is_bot = 1 ORDER BY gold').map((r) => r.gold);
    const c = Object.fromEntries(all('SELECT key, SUM(value) v FROM counters GROUP BY key').map((r) => [r.key, r.v]));
    const bat = all('SELECT COUNT(*) n FROM battles')[0].n, dg = all('SELECT COALESCE(MAX(best_ever), 0) n FROM dungeon')[0].n;
    console.log(`${String(d).padStart(3)} | ${pct(lv, 0.1)} ${pct(lv, 0.5)} ${pct(lv, 0.9)} ${lv[lv.length - 1]} | ${pct(gold, 0.5)} ${gold[gold.length - 1]} | ${bat} | ${dg} | ${Object.entries(c).map(([k, v]) => `${k}:${v}`).join(' ')}`);
  },
});
console.log(`(${((Date.now() - t0) / 1000).toFixed(0)} s)`);

// what the characters look like at the end, by level band
console.log('\nlevel band | bots | base stats avg (str def agi sta dex) | gold avg | items | sentinel | hardening | clan% | raid W/L (as attacker)');
const rows = all(`SELECT p.level, p.str, p.def, p.agi, p.sta, p.dex, p.gold, p.clan_id,
  (SELECT COUNT(*) FROM inventory i WHERE i.player_id = p.id) items,
  (SELECT COALESCE(MAX(hardening), 0) FROM inventory i WHERE i.player_id = p.id) hard,
  (SELECT sentinel_key FROM sentinels s WHERE s.player_id = p.id) sen,
  (SELECT COUNT(*) FROM battles b WHERE b.attacker_id = p.id AND b.winner_id = p.id) w,
  (SELECT COUNT(*) FROM battles b WHERE b.attacker_id = p.id AND b.winner_id != p.id) l
  FROM players p WHERE p.is_bot = 1 ORDER BY p.level`);
const bands = new Map<number, any[]>();
for (const r of rows) { const b = Math.floor((r.level - 1) / 10) * 10 + 1; (bands.get(b) ?? bands.set(b, []).get(b)!).push(r); }
const avg = (xs: any[], k: string) => (xs.reduce((a, r) => a + (r[k] ?? 0), 0) / xs.length).toFixed(0);
for (const [b, xs] of [...bands].sort((a, z) => a[0] - z[0])) {
  const sen = xs.filter((r) => r.sen).map((r) => Number(String(r.sen).split('_')[1]));
  console.log(`${b}-${b + 9} | ${xs.length} | ${['str', 'def', 'agi', 'sta', 'dex'].map((k) => avg(xs, k)).join(' ')} | ${avg(xs, 'gold')} | ${avg(xs, 'items')} | ${sen.length ? (sen.reduce((a, c) => a + c, 0) / sen.length).toFixed(0) : '-'} | ${avg(xs, 'hard')} | ${(100 * xs.filter((r) => r.clan_id).length / xs.length).toFixed(0)} | ${xs.reduce((a, r) => a + r.w, 0)}/${xs.reduce((a, r) => a + r.l, 0)}`);
}
