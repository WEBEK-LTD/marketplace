import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  STAFF_ROLES,
  type AdminSession,
  type ProblemCode,
  type StaffRole,
} from '@repo/contracts';
import { isAal2 } from '../auth/access-token-claims.js';
import { AuthenticationRequiredError } from '../auth/auth-errors.js';
import { SUPABASE_AUTH_CLIENT } from '../auth/login.service.js';

/** The one provider call this service makes: whose token is this, and is it genuine? */
export interface StaffConsoleProvider {
  getUser(accessToken: string): Promise<{ readonly id: string }>;
}

/** One row of `app_private.staff_console_access`, as the driver returns it. */
export interface StaffConsoleRow {
  readonly hasConsoleRole: boolean;
  readonly requiresStepUp: boolean;
  readonly roles: readonly string[];
  readonly permissions: readonly string[];
}

export interface StaffConsoleStore {
  /** `app_private.staff_console_access(uuid, boolean)` (0068). */
  staffConsoleAccess(input: { userId: string; isAal2: boolean }): Promise<StaffConsoleRow>;
  /** `app_private.buyer_profile(uuid)` (0067), for the name and language the header shows. */
  buyerProfile(userId: string): Promise<{
    readonly id: string;
    readonly displayName: string | null;
    readonly localeCode: string | null;
  } | null>;
}

export const STAFF_CONSOLE_STORE = Symbol('STAFF_CONSOLE_STORE');

/** The console session could not be established because a dependency was unreachable. */
export class StaffConsoleUnavailableError extends Error {
  readonly problem: { readonly status: number; readonly code: ProblemCode } = {
    status: 503,
    code: 'SERVICE_UNAVAILABLE',
  };

  constructor(override readonly cause: unknown) {
    super('The service is temporarily unavailable.');
    this.name = 'StaffConsoleUnavailableError';
  }
}

const STAFF_ROLE_SET = new Set<string>(STAFF_ROLES);

/**
 * The staff console session (Phase 7-F).
 *
 * **The order of the three hops is the security property, and it is fixed.**
 *
 *   1. The **provider** says whether the token is genuine and whose it is. A forged, altered, expired or
 *      revoked token is refused here and never reaches step 2.
 *   2. The **assurance level** is read from that same, now-vouched-for token. It is GoTrue's own claim
 *      about the session, not something a browser asserted: the bytes it is read from are the bytes the
 *      provider just validated. Anything unreadable is `aal1` — see `access-token-claims.ts`, where the
 *      argument for reading claims without re-checking a signature is set out in full.
 *   3. The **database** applies 0003's rule. `app_private.staff_console_access` counts a role only when
 *      `not requires_mfa or <the level from step 2>`, which is the identical predicate
 *      `public.has_permission` uses. The filtering happens there, so what comes back is already the
 *      effective set and there is no unfiltered set anywhere in this process to leak.
 *
 * Reading the claims before validating them would be reading an attacker's JSON, so that order is never
 * varied and the test suite holds it: a provider refusal means no store call happens at all.
 *
 * **This service grants nothing.** It has no writer, the reader behind it is `stable`, and no method
 * takes a role, a permission or an assurance level from a caller. The account comes from the provider's
 * answer and never from the token body, so a token whose claims disagreed with the provider could not
 * name a different person.
 *
 * **A person who is not staff is not an error.** They receive the same shape with `isStaff: false` and
 * empty sets, and the shell refuses them neutrally. Distinguishing "not staff" from "no such account"
 * in a status code would be an oracle; distinguishing "staff who must step up" is not, because that is
 * a fact about the caller's own account which they already know and must act on.
 */
@Injectable()
export class StaffConsoleService {
  private readonly logger = new Logger(StaffConsoleService.name);

  constructor(
    @Inject(SUPABASE_AUTH_CLIENT) private readonly provider: StaffConsoleProvider,
    @Inject(STAFF_CONSOLE_STORE) private readonly store: StaffConsoleStore,
  ) {}

  async forToken(accessToken: string): Promise<AdminSession> {
    if (accessToken === '') throw new AuthenticationRequiredError();

    // 1. The provider validates the token. Its errors are already the right ones.
    const user = await this.provider.getUser(accessToken);

    // 2. Only now are the token's own claims read, and only one of them.
    const aal2 = isAal2(accessToken);

    // 3. The database applies 0003's rule with that level supplied.
    let access: StaffConsoleRow;
    let profile: Awaited<ReturnType<StaffConsoleStore['buyerProfile']>>;
    try {
      [access, profile] = await Promise.all([
        this.store.staffConsoleAccess({ userId: user.id, isAal2: aal2 }),
        this.store.buyerProfile(user.id),
      ]);
    } catch (error) {
      this.logger.error('A console session could not be read.');
      throw new StaffConsoleUnavailableError(error);
    }

    // A deleted profile is no usable session, exactly as the 5-A identity read decides it.
    if (profile === null) throw new AuthenticationRequiredError();

    return {
      id: profile.id,
      displayName: profile.displayName,
      localeCode: profile.localeCode,
      isStaff: access.hasConsoleRole,
      requiresStepUp: access.requiresStepUp,
      // Narrowed to the four roles the contract names. A role the console does not recognise is not
      // reported as one it does: the shell is driven by permissions, and an unknown role carries none
      // that this filter could remove.
      roles: access.roles.filter((role): role is StaffRole => STAFF_ROLE_SET.has(role)),
      permissions: [...access.permissions],
    };
  }
}
