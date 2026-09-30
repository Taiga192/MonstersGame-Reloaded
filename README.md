# MonstersGame-Reloaded

Vampire-vs-Werewolf PvP browser RPG, rebuilt as a headless game server.
Stack: TypeScript on Node ≥24 (native type stripping), built-in `node:sqlite`, Hono HTTP API. No native deps.

    npm install
    npm start          # open http://localhost:3000 — playable UI. DB file: monsters.db (DB_PATH to change)
    npm test           # node:test, in-memory SQLite, injected clock + seeded RNG
    npm run test:wasm  # the same suite on SQLite-WebAssembly (the browser engine)
    npm run typecheck

Rules and which numbers are documented vs. assumed: [docs/MECHANICS.md](docs/MECHANICS.md).
All tunables live in `src/config.ts`. Game logic takes `now` and an `rng` as parameters, so everything is testable and replayable.

## The dungeon (a new mechanic, not in the original game)
An endless ladder of monsters. Details: [docs/MECHANICS.md](docs/MECHANICS.md#dungeon).
- **Dungeon HP** is a separate pool, full on entry (= your max HP, whatever your real HP is) and **never regenerating** during a run.
- Each level has one monster, stronger every level (`dungeonMonsterStat` in `src/config.ts`, tuned with `node scripts/dungeon-calibrate.ts`). Winning: XP (3 + 0.4 per level, a village pays 2), **25 % drop chance** of a valuable item, one level deeper. Every **10th level is a guardian**: beat it to choose 1 of 3 high value rewards.
- **Dying costs nothing** (XP and items are kept) but ends the run. Progress is saved when you leave or die and **resets every Monday 00:00 UTC**; loot stays until sold to the **Relic Dealer** (Town). A weekly **Dungeon** highscore ranks levels cleared.
- While inside you cannot be raided and cannot raid, hunt, work, shop or train.
- **One run per day:** a **24 hour cooldown** after leaving or dying (which also means no leave-and-re-enter to refill HP and no free retries), and a run idle for **30 min ends by itself** (the dungeon is not a safe house from raids).
- Bots delve too (fight until dead, claim guardian rewards, sell loot).

## Safety and limits (design decisions)
- **Raid cooldown: 10 minutes.** A character that is **hunting, working or inside the dungeon can't be raided** (search, direct attack and clan-war roster all respect it; protection ends with the activity, or when a hunt is cancelled).
- **Vitality Potions** give +10 max HP each but **at most +150 in total** (15 potions), so high level characters do not snowball. Potions already in your bag count against the cap and can't be bought or traded for beyond it.

## Automatic bots
100 bots play the game around the clock so the world is never empty (`BOTS=0` turns them off, `BOTS=250` for more). They are ordinary players (`is_bot = 1`, no password) and call exactly the same game services as a human's clicks, so they cannot cheat or break rules.
- **Personas** (brawler 25, hunter 25, worker 15, clan leader 10, balanced 20, casual 5) differ in what they train, how often they raid, hunt or work, and how social they are.
- **Behaviour:** short play sessions with gaps, a time zone each (they "sleep" at night), long hunts/graveyard shifts when they go away, otherwise simply logged out (and attackable). They train, buy gear/sentinels, harden weapons, upgrade hideouts, use the ancestral site, pick achievement sets, raid only opponents they can plausibly beat, found and join clans, recruit, accept applications, declare wars, make peace, take part in and create arena events, post on the clan forum, and **trade in the Blood Temple**: they list gear they have outgrown at a price between the shop's buy-back and the replacement cost (hardening included), reprice stale offers 15 % cheaper (sold to the shop once at the floor), and buy other players' listings (humans included) when the item is a real upgrade and clearly cheaper than the shop. Mail addressed to bots is dropped.
- **Real players:** bots raid humans only `BOTS_HUMAN_RAID_CHANCE` (default 0.3) of the time they find one; `BOTS_RAID_HUMANS=0` leaves humans completely alone.
- **They start like real players:** level 1, 5 in every attribute, 100 gold, no history. Their first sessions are spread over the first two hours, and everything they achieve happens in real time while the server runs.
- **Tools:** Test tools → *Bot report / Bots act now / +10 bots*. `node scripts/simulate.ts [bots] [days] [seed]` prints a balance report from a reproducible virtual run on a throwaway in-memory database (a balance tool; the server never fast-forwards anything).

## Playing / testing
Open http://localhost:3000, create a character, and use the **🛠 Test tools** box (bottom right; hidden when `NODE_ENV=production`):
add gold, set your level, full heal, spawn bot opponents, fill your arena event / seed the market / send clan applicants / get mail, and **skip time** (cooldowns, HP regen, work shifts, 24h ancestral).
`node scripts/balance.ts` prints combat win-rate statistics.

## Art assets
`npm run assets` writes [docs/ASSETS.md](docs/ASSETS.md) (art bible, exact filenames, sizes, ready-to-paste prompts, done-checklist) and `docs/assets-manifest.json`, and prints progress (`-- --missing` lists every missing file).
Drop an image at `public/assets/<id>.<png|jpg|webp|svg>` (e.g. `public/assets/items/itm_Blade_1.png`) and reload the page: it appears automatically. Missing images just keep the text/emoji fallback, so you can add art gradually.

### Importing generated art
`npm run art -- <image> <number|id>` (e.g. `npm run art -- ~/Downloads/logo.jpg 001`) or drop several files into `art-inbox/` named `001.jpg`, `002-anything.png` or `brand__logo.png` and run `npm run art -- --dir art-inbox`.
Transparent assets (icons, badges, logos): the flat background colour (magenta) is detected and keyed out with edge matting/despill, the Gemini sparkle is removed, the image is trimmed and fitted to the manifest size, saved as `public/assets/<id>.png`. Full-bleed assets (banners, backdrops, tiles): the sparkle corner is trimmed, the image is cropped to the exact aspect ratio and saved as `.jpg`. Originals are kept in `art-src/`. Needs ImageMagick (`magick`). Then `npm run assets` shows your progress.

## Three ways to run it
| | Multiplayer | Bots | Where the save lives | How |
|---|---|---|---|---|
| **Game server** (recommended) | **yes**, everybody shares one world | 24/7 | on the server (SQLite file + automatic backups) | `npm start`, or Docker: see [docs/DEPLOY.md](docs/DEPLOY.md) |
| **Frontend elsewhere** (itch.io, GitHub Pages) + your server | yes | 24/7 | on the server | `npm run build:online -- --api https://your-server` |
| **Browser-only** (GitHub Pages, no server) | no, single player | only while the tab is open | in the browser (can be lost when site data is cleared; export it) | `npm run build:pages` |

A static site (GitHub Pages, itch.io) can never hold the database or run the bots, and database credentials must never be shipped in a frontend config file; so a shared game always needs the game server. All three run the same rules and the same SQL.

**Public server essentials** (details in [docs/DEPLOY.md](docs/DEPLOY.md)): `NODE_ENV=production` (no cheat tools), `CORS_ORIGINS` for a separately hosted frontend, `TRUST_PROXY=1` behind a proxy, rate limits on register/login, 100 KB request limit, sessions expire after 90 days and logout is real, automatic backups every 6 h plus a final one on shutdown, run exactly one instance. `npm run e2e:online` proves it in real Firefox: separate origins (CORS), progress survives clearing all browser data and a server restart, players share one world.

## Browser-only version (GitHub Pages, single player)
GitHub Pages can only host static files, so there is no server and no database server. This version therefore runs **the whole game inside the player's browser**: the same rules, the same SQLite schema and SQL, and the bots, in a Web Worker. The database is SQLite compiled to WebAssembly, stored in the browser's private file system (OPFS) and saved after every action. It is a **single-player world**: it contains you and the bots, and other people cannot join it (each visitor gets their own world).

**Deploy**
1. Create a GitHub repository and push this project to the `main` branch.
2. In the repository: **Settings → Pages → Build and deployment → Source: GitHub Actions**.
3. The workflow in `.github/workflows/pages.yml` type-checks, runs the tests (on node:sqlite **and** on SQLite-WebAssembly), builds and publishes the site to `https://<user>.github.io/<repo>/`.

**Locally:** `npm run build:pages && npm run preview` then open http://localhost:8080/MonstersGame/ (served from a sub-path without special headers, like GitHub Pages). `npm run e2e` drives the built site in real Firefox: register, play, reload (persistence), a second tab, export / reset / import.

**Things to know**
- **Saves:** live in the browser on that device. The *Game* page (top menu) has *Export save* / *Import save* (a plain SQLite file, also the way to move to another browser or device), *Delete save*, and asks the browser not to evict the data. Clearing site data deletes the save.
- **One tab at a time:** the database can be open in one tab; a second tab shows a clear message.
- **Bots** only play while the game is open (like the Node server only plays while it is running). Number of bots, and whether they may raid you, are set on the *Game* page.
- **Browsers:** current Chrome, Edge, Firefox (111+) and Safari (16.4+). In private/incognito windows the browser may refuse persistent storage; the game then warns that progress is not saved.
- **Test tools** (cheats, time skip) are hidden on the public site; enable them on the *Game* page.
- **Two ways to run the same game:** `npm start` = Node server (`config.js`: `MG_LOCAL = false`, accounts, real multiplayer possible); `npm run build:pages` = browser-only (`MG_LOCAL = true`). The rules live in `src/game/`, `src/bots/` and `src/api.ts` and run unchanged in both; only the database opener differs (`src/db.ts` = node:sqlite, `src/browser/` = WebAssembly).

## Layout
- `public/` – frontend (vanilla JS, no build). `test/ui.test.ts` drives it in jsdom against the real API
- `src/db-core.ts` – browser-safe DB interface, schema, migrations, transactions. `src/db.ts` – node:sqlite opener. `src/browser/` – WebAssembly DB adapter, engine Web Worker, crypto shim. `src/node-app.ts` – API + static files for the Node server, `src/security.ts` – CORS, rate limits, size limit, `src/backup.ts` – database snapshots
- `src/game/` – services: `auth`, `player` (stats/xp/hp), `combat` (pure), `raid`, `economy` (train/store/sentinels/hideout/hunt/work/ancestral), `clan`, `forum`, `arena`, `accomplishments`, `temple`, `mail`, `highscore`
- `src/api.ts` – REST routes (Bearer token); every action runs in one SQLite transaction
- `src/db.ts` – schema + `tx()`

## Status
- [x] Accounts, race, attributes, training, lazy HP regen, XP/levels, recruit bonus
- [x] Raids: search (dex vs hideout), cooldowns, protection, 12h same-opponent rule, gold steal, battle reports
- [x] Store, inventory, potions, rings, amulets; sentinels; hideout; hunts; victim-link bites; graveyard work (cancel = pro-rata pay)
- [x] Ancestral site; clans, domicile, wars (snapshot, 4 attacks/12h, peace/ceasefire/capitulation)
- [x] Design decisions: no premium/blood crystals; one timed activity at a time (work or hunt); hunts 3 h/day; work shifts up to 48 h
- [x] Arena: duels/tournaments (4/8/16), skill bands, escrowed fees, snapshots, 9 PM start, points + daily decay, 10 ranks, 30-day moon trend, monthly seasons + titles
- [x] Accomplishments: 12 auto-earned, 5 tiers each, 5 sets of 5, one active set gives bonuses
- [x] Blood Temple (player market, 5% fee) and weapon hardening (gold, +2 STR/level, max +10)
- [x] Clan admin permissions (recruit/kick/war/treasury/forum), applications, forum (pin/lock/moderate); private mail; highscore variants + public profiles
- [x] Frontend + test tools
- [x] Dungeon (weekly ladder, guardians, loot, relic dealer, bots delve)
- [x] Automatic bots (personas, clans, wars, arena, market, dungeon; they start from zero)
- [ ] Balance pass against real-game data

## Admin page (rates, cooldowns, wipes, speed servers)
An **Admin** entry appears in the menu for admins. There you can change, without touching code and effective immediately:
* **Rates:** an XP multiplier, a gold multiplier (hunting, graveyard work, relic dealer, bites; gold taken from other players is not multiplied) and the XP needed per level.
* **Every cooldown and limit:** raid cooldown, protection, hunt portion and daily hunting time, work shift length, Ancestral Site, dungeon, arena, plus combat, progression, economy and clan numbers (about 60 settings, each with safe limits).
* **Presets:** Normal, Double XP/gold, Speed server (5x with short cooldowns) in one click.
* **Wipe the world:** keep all accounts and reset their characters, or keep only admin accounts. Clans, market, mail, battles, bots and so on are deleted and fresh bots start from level 1. Settings and the audit log survive.
* **Players:** search, edit level / gold / attributes / health, give items, release a stuck character, reset a password, make admin, delete.
* **Announcement** mail to everyone, and a **log** of everything admins did.

**Who is an admin?** Single player (browser build): you, always. Multiplayer server: only players with the admin flag, which you set by hand on the server, so nobody can promote themselves:
```bash
node scripts/admin.ts /data/monsters.db grant MyName      # Docker: docker compose exec game node scripts/admin.ts /data/monsters.db grant MyName
node scripts/admin.ts /data/monsters.db list
node scripts/admin.ts /data/monsters.db revoke MyName
```
On a server, wiping, deleting accounts, resetting passwords and giving admin rights ask for the admin's password again. Settings are stored in the database (only what differs from `src/config.ts`), so they survive restarts and come with backups.
