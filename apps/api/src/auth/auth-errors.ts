/**
 * Authentication failures the enforcement layer can raise.
 *
 * Every message here is deliberately identical and deliberately uninformative. The specification's login
 * flow ends with "Generic error message always", and the approved decision "Registration and recovery
 * responses never reveal whether an account exists" has the same shape: a caller must not be able to
 * tell a locked account from a wrong password from an address that was never registered.
 *
 * The distinction between these classes is therefore carried by the *type*, for the API's own logging and
 * security events, and never by the message. These errors are not mapped to HTTP status codes here: the
 * specification defines no status code for a lockout or a throttle rejection, so that mapping belongs to
 * the step that introduces the login endpoint, under an owner decision.
 */

/** The single response text every authentication failure uses. */
export const GENERIC_AUTH_FAILURE_MESSAGE = 'Authentication failed.';

export abstract class AuthEnforcementError extends Error {
  protected constructor() {
    super(GENERIC_AUTH_FAILURE_MESSAGE);
    this.name = new.target.name;
  }
}

/** The account holds an active lockout. Raised before any Supabase call is made (AUTH-3 / N1). */
export class AccountLockedError extends AuthEnforcementError {
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
  constructor(override readonly cause: unknown) {
    super();
  }
}
