import type { Context, MiddlewareHandler, Hono } from 'hono';
import { tx, type DB } from '../db/core.ts';
import type { Rng } from '../core/rng.ts';
import * as auth from '../game/character/auth.ts';
import * as shrine from '../game/world/shrine.ts';
import * as quests from '../game/world/quests.ts';
import type { LoginGuard } from './login-guard.ts';
import { cleanBody } from './validate.ts';

export interface Deps {
  db: DB;
  now: () => number;
  rng: Rng;
  devClock?: { offset: number };
  /** which art files exist (extension-less key -> file + version); the Node server scans a folder, the browser build ships a list */
  assets?: () => Record<string, { file: string; v: number }>;
  /** runs before every /api route (CORS, rate limits, body size limit on a public server) */
  middleware?: MiddlewareHandler[];
  /** runs before EVERY route, static files included (security headers) */
  globalMiddleware?: MiddlewareHandler[];
  /** when set, registering needs this code (private servers) */
  registrationCode?: string;
  /** stable identifier of the caller for anonymous features (victim link); on a server this must come from the connection, never from a request header */
  clientKey?: (c: Context) => string;
  /** single player (the browser-only build): the one human is always an admin. Multiplayer: only players with the is_admin flag. */
  singlePlayer?: boolean;
  /** called after the admin wiped the world (the server creates fresh bots) */
  onWipe?: () => void;
}

type Action = <T>(fn: (id: number, b: Record<string, any>, c: Context) => T) => (c: Context) => Promise<Response>;

/** What every route module gets: the app plus the helpers the handlers share. */
export interface Api {
  app: Hono;
  db: DB;
  now: () => number;
  rng: Rng;
  assets?: Deps['assets'];
  registrationCode?: string;
  clientKey?: Deps['clientKey'];
  singlePlayer: boolean;
  onWipe?: () => void;
  guard: LoginGuard;
  bearer: (c: Context) => string | undefined;
  /** the logged-in player's id (401 without a valid token) */
  me: (c: Context) => number;
  /** JSON body through the input firewall (an empty or unparsable body counts as {} and fails the handler's own validation). */
  body: (c: Context) => Promise<Record<string, any>>;
  /** Authenticated action wrapped in a transaction. */
  act: Action;
}

// Activities that need the character's full attention: a running shrine stops first (one thing at a time, and no automated
// hunting while you raid). Everything else (shopping, mail, clan, market ...) can be done with the shrine running.
const MANUAL = new Set([
  '/api/hunt/start',
  '/api/work/start',
  '/api/dungeon/enter',
  '/api/raid/search',
  '/api/raid/attack',
  '/api/clan/war/attack',
  '/api/arena/create',
  '/api/arena/join',
  '/api/ancestral/challenge',
]);

export function createContext(app: Hono, deps: Deps, guard: LoginGuard): Api {
  const { db, now, rng } = deps;
  const bearer = (c: Context) => c.req.header('authorization')?.replace(/^Bearer /, '');
  const me = (c: Context) => auth.playerForToken(db, bearer(c), now());
  const body = async (c: Context) => cleanBody(await c.req.json().catch(() => ({})));
  const act: Action = (fn) => async (c) => {
    const id = me(c);
    const b = await body(c);
    return c.json(
      tx(db, () => {
        quests.ensureWeek(db, now()); // a new quest week starts before any counter moves in it
        shrine.settle(db, id, now(), rng); // what the shrine did while you were away is paid before anything else happens
        if (MANUAL.has(c.req.path)) shrine.pause(db, id, now(), rng);
        return fn(id, b, c);
      }) ?? { ok: true },
    );
  };
  return {
    app,
    db,
    now,
    rng,
    assets: deps.assets,
    registrationCode: deps.registrationCode,
    clientKey: deps.clientKey,
    singlePlayer: deps.singlePlayer ?? false,
    onWipe: deps.onWipe,
    guard,
    bearer,
    me,
    body,
    act,
  };
}
