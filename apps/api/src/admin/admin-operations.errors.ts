import type { ProblemCode } from '@repo/contracts';

/**
 * Seller, user, recovery and audit failures, the admin side (Phase 7-O).
 *
 * Each declares the problem it becomes, which is how every other error in this API reaches the
 * problem-details filter.
 *
 * **There is no "forbidden" here.** A storefront, an account or a recovery request that does not exist, and
 * a caller who does not hold the required key at `aal2`, all become {@link AdminOperationsNotFoundError} —
 * identical in status, code and sentence. That is 7-G's, 7-L's and 7-N's rule on the admin surfaces and it
 * holds for the same reason: a distinguishable refusal is a way to ask whether a row exists, and on these
 * four surfaces the rows are people.
 *
 * It matters more here than anywhere else, because these keys are not held together. A support agent holds
 * `users.profile.read` and not `users.security.read`; a moderator holds `sellers.profile.read` and not
 * `users.role.read`; only an administrator holds `audit.read`. If a missing key answered differently from
 * an absent row, each of those surfaces would be a way for a colleague to learn what they are not trusted
 * to read — and, worse, a way to confirm that a particular account exists at all.
 *
 * The four refusals below are the recovery workflow's, and each is about the caller's own request or about a
 * row they are already reading, so naming the reason discloses nothing. There is **no error class here for
 * assigning a role or for changing a seller's status**, because there is no operation that does either: both
 * lack an authoritative writer in this repository and are reported as capability gaps.
 */

/** Nothing here for this caller. One answer for absence and for a missing permission. */
export class AdminOperationsNotFoundError extends Error {
  readonly problem: { readonly status: number; readonly code: ProblemCode } = {
    status: 404,
    code: 'NOT_FOUND',
  };

  constructor() {
    super('The requested resource was not found.');
    this.name = 'AdminOperationsNotFoundError';
  }
}

/**
 * The recovery request is the caller's own account.
 *
 * 0028 refuses it at every step — "nobody reviews their own recovery", "nobody approves their own recovery",
 * "nobody completes their own recovery". It discloses nothing, because the only account it concerns is the
 * caller's, and the remedy is for a colleague to take it.
 */
export class RecoveryIsOwnError extends Error {
  readonly problem: { readonly status: number; readonly code: ProblemCode } = {
    status: 409,
    code: 'RECOVERY_IS_OWN',
  };

  constructor() {
    super('Nobody acts on their own account recovery.');
    this.name = 'RecoveryIsOwnError';
  }
}

/**
 * The decision needs somebody other than the caller.
 *
 * The two-person rule, which 0028's own writer enforces: the reviewer can never approve their own review.
 * The account holder reaches the same refusal, and both arrive here as one code, because to a console they
 * mean the same thing and telling them apart would say which of the two the caller is.
 */
export class RecoveryNeedsAnotherPersonError extends Error {
  readonly problem: { readonly status: number; readonly code: ProblemCode } = {
    status: 409,
    code: 'RECOVERY_NEEDS_ANOTHER_PERSON',
  };

  constructor() {
    super('A recovery is decided by somebody other than the person who reviewed it.');
    this.name = 'RecoveryNeedsAnotherPersonError';
  }
}

/**
 * The request is not in a state for that step.
 *
 * One class carrying the step's own code, because the remedy is the same in each: reload and read where the
 * request actually is. This is also what a repeat looks like, and what the second of two colleagues acting
 * at once receives — the writer locks the row, so they are ordered rather than raced.
 */
export class RecoveryNotInStateError extends Error {
  readonly problem: { readonly status: number; readonly code: ProblemCode };

  constructor(code: 'RECOVERY_NOT_REVIEWABLE' | 'RECOVERY_NOT_DECIDABLE' | 'RECOVERY_NOT_COMPLETABLE') {
    super('This recovery request is not at that step.');
    this.name = 'RecoveryNotInStateError';
    this.problem = { status: 409, code };
  }
}

/**
 * The request was refused by the writer's own validation.
 *
 * Reached only when a value survives the contract and the database still refuses it — a decision that is
 * neither of the two words, or a rejection with no reason. Both are checked before the call, so this is the
 * floor rather than the path.
 */
export class RecoveryInvalidError extends Error {
  readonly problem: { readonly status: number; readonly code: ProblemCode } = {
    status: 400,
    code: 'VALIDATION_FAILED',
  };

  constructor() {
    super('That recovery decision was refused.');
    this.name = 'RecoveryInvalidError';
  }
}

/**
 * A seller status transition the database refused.
 *
 * One class carrying the refusal's own code, because each has a different remedy and none of them discloses
 * anything: every one is about the storefront the caller is already reading.
 *
 *   * `SELLER_STATUS_NOT_ALLOWED` — not one of the seven legal pairs. Covers every move out of `closed`,
 *     which is terminal; `active → pending`; and `pending → active`, which belongs to 7-G's verification
 *     approval. Retrying never helps.
 *   * `SELLER_STATUS_NO_CHANGE` — the storefront is already there. This is what a repeat looks like and what
 *     the second of two colleagues acting at once receives, the writer having locked the row.
 *   * `SELLER_STATUS_REASON_REQUIRED` — a suspension with no reason. The contract checks it first, so this is
 *     the floor rather than the path.
 *   * `SELLER_STATUS_NOT_VERIFIED` / `SELLER_STATUS_ALREADY_VERIFIED` — the two reinstatement conditions,
 *     which are complements: a verified storefront reinstates to `active`, an unverified one to `pending`.
 */
export class SellerStatusRefusedError extends Error {
  readonly problem: { readonly status: number; readonly code: ProblemCode };

  constructor(
    code:
      | 'SELLER_STATUS_NOT_ALLOWED'
      | 'SELLER_STATUS_NO_CHANGE'
      | 'SELLER_STATUS_REASON_REQUIRED'
      | 'SELLER_STATUS_NOT_VERIFIED'
      | 'SELLER_STATUS_ALREADY_VERIFIED',
  ) {
    super('That status change was refused.');
    this.name = 'SellerStatusRefusedError';
    this.problem = { status: 409, code };
  }
}

/**
 * A role grant or withdrawal the database refused (0100).
 *
 * Eight codes, each naming a different boundary, and **none of them is a "forbidden"**: a caller who does not
 * hold `users.role.manage`, an account that does not exist and a role nobody holds all become
 * {@link AdminOperationsNotFoundError} instead, exactly as every other operation in this console behaves.
 * What reaches here is a refusal of a change by somebody entitled to attempt it, which tells them nothing they
 * did not already have the right to know:
 *
 *   * `STAFF_ROLE_IS_SELF` — they are the target. Granting and withdrawing are both refused.
 *   * `STAFF_ROLE_ABOVE_CEILING` — the role sits above their own highest effective role.
 *   * `STAFF_ROLE_NOT_GRANTABLE` / `STAFF_ROLE_NOT_REVOCABLE` — `super_admin`, from either side.
 *   * `STAFF_ROLE_NOT_ASSIGNABLE` — `roles.is_assignable` is false for it.
 *   * `STAFF_ROLE_ALREADY_REVOKED` — what a repeat, and a race, look like.
 *   * `STAFF_ROLE_EXPIRY_INVALID` — an expiry that is not in the future.
 *   * `STAFF_ROLE_REASON_REQUIRED` — the floor under the contract's own required reason.
 */
export class StaffRoleRefusedError extends Error {
  readonly problem: { readonly status: number; readonly code: ProblemCode };

  constructor(
    code:
      | 'STAFF_ROLE_IS_SELF'
      | 'STAFF_ROLE_ABOVE_CEILING'
      | 'STAFF_ROLE_NOT_GRANTABLE'
      | 'STAFF_ROLE_NOT_REVOCABLE'
      | 'STAFF_ROLE_NOT_ASSIGNABLE'
      | 'STAFF_ROLE_ALREADY_REVOKED'
      | 'STAFF_ROLE_EXPIRY_INVALID'
      | 'STAFF_ROLE_REASON_REQUIRED',
  ) {
    super('That role change was refused.');
    this.name = 'StaffRoleRefusedError';
    this.problem = { status: 409, code };
  }
}

/** An unusable page cursor. One code for every way a cursor can fail to be one. */
export class AdminOperationsCursorInvalidError extends Error {
  readonly problem: { readonly status: number; readonly code: ProblemCode } = {
    status: 400,
    code: 'VALIDATION_FAILED',
  };

  constructor() {
    super('The cursor could not be read.');
    this.name = 'AdminOperationsCursorInvalidError';
  }
}

/** Raised when a read or a write could not be performed at all. Becomes a 503. */
export class AdminOperationsUnavailableError extends Error {
  readonly problem: { readonly status: number; readonly code: ProblemCode } = {
    status: 503,
    code: 'SERVICE_UNAVAILABLE',
  };

  constructor(cause?: unknown) {
    super('The service is temporarily unavailable.');
    this.name = 'AdminOperationsUnavailableError';
    if (cause !== undefined) this.cause = cause;
  }
}
