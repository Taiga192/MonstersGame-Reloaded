import * as skills from '../../game/character/skills.ts';
import * as questsApi from '../../game/world/quests.ts';
import { NODE_BY_ID, NODES } from '../../data/skill-board.ts';
import { loadPlayer } from '../../game/character/player.ts';
import { type Persona } from '../personas.ts';
import { ok, type Ctx } from '../context.ts';

/** Now and then look at the weekly quests and take the reward of every finished one (gold, XP or the special reward). */
export function questTurn(ctx: Ctx, id: number, note: (a: string) => void) {
  const { db, now, rng } = ctx;
  if (rng() > 0.25) return;
  for (const q of questsApi.questState(db, id, now).quests) {
    if (!q.done || q.claimed || q.locked) continue;
    const roll = rng(),
      choice = roll < 0.4 ? 'xp' : roll < 0.8 ? 'gold' : 'special';
    if (ok(() => questsApi.claim(db, id, q.id, choice, now))) note(`quest: ${q.title} (${choice})`);
  }
}

export const KIND_VALUE: Record<string, number> = { small: 1, notable: 4, keystone: 6, origin: 0.6, hub: 0.5, bridge: 1 };
/**
 * Spend free skill points the way a player with a plan does: the first point picks the start node of the persona's favourite
 * region, then every point goes one step along the shortest path to the most valuable node still out of reach
 * (value = how much the persona likes its region, times what kind of node it is, divided by the distance).
 */
export function skillTurn(ctx: Ctx, id: number, persona: Persona, note: (a: string) => void) {
  const { db, now } = ctx;
  if (skills.usedPoints(db, id) >= skills.pointsTotal(loadPlayer(db, id, now).level)) return;
  const weight = (region: string) => {
    const parts = region.split('+');
    return parts.reduce((s, r) => s + (persona.skills.weights[r] ?? (r === 'hub' ? 0.2 : 0)), 0) / parts.length;
  };
  for (let spent = 0; spent < 15; spent++) {
    const st = skills.skillState(db, id, now);
    if (!st.free) return;
    let pick: string | undefined;
    if (!st.allocated.length) pick = `${Object.entries(persona.skills.weights).sort((a, b) => b[1] - a[1])[0][0]}.start`;
    else {
      // breadth first search outward from the build; remember the first step towards every node
      const taken = new Set(st.allocated),
        first = new Map<string, string>(),
        dist = new Map<string, number>();
      let frontier: string[] = [];
      for (const n of NODES)
        if (!taken.has(n.id) && n.links.some((l) => taken.has(l))) {
          first.set(n.id, n.id);
          dist.set(n.id, 1);
          frontier.push(n.id);
        }
      while (frontier.length) {
        const next: string[] = [];
        for (const f of frontier)
          for (const l of NODE_BY_ID.get(f)!.links)
            if (!taken.has(l) && !dist.has(l)) {
              dist.set(l, dist.get(f)! + 1);
              first.set(l, first.get(f)!);
              next.push(l);
            }
        frontier = next;
      }
      let best = 0;
      for (const [nid, d] of dist) {
        const n = NODE_BY_ID.get(nid)!;
        if (n.kind === 'keystone' && persona.skills.keystone !== n.region) continue; // keystones carry a drawback: only the persona that suits one takes it
        const value = (weight(n.region) * KIND_VALUE[n.kind]) / (d * d); // near things first, but a notable three steps away beats a small node next door
        if (value > best) {
          best = value;
          pick = first.get(nid);
        }
      }
    }
    if (!pick || !ok(() => skills.allocate(db, id, pick, now))) return; // (a notable or keystone next in line may cost more than the points left: wait for the next level)
    if (spent === 0) note('skill points');
  }
}
