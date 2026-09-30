import { CFG } from '../config.ts';
import { GameError } from '../errors.ts';

/**
 * Per-ACCOUNT brake on password guessing, on top of the per-address rate limit: after CFG.loginLockThreshold failures the account
 * refuses logins (from every address) until the window ends. Trade-off: someone can lock a known name out for a few minutes;
 * that is a nuisance, while unlimited guessing would be a break-in. In memory on purpose (a restart clears it).
 */
export class LoginGuard {
  private fails = new Map<string, { count: number; since: number }>();
  private key = (name: unknown) => String(name ?? '').toLowerCase().slice(0, 40);

  /** Throws 429 while the account is locked. Call BEFORE checking the password (a locked account costs no CPU). */
  check(name: unknown, now: number) {
    const f = this.fails.get(this.key(name));
    if (f && now - f.since < CFG.loginLockWindow && f.count >= CFG.loginLockThreshold) {
      const min = Math.ceil((CFG.loginLockWindow - (now - f.since)) / 60000);
      throw new GameError('account_locked', `Too many failed logins for this account. Try again in ${min} minute${min === 1 ? '' : 's'}.`, 429);
    }
  }
  fail(name: unknown, now: number) {
    if (this.fails.size > 10_000) for (const [k, v] of this.fails) if (now - v.since >= CFG.loginLockWindow) this.fails.delete(k);
    const k = this.key(name), f = this.fails.get(k);
    if (!f || now - f.since >= CFG.loginLockWindow) this.fails.set(k, { count: 1, since: now });
    else f.count++;
  }
  ok(name: unknown) { this.fails.delete(this.key(name)); }
}
