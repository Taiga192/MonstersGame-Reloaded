# MonstersGame – Mechanics Reference

Sources: official manual (moonID, `index.php?ac=anleitung`), community guide, MMOGames/Codex Gamicus.
**[DOCUMENTED]** = stated by the manual/guides. **[ASSUMED]** = not published; my approximation, tunable in `src/core/config.ts`.

## Races
Vampire vs Werewolf. You can only raid the opposite race. Clans are same-race only. [DOCUMENTED]

## Attributes
Strength (damage), Defense (block/evade), Agility (hit chance), Stamina (damage mitigation),
Dexterity (find opponents during search; reduces enemy hideout bonus), Health, Experience/Level. New characters start with 5 in each main stat. [DOCUMENTED]
Training cost: `(current value)² - 5` gold. [DOCUMENTED by guide]

## Health
+10 HP/hour regeneration. Battle is lost when HP < 10. Below 25 HP you can neither attack nor be attacked. Minimum HP 1. Potions: heal to full, +stats for 1h, +10 max HP permanent (**Vitality Potion: at most +150 max HP in total from potions**, i.e. 15 potions; potions in the bag count against the cap and cannot be bought or traded for beyond it; level-up HP is separate). [DOCUMENTED, cap is a DESIGN DECISION]

## Raids (PvP)
- Attack cooldown: **10 min** for everyone (original: 15 min basic / 5 min premium; premium removed and the value set to 10 min in this replica). [DESIGN DECISION]
- **Safe while away:** a character that is hunting, working in the graveyard or inside the dungeon cannot be found or attacked (in raids and in clan wars). [DESIGN DECISION]
- Same opponent: 1 attack per 12 h (clan war: 4 per 12 h). 1 h protection after being attacked. [DOCUMENTED]
- Winner takes 5–10 % of loser's current gold. [DOCUMENTED]
- XP: same level 1 (win or lose); losing to higher level 1; beating higher level 2. [DOCUMENTED]
- Search/discovery uses Dexterity vs target hideout. [DOCUMENTED, formula ASSUMED]
- Combat round formulas, level curve. [ASSUMED]

## Hunts (manhunt) — CHANGED from the original
3 h/day budget (original: 1 h, 2 h premium), run in real time in 10 min portions; the character is locked while hunting and can cancel (completed portions pay out, unused time is refunded).
Each portion: village 50 % (2 XP, ~8–15 gold), small town 35 % (+100 %), large town 15 % (+250 %); gold scales with level. [DESIGN DECISION]

## Victim link (bite)
Bite gives 1–3 gold (blood/flesh). Recruit bonus: 50 gold + 1 XP when referred character hits level 3. [DOCUMENTED]

## Hideout
Surroundings 0–7, Path 0–10, Wall 0–12, Building 0–23. Adds defense when at home and lowers enemy discovery chance. [DOCUMENTED max levels; costs ASSUMED]

## Town
- Store (weapons/armor/rings/amulets(Lv30+)/potions), sells back at 50 %. [DOCUMENTED]
- Sentinels: unlock Lv5, 40+ types, add Atk/Def/Sta; training cost per point 1,4,9,…; dismissal refunds price, not training; sell at full price. [DOCUMENTED]
- Graveyard: work up to 48 h per shift (original 12 h), locked from all other actions incl. hunting; can quit early for pro-rata wages. No blood-crystal drops. [DESIGN DECISION]

## Ancestral Site
Unlock Lv20; challenge once/24 h with escalating fee; 4 abilities per race (+5 to a stat per ability level); learn 1 at Lv20, 2 at 40, 3 at 60, 4 at 80; only active if both fighters ≥ Lv20. [DOCUMENTED]

## Clans
Create at Lv3; same race; domicile +5 member slots per level (donations); wars need ≥5 attackers, roster snapshot at declaration, 4 attacks/12 h, peace / ceasefire / capitulation. [DOCUMENTED]

## Arena
Duels (2) and tournaments (4/8/16). Level 5+. Creator sets skill band (±% of own skill average `(STR+DEF+AGI+STA+DEX)/5`), entry fee, registration time (10 min–3 days) and which groups count (equipment incl. accomplishments / sentinels / ancestral). Stats are frozen at registration; potions never count. Fees are escrowed and refunded on cancel/expiry.
Full events start automatically at ~21:00 UTC. Duel winner takes the pool (= 2 fees); tournaments pay 70 % winner / 30 % finalist. [DOCUMENTED, tournament split ASSUMED]
Points: ~300 per win, ~100 per loss, scaled by relative strength (upsets pay up to 2×). All-time points decay 2 %/day; 10 ranks (10 lowest…2 by thresholds, rank 1 only for the top player); personal trend = moon phase of the last-30-day win rate; monthly seasons, top 3 get a title + mail. [DOCUMENTED structure, numbers ASSUMED]
Arena fights never touch real HP/gold/W-L.

## Accomplishments
12 accomplishments earned automatically from lifetime counters (5 tiers each). Up to 5 sets of 5; exactly ONE set is active (the original's second set was a premium perk) and only its bonuses apply. Bonuses: +stat, +raid gold %, +hunt reward %, +work wage %. Cannot switch sets while busy. [DOCUMENTED structure, content ASSUMED]

## Blood Temple / weapon hardening — CHANGED
The original used blood crystals; they do not exist here. Blood Temple is a player-to-player item market (list at any price, 5 % temple fee, 7-day expiry, hardening travels with the item). Weapon hardening costs gold (25 % of price × (level+1)), +2 Strength per level, max +10. [DESIGN DECISION]

## Clan administration
Delegable permissions: recruit, kick, war, treasury, forum (leader has all). Clans can be open or application-only. Forum: threads, replies, pin/lock/delete for moderators, authors delete their own posts. Officers cannot kick other officers. [DOCUMENTED: flexible admin rights; details ASSUMED]

## Mail & highscores
Private messages (2000 chars, 20/hour), system messages for arena/market/clan events. Highscores: level, raid wins, gold looted, hunter, gravedigger, arena season/all-time, clans; race filter; public profiles (no gold/HP/stats shown). [DOCUMENTED]

## Dungeon
NEW, not in the original game. An endless ladder; see README. Wait between fights: 2 minutes after every victory (`dungeonFightCooldown`). Checkpoints every 25 levels (`dungeonCheckpoint`): the weekly reset returns you to the highest one you reached. The weekly ladder only lists players who fought this week. Rules: dungeon HP separate from real HP (full at entry, no regeneration); one monster per level with stronger stats every level; XP `3 + 0.4 x level` (guardians x3); 25 % drop chance of a loot item worth `15 + 4 x level^1.15` (x0.8-1.2); every 10th level a guardian with a 1-of-3 reward worth 4-8x an ordinary drop; death keeps XP and items; progress saved on leave/death and wiped every Monday 00:00 UTC (loot kept, an unclaimed guardian reward is auto-claimed); loot is sold to the relic dealer only outside the dungeon; inside you cannot be raided or do anything else; 24 hour re-entry cooldown after leaving or dying (one run per day, counted from leaving/dying; an idle-expired run counts from the last action); an idle run ends after 30 min. [DESIGN DECISION, numbers ASSUMED]

## Premium / Blood Crystals
Removed in this replica by design (no premium accounts, no crystals).

## World settings (admin page, not in the original game)
Every rate and cooldown is a runtime setting (`src/core/settings.ts`). The XP multiplier applies to all XP, the gold multiplier to hunting, graveyard wages, the relic dealer and victim-link bites (never to gold taken from other players). Wipes reset characters to the start values and delete all other game data.

## Skill board
NEW, not in the original game. `src/data/skill-board.ts` generates the board (7 regions x (start node + 3 arms of 10 + keystone), 7 hubs, and 21 arcs of plain attribute nodes with a notable in the middle joining neighbouring regions) from a few tables; `src/game/character/skills.ts` handles spending. Every node is a set of modifiers; their sum is stored on the player row (`players.skill_mods`) and read by the rules through `modsOf()`. Maximum health from nodes is stored in `max_hp` (like level-ups). Caps keep chances sane (see `MODS` in `src/data/skill-board.ts`).

## Equipment and balance
Gear, prices, pacing targets and the measurements behind them are in [BALANCE.md](BALANCE.md).
