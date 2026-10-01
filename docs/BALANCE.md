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
  the XP of a portion with the level (`huntVillage.xp` in `src/config.ts`); the XP needed per level is then raised to compensate.
* **Races are even.** Vampires won 56 % of the fights in the first seed, 51 % in the second and 46 % in the third. Nothing in the rules
  differs between the races, so that spread is simulation noise (clan wars, who levels first), not a rule.

## Art
The new equipment is 123 more images (408 in total, see `docs/ASSETS.md`). If that is too much, art can be shared per line and tier
band (for example one Blade image per 5 tiers): the game shows an image only if its file exists.
