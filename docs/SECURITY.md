# Security

No software can honestly be called "free of security holes". This document says what the game defends against, where each defence is proven by an automated test, and what remains open.

## Threat model
Attackers are anonymous internet users (players, cheaters, scanners), a malicious website trying to use a player's browser, and someone who steals a database backup. Not covered: an attacker with root on the server, a compromised hosting provider, or attacks on the network itself.

## Protections and where they are tested
| Threat | Protection | Test |
|---|---|---|
| Password guessing | scrypt hashing, min 8 / max 128 chars, per-address rate limit, per-account lockout (10 failures / 15 min), global login limit, equalised timing for unknown names | `test/api/security-auth.test.ts` |
| Stolen database | passwords salted+scrypt; session tokens stored only as SHA-256 | `test/api/security-auth.test.ts` |
| Session theft / reuse | random tokens, 90-day expiry, real server-side logout, password change ends other sessions, daily purge | `test/api/security-auth.test.ts`, `test/api/server-safety.test.ts` |
| Reading other players' data (IDOR) | battle logs and war stats checked for participation | `test/api/security-api.test.ts` |
| Fake client address (rate-limit and referral abuse) | `X-Forwarded-For` only trusted with `TRUST_PROXY=1`, and only the last entry | `test/api/security-api.test.ts` |
| Malformed / hostile input | central body cleaning, integer/page validation, prototype-key checks, 100 KB body limit, fuzzing of every endpoint (no 500s, no state corruption) | `test/api/security-fuzz.test.ts`, `test/api/security-api.test.ts` |
| SQL injection | all queries are parameterised | `test/api/security-fuzz.test.ts` |
| XSS | all output escaped, no inline scripts or event attributes, route sanitiser, strict CSP (`script-src 'self'`) | `test/ui/security-xss.test.ts` |
| Clickjacking, sniffing, leaks | `frame-ancestors 'none'`, `X-Frame-Options`, nosniff, no-referrer, HSTS, `no-store` on the API | `test/api/server-safety.test.ts` |
| Other websites calling the API | CORS allow-list (empty = same origin only) | `test/ui/online-mode.test.ts`, `npm run e2e:online` |
| Exposure of the server itself | listens on 127.0.0.1 by default, non-root read-only container, private file modes (umask 077) | manual check, see SERVER-HARDENING.md |
| Data loss | automatic consistent backups, final backup on shutdown | `test/api/backend.test.ts` |
| Admin page abused (promoting yourself, editing others) | the admin flag exists only in the database and is read on every request (never from the client); it can only be set by hand on the server or by an existing admin with their password; every admin route returns 403 for others; dangerous actions (wipe, delete, password reset, admin flag) need the admin password again; admin values are range-checked and every action is written to an audit log | `test/api/admin.test.ts`, `test/ui/admin-ui.test.ts` |
| Reading or clearing somebody else's notifications and quests | every notification and quest route works only on the logged-in player's own rows; ids that belong to others are ignored; links in notifications are restricted to in-game routes; claim and read routes are validated and fuzzed | `test/game/notifications.test.ts`, `test/game/quests.test.ts` |
| Cheating via dev tools | not registered when `NODE_ENV=production` | `test/api/server-safety.test.ts` |

Honest note: the route sanitiser in the frontend is defence in depth only. The old code was not exploitable through it, so its test passes with or without it.

## Residual risks
* **HTTPS is your reverse proxy's job.** Without it, passwords and tokens travel in clear text. Use the Caddy setup.
* **Multiple accounts.** Rate limits slow mass registration but cannot stop a patient person; use `REGISTRATION_CODE` for a private server.
* **Network floods (DDoS)** cannot be stopped by the application; put Cloudflare or your provider's protection in front if it happens.
* **No email**, so no password reset. A forgotten password means a database edit by you.
* **No name or content moderation** (forum, clan names, mail).
* **Single server**: one machine, one process; downtime and disk loss are possible. Off-site backups are required (SERVER-HARDENING.md, section 7).
* **Not independently audited.** The tests above were written by the same author as the code. For a public launch, have a third party review it.
* **Not verified in this environment:** the Docker image build, the systemd unit, and itch.io's real iframe origin.
* Dependencies: run `npm audit --omit=dev` before each deployment (also done in CI).

**Admin accounts are powerful.** An admin can edit or wipe the whole world. Give the flag to as few accounts as possible, use a long unique password for them, and check `node scripts/admin.ts <db> list` now and then. The admin password prompt and the audit log limit the damage of a stolen login token, not of a stolen password.

## Reporting and incidents
Keep a contact address on your site. Incident steps (log everyone out, rotate the registration code, rebuild from a clean server) are in SERVER-HARDENING.md, section 10.
