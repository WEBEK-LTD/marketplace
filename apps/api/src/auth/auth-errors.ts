import type { ProblemCode } from '@repo/contracts';

/**
 * Authentication failures the enforcement layer can raise.
 *
 * Every message here is deliberately identical and deliberately uninformative. The specification's login
 * flow ends with "Generic error message always", and the approved decision "Registration and recovery
 * responses never reveal whether an account exists" has the same shape: a caller must not be able to
 * tell a locked account from a wrong password from an address that was never registered.
 *
 * The distinction between these classes is therefore carried by the *type*, for the API's own logging and
 * security events, and never by the message. Owner decision C-2 supplied the statuses the specification
 * did not define, so each error now declares the problem it becomes — and two of them declare the same
 * one on purpose.
 */

/** The single response text every authentication failure uses. */
export const GENERIC_AUTH_FAILURE_MESSAGE = 'Authentication failed.';

/**
 * The status and code each error becomes, per owner decision C-2.
 *
 * Declaring it on the error keeps the mapping next to the meaning, and keeps `common` from importing
 * `auth`. Note that two different classes carry the *same* problem: a locked account and a wrong
 * password are distinct internally and identical on the wire, which is the requirement.
 */
export interface AuthProblem {
  readonly status: number;
  readonly code: ProblemCode;
}

export abstract class AuthEnforcementError extends Error {
  /** What the problem-details filter renders. Never varies with the cause of the failure. */
  abstract readonly problem: AuthProblem;

  protected constructor() {
    super(GENERIC_AUTH_FAILURE_MESSAGE);
    this.name = new.target.name;
  }
}

const AUTHENTICATION_FAILED: AuthProblem = Object.freeze({ status: 401, code: 'AUTHENTICATION_FAILED' });
const TOO_MANY_REQUESTS: AuthProblem = Object.freeze({ status: 429, code: 'TOO_MANY_REQUESTS' });
const SERVICE_UNAVAILABLE: AuthProblem = Object.freeze({ status: 503, code: 'SERVICE_UNAVAILABLE' });

const VALIDATION_FAILED: AuthProblem = Object.freeze({ status: 400, code: 'VALIDATION_FAILED' });

/**
 * A new password that the approved D1 policy refuses (F3).
 *
 * It is a 400 and not a 401 because nothing about authentication failed: the person's token is still
 * valid and deliberately still unconsumed. The issue identifiers travel for the server's own record and
 * never the password itself.
 */
export class PasswordPolicyError extends AuthEnforcementError {
  readonly problem = VALIDATION_FAILED;
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super();
    this.issues = Object.freeze([...issues]);
  }
}

const AUTHENTICATION_REQUIRED: AuthProblem = Object.freeze({ status: 401, code: 'AUTHENTICATION_REQUIRED' });
const THROTTLED: AuthProblem = Object.freeze({ status: 429, code: 'THROTTLED' });

// Phase 7-B. The only two things the TOTP surface ever says beyond the generic refusal, and both are
// facts about the caller's own account that the same surface already reports.
const TOTP_ALREADY_ENROLLED: AuthProblem = Object.freeze({ status: 409, code: 'TOTP_ALREADY_ENROLLED' });
const TOTP_NOT_ENROLLED: AuthProblem = Object.freeze({ status: 409, code: 'TOTP_NOT_ENROLLED' });

/**
 * No usable session was presented (F4).
 *
 * Distinct from {@link InvalidCredentialsError} because nothing was attempted: the caller never got as
 * far as presenting a code. The approved F4 contract gives it its own code, and it says no more than
 * that a session is needed.
 */
export class AuthenticationRequiredError extends AuthEnforcementError {
  readonly problem = AUTHENTICATION_REQUIRED;

  constructor() {
    super();
  }
}

/**
 * The approved OTP-send limits refused a contact-change request (F4).
 *
 * Same numbers and same counters as everywhere else; only the response code differs, because the F4
 * contract names `THROTTLED` where the login contract names `TOO_MANY_REQUESTS`.
 */
export class ContactChangeThrottledError extends AuthEnforcementError {
  readonly problem = THROTTLED;
  readonly bucket: string;

  constructor(bucket: string) {
    super();
    this.bucket = bucket;
  }
}

/** The account holds an active lockout. Raised before any Supabase call is made (AUTH-3 / N1). */
export class AccountLockedError extends AuthEnforcementError {
  readonly problem = AUTHENTICATION_FAILED;

  constructor() {
    super();
  }
}

/**
 * The durable lockout state could not be established.
 *
 * The specification requires the Postgres fallback to "never fail open for auth", so an unreachable or
 * erroring database denies the attempt. This is a distinct type only so that the API can alert on it;
 * the caller still sees the generic message.
 */
export class EnforcementUnavailableError extends AuthEnforcementError {
  readonly problem = SERVICE_UNAVAILABLE;

  constructor(override readonly cause: unknown) {
    super();
  }
}

/**
 * The identifier matched no account, or the password was wrong.
 *
 * One type for both, because the API never learns which: Supabase answers a bad password and an unknown
 * address with the same refusal, and nothing downstream is allowed to tell them apart either. It sits
 * beside {@link AccountLockedError} so the *internal* record can distinguish them (C-20 reason codes);
 * both leave the building as the same status, the same code and the same body (C-2).
 */
export class InvalidCredentialsError extends AuthEnforcementError {
  readonly problem = AUTHENTICATION_FAILED;

  constructor() {
    super();
  }
}

/**
 * A throttle bucket rejected the request (C-1).
 *
 * Distinct from a lockout: a lockout is about one account and lasts 15 minutes after 5 failures, while a
 * throttle is about request volume per identifier, per IP and per burst, and counts every request
 * whether it succeeded or not. The caller sees 429; it learns nothing about which bucket, or whether the
 * account exists.
 */
export class LoginThrottledError extends AuthEnforcementError {
  readonly problem = TOO_MANY_REQUESTS;

  constructor(readonly bucket: string) {
    super();
  }
}

/**
 * The caller already has a verified authenticator (Phase 7-B).
 *
 * A 409 rather than a 400, because nothing about the request was malformed: the account is simply in a
 * state where enrolling again is not what happens. It is safe to say so — it is the caller's own state,
 * readable from the same surface they just asked — and it is the only thing enrolment ever discloses.
 */
export class TotpAlreadyEnrolledError extends AuthEnforcementError {
  readonly problem = TOTP_ALREADY_ENROLLED;

  constructor() {
    super();
  }
}

/**
 * A challenge was asked for by a caller who has no authenticator (Phase 7-B).
 *
 * Distinct from {@link InvalidCredentialsError} because nothing was attempted and nothing can be
 * retried: there is no code that would work. Like its sibling above it reports only the caller's own
 * state, and it is what sends somebody to the setup screen instead of a code box.
 */
export class TotpNotEnrolledError extends AuthEnforcementError {
  readonly problem = TOTP_NOT_ENROLLED;

  constructor() {
    super();
  }
}

/**
 * Supabase Auth could not be reached, or answered in a way this service does not understand.
 *
 * Never conflated with a wrong password. A provider outage that rendered as "authentication failed"
 * would train users to retype a correct password and would hide the outage from every dashboard that
 * watches failure rates; C-2 gives it 503 precisely so the two stay apart.
 */
export class AuthProviderUnavailableError extends AuthEnforcementError {
  readonly problem = SERVICE_UNAVAILABLE;

  constructor(override readonly cause: unknown) {
    super();
  }
}
