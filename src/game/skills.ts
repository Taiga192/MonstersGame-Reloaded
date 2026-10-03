/**
 * The skill board for one character: spending points, taking nodes back, resetting. The board itself (nodes, effects) is src/skills.ts;
 * the summed effects are kept on the player row (players.skill_mods) so the game rules can read them without extra queries.
 */
import { CFG } from '../config.ts';
import type { DB } from '../db-core.ts';
import { assert } from '../errors.ts';
import { bump } from './counters.ts';
import { aggregate, dominantRegion, isConnected, modText, NODE_BY_ID, NODES, nodeCost, ORIGINS, type ModKey, type Mods } from '../skills.ts';
import { modsOf } from './mods.ts';
import { loadPlayer } from './player.ts';

/** Skill points a character of this level has earned in total. */
export const pointsTotal = (level: number) => Math.max(0, Math.floor(level * CFG.skillPointsPerLevel));

/** Points the given nodes cost together (notables 2, keystones 3, the rest 1). */
export const pointsFor = (ids: Iterable<string>) => { let sum = 0; for (const n of ids) { const node = NODE_BY_ID.get(n); if (node) sum += nodeCost(node.kind); } return sum; };
/** Points a character has spent. */
export const usedPoints = (db: DB, id: number) => pointsFor(allocatedOf(db, id));

const allocatedOf = (db: DB, id: number) => (db.prepare('SELECT node_id FROM skills WHERE player_id = ? ORDER BY rowid').all(id) as { node_id: string }[]).map((r) => r.node_id);

/** The maximum health the board adds (stored in max_hp, like level-ups and vitality potions, so it is part of every health calculation). */
export const maxHpBonus = (db: DB, id: number) => modsOf(db.prepare('SELECT skill_mods FROM players WHERE id = ?').get(id) as { skill_mods: string }).maxHp ?? 0;

/** Store a new set of nodes: the sum goes on the player row and the health bonus moves max HP by the difference. */
function store(db: DB, id: number, ids: string[], start: string | null) {
  const old = modsOf(db.prepare('SELECT skill_mods FROM players WHERE id = ?').get(id) as { skill_mods: string }).maxHp ?? 0;
  const mods: Mods = aggregate(ids);
  const delta = (mods.maxHp ?? 0) - old;
  db.prepare('DELETE FROM skills WHERE player_id = ?').run(id);
  for (const n of ids) db.prepare('INSERT INTO skills (player_id, node_id) VALUES (?, ?)').run(id, n);
  db.prepare('UPDATE players SET skill_mods = ?, skill_start = ?, max_hp = MAX(1, max_hp + ?), hp = MIN(MAX(1, max_hp + ?), hp + MAX(?, 0)) WHERE id = ?')
    .run(JSON.stringify(mods), ids.length ? start : null, delta, delta, delta, id);
}

export function skillState(db: DB, id: number, now: number) {
  const p = loadPlayer(db, id, now);
  const allocated = allocatedOf(db, id), set = new Set(allocated);
  const total = pointsTotal(p.level), used = pointsFor(allocated), free = Math.max(0, total - used);
  // `reachable`: touches the build (or is a start node while there is no build); `available`: reachable AND affordable right now
  const reachable = !allocated.length ? [...ORIGINS] : NODES.filter((n) => !set.has(n.id) && n.links.some((l) => set.has(l))).map((n) => n.id);
  const available = reachable.filter((n) => nodeCost(NODE_BY_ID.get(n)!.kind) <= free);
  const dom = dominantRegion(allocated);
  return {
    total, used, nodes: allocated.length, free, allocated, start: p.skill_start, reachable, available, mods: modsOf(p),
    summary: (Object.entries(modsOf(p)) as [ModKey, number][]).filter(([, v]) => v).map(([k, v]) => modText(k, v)), title: dom ? dom.title : null, refundCost: CFG.skillRefundCostPerLevel * p.level, respecCost: CFG.skillRespecCostPerLevel * p.level, gold: p.gold,
  };
}

/** Take a node. The first one has to be a start node (that is the character's class); every later one has to touch a node already taken. */
export function allocate(db: DB, id: number, nodeId: unknown, now: number) {
  const node = typeof nodeId === 'string' ? NODE_BY_ID.get(nodeId) : undefined;
  assert(node, 'bad_node', 'There is no such node');
  const p = loadPlayer(db, id, now);
  const have = allocatedOf(db, id), set = new Set(have);
  assert(!set.has(node.id), 'taken', 'You already have this node');
  const cost = nodeCost(node.kind);
  assert(pointsFor(have) + cost <= pointsTotal(p.level), 'no_points', cost > 1 ? `This node costs ${cost} skill points and you do not have that many left` : 'You have no skill points left');
  if (!have.length) assert(node.kind === 'origin', 'not_a_start', 'Your first point has to go on a start node: that is your class');
  else assert(node.links.some((l) => set.has(l)), 'not_connected', 'You can only take a node that touches one you already have');
  store(db, id, [...have, node.id], have.length ? p.skill_start : node.id);
  bump(db, id, 'skill_nodes');
}

/** Take one node back (costs gold). Everything that is left has to stay connected to the start node. */
export function refund(db: DB, id: number, nodeId: unknown, now: number) {
  const p = loadPlayer(db, id, now);
  const have = allocatedOf(db, id);
  assert(typeof nodeId === 'string' && have.includes(nodeId), 'not_taken', 'You do not have this node');
  const rest = have.filter((n) => n !== nodeId);
  assert(isConnected(new Set(rest), p.skill_start ?? undefined), 'would_split', 'Taking this node back would cut other nodes off: take back the ones at the end of the branch first');
  const cost = CFG.skillRefundCostPerLevel * p.level;
  assert(p.gold >= cost, 'no_gold', `Taking back a node costs ${cost} gold`);
  db.prepare('UPDATE players SET gold = gold - ? WHERE id = ?').run(cost, id);
  store(db, id, rest, p.skill_start);
}

/** Reset the whole board (costs gold; free when nothing is taken). All points come back. */
export function respec(db: DB, id: number, now: number) {
  const p = loadPlayer(db, id, now);
  const have = allocatedOf(db, id);
  if (!have.length) return;
  const cost = CFG.skillRespecCostPerLevel * p.level;
  assert(p.gold >= cost, 'no_gold', `Resetting the board costs ${cost} gold`);
  db.prepare('UPDATE players SET gold = gold - ? WHERE id = ?').run(cost, id);
  store(db, id, [], null);
}

/** A character that has more nodes than points (the level was lowered, or points per level were cut) loses the board without paying. */
export function reconcile(db: DB, id: number, now: number) {
  const p = loadPlayer(db, id, now);
  if (usedPoints(db, id) > pointsTotal(p.level)) store(db, id, [], null);
}
