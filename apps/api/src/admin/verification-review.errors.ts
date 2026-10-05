import type { ProblemCode } from '@repo/contracts';
import { RequestValidationException } from '../common/request-validation.exception.js';

/**
 * The reviewer surface's failures (Phase 7-G).
 *
 * **There is deliberately no "forbidden" here.** A reviewer who may not review, a verification that does
 * not exist, a draft, a document on somebody else's application and a document id spent against the
 * wrong case all become {@link VerificationNotFoundError}: the same status, the same code and the same
 * sentence. A distinct refusal for any of them would confirm that a particular application is there,
 * which is exactly what a surface holding identity documents must not do. The admin shell refuses an
 * unauthorized person at the page boundary, where a neutral refusal is a page and not an oracle.
 *
 * The two conflicts below are the opposite case: both are facts about the application in front of the
 * reviewer, both change what they should do next, and neither names another person.
 */

/** Nothing here for this caller. One answer for absence and for "you may not review". */
export class VerificationNotFoundError extends Error {
  readonly problem: { readonly status: number; readonly code: ProblemCode } = {
    status: 404,
    code: 'NOT_FOUND',
  };

  constructor() {
    super('The requested resource was not found.');
    this.name = 'VerificationNotFoundError';
  }
}

/**
 * The application is not in a state this path decides from (Phase 7-G).
 *
 * Already approved, already rejected, or expired. Its own code because the remedy is specific and is not
 * about the form: reload, and look at the decision that is already recorded. The sentence names no
 * reviewer and no reason — who decided is in the record the console shows, not in an error body.
 */
export class VerificationNotDecidableError extends Error {
  readonly problem: { readonly status: number; readonly code: ProblemCode } = {
    status: 409,
    code: 'VERIFICATION_NOT_DECIDABLE',
  };

  constructor() {
    super('This verification has already been decided.');
    this.name = 'VerificationNotDecidableError';
  }
}

/**
 * An approval was attempted before both contact verifications (Phase 7-G).
 *
 * 0009's `seller_verifications_approval_needs_contacts` makes that combination impossible, and the
 * database answers it as an outcome so this can be a sentence a reviewer can act on rather than a failed
 * statement.
 */
export class VerificationContactsUnverifiedError extends Error {
  readonly problem: { readonly status: number; readonly code: ProblemCode } = {
    status: 409,
    code: 'VERIFICATION_CONTACTS_UNVERIFIED',
  };

  constructor() {
    super('This application cannot be approved until both contact details are verified.');
    this.name = 'VerificationContactsUnverifiedError';
  }
}

/**
 * A rejection with no reason (Phase 7-G).
 *
 * A validation failure naming the field, because that is what it is: a form that has not been filled in.
 * It extends the validation exception so the issue travels to the client and the form can point at the
 * box, exactly as every other missing field on this platform does.
 */
export class VerificationReasonRequiredError extends RequestValidationException {
  constructor() {
    super([{ path: 'reason', message: 'A reason is required to reject a verification.' }]);
    this.name = 'VerificationReasonRequiredError';
  }
}

/** The queue cursor cannot be read. One answer for malformed, altered and outdated. */
export class VerificationCursorInvalidError extends Error {
  readonly problem: { readonly status: number; readonly code: ProblemCode } = {
    status: 400,
    code: 'VERIFICATION_CURSOR_INVALID',
  };

  constructor() {
    super('The cursor is invalid.');
    this.name = 'VerificationCursorInvalidError';
  }
}

/** A dependency could not answer. Never rendered as a refusal: an outage is not a demotion. */
export class VerificationReviewUnavailableError extends Error {
  readonly problem: { readonly status: number; readonly code: ProblemCode } = {
    status: 503,
    code: 'SERVICE_UNAVAILABLE',
  };

  constructor(override readonly cause: unknown) {
    super('The service is temporarily unavailable.');
    this.name = 'VerificationReviewUnavailableError';
  }
}
