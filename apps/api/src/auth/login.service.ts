import { Inject, Injectable, Logger } from '@nestjs/common';
import { DeviceIdentity } from '@repo/server-config';
import type { PseudonymousUserId } from '@repo/server-config';
import { PSEUDONYMOUS_USER_ID, recordLogIdentity } from '../logging/log-identity.js';
import {
  AccountLockedError,
  AuthProviderUnavailableError,
  EnforcementUnavailableError,
  InvalidCredentialsError,
} from './auth-errors.js';
import { AUTH_EVENT, AuthSecurityEventsService, type AuthEventType } from './auth-security-events.service.js';
import { LoginEnforcementService } from './login-enforcement.service.js';
import { LoginThrottleService } from './login-throttle.service.js';
import { hashClientIp, hashIdentifier, hashUserAgent } from './subject-hash.js';
import type { SupabaseAuthClient, SupabaseSession } from './supabase-auth.client.js';

/** Resolves a login identifier to its account, server-side only. */
export interface LoginIdentityStore {
  /** `app_private.user_id_for_login_identifier(text)`; null when no account matches. */
  userIdForLoginIdentifier(identifier: string): Promise<string | null>;
  /**
   * `app_private.login_contact_confirmed(uuid)` (0065): whether the account has confirmed any contact.
   *
   * Added by Phase 7-A to enforce the approved VERIFY FIRST decision — a newly registered account
   * verifies its contact before its first sign-in. It is deliberately generous, answering true when
   * **either** the email or the phone is confirmed, so that no account which could sign in before 7-A is
   * refused by it.
   */
  loginContactConfirmed(userId: string): Promise<boolean>;
}

export const LOGIN_IDENTITY_STORE = Symbol('LOGIN_IDENTITY_STORE');
export const SUPABASE_AUTH_CLIENT = Symbol('SUPABASE_AUTH_CLIENT');

export interface LoginInput {
  /** Already normalised by the contract: trimmed and lower-cased. */
  readonly identifier: string;
  readonly password: string;
  readonly requestIp: string | null;
  readonly userAgent: string | null;
  readonly requestId: string | null;
  /**
   * The C-15 device value the BFF read from `__Host-mp_device_id`, or issued for a browser that had
   * none. Null when the caller sent none; nothing is recorded in that case.
   */
  readonly deviceId?: string | null;
}

/** Recording which device an account signed in from (C-15). */
export interface KnownDeviceStore {
  /** `app_private.register_known_device(uuid, bytea, inet)`. */
  registerKnownDevice(input: {
    userId: string;
    deviceHash: Buffer;
    requestIp: string | null;
  }): Promise<{ outcome: string; deviceId: string | null }>;
}

export const KNOWN_DEVICE_STORE = Symbol('KNOWN_DEVICE_STORE');
export const DEVICE_IDENTITY = Symbol('DEVICE_IDENTITY');

/**
 * The session, plus the one thing the BFF may need to act on beyond it.
 *
 * `rotatedDeviceId` is present only when the device this request presented had been revoked and a
 * fresh one was issued in its place (C-15). It travels to the BFF as a response header on the internal
 * hop and stops there, in the `Set-Cookie` the BFF writes; the browser's own response body is
 * unchanged, and the approved login response schema gains nothing.
 */
export interface LoginResult extends SupabaseSession {
  readonly rotatedDeviceId?: string;
}

/** Internal reason codes. They reach the security-event row and nothing else. */
const REASON = Object.freeze({
  accepted: 'password_accepted',
  invalidCredentials: 'invalid_credentials',
  locked: 'account_locked',
  throttled: 'throttle_rejected',
  providerUnavailable: 'provider_unavailable',
  enforcementUnavailable: 'enforcement_unavailable',
  /** Phase 7-A: the password was right, but the account has confirmed no contact yet. */
  contactUnverified: 'contact_unverified',
});

/**
 * The F2 login flow, in the approved order.
 *
 *   1. the request is already validated by the contract, password policy included (D1);
 *   2. the C-1 throttle counts the request and may reject it;
 *   3. the identifier is resolved to an account and the durable 0034 lockout is checked — **before**
 *      Supabase is contacted, which is the whole point of AUTH-3 / N1;
 *   4. Supabase Auth verifies the password;
 *   4b. the approved VERIFY FIRST rule is applied: an account that has confirmed no contact is refused
 *      even with the right password (Phase 7-A);
 *   5. the outcome is recorded durably (0034) and as a security event (C-20);
 *   6. the session is handed back for the BFF to turn into cookies (C-8).
 *
 * Step 4b is the only change Phase 7-A makes to this completed Phase 3 surface, and it is here rather
 * than anywhere else for two reasons. It is **after** the provider call, so an unverified account costs
 * the same work and the same time as an unknown one: a gate placed before the provider would answer
 * faster for a registered-but-unverified address than for an address that does not exist, which is an
 * account-existence oracle obtainable with any wrong password. And it is enforced **in this service**
 * rather than delegated to the provider's own confirmation setting, for the reason O-1 already settled
 * for the durable lockout: a rule this project promised is a rule this project checks. If the provider
 * also refuses such a sign-in, this gate simply never fires; the guarantee does not depend on it either
 * way.
 *
 * Two things this service never does, and both are deliberate.
 *
 * **It never tells the caller which failure happened.** Every refusal leaves here as one of a small set
 * of typed errors that the controller maps to a single status and body. An unknown identifier takes the
 * same path as a wrong password: the account lookup returns null, the lockout check passes trivially,
 * Supabase refuses, and the result is indistinguishable — including in the time it takes, because the
 * provider call happens either way.
 *
 * **It never feeds anything but a real credential test into the lockout counter.** `record_login_attempt`
 * applies the 5-in-15-minutes rule, so every row written there can lock an account. A throttle
 * rejection, a lockout rejection and a provider outage are therefore recorded as security events but
 * **not** as login attempts: writing them would let a flood of requests, or a Supabase incident, lock
 * out accounts whose password was never even tried. The durable rule stays exactly what 0034 defines,
 * counting exactly what it was defined to count.
 */
@Injectable()
export class LoginService {
  private readonly logger = new Logger(LoginService.name);

  constructor(
    private readonly throttle: LoginThrottleService,
    private readonly enforcement: LoginEnforcementService,
    private readonly events: AuthSecurityEventsService,
    @Inject(LOGIN_IDENTITY_STORE) private readonly identities: LoginIdentityStore,
    @Inject(SUPABASE_AUTH_CLIENT) private readonly provider: SupabaseAuthClient,
    @Inject(PSEUDONYMOUS_USER_ID) private readonly pseudonymous: PseudonymousUserId,
    @Inject(DEVICE_IDENTITY) private readonly devices: DeviceIdentity,
    @Inject(KNOWN_DEVICE_STORE) private readonly deviceStore: KnownDeviceStore,
  ) {}

  async login(input: LoginInput): Promise<LoginResult> {
    const identifierHash = hashIdentifier(input.identifier);
    const ipHash = hashClientIp(input.requestIp);
    const userAgentHash = hashUserAgent(input.userAgent);
    const record = (eventType: AuthEventType, reasonCode: string, userId: string | null): Promise<void> =>
      this.events.record({
        eventType,
        userId,
        identifierHash,
        ipHash,
        userAgentHash,
        requestId: input.requestId,
        reasonCode,
      });

    // 2. Throttle (C-1). Counted first so a flood costs a counter increment, not a provider call.
    try {
      await this.throttle.assertWithinLimits({ identifierHash, ipHash });
    } catch (error) {
      const throttled = !(error instanceof EnforcementUnavailableError);
      await record(
        throttled ? AUTH_EVENT.throttled : AUTH_EVENT.providerError,
        throttled ? REASON.throttled : REASON.enforcementUnavailable,
        null,
      );
      throw error;
    }

    // 3. Resolve the account, then apply the durable lockout — still before any provider call.
    let userId: string | null;
    try {
      userId = await this.identities.userIdForLoginIdentifier(input.identifier);
    } catch (error) {
      await record(AUTH_EVENT.providerError, REASON.enforcementUnavailable, null);
      throw new EnforcementUnavailableError(error);
    }

    try {
      await this.enforcement.assertNotLocked(userId);
    } catch (error) {
      const locked = error instanceof AccountLockedError;
      await record(
        locked ? AUTH_EVENT.locked : AUTH_EVENT.providerError,
        locked ? REASON.locked : REASON.enforcementUnavailable,
        userId,
      );
      throw error;
    }

    // 4. The provider decides. It is called for an unknown identifier too, so that an account that does
    //    not exist costs the same work and the same time as one that does.
    let session: SupabaseSession;
    try {
      session = await this.provider.signInWithPassword(input.identifier, input.password);
    } catch (error) {
      if (error instanceof InvalidCredentialsError) {
        // 5a. A real credential test failed: this is the one failure the lockout rule counts.
        await this.enforcement.recordAttempt({
          userId,
          identifierHash,
          succeeded: false,
          failureReason: REASON.invalidCredentials,
          requestIp: input.requestIp,
          userAgentHash,
        });
        await record(AUTH_EVENT.failure, REASON.invalidCredentials, userId);
        throw error;
      }

      await record(AUTH_EVENT.providerError, REASON.providerUnavailable, userId);
      throw error instanceof AuthProviderUnavailableError
        ? error
        : new AuthProviderUnavailableError(error);
    }

    // 5a-bis. The request now has a user (C-13, O8-12). Log correlation only: nothing about the
    //         response, the ordering or the recorded events changes, and the raw UUID is not logged.
    recordLogIdentity(this.pseudonymous, session.userId);

    // 5b. Success. Recorded durably first: a success that cannot be written is not a success, because
    //     the attempt history is what the lockout rule reads.
    await this.enforcement.recordAttempt({
      userId: session.userId,
      identifierHash,
      succeeded: true,
      failureReason: null,
      requestIp: input.requestIp,
      userAgentHash,
    });

    // 4b. VERIFY FIRST (Phase 7-A). Recorded as a successful attempt above on purpose: 0034 counts
    //     credential tests, and this credential test passed. Writing it as a failure instead would let a
    //     person whose password is perfectly correct lock their own account out while waiting to verify.
    //     The sign-in itself is refused all the same, and refused with the same error every other login
    //     failure uses, so the caller learns nothing beyond "that did not work".
    if (!(await this.contactConfirmed(session.userId))) {
      // The provider created a session on its way to telling us the password was right. Nothing has been
      // returned to the BFF, so no browser can hold it — but it exists, so it is revoked rather than left
      // to expire. Best effort: the sign-in is refused either way, and a failed revocation must not turn
      // into a different answer.
      try {
        await this.provider.signOut(session.accessToken);
      } catch {
        this.logger.error('An unverified account’s discarded session could not be revoked.');
      }
      await record(AUTH_EVENT.failure, REASON.contactUnverified, session.userId);
      throw new InvalidCredentialsError();
    }

    await record(AUTH_EVENT.success, REASON.accepted, session.userId);

    // 5c. The device this sign-in came from (C-15). Deliberately after the durable record and the
    //     event: a device note is an observation about a login that has already succeeded, and it must
    //     not be able to change whether that login succeeds. Best-effort for the same reason the event
    //     writer is — see `rememberDevice`.
    const rotatedDeviceId = await this.rememberDevice(session.userId, input);

    // 6. The session goes back to the BFF, which is the only thing that may turn it into cookies.
    return rotatedDeviceId === null ? session : { ...session, rotatedDeviceId };
  }

  /**
   * Whether the account has confirmed any contact (Phase 7-A, 0065).
   *
   * **Never fails open.** The specification's rule for the enforcement fallback is that auth controls do
   * not fail open, and this is an auth control: a read that cannot answer denies the sign-in rather than
   * allowing one. It becomes a 503, distinct from a wrong password, exactly as an unreachable lockout
   * store already does.
   */
  private async contactConfirmed(userId: string): Promise<boolean> {
    try {
      return await this.identities.loginContactConfirmed(userId);
    } catch (error) {
      this.logger.error('Whether the account has a confirmed contact could not be established.');
      throw new EnforcementUnavailableError(error);
    }
  }

  /**
   * Records the device, if this request carried one (C-15).
   *
   * The raw value is hashed here and never leaves this method: what reaches the database is the keyed
   * digest and nothing else. A value that is not the shape this server issues yields no digest and
   * therefore no device record — a caller cannot register a device of its own invention.
   *
   * **A revoked device is replaced, never revived (C-15 §4).** If the value the browser presented
   * belongs to a row that has been revoked, that row is left exactly as it is — `revoked_at` intact,
   * sighting untouched — and a brand-new device value is issued and registered alongside it. The
   * browser is then given the new value, so the person can sign in from that machine again while the
   * revoked device stays revoked forever. Nothing here can clear a revocation.
   *
   * Returns the fresh value when that happened, and null otherwise. The value is returned rather than
   * logged: it reaches exactly one place, the BFF's `Set-Cookie`.
   *
   * Failures are swallowed on purpose. The person is signed in; the session has been created, the
   * attempt recorded and the event written. Turning a failed note about which browser they used into a
   * failed login would trade a real capability for a bookkeeping detail. The same reasoning already
   * governs the security-event writer.
   */
  private async rememberDevice(userId: string, input: LoginInput): Promise<string | null> {
    const deviceHash = this.devices.digestOf(input.deviceId ?? null);
    if (deviceHash === null) return null;
    try {
      const seen = await this.deviceStore.registerKnownDevice({ userId, deviceHash, requestIp: input.requestIp });
      if (seen.outcome !== 'revoked') return null;

      // A second, separate registration: a different digest, so it can only ever insert a new row.
      const fresh = DeviceIdentity.issue();
      const replacement = await this.deviceStore.registerKnownDevice({
        userId,
        deviceHash: this.devices.digest(fresh),
        requestIp: input.requestIp,
      });
      // Only a genuine new registration rotates the cookie. Anything else leaves the browser with what
      // it had rather than handing it a value the database did not accept.
      return replacement.outcome === 'registered' ? fresh : null;
    } catch {
      this.logger.error('The device could not be recorded; the sign-in still stands.');
      return null;
    }
  }
}
