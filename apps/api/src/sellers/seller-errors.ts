import type { ProblemCode } from '@repo/contracts';

/**
 * Seller failures (Phase 6-A).
 *
 * Each declares the problem it becomes, which is how every other error in this API reaches the
 * problem-details filter — no mapping table, no `try`/`catch` in a controller turning outcomes into
 * statuses.
 *
 * {@link SellerProfileNotFoundError} is the answer for an authenticated caller who is not a seller. It is
 * a 404 rather than a 403, and it uses the platform's ordinary not-found code rather than one that names
 * sellers: "you have no storefront" and "there is nothing here" are the same sentence, and a code that
 * said *why* would be a code that distinguishes an account with a pending application from one with none.
 * There is nothing to hide from the caller about their own account — the reader reports every status — but
 * there is no reason to invent a second vocabulary for an absence either.
 */
export class SellerProfileNotFoundError extends Error {
  readonly problem: { readonly status: number; readonly code: ProblemCode } = {
    status: 404,
    code: 'NOT_FOUND',
  };

  constructor() {
    super('The requested resource was not found.');
    this.name = 'SellerProfileNotFoundError';
  }
}

/**
 * The caller already has a storefront (Phase 6-C).
 *
 * A 409 with its own code, unlike the not-found above, and for the opposite reason: there is nothing to
 * hide and something to say. The caller is asking about their own account, already knows whether they have
 * one, and a form that received a bare validation failure could not tell them to go to their dashboard
 * instead. Nothing is created and nothing is replaced.
 */
export class SellerProfileExistsError extends Error {
  readonly problem: { readonly status: number; readonly code: ProblemCode } = {
    status: 409,
    code: 'SELLER_PROFILE_EXISTS',
  };

  constructor() {
    super('A seller profile already exists for this account.');
    this.name = 'SellerProfileExistsError';
  }
}

/**
 * The chosen public address belongs to another storefront (Phase 6-C).
 *
 * It says that, and only that. Never who holds the slug, never when they took it, and never what state
 * their storefront is in — a message that distinguished "taken by an active seller" from "taken by a
 * pending one" would be an enumeration oracle over accounts, reachable by anyone who can guess names. The
 * caller's remedy is the same in every case: choose another address.
 */
export class SellerSlugTakenError extends Error {
  readonly problem: { readonly status: number; readonly code: ProblemCode } = {
    status: 409,
    code: 'SELLER_SLUG_TAKEN',
  };

  constructor() {
    super('That seller address is not available.');
    this.name = 'SellerSlugTakenError';
  }
}

/**
 * The storefront is suspended or closed, so it cannot be edited (Phase 6-D).
 *
 * A 409 with its own code, and the sentence behind it says only that. Not why the account was suspended,
 * not when, not by whom and not for how long — the suspension reason is moderation's record and is neither
 * selected nor returned by anything on this path. The caller's own *state* is not a secret from them: they
 * can read `suspended` or `closed` from their own seller identity, which is what a surface uses to disable
 * its controls. What the state means is a conversation with a human, not an error code.
 */
export class SellerProfileNotEditableError extends Error {
  readonly problem: { readonly status: number; readonly code: ProblemCode } = {
    status: 409,
    code: 'SELLER_PROFILE_NOT_EDITABLE',
  };

  constructor() {
    super('This seller profile cannot be edited in its current state.');
    this.name = 'SellerProfileNotEditableError';
  }
}

/**
 * The onboarding request does not satisfy the storefront's own constraints (Phase 6-C).
 *
 * One error for all of them, carrying no field name, no constraint name and no SQL. The strict contract has
 * already told the caller which field is wrong in the ordinary case; this is what is left when the database
 * refuses something the contract allowed — a country that is not enabled for the marketplace, a locale that
 * does not exist — and naming the constraint would be describing the schema to whoever asked.
 */
export class SellerOnboardingInvalidError extends Error {
  readonly problem: { readonly status: number; readonly code: ProblemCode } = {
    status: 400,
    code: 'VALIDATION_FAILED',
  };

  constructor() {
    super('The seller information could not be accepted.');
    this.name = 'SellerOnboardingInvalidError';
  }
}

/** The approved onboarding limit refused this attempt (Phase 6-C). */
export class SellerThrottledError extends Error {
  readonly problem: { readonly status: number; readonly code: ProblemCode } = {
    status: 429,
    code: 'THROTTLED',
  };
  readonly bucket: string;

  constructor(bucket: string) {
    super('Too many requests.');
    this.name = 'SellerThrottledError';
    this.bucket = bucket;
  }
}

/**
 * The object a confirmation names is not in storage (Phase 6-E).
 *
 * A 404 with its own code, because the remedy is specific and the caller can act on it: the bytes never
 * arrived, so upload them and confirm again. A generic validation failure would send somebody looking at their
 * form fields for a mistake that is not there. It says nothing about storage — no bucket, no path, no provider,
 * no reason beyond the one fact.
 */
export class SellerMediaObjectMissingError extends Error {
  readonly problem: { readonly status: number; readonly code: ProblemCode } = {
    status: 404,
    code: 'SELLER_MEDIA_OBJECT_MISSING',
  };

  constructor() {
    super('The uploaded file could not be found.');
    this.name = 'SellerMediaObjectMissingError';
  }
}

/**
 * The listing is not in a state this surface writes (Phase 6-F).
 *
 * One error for several situations that share a remedy and must not be told apart in detail: the storefront
 * is suspended or closed, the listing has already been submitted and is now somebody else's to act on, or it
 * is not live and so cannot be archived. It never says which moderation state a listing is in, never names a
 * moderator or a decision, and never carries a rejection reason — a seller reads their own listing's status
 * from the listings index, which is the owner reading their own row, and the meaning of a moderation state is
 * a conversation with a human rather than an error code.
 */
export class SellerListingNotEditableError extends Error {
  readonly problem: { readonly status: number; readonly code: ProblemCode } = {
    status: 409,
    code: 'SELLER_LISTING_NOT_EDITABLE',
  };

  constructor() {
    super('This listing cannot be changed in its current state.');
    this.name = 'SellerListingNotEditableError';
  }
}

/**
 * The chosen listing address is unavailable (Phase 6-F).
 *
 * It says that and nothing else — never who holds the address, never whether a listing ever lived there and
 * never whether one was deleted. The underlying refusal can come from a live listing or from the permanent
 * redirect history a slug accumulates, and the two are deliberately indistinguishable here: telling them
 * apart would report that something once existed at an address, which is an enumeration oracle over a
 * catalogue. The remedy is the same either way: choose another address.
 */
export class SellerListingSlugTakenError extends Error {
  readonly problem: { readonly status: number; readonly code: ProblemCode } = {
    status: 409,
    code: 'SELLER_LISTING_SLUG_TAKEN',
  };

  constructor() {
    super('That listing address is not available.');
    this.name = 'SellerListingSlugTakenError';
  }
}

/**
 * The draft cannot yet be reviewed (Phase 6-F).
 *
 * Its own code because the remedy is specific and entirely in the seller's hands: the listing needs a price
 * before a moderator can be asked to look at it. It is the approval rule applied a step early, so a seller
 * learns now rather than after somebody's time has been spent on it. It names no column and no constraint.
 */
export class SellerListingIncompleteError extends Error {
  readonly problem: { readonly status: number; readonly code: ProblemCode } = {
    status: 409,
    code: 'SELLER_LISTING_INCOMPLETE',
  };

  constructor() {
    super('This listing is not yet complete enough to be submitted for review.');
    this.name = 'SellerListingIncompleteError';
  }
}

/**
 * The listing does not satisfy the listings table's own constraints (Phase 6-F).
 *
 * One error for all of them, carrying no field name, no constraint name and no SQL. The strict contract has
 * already told the caller which field is wrong in the ordinary case; this is what is left when the database
 * refuses something the contract allowed — a category that does not exist or is not active, a category scoped
 * to the other listing type, a country that is not enabled for the marketplace, a currency that is not enabled
 * for pricing, a locale that is not one. Naming which would be describing the schema to whoever asked.
 */
export class SellerListingInvalidError extends Error {
  readonly problem: { readonly status: number; readonly code: ProblemCode } = {
    status: 400,
    code: 'VALIDATION_FAILED',
  };

  constructor() {
    super('The listing information could not be accepted.');
    this.name = 'SellerListingInvalidError';
  }
}

/**
 * No listing of the caller's lives at that address (Phase 6-F).
 *
 * A 404 carrying the platform's ordinary not-found code, and it is the same answer for a listing that does
 * not exist, one that belongs to another seller and one that has been deleted. That is the point: a distinct
 * "not yours" would confirm that the listing is real, which would make this surface an oracle over every
 * address in the catalogue for anyone with a session.
 */
export class SellerListingNotFoundError extends Error {
  readonly problem: { readonly status: number; readonly code: ProblemCode } = {
    status: 404,
    code: 'NOT_FOUND',
  };

  constructor() {
    super('The requested resource was not found.');
    this.name = 'SellerListingNotFoundError';
  }
}

/**
 * The listings cursor cannot be read (Phase 6-F).
 *
 * Malformed, altered, or from a version this API no longer reads — one code for all three, because the
 * client's remedy is the same in each and naming which check failed would help somebody mapping the format.
 */
export class InvalidSellerListingCursorError extends Error {
  readonly problem: { readonly status: number; readonly code: ProblemCode } = {
    status: 400,
    code: 'SELLER_LISTING_CURSOR_INVALID',
  };

  constructor() {
    super('That page cursor could not be read.');
    this.name = 'InvalidSellerListingCursorError';
  }
}

/**
 * An attempt is already open (Phase 6-I).
 *
 * The storefront has a verification in `draft`, `submitted` or `under_review`, and the verification schema
 * permits exactly one of those at a time. Its own code because the remedy is not to try again but to work on
 * the attempt that exists, which the same surface returns; nothing is created, and the existing attempt is
 * left exactly as it was.
 */
export class SellerVerificationExistsError extends Error {
  readonly problem: { readonly status: number; readonly code: ProblemCode } = {
    status: 409,
    code: 'SELLER_VERIFICATION_EXISTS',
  };

  constructor() {
    super('A verification is already in progress.');
    this.name = 'SellerVerificationExistsError';
  }
}

/**
 * The storefront is already verified (Phase 6-I, owner decision 2).
 *
 * No attempt is created and no form is offered: a verified seller has nothing to apply for, and this API
 * provides no way to verify again. It is a conflict rather than a refusal because the caller's own state is
 * the reason, and that state is already readable to them.
 */
export class SellerVerificationAlreadyVerifiedError extends Error {
  readonly problem: { readonly status: number; readonly code: ProblemCode } = {
    status: 409,
    code: 'SELLER_VERIFICATION_ALREADY_VERIFIED',
  };

  constructor() {
    super('This storefront is already verified.');
    this.name = 'SellerVerificationAlreadyVerifiedError';
  }
}

/**
 * The attempt is not in a state this surface writes (Phase 6-I).
 *
 * One error for several situations that share a remedy and must not be told apart: the storefront is suspended
 * or closed, or the attempt has reached `under_review`, `approved`, `rejected` or `expired` and is no longer
 * the applicant's to change. It never says which, never names a reviewer, never carries a decision reason and
 * never hints at how a decision went — a seller reads their own attempt's status from the verification
 * surface, which is the owner reading their own row, and what a decision *meant* is a conversation with a
 * human rather than an error code.
 */
export class SellerVerificationNotEditableError extends Error {
  readonly problem: { readonly status: number; readonly code: ProblemCode } = {
    status: 409,
    code: 'SELLER_VERIFICATION_NOT_EDITABLE',
  };

  constructor() {
    super('This verification cannot be changed in its current state.');
    this.name = 'SellerVerificationNotEditableError';
  }
}

/**
 * That object has already been recorded (Phase 6-I).
 *
 * Its own code because the remedy is to authorize a fresh upload rather than to correct a field. It is reached
 * only for an object inside the caller's own namespace: another seller's already-recorded object is refused
 * earlier, by the path check, and answers as invalid — so this never reveals that somebody else's document is
 * there.
 */
export class SellerVerificationDocumentPathTakenError extends Error {
  readonly problem: { readonly status: number; readonly code: ProblemCode } = {
    status: 409,
    code: 'SELLER_VERIFICATION_DOCUMENT_PATH_TAKEN',
  };

  constructor() {
    super('That upload has already been recorded.');
    this.name = 'SellerVerificationDocumentPathTakenError';
  }
}

/** The database could not be asked, or answered something this API does not understand. */
export class SellerIdentityUnavailableError extends Error {
  readonly problem: { readonly status: number; readonly code: ProblemCode } = {
    status: 503,
    code: 'SERVICE_UNAVAILABLE',
  };

  constructor(cause?: unknown) {
    super('The service is temporarily unavailable.');
    this.name = 'SellerIdentityUnavailableError';
    if (cause !== undefined) this.cause = cause;
  }
}
