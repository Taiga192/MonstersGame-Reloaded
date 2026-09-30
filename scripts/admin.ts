// Give or take away the admin flag on a multiplayer server. Works on a running server (the flag is read on every request).
//   node scripts/admin.ts <database file> list
//   node scripts/admin.ts <database file> grant <player name>
//   node scripts/admin.ts <database file> revoke <player name>
// With Docker:  docker compose exec game node scripts/admin.ts /data/monsters.db grant MyName
import { DatabaseSync } from 'node:sqlite';

const [file, cmd, name] = process.argv.slice(2);
if (!file || !['list', 'grant', 'revoke'].includes(cmd ?? '') || (cmd !== 'list' && !name)) {
  console.error('usage: node scripts/admin.ts <database file> list | grant <name> | revoke <name>');
  process.exit(2);
}
const db = new DatabaseSync(file);
db.exec('PRAGMA busy_timeout = 5000');
const cols = (db.prepare('PRAGMA table_info(players)').all() as { name: string }[]).map((c) => c.name);
if (!cols.includes('is_admin')) db.exec('ALTER TABLE players ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0'); // (the server adds it on start as well)

if (cmd === 'list') {
  const rows = db.prepare('SELECT id, name, level FROM players WHERE is_admin = 1 AND is_bot = 0 ORDER BY name').all() as { id: number; name: string; level: number }[];
  console.log(rows.length ? rows.map((r) => `${r.name} (id ${r.id}, level ${r.level})`).join('\n') : 'No admins yet.');
} else {
  const p = db.prepare('SELECT id, name, is_bot FROM players WHERE name = ?').get(name) as { id: number; name: string; is_bot: number } | undefined;
  if (!p) { console.error(`No player called "${name}".`); process.exit(1); }
  if (p.is_bot) { console.error('Bots cannot be admins.'); process.exit(1); }
  db.prepare('UPDATE players SET is_admin = ? WHERE id = ?').run(cmd === 'grant' ? 1 : 0, p.id);
  console.log(`${p.name} is ${cmd === 'grant' ? 'now an admin' : 'no longer an admin'}.`);
}
db.close();
