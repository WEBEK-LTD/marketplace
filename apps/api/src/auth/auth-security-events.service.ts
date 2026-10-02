import { Inject, Injectable, Logger } from '@nestjs/common';

/**
 * The event types owner decision C-20 approves, and no others.
 *
 * Five of them are the login outcomes C-20 defined. The sixth, `auth.password_reset.success`, was added
 * by the F3 decision, the seventh, `auth.contact_change.success`, by F4, and the eighth,
 * `auth.registration.success`, by Phase 7-A. All three are success-only: there is deliberately no failure
 * type, so a refused reset, a refused code and a registration that created nothing leave no row that
 * could be counted to learn something about an account.
 *
 * Every name is `auth.<flow>.<outcome>`, the flow in snake_case. A new flow gets a new middle segment and
 * reuses the outcome words; it does not get a new shape.
 */
export const AUTH_EVENT = Object.freeze({
  success: 'auth.login.success',
  failure: 'auth.login.failure',
  locked: 'auth.login.locked',
  throttled: 'auth.login.throttled',
  providerError: 'auth.login.provider_error',
  passwordResetSuccess: 'auth.password_reset.success',
  contactChangeSuccess: 'auth.contact_change.success',
  registrationSuccess: 'auth.registration.success',
} as const);

export type AuthEventType = (typeof AUTH_EVENT)[keyof typeof AUTH_EVENT];

/**
 * One authentication event, already pseudonymous.
 *
 * Every field that could identify a person arrives hashed, and there is deliberately no field for a
 * password, a token, an OTP or a cookie: C-20's "never store" list is enforced by the shape of this
 * type as much as by the database function behind it.
 */
export interface AuthSecurityEvent {
  readonly eventType: AuthEventType;
  readonly userId: string | null;
  readonly identifierHash: Buffer;
  readonly ipHash: Buffer | null;
  readonly userAgentHash: Buffer | null;
  readonly requestId: string | null;
  /** Short internal code, never a message and never a value. */
  readonly reasonCode: string;
}

export interface AuthSecurityEventStore {
  /** `app_private.record_auth_security_event(...)`. */
  recordAuthSecurityEvent(event: AuthSecurityEvent): Promise<void>;
}

export const AUTH_SECURITY_EVENT_STORE = Symbol('AUTH_SECURITY_EVENT_STORE');

/**
 * The C-20 writer, and the one place authentication events are produced.
 *
 * Recording is **best effort on purpose**, and this is the one design choice here worth stating
 * plainly. The controls that must never fail open are the throttle, the durable lockout and the login
 * attempt record; each of those raises and denies the request if it cannot be written. A security event
 * is the timeline a human reads afterwards. Failing a correct sign-in because an append to that
 * timeline failed would turn an observability outage into an authentication outage, so a write failure
 * is logged loudly and the request continues.
 */
@Injectable()
export class AuthSecurityEventsService {
  private readonly logger = new Logger(AuthSecurityEventsService.name);

  constructor(@Inject(AUTH_SECURITY_EVENT_STORE) private readonly store: AuthSecurityEventStore) {}

  async record(event: AuthSecurityEvent): Promise<void> {
    try {
      await this.store.recordAuthSecurityEvent(event);
    } catch {
      // No identifier, no address and no provider text in this message: it is the fact of the failure.
      this.logger.error(`Recording the ${event.eventType} security event failed.`);
    }
  }
}
