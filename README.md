# MonstersGame-Reloaded

A gothic browser RPG of **Vampires against Werewolves**: raid the enemy race, hunt, work, delve into a dungeon, join a clan and fight clan wars, all in one shared persistent world that is never empty.

MonstersGame-Reloaded is an independent, unofficial re-implementation of the classic browser game *MonstersGame*, with modern technology and a set of new mechanics: a dungeon, a skill board, weekly quests, an idle shrine, notifications and an admin console. It shares no code or assets with the original and is not affiliated with it.

- **Server-authoritative multiplayer.** One game server owns the world (SQLite), runs the rules and the bots. The browser is only a view.
- **100 bots** play around the clock like ordinary players (hunting, raiding, trading, founding clans) so there is always someone to fight and trade with.
- **Deterministic and tested.** All game logic takes the current time and a random source as parameters. Everything is covered by an automated test suite, and balance is checked with a reproducible simulation of the bot population.
- **Runs three ways:** as a game server, with the frontend hosted elsewhere, or entirely inside the browser as a single-player build.

> In this document **New** marks mechanics that do not exist in the original game, **Changed** marks original mechanics whose rules were modified, and unmarked mechanics follow the original.

## Contents
1. [The game](#the-game)
2. [Mechanics](#mechanics)
3. [Installation](#installation)
4. [Running modes](#running-modes)
5. [Administration](#administration)
6. [Development](#development)
7. [Documentation](#documentation)

---

## The game

You create a vampire or a werewolf. Training your five attributes, equipping gear and growing a hideout make you stronger; raids against the opposite race take gold and give XP; hunting and graveyard work are your safe income. Level by level you earn skill points, join a clan, enter the arena, climb the dungeon and trade in the player market. Only one timed activity runs at a time: while you hunt, work or delve, you cannot be raided, and you cannot do anything else.

There is **no premium currency and no pay-to-win**: every feature of the original that was sold for real money was removed, and every convenience (such as the idle shrine) is deliberately weaker than playing by hand.

## Mechanics

### Core mechanics (from the original game)

| Mechanic | How it works |
|---|---|
| **Races** | Vampire or werewolf. You can only raid the other race; clans are single-race. |
| **Attributes** | Strength, Defence, Agility, Stamina and Dexterity, 5 each at the start. Training costs `value² − 5` gold. Combat is decided by hit chance (Agility vs Defence) and damage (Strength vs Stamina). |
| **Health** | +10 HP per hour. A fight is lost below 10 HP; below 25 HP you can neither attack nor be attacked. Potions heal, boost stats for an hour, or add permanent max HP. |
| **Raids (PvP)** | Search an opponent (Dexterity against their hideout), then attack. The winner takes 5–10 % of the loser's gold; one attack per opponent per 12 h; 1 h protection after being attacked; battle reports for both. |
| **Victim link** | Anyone can bite your link for 1–3 gold. A recruited player who reaches level 3 pays a recruit bonus. |
| **Hideout** | Four upgradeable parts (surroundings, path, wall, building) that add defence at home and make you harder to find. |
| **Store and inventory** | Weapons, armour, rings, amulets and potions. The best usable item of each kind is worn automatically. Items sell back at 50 %. |
| **Sentinels** | Guardian creatures from level 5 that add attack, defence and stamina; trainable; 48 kinds. |
| **Ancestral Site** | From level 20: a daily challenge with an escalating fee that teaches ancestral skills (permanent attribute bonuses, four per race). |
| **Clans** | Founded at level 3. Domicile levels (paid from the treasury) add member slots; delegable permissions (recruit, kick, war, treasury, forum); open or application-only; a clan forum. |
| **Clan wars** | At least five attackers; the roster is fixed at declaration; four attacks per opponent per 12 h; a war room that picks a random enemy of your skill level; peace, ceasefire or capitulation. |
| **Arena** | From level 5: duels and tournaments of 4, 8 or 16. The creator sets skill band, entry fee and which bonuses count; stats are frozen at registration; events start at 21:00 UTC; arena points decay daily; ten ranks; monthly seasons with titles. |
| **Accomplishments** | 12 achievements with five tiers each, earned from lifetime counters. Up to five sets of five; one active set grants bonuses. |
| **Mail and highscores** | Private mail and system messages; highscores for level, raid wins, gold looted, hunting, graveyard, arena, clans and the weekly dungeon, with race filter and public profiles. |

### Changed mechanics

| Mechanic | What is different |
|---|---|
| **Hunting** (Changed) | A real-time activity in 10-minute portions with a budget of **3 hours per day**. Each portion hits a village (50 %), a small town (35 %, +100 % reward) or a large town (15 %, +250 %). The character is locked while hunting and can cancel for a pro-rata payout. |
| **Graveyard work** (Changed) | Shifts of up to **48 hours**, locked against everything else; quitting early pays pro rata. |
| **Raid cooldown and safety** (Changed) | A 10-minute cooldown for everybody. A character that is hunting, working or inside the dungeon cannot be found or attacked (also in clan wars). |
| **Blood Temple** (Changed) | A **player-to-player market** (5 % fee, 7-day listings, hardening travels with the item) instead of the original blood-crystal shop. Weapon hardening costs gold: +2 Strength per level, up to +10. |
| **Vitality Potions** (Changed) | +10 max HP each, but at most **+150 in total** from potions, so high levels do not snowball. |
| **One thing at a time** (Changed) | Hunting, working and the dungeon exclude each other and everything else. |
| **Premium** (Removed) | No premium accounts, no blood crystals. |
| **Gear to level 100** (Changed) | Five gear lines of 25 tiers (Blade, Plate, Hide, Talon, Gauntlet), 14 Stat Rings, 12 Plunder Rings, 12 Tracker Rings, Amulets of Might and 48 sentinels, with a price curve that stays reachable for characters that are raided. |

### New mechanics

#### The dungeon (New)
An endless ladder of monsters, stronger on every level.
- **Separate dungeon health:** full on entry (equal to your max HP) and **never regenerating** during a run. Dying costs nothing, but ends the run.
- **Rewards:** XP that grows with depth, a 25 % chance of a valuable drop, and every 10th level is a **guardian** whose defeat lets you choose one of three high-value rewards. Loot is sold to the **Relic Dealer**.
- **Pace:** after each victory the next monster needs **2 minutes**; one run per day (24-hour cooldown after leaving or dying); an idle run ends itself after 30 minutes. While inside you cannot be raided and cannot do anything else.
- **Checkpoints:** every **25th level** you reach is kept across the weekly reset (Monday 00:00 UTC), which otherwise sends you back to level 1.
- A weekly **Dungeon highscore** ranks levels cleared by players who fought that week.

#### The skill board (New)
Every level gives **1 skill point**, spent on a **board of 308 nodes** (pan and zoom, hover for details, **double-click to learn**).
- **Seven regions**, each with a start node (your class), three arms of ten nodes and a keystone: **Hunter**, **Warrior**, **Shadow**, **Delver**, **Warden**, **Artisan**, **Acolyte**. Hubs and **arcs between neighbouring regions** (plain attribute nodes with a notable in the middle) let a build cross over.
- The first point goes on a start node; every later node has to touch one you own.
- **Costs:** start and small nodes 1 point, **notables 2**, **keystones 3**. The whole board costs about 400 points, so even a level-100 character can afford only a quarter: builds are real choices.
- **Keystones** are huge bonuses with a drawback (for example *Lone Wolf*: +15 % hunting gold and XP, but you lose 20 % more gold when raided).
- Effects cover attributes, health, hunting, wages, raids, the dungeon, XP and gold, prices, the Blood Temple fee, the Ancestral Site and the shrine.
- Taking a node back costs gold (10 per level, only at the end of a branch); resetting the whole board costs 50 gold per level.

#### Weekly quests (New)
A pool of **105 quests** (35 kinds in three difficulties). Every Monday **10 are drawn** (4 easy, 4 normal, 2 hard), the same for everybody and different every week: never two of the same kind, at least six a new character can do, at most three that depend on luck. Nothing is daily, so a week can be planned.
- Progress counts from Monday on. Targets about gold or XP scale with your level.
- A finished quest lets you **choose one of three rewards that grow with your level**: gold, XP, or a special reward (animal blood, health potions or dungeon loot). Unclaimed rewards expire on Monday.

#### The shrine, idle PvE (New)
For players who cannot be online all day. Unlocked at **level 10**, the shrine runs a **routine** of hunting, work and (with an Idol of the Hunt) dungeon runs while you are away, **always clearly weaker than playing by hand**: 60 % of the pay, 75 % at best.
- **Animal blood** is the fuel. Every manual action gathers some on the way; automated hours burn it. The tank size also caps how long the shrine can run unattended.
- **Parts** raise efficiency by 2.5 % each: Blood Chalice (tank), Bone Altar (routine steps), Idol of the Hunt (dungeon automation, then more blood). Tier I is sold in the shop for everybody; tier II is found in large towns and from dungeon guardians, or bought from other players.
- The usual daily limits apply. While it runs you have **no protection** from raids, but a raid takes at most 3 % of your gold. Any manual activity pauses it. Nothing can be bought with real money.

#### Notifications (New)
- A **bell with a counter** in the header and an **alert bar** that stays visible while you scroll. The bar lists what needs you right now (a finished hunt or shift, unspent skill points, finished quests, unread mail, a guardian reward, an empty shrine); chips are links.
- **Notifications** report what happened while you were away: raids against you, market sales, arena results, war declared or ended, clan removal, level-ups, mail, announcements, new quests.
- The page checks every 20 seconds; new events appear as toasts, the bell rings and the tab title shows a count. Desktop notifications are opt-in.

#### Automatic bots (New)
100 bots (configurable) play like real players, using exactly the same game services as a human's clicks, so they cannot cheat or break rules. They start at level 1 with no history; everything happens in real time while the server runs.
- **Personas** (brawler, hunter, worker, clan leader, balanced, casual) differ in training, raiding, working, trading and social behaviour.
- They keep a daily rhythm (they "sleep" at night), hunt, work, delve, trade in the Blood Temple, found and join clans, fight clan wars, spend skill points along a plan and claim quests.
- They raid real players only a fraction of the time they find one (`BOTS_HUMAN_RAID_CHANCE`), or never (`BOTS_RAID_HUMANS=0`).

#### Administration (New)
An **Admin** page with live-tunable rates (XP, gold, level curve), more than 80 cooldowns and limits, presets (including a **speed server**), a **world wipe** for seasons, player editing, announcements and an audit log. See [Administration](#administration).

---

## Installation

**Requirements:** Node.js **24 or newer** (native TypeScript and `node:sqlite`; no native dependencies, no build step for the server).

```bash
git clone <repository-url> monstersgame-reloaded
cd monstersgame-reloaded
npm ci
npm start            # http://localhost:3000
```

Open the address, register, and play. The database is a single file (`monsters.db` in the working directory, set with `DB_PATH`); 100 bots start playing immediately. In development a **Test tools** box (bottom right) lets you add gold, set your level, skip time and spawn opponents; it is switched off when `NODE_ENV=production`.

### Configuration
The server is configured with environment variables:

| Variable | Default | Meaning |
|---|---|---|
| `PORT` / `HOST` | `3000` / `127.0.0.1` | Listening port and address (keep it local behind a reverse proxy). |
| `DB_PATH` | `monsters.db` | The database file: the only state that has to survive. |
| `BOTS` | `100` | Number of bots (`0` = none). |
| `NODE_ENV` | | `production` switches the test tools off. |
| `CORS_ORIGINS` | empty | Sites allowed to call the API (for a separately hosted frontend). |
| `TRUST_PROXY` | off | `1` behind exactly one reverse proxy. |
| `REGISTRATION_CODE` | empty | If set, registering needs this code (private servers). |

More (rate limits, bot options, backups) are in [docs/DEPLOY.md](docs/DEPLOY.md). Game numbers (rates, cooldowns, prices of skill nodes, shrine, quests ...) are **not** environment variables: they are changed live on the admin page.

### Production
`docker compose up -d --build` runs a hardened container (non-root, read-only filesystem, one writable data volume, port bound to localhost only) behind a TLS reverse proxy such as Caddy. A complete walkthrough for a Linux vServer, including firewall, backups and incident handling, is in [docs/SERVER-HARDENING.md](docs/SERVER-HARDENING.md) and [docs/DEPLOY.md](docs/DEPLOY.md). Run exactly **one** instance: the database is a file and the bots live in the process.

---

## Running modes

| Mode | Players | Bots | Where the world lives | How |
|---|---|---|---|---|
| **Game server** (recommended) | Multiplayer, one shared world | 24/7 | On the server, with automatic backups | `npm start` or Docker |
| **Frontend elsewhere** | Multiplayer | 24/7 | On your server | `npm run build:online -- --api https://your-server`, then host `dist-online/` on itch.io or GitHub Pages and add its address to `CORS_ORIGINS` |
| **Browser-only** | Single player | Only while the tab is open | In the browser (private file system), exportable | `npm run build:pages` |

All three run the same rules and the same SQL. A static host can never hold the shared database or run the bots, and database credentials must never be shipped in a frontend file; a shared game therefore always needs the game server.

**Browser-only build (GitHub Pages).** The whole game, including the bots, runs in a Web Worker on SQLite compiled to WebAssembly; the save lives in the browser (export and import on the *Game* page; clearing site data deletes it). To publish: push to `main`, enable *Settings → Pages → Source: GitHub Actions*, and the workflow in `.github/workflows/pages.yml` tests, builds and deploys. Locally: `npm run build:pages && npm run preview`. In this mode you are always the admin.

---

## Administration

An **Admin** entry appears in the menu for administrators. Everything is effective immediately, stored in the database and included in backups:
- **Rates:** XP multiplier, gold multiplier, XP needed per level.
- **Settings:** more than 80 numbers, each with safe limits: every cooldown (raid, hunt portion, work shift, dungeon, Ancestral Site, arena ...), combat, progression, economy, dungeon, skill board, shrine, quests, clans.
- **Presets:** Normal, Double XP/gold, Speed server (5× with short cooldowns).
- **World wipe:** keep all accounts or only admins; clans, market, mail, battles and bots are deleted and fresh bots start at level 1. Settings and the audit log survive: regular wipes and speed servers need no code changes.
- **Players:** search, edit level, gold, attributes and health; give items; release a stuck character; reset a password; promote or delete.
- **Announcements** to every player and a **log** of all admin actions.

On a multiplayer server the admin flag can only be set on the server itself, so nobody can promote themselves; wiping, deleting accounts, resetting passwords and promoting ask for the admin's password again:

```bash
node scripts/admin.ts /data/monsters.db grant MyName
node scripts/admin.ts /data/monsters.db list
node scripts/admin.ts /data/monsters.db revoke MyName
```

---

## Development

```bash
npm test             # the full suite on node:sqlite (in-memory database, injected clock, seeded RNG)
npm run test:wasm    # the same suite on SQLite-WebAssembly (the browser engine)
npm run typecheck
npm run e2e          # real Firefox against the browser-only build
npm run e2e:online   # real Firefox: a server plus a frontend on another origin
```

### Architecture
```
src/
  core/      config (default numbers, catalogs), settings (the live-tunable subset), errors, seeded rng
  data/      static content: skill board generator, weekly quest pool, dungeon data
  db/        schema, migrations and transactions on a small database interface; adapter for node:sqlite
  game/      the rules, all taking `now` and `rng`; every action runs in one SQLite transaction
    character/  players, auth, skills, modifiers, accomplishments, counters
    combat/     raids, wars, arena
    world/      economy, hunting and work, dungeon, shrine, temple (market), quests, blood
    social/     clans, forum, mail, notifications, alerts, highscores
    admin/      the admin actions and the audit log
  api/       the HTTP API (Hono; runs on Node, in a Web Worker or anywhere)
    routes/     one file per feature area; context.ts holds the shared helpers (auth, transactions, body firewall)
  server/    Node entry point: static files, security layer (CORS, rate limits, headers), backups
  browser/   the browser-only build: SQLite-WebAssembly adapter and the engine worker
  bots/      the automatic players: brain.ts runs a session, behavior/ holds what bots do per feature
  tools/     art import
public/      the frontend: vanilla ES modules (js/, js/pages/), no build step
scripts/     balance simulations, admin CLI, build and end-to-end scripts
test/        game/ bots/ api/ ui/ tools/ (UI tests run in jsdom against the real API), support/ helpers
```

### Balance tools
Balance is measured, not guessed. `node scripts/progress.ts 150 100 1 30` runs 100 bots for 150 virtual days on a throwaway database and prints level curves by day and by playing style (about six minutes); `SIM_SET="rateXp=2"` tries a setting, `SIM_TEMPO=6` simulates players who log in less often. `scripts/balance.ts` prints combat win rates, `scripts/dungeon-calibrate.ts` dungeon depth by strength. Results and targets: [docs/BALANCE.md](docs/BALANCE.md).

### Art
The game works without images (text and emoji fallbacks) and shows any image the moment its file exists. `npm run assets` writes the complete list with filenames, sizes and ready-to-paste prompts ([docs/ASSETS.md](docs/ASSETS.md)); `npm run art -- <image> <number|id>` imports generated art (background removal, trimming, fitting).

---

## Documentation

| Document | Contents |
|---|---|
| [docs/MECHANICS.md](docs/MECHANICS.md) | Rules reference: which numbers are documented, which are design decisions, which are assumed |
| [docs/BALANCE.md](docs/BALANCE.md) | Pacing targets, simulation results, findings |
| [docs/DEPLOY.md](docs/DEPLOY.md) | Hosting options, configuration, backups and restore |
| [docs/SERVER-HARDENING.md](docs/SERVER-HARDENING.md) | Step-by-step secure Linux vServer setup |
| [docs/SECURITY.md](docs/SECURITY.md) | Threat model, protections with their tests, residual risks |
| [docs/ASSETS.md](docs/ASSETS.md) | Art bible, filenames, prompts |

---

## License

Released under the [MonstersGame-Reloaded Source-Available License](LICENSE) (based on the MIT License). Copyright (c) 2026 Taiga192.

In short: you may read, use, modify and share the code **for non-commercial purposes**, and you must **credit the project** ("Based on MonstersGame-Reloaded by Taiga192", with a link) in a visible place on every site or app that offers it to other people. **Monetization is not allowed** (no sales, paid access or items, advertising or donations). This makes it source-available, not open source in the sense of the OSI definition. The license text is binding; this summary is not.

It covers the code and documentation of this repository. It does not grant any rights to the name, artwork or other assets of the original *MonstersGame*, with which this project is not affiliated. Dependencies keep their own licenses.
