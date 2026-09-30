import { serveStatic } from '@hono/node-server/serve-static';
import { getConnInfo } from '@hono/node-server/conninfo';
import { createHash } from 'node:crypto';
import type { Context, MiddlewareHandler } from 'hono';
import { createApi, type Deps } from './api.ts';
import { listAssets } from './assets.ts';
import { corsMiddleware, DEFAULT_LIMITS, noStore, rateLimit, requestSizeLimit, securityHeaders, type Limits } from './security.ts';

export interface SecurityOptions {
  /** origins allowed to call the API from another site (itch.io, GitHub Pages, ...). Empty = same origin only. */
  corsOrigins?: string[];
  /** true when running behind exactly one trusted reverse proxy / platform edge (Fly, Railway, nginx...): use its X-Forwarded-For */
  trustProxy?: boolean;
  /** rate limits; `false` turns them off */
  limits?: Limits | false;
  maxBodyBytes?: number;
  /** private server: registering requires this code */
  registrationCode?: string;
}
export interface NodeDeps extends Omit<Deps, 'assets' | 'middleware' | 'globalMiddleware' | 'registrationCode' | 'clientKey'> { publicDir?: string; security?: SecurityOptions }

/** Client address: the proxy's forwarded address when we sit behind one, otherwise the socket. */
const clientIp = (trustProxy: boolean) => (c: Context): string => {
  if (trustProxy) { const xff = c.req.header('x-forwarded-for'); if (xff) return xff.split(',').at(-1)!.trim(); } // the LAST entry is the one our proxy appended
  try { return getConnInfo(c).remote.address ?? 'unknown'; } catch { return 'unknown'; }
};

/** The game API (with public-server protections when `security` is given) plus the static frontend (public/). */
export function createApp({ publicDir = './public', security, ...deps }: NodeDeps) {
  const middleware: MiddlewareHandler[] = [], globalMiddleware: MiddlewareHandler[] = [];
  if (security) {
    globalMiddleware.push(securityHeaders());
    middleware.push(noStore);
    if (security.corsOrigins?.length) middleware.push(corsMiddleware(security.corsOrigins)); // first, so even 429/413 answers carry CORS headers
    middleware.push(requestSizeLimit(security.maxBodyBytes));
    if (security.limits !== false) middleware.push(rateLimit(security.limits ?? DEFAULT_LIMITS, clientIp(!!security.trustProxy), deps.now));
  }
  // anonymous features (victim link) identify a visitor by the connection's address, hashed so no raw address is stored
  const ip = clientIp(!!security?.trustProxy);
  const clientKey = (c: Context) => createHash('sha256').update(ip(c)).digest('hex').slice(0, 32);
  const app = createApi({ ...deps, assets: () => listAssets(publicDir), middleware, globalMiddleware, registrationCode: security?.registrationCode || undefined, clientKey });
  app.use('/*', serveStatic({ root: publicDir }));
  return app;
}
