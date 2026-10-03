import type { Context, MiddlewareHandler } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { cors } from 'hono/cors';
import { secureHeaders } from 'hono/secure-headers';

// Middleware for a PUBLIC server (portable Hono middleware; the Node wrapper in node-app.ts assembles it).

/**
 * Which pages may call this API from another origin (e.g. the game embedded on itch.io or hosted on GitHub Pages).
 * Entries: an exact origin ("https://me.github.io"), a subdomain wildcard ("https://*.itch.zone") or "*" (anyone).
 * Nothing listed = no cross-origin access at all (the frontend then has to be served by this same server).
 */
export function originMatcher(patterns: string[]): (origin: string) => boolean {
  const rules = patterns
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p): ((o: string) => boolean) => {
      if (p === '*') return () => true;
      if (!p.includes('*')) return (o) => o === p;
      // "https://*.itch.zone": '*.' stands for one or more subdomain labels; everything else must match literally
      const escaped = p.replace(/[.+?^${}()|[\]\\]/g, '\\$&'); // regex-escape (the '*' itself is not special-cased here)
      const re = new RegExp('^' + escaped.replace(/\*\\\./g, '(?:[a-z0-9-]+\\.)+') + '$', 'i');
      return (o) => re.test(o);
    });
  return (origin) => rules.some((r) => r(origin));
}

export function corsMiddleware(origins: string[]): MiddlewareHandler {
  const allowed = originMatcher(origins);
  return cors({
    origin: (origin) => (allowed(origin) ? origin : null),
    allowHeaders: ['Authorization', 'Content-Type'],
    allowMethods: ['GET', 'POST', 'OPTIONS'],
    maxAge: 86400,
  });
}

export const requestSizeLimit = (maxBytes = 100 * 1024) =>
  bodyLimit({ maxSize: maxBytes, onError: (c) => c.json({ error: 'too_large', message: 'The request is too large' }, 413) });

export interface Limit {
  windowMs: number;
  max: number;
}
export interface Limits {
  register: Limit;
  login: Limit;
  api: Limit;
  /** register + login together, over ALL addresses: password hashing is expensive, this bounds the CPU an attacker with many addresses can burn */ authGlobal?: Limit;
}
export const DEFAULT_LIMITS: Limits = {
  register: { windowMs: 60 * 60_000, max: 5 }, // new accounts per hour per address
  login: { windowMs: 10 * 60_000, max: 20 }, // login attempts per 10 minutes per address (slows password guessing)
  api: { windowMs: 60_000, max: 600 }, // everything else, per minute per address
  authGlobal: { windowMs: 60_000, max: 120 }, // all registrations + logins together, per minute
};

/** Fixed-window rate limiter keyed by client address and route group. Answers 429 with Retry-After. */
export function rateLimit(limits: Limits, ipOf: (c: Context) => string, now: () => number = Date.now): MiddlewareHandler {
  const hits = new Map<string, { count: number; resetAt: number }>();
  return async (c, next) => {
    if (c.req.method === 'OPTIONS') return next(); // CORS preflights are free
    const group = c.req.path === '/api/register' ? 'register' : c.req.path === '/api/login' ? 'login' : 'api';
    const limit = limits[group],
      t = now(),
      key = `${group}:${ipOf(c)}`;
    if (limits.authGlobal && (group === 'register' || group === 'login' || c.req.path === '/api/password')) {
      let g = hits.get('auth:*');
      if (!g || g.resetAt <= t) {
        g = { count: 0, resetAt: t + limits.authGlobal.windowMs };
        hits.set('auth:*', g);
      }
      if (++g.count > limits.authGlobal.max) {
        c.header('Retry-After', '30');
        return c.json({ error: 'rate_limited', message: 'The server is busy with logins right now. Please try again in a moment.' }, 429);
      }
    }
    if (hits.size > 50_000) for (const [k, v] of hits) if (v.resetAt <= t) hits.delete(k); // keep memory bounded
    let h = hits.get(key);
    if (!h || h.resetAt <= t) {
      h = { count: 0, resetAt: t + limit.windowMs };
      hits.set(key, h);
    }
    if (++h.count > limit.max) {
      const retry = Math.max(1, Math.ceil((h.resetAt - t) / 1000));
      c.header('Retry-After', String(retry));
      return c.json(
        { error: 'rate_limited', message: `Too many requests. Please try again in ${retry < 90 ? retry + ' seconds' : Math.ceil(retry / 60) + ' minutes'}.` },
        429,
      );
    }
    return next();
  };
}

/**
 * Browser-side protections for everything this server sends. The important one is the Content Security Policy: only scripts
 * from this very site may run and inline scripts / event-handler attributes are forbidden, so even a hypothetical HTML injection
 * could not execute code or steal the login token. (Inline STYLES stay allowed: the UI sets style="..." attributes.)
 */
export function securityHeaders(): MiddlewareHandler {
  return secureHeaders({
    contentSecurityPolicy: {
      defaultSrc: ["'none'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", 'data:', 'blob:'],
      connectSrc: ["'self'"],
      baseUri: ["'none'"],
      formAction: ["'self'"],
      frameAncestors: ["'none'"],
      objectSrc: ["'none'"],
    },
    xFrameOptions: 'DENY',
    xContentTypeOptions: 'nosniff',
    referrerPolicy: 'no-referrer',
    strictTransportSecurity: 'max-age=31536000; includeSubDomains', // ignored by browsers on plain http, so harmless in development
    permissionsPolicy: { camera: [], microphone: [], geolocation: [], payment: [], usb: [], fullscreen: ['self'] },
    crossOriginResourcePolicy: false, // the API is meant to be read by other origins that are on the CORS list
    crossOriginOpenerPolicy: 'same-origin',
    crossOriginEmbedderPolicy: false,
  });
}

/** API answers are personal: never let a browser or proxy cache them. */
export const noStore: MiddlewareHandler = async (c, next) => {
  await next();
  c.header('Cache-Control', 'no-store');
};
