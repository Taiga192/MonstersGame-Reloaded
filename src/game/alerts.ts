/**
 * "Things that need you", worked out from the character's state every time they are asked for (nothing is stored): a finished hunt,
 * unspent skill points, finished quests, unread mail ... They stay on the alert bar until the character does something about them.
 * (Things that HAPPENED, like a raid against you, are notifications, see notify.ts.)
 */
import type { DB } from '../db-core.ts';
import { unreadCount as unreadMail } from './mail.ts';
import { readyCount } from './quests.ts';
import { pointsTotal, usedPoints } from './skills.ts';

export interface Alert { key: string; text: string; link: string; tone: 'good' | 'warn' | 'info' }

export function alertsFor(db: DB, id: number, now: number): Alert[] {
  const p = db.prepare('SELECT level, hunt_started, hunt_until, work_started, work_until FROM players WHERE id = ?').get(id) as
    { level: number; hunt_started: number | null; hunt_until: number | null; work_started: number | null; work_until: number | null } | undefined;
  if (!p) return [];
  const out: Alert[] = [];
  if (p.hunt_started && (p.hunt_until ?? 0) <= now) out.push({ key: 'hunt', text: 'Your hunt is over: collect the spoils', link: '#/hunt', tone: 'good' });
  if (p.work_started && (p.work_until ?? 0) <= now) out.push({ key: 'work', text: 'Your shift is over: collect your wages', link: '#/town/graveyard', tone: 'good' });
  const pending = db.prepare('SELECT pending FROM dungeon WHERE player_id = ?').get(id) as { pending: string | null } | undefined;
  if (pending?.pending) out.push({ key: 'reward', text: 'A dungeon guardian left a reward for you to choose', link: '#/dungeon', tone: 'good' });
  const quests = readyCount(db, id, now);
  if (quests) out.push({ key: 'quests', text: `${quests} weekly quest${quests === 1 ? ' is' : 's are'} done: choose your reward`, link: '#/quests', tone: 'good' });
  const points = Math.max(0, pointsTotal(p.level) - usedPoints(db, id));
  if (points) out.push({ key: 'skills', text: `You have ${points} skill point${points === 1 ? '' : 's'} to spend`, link: '#/skills', tone: 'good' });
  const shrine = db.prepare('SELECT status, routine FROM shrine WHERE player_id = ?').get(id) as { status: string; routine: string } | undefined;
  if (shrine?.status === 'starved') out.push({ key: 'shrine', text: 'The shrine is out of blood', link: '#/shrine', tone: 'warn' });
  const mail = unreadMail(db, id);
  if (mail) out.push({ key: 'mail', text: `${mail} unread mail${mail === 1 ? '' : 's'}`, link: '#/mail', tone: 'info' });
  return out;
}
