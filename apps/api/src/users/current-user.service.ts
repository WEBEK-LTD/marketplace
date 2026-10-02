import { Inject, Injectable, Logger } from '@nestjs/common';
import type { CurrentUser } from '@repo/contracts';
import { AuthProviderUnavailableError, AuthenticationRequiredError } from '../auth/auth-errors.js';
import { SUPABASE_AUTH_CLIENT } from '../auth/login.service.js';

/** The one provider call this service makes: whose token is this? */
export interface CurrentUserProvider {
  getUser(accessToken: string): Promise<{ readonly id: string }>;
}

export interface CurrentUserStore {
  /** `app_private.user_identity(uuid)`. Null when the profile is deleted or absent. */
  userIdentity(userId: string): Promise<{ readonly id: string; readonly displayName: string | null } | null>;
}

export const CURRENT_USER_STORE = Symbol('CURRENT_USER_STORE');

/**
 * The caller's own identity (Phase 5-A).
 *
 * Two hops, in this order, and the order is the security property: the provider says *who* the token
 * belongs to, and only then does the database say *what* that account's identity is. The account is
 * never taken from the request — there is no parameter here that a browser could supply — so no caller
 * can ask for somebody else's name.
 *
 * The projection is the database's, not this service's: `app_private.user_identity` returns the two
 * approved fields, so there is no place here where a third one could be picked up by accident.
 *
 * A deleted profile resolves to nothing, and nothing is treated as no usable session rather than as an
 * empty identity. A live token belonging to an account that no longer exists is exactly the case where
 * rendering a signed-in surface would be wrong.
 */
@Injectable()
export class CurrentUserService {
  private readonly logger = new Logger(CurrentUserService.name);

  constructor(
    @Inject(SUPABASE_AUTH_CLIENT) private readonly provider: CurrentUserProvider,
    @Inject(CURRENT_USER_STORE) private readonly store: CurrentUserStore,
  ) {}

  async forToken(accessToken: string): Promise<CurrentUser> {
    if (accessToken === '') throw new AuthenticationRequiredError();

    // Errors from here are already the right ones: the client raises AuthenticationRequiredError when
    // the provider refuses the token and AuthProviderUnavailableError when it could not be asked.
    const user = await this.provider.getUser(accessToken);

    let identity: Awaited<ReturnType<CurrentUserStore['userIdentity']>>;
    try {
      identity = await this.store.userIdentity(user.id);
    } catch (error) {
      this.logger.error('An account identity could not be read.');
      throw new AuthProviderUnavailableError(error);
    }

    if (identity === null) throw new AuthenticationRequiredError();
    return { id: identity.id, displayName: identity.displayName };
  }
}
