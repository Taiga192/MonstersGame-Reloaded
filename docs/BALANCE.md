# Balance: targets, measurements, and how to re-check

Everything here was measured with `scripts/progress.ts` (100 bots, virtual time, same rules as the real game) and
`scripts/balance.ts` (combat Monte-Carlo). Bots are a stand-in for active players: they play several sessions a day, hunt, work,
raid, delve, trade and train. Real people will find strategies the bots do not, so treat the numbers as a first calibration and
re-check once real players have played for a few weeks.

```bash
node scripts/progress.ts 150 100 1 30     # days, bots, seed, print every N days  (about 6 minutes; SIM_DB=file.db keeps the database)
node scripts/balance.ts                    # combat fairness
node scripts/dungeon-calibrate.ts          # dungeon depth by character strength
```

## Pace (targets and result, median bot)
| Level | Target | Measured |
|---|---|---|
| 10 | about 4 days | 4-5 days |
| 25 | about 16 days | about 18 days |
| 50 | about 48 days | about 57 days |
| 75 | about 100 days | about 112 days |
| 100 | about 170 days | about 195 days |

Measured with the dungeon wait at 2 minutes and checkpoints every 25 levels (below). Before the checkpoints the curve was about 10 %
faster (level 100 at about 155-165 days). The XP curve (5 x level per level) itself was never changed. Different seeds gave the same
curve within 1-2 levels. Bots of different play styles end up within about 1.4x of each other (hunter 91, balanced 89, leader 84,
brawler 81, worker 72, casual 69 at day 150), so no style is useless and none runs away. To make a world faster or slower use the XP
rate on the admin page.

## Dungeon: wait between fights and checkpoints
* After every victory the next monster needs **2 minutes** (default; 0 switches it off). A character that survives stays inside (locked:
  no hunting, working or raiding) and pays for dungeon XP with time. Bots stay inside and fight once per wait.
* **What actually moves the pace is the checkpoint, not the wait.** Three runs of 100 days, same seed, median level on day 99:
  no checkpoints 76, checkpoints with a 2 minute wait 70, checkpoints without any wait 69. The wait barely matters because a run ends by
  dying after a few levels, long before the minutes add up. The checkpoint matters because a week that starts on level 25 or 50 skips
  the many easy early levels that used to be a cheap XP source (levels cleared per bot dropped by more than half), and deeper monsters
  kill the character sooner. If the dungeon should give more XP again, raise the XP rate or the dungeon XP rather than lowering the wait.
* **Checkpoints** every 25 levels (standing on level 25, 50, 75 ...) are kept across the weekly reset. After 150 days every bot has at
  least checkpoint 25 and about two thirds have 50; the casual and worker styles stay at 25. Depth per week is about 42 (level 60-80
  characters) to 57 (level 80+).
* The weekly dungeon ranking only lists players who fought that week (otherwise a checkpoint on level 50 would already be a score).

## The shrine (idle automation)
Design rules (yours): automation is **always clearly weaker than playing**, nothing can be bought with real money, and people with
little time must be able to progress. So: 60 % of the manual pay, +2.5 % for each of 6 part tiers, **75 % at best**; the usual daily
limits stay (3 h of hunting, one dungeon run); tier I parts are sold in the shop for everybody, tier II parts are found by playing
(large towns, dungeon guardians) or traded; fuel (animal blood) comes from playing, a manual hunt portion or work hour gathers 1 and an
automated hour burns 1, so a little play funds a lot of automation; the tank holds 60 hours (more with Chalices).

Measured (same seed, 150 days, median level on the last day):

| Population | no shrine | with shrine |
|---|---|---|
| active (log in all day) | 86 | 83 |
| low time (play about six times less often) | 52 | 58 |

* An **active** player who uses the shrine instead of a manual away activity loses about 3 %: 75 % of an hour is less than 100 %.
  That is the intended price of convenience; nobody is forced into it.
* For the **low-time** population the median level is about 11 % higher; the better play styles gain 3-7 %, the lowest ones (casual,
  worker) about nothing, because a manual graveyard shift of up to 48 hours already covers a player who logs in every other day at
  100 %. The real gain of the shrine is what cannot be done by hand: a 3 hour hunt **every** day while away for days, and the daily
  dungeon run (needs presence otherwise). Real low-time players, who do not manage their away time as well as the bots do, should gain more.
* Fuel: about a fifth of the low-time shrines are out of blood at any time; the active ones almost never. If low-time players feel the
  shrine stops too often, raise the blood gathered per action or the tank (both on the admin page) before touching the efficiency.
* Tier II parts: each bot found about 8 in 150 days with the first drop rates (1 % per large town, 15 % per guardian), which filled 94 %
  of all slots, so the rates were lowered to 0.6 % and 10 %: a full set takes roughly half a year on average, and the market and
  duplicates matter.

## The skill board
308 nodes, 1 point per level, **costs: start and small nodes 1, notables 2, keystones 3** (see README). The whole board costs 406 points,
so a level 100 character can afford about a quarter of it and it takes level 200+ to reach half. Bots build it with a plan (a class from
their favourite region, then the best notable within reach; keystones only for the style that suits one; a notable or keystone waits
until the points for it are there). Measured, same seed, 150 days, median level on the last day:

| Population | no board | board, 1 point per node | board with costs 1/2/3 |
|---|---|---|---|
| active (log in all day) | 83 | 92 (+11 %) | 90 (+8 %) |

By style with costs (active population): hunter 89 -> 103, balanced 85 -> 91, brawler 81 -> 90, leader 81 -> 85, casual 66 -> 67, worker 69 -> 70.
Bots take 28 % fewer nodes with costs (6,559 instead of 9,105 across 100 bots). A low-time population gained about 7 % in an earlier
measurement (before node costs; not repeated).
* The board speeds levelling up by about a twelfth, so level 100 comes at about day 170, close to the target before the board existed.
  XP bonuses on the board are scaled by 0.7 (`XP_SCALE` in `src/data/skill-board.ts`). If it is too fast or slow, use the XP rate or the points
  per level on the admin page; the notable and keystone prices are settings too.
* **The Hunter is the strongest build for levelling** (+16 %), the Artisan (wages, prices) gives richer characters but no faster levels.
  That is intentional: an economy build trades speed for gold. If you want the Hunter closer to the others, look at the Plunder and
  Tracking arms (`REGION_DEFS` in `src/data/skill-board.ts`).
* What a typical bot ends up with is far from every cap in `MODS`.

## Weekly quests
105 quests, 10 per week (see README). Rewards per finished quest, for a character of level L: gold `2L+10` (easy), `4L+20` (normal), `8L+40` (hard);
XP 3 % / 6 % / 12 % of the XP needed for the next level; or a special reward (10 / 20 / 40 animal blood, 1 / 2 / 4 health potions, or
dungeon loot worth 1.4x the gold). All multiplied by the reward scale on the admin page. Measured (same seed, 150 days, active
population, with the board and shrine): median level on the last day **89 without quest rewards, 92 with them (+3 %)**; the hunter
style 103 -> 105. Active bots finish about six of the ten quests in a week (bots only look at the quests now and then), so the
rewards are worth roughly a tenth of a week's gold and a few percent of its XP: a nice planned extra, not a second income.
If they should matter more or less, change the reward scale; the number of quests per week is a setting too.

## What changed
* **Equipment now carries a character to level 100.** Five gear lines with 25 tiers each (a new tier every 4 levels: Blade/Strength,
  Plate/Defence, Hide/Stamina, Talon/Agility, Gauntlet/Dexterity), 14 Stat Rings, 12 Plunder Rings, 12 Tracker Rings, 6 Amulets of
  Might, and 48 sentinels (was 40, now to level 100). Each line is its own slot, so more lines = more equipment worn at once.
* **Prices:** steep up to tier 10 (unchanged, so the early game feels the same), flatter after that. A pure power curve put the top tiers
  (35,000 gold for one blade) out of reach: characters that get raided cannot hold more than about two days of income (see below).
  Top blade is now 16,000 gold, top sentinel 74,000.
* **Store:** items are grouped by line, and items far above your level are folded away ("Show all").
* **Bots:** save for expensive gear (but keep training with part of the money), and donate to a clan only while it needs money for its
  next level. Before, bots donated 10 % of their gold again and again and 94 % of all gold in the world ended up in clan treasuries
  nobody could use. (That was a bot habit, not a rule of the game; the treasury still has only one use: clan levels.)

## Findings you may want to act on
* **Raiding is the biggest gold flow** (about 16 million gold moved among 100 bots in 150 days, versus about 6 million from graveyard
  work). With a 10-minute raid cooldown a player holds about two days of income at most. If you want saving to be possible, raise the
  raid cooldown, lower the 5-10 % theft, or lengthen the protection after a raid (admin page: raid cooldown, protection, theft).
* **Combat is steep.** With equal strength the attacker wins 52 %; with 10 % more stats 77 %, with 25 % more 95 %. That is how a
  power based game feels, but it means the +-10 level search range matters at high level (10 levels = about 10 % stats).
* **Hunting gives gold, not XP, late in the game.** Hunt XP is flat (2 per portion) while the XP needed per level grows, so at level 90
  the dungeon gives about two thirds of a character's XP and a hunt about a quarter. If you want hunting to stay a way to level, scale
  the XP of a portion with the level (`huntVillage.xp` in `src/core/config.ts`); the XP needed per level is then raised to compensate.
* **Races are even.** Vampires won 56 % of the fights in the first seed, 51 % in the second and 46 % in the third. Nothing in the rules
  differs between the races, so that spread is simulation noise (clan wars, who levels first), not a rule.

## Art
The new equipment is 123 more images (408 in total, see `docs/ASSETS.md`). If that is too much, art can be shared per line and tier
band (for example one Blade image per 5 tiers): the game shows an image only if its file exists.
