import { Inject, Injectable, Logger } from '@nestjs/common';
import { AuthenticationRequiredError } from './auth-errors.js';
import type { SupabaseSession } from './supabase-auth.client.js';
import { SUPABASE_AUTH_CLIENT } from './login.service.js';

/**
 * The provider operations session continuity needs. Narrow on purpose: this service can renew a session
 * and end one, and it has no way to sign anybody in, change a password or revoke an account's sessions.
 */
export interface SessionAuthProvider {
  refreshSession(refreshToken: string): Promise<SupabaseSession>;
  signOut(accessToken: string): Promise<'signed_out' | 'already_invalid'>;
}

/**
 * Renewing and ending a session (Phase 5-A).
 *
 * F2 created sessions and nothing renewed them, so a signed-in surface lasted the fifteen minutes of the
 * access cookie. This service adds the two operations that were missing and deliberately adds nothing
 * else: it does not sign anyone in, does not consult the lockout state, does not touch the device
 * record and does not write a security event. Those all belong to *establishing* a session, and F2 owns
 * them.
 *
 * What it does not do is as load-bearing as what it does:
 *
 * **It never revokes an account's other sessions.** `revokeAllSessions` exists on the same provider
 * client and is deliberately not reachable from here — this service is typed against an interface that
 * does not contain it, so a logout cannot grow into a global sign-out by a one-line edit.
 *
 * **It refuses to guess.** A refresh token the provider rejects is one refusal with one code, whatever
 * the reason; a provider that cannot be reached is a 503 and never a "your session ended".
 */
@Injectable()
export class SessionService {
  private readonly logger = new Logger(SessionService.name);

  constructor(@Inject(SUPABASE_AUTH_CLIENT) private readonly provider: SessionAuthProvider) {}

  /**
   * Renews a session from its refresh token.
   *
   * The token arrives from the BFF's `__Host-mp_refresh` cookie and nowhere else. An empty value is
   * treated as no token at all rather than forwarded, so a browser with a cleared cookie cannot spend a
   * provider call to learn that the empty string is not a session.
   */
  async refresh(refreshToken: string): Promise<SupabaseSession> {
    if (refreshToken === '') throw new AuthenticationRequiredError();
    return await this.provider.refreshSession(refreshToken);
  }

  /**
   * Ends the caller's own session.
   *
   * Idempotent by construction: a token the provider no longer recognises comes back as
   * `already_invalid`, which this method treats exactly like a successful sign-out, because the session
   * it named is gone either way. The only failure is an unreachable provider, which the client raises.
   */
  async logout(accessToken: string): Promise<void> {
    if (accessToken === '') throw new AuthenticationRequiredError();
    const outcome = await this.provider.signOut(accessToken);
    if (outcome === 'already_invalid') {
      // Worth a line in the log and nothing more: it is the ordinary shape of a second logout, or of
      // signing out after the access token has already expired.
      this.logger.log('A logout named a session the provider no longer holds.');
    }
  }
}
