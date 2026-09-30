# Running MonstersGame as a real multiplayer game

The game needs **one always-on server process** that owns the database and runs the bots. Static hosts (GitHub Pages, itch.io) cannot do that: they only serve files. So the setup is:

```
 player's browser ──► frontend (static files: itch.io, GitHub Pages, or the game server itself)
        │
        └──HTTPS API calls──► GAME SERVER (this project: Node + SQLite file + bots)  ──► /data (database + backups)
```

* The frontend contains **no secrets and no database access**. Everything in it is readable by every player. The only thing it knows is the server's address.
* **Never put database credentials in the frontend or in a config file that ships with it.** Anyone could read them and delete or steal the whole database. The server is the only thing that talks to the database.
* SQLite (a file on the server's disk) is the right database for this game: it needs no separate database server, and it is fast and simple. MySQL/Postgres would mean rewriting every query for no benefit at this scale.

## 1. Choose where the server runs

| Option | Cost (check current prices) | Notes |
|---|---|---|
| **VPS** (Hetzner CX22, DigitalOcean, ...) | about 4-6 EUR/month | Best value and the simplest mental model. Docker Compose file included. |
| **Fly.io** | about 2-5 USD/month | Needs a small volume; set `TRUST_PROXY=1`; keep exactly one machine that never auto-stops. |
| **Railway** | about 5+ USD/month | Add a volume mounted at `/data`; set `TRUST_PROXY=1`. |
| **Your own PC / Raspberry Pi** | free (electricity) | Must stay on for the bots to play. Use a Cloudflare Tunnel to get a public HTTPS address. |
| Not suitable | | Render's free tier (sleeps after 15 minutes, so the bots freeze), any host without a persistent disk, GitHub Pages / itch.io alone (static files only). |
| Cloudflare Workers + Durable Objects | 5 USD/month plan | Possible in principle, but needs a rewrite of the server, and the free plan allows only 100,000 database writes per day, which 100 active bots would exceed. |

**Run exactly ONE server instance.** The database is a file and the bots live in the process; two instances would fight over both.

## 2. Deploy the server

### A) Your own Linux vServer (recommended)
Follow **[SERVER-HARDENING.md](SERVER-HARDENING.md)**: SSH keys, firewall, Docker, Caddy with HTTPS, backups, monitoring. In short:
```bash
cp .env.example .env && chmod 600 .env     # edit: REGISTRATION_CODE, BOTS, CORS_ORIGINS
docker compose up -d --build               # game on 127.0.0.1:3000 ONLY; Caddy (deploy/Caddyfile) publishes it via HTTPS
```
The container runs as a non-root user with a read-only filesystem; only the `/data` volume is writable. `TRUST_PROXY=1` is set because Caddy is exactly one proxy in front. Security details: [SECURITY.md](SECURITY.md).

### B) Fly.io
```bash
fly launch --no-deploy                 # accept the Dockerfile; do NOT create extra machines
fly volumes create mg_data --size 1    # persistent disk for the database
```
`fly.toml` essentials:
```toml
[env]
  PORT = "3000"
  TRUST_PROXY = "1"
[[mounts]]
  source = "mg_data"
  destination = "/data"
[http_service]
  internal_port = 3000
  force_https = true
  auto_stop_machines = "off"     # the bots must keep running
  min_machines_running = 1
```
```bash
fly deploy
```

### C) Railway
New service from the repo (it detects the Dockerfile) -> add a **Volume** mounted at `/data` -> variables `TRUST_PROXY=1` -> deploy.

## 3. Choose where the frontend lives

**Simplest: served by the game server itself.** Nothing to configure: open the server's URL. No CORS needed.

**Hosted elsewhere (itch.io, GitHub Pages):**
```bash
npm run build:online -- --api https://game.example.com     # -> dist-online/  (frontend only, no engine)
```
* **itch.io:** zip the *contents* of `dist-online/` (so `index.html` is at the root of the zip), create an itch.io project of kind **HTML**, upload the zip, tick "This file will be played in the browser". itch runs uploaded games in an iframe served from its own domains (documentation and forum posts mention `html-classic.itch.zone` and `html.itch.zone`), so the server has to allow that origin:
  `CORS_ORIGINS=https://*.itch.zone`
  **Verify this once with your real upload:** if the game shows "Cross-Origin Request Blocked" in the browser console (F12), the message names the origin itch used; add exactly that origin to `CORS_ORIGINS` (comma separated). itch may change its hosting domains, and I could not test against a real itch.io page.
* **GitHub Pages:** publish `dist-online/` (or adapt the included workflow) and allow your page: `CORS_ORIGINS=https://YOURNAME.github.io`
* The server address must be **https** (the page is https). `http://localhost` is accepted for local testing.

Character data lives on the server, so **clearing browser data only logs you out**: log in again with your name and password and everything is there.

## 4. Settings (environment variables)

| Variable | Default | Meaning |
|---|---|---|
| `HOST` | `127.0.0.1` (`0.0.0.0` inside Docker) | listening address; keep it local behind a proxy |
| `PORT` | 3000 | listening port |
| `REGISTRATION_CODE` | empty | if set, new accounts need this code (private server) |
| `DB_PATH` | `monsters.db` (`/data/monsters.db` in Docker) | the database file: the only thing that must survive |
| `BOTS` | 100 | number of bots (0 = none) |
| `BOTS_RAID_HUMANS` / `BOTS_HUMAN_RAID_CHANCE` | on / 0.3 | may bots raid real players, and how often when they find one |
| `CORS_ORIGINS` | empty | sites allowed to call the API from elsewhere. Exact origin, `https://*.domain` wildcard, or `*`. Empty = same origin only. |
| `TRUST_PROXY` | off | set to `1` behind exactly one reverse proxy / platform edge |
| `RATE_REGISTER_PER_HOUR` / `RATE_LOGIN_PER_10MIN` / `RATE_API_PER_MIN` / `RATE_AUTH_GLOBAL_PER_MIN` | 5 / 20 / 600 / 120 | per address; `RATE_LIMIT=0` turns limits off |
| `BACKUP_DIR` / `BACKUP_EVERY_HOURS` / `BACKUP_KEEP` | `<db folder>/backups` / 6 / 28 | automatic snapshots (0 hours = off) |
| `NODE_ENV` | | set `production`: switches the cheat/test tools off |

## 5. Backups and restoring
* Every 6 hours the server writes a consistent snapshot to the backup folder and keeps the newest 28 (about a week). A final one is taken on a clean shutdown (`SIGTERM`, which Docker/Fly/Railway send on redeploy).
* Backups on the same disk do not protect against losing the disk. **Copy them off the machine** regularly (e.g. `rclone`/`rsync` in a cron job to another provider). For continuous replication look at Litestream.
* **Restore:** stop the server, copy a snapshot over `DB_PATH` (a backup is a normal game database), start the server.

## 6. Updating
`git pull && docker compose up -d --build` (Fly: `fly deploy`). The volume, and so the game, is untouched.

## 7. What is protected, what is not
* Passwords (8-128 characters) are stored as salted scrypt hashes; session tokens are stored hashed, expire after 90 days, and logout really ends them; repeated failed logins lock the account temporarily; `/api/password` changes the password.
* Registration, login and general API use are rate limited per address; requests over 100 KB are refused.
* The test/cheat tools do not exist on a production server.
* Not included: email/password reset, moderation tools, or a CAPTCHA. Rate limits slow abuse down; they do not stop a determined attacker. Player names are only checked for length and characters, not for offensive words.
