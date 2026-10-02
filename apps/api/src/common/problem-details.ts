import { HttpException } from '@nestjs/common';
import { PROBLEM_CODES, type ProblemCode, type ProblemDetails, type ValidationIssue } from '@repo/contracts';
import { RequestValidationException } from './request-validation.exception.js';

interface ProblemSpec {
  readonly status: number;
  readonly code: ProblemCode;
  readonly errors?: readonly ValidationIssue[];
}

/**
 * An error may declare the problem it should become.
 *
 * This keeps the mapping where the meaning is — an authentication error knows it is a 401 with
 * `AUTHENTICATION_FAILED` — without this module having to import every domain's error types, and
 * therefore without a dependency from `common` into `auth`. The declaration is validated here rather
 * than trusted: an unknown code or an out-of-range status falls through to the generic mapping.
 */
export interface DeclaresProblem {
  readonly problem: { readonly status: number; readonly code: ProblemCode };
}

function declaredProblem(error: unknown): ProblemSpec | undefined {
  const declared = (error as Partial<DeclaresProblem> | null)?.problem;
  if (declared === undefined || declared === null) return undefined;
  const { status, code } = declared as { status?: unknown; code?: unknown };
  if (typeof status !== 'number' || !Number.isInteger(status) || status < 400 || status > 599) return undefined;
  if (typeof code !== 'string' || !(PROBLEM_CODES as readonly string[]).includes(code)) return undefined;
  return { status, code: code as ProblemCode };
}

const TITLES: Readonly<Record<number, string>> = {
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  405: 'Method Not Allowed',
  409: 'Conflict',
  413: 'Content Too Large',
  415: 'Unsupported Media Type',
  422: 'Unprocessable Content',
  429: 'Too Many Requests',
  500: 'Internal Server Error',
  503: 'Service Unavailable',
};

const DETAILS: Readonly<Record<ProblemCode, string>> = {
  BAD_REQUEST: 'The request could not be processed.',
  VALIDATION_FAILED: 'The request is invalid.',
  NOT_FOUND: 'The requested resource was not found.',
  PAYLOAD_TOO_LARGE: 'The request body is too large.',
  UNSUPPORTED_MEDIA_TYPE: 'The request content type is not supported.',
  HTTP_ERROR: 'The request could not be completed.',
  INTERNAL_ERROR: 'An unexpected error occurred.',
  // C-2: one sentence for every authentication failure. A wrong password, an identifier that matches no
  // account and a locked account all read exactly like this, because anything else is an oracle.
  AUTHENTICATION_FAILED: 'Authentication failed.',
  TOO_MANY_REQUESTS: 'Too many requests.',
  SERVICE_UNAVAILABLE: 'The service is temporarily unavailable.',
  AUTHENTICATION_REQUIRED: 'Authentication is required.',
  THROTTLED: 'Too many requests.',
  // Phase 7-B. Both sentences report the caller's own account state and nothing else — no factor, no
  // date, no count — because that state is already readable from the same surface that just refused.
  TOTP_ALREADY_ENROLLED: 'This account already has an authenticator app set up.',
  TOTP_NOT_ENROLLED: 'This account has no authenticator app set up.',
  // Phase 7-C. One sentence for a malformed cursor, an altered one and one from a retired version.
  NOTIFICATIONS_CURSOR_INVALID: 'The list position could not be used.',
  // Phase 5-C. One sentence for a malformed cursor, an altered one and one from a retired version: the
  // remedy is the same in all three, and naming which check failed would help only somebody probing the
  // format. And one sentence for a conversation the caller may not read, which is deliberately the same
  // sentence a conversation that does not exist produces.
  MESSAGING_CURSOR_INVALID: 'The cursor could not be used.',
  MESSAGING_CONVERSATION_NOT_FOUND: 'The conversation could not be found.',
  // Phase 5-E. Each says what the caller can do something about and nothing more: a closed conversation
  // is closed, an exchange that is blocked is unavailable without saying who blocked whom, and a seller
  // who cannot be contacted is one sentence for a suspension, a closure and a listing nobody can see.
  MESSAGING_CONVERSATION_CLOSED: 'The conversation is closed.',
  MESSAGING_BLOCKED: 'The conversation is not available.',
  MESSAGING_SELLER_NOT_CONTACTABLE: 'This seller cannot be contacted.',
  // Phase 5-H. One sentence for a message or conversation the caller may not report and one that does
  // not exist: the two are the same refusal, and a second sentence would be the difference between them.
  MESSAGING_REPORT_TARGET_NOT_FOUND: 'The reported item could not be found.',
  // Phase 6-C. The caller may know both of these about their own attempt: that they already have a
  // storefront, and that the public address they asked for is unavailable. Neither sentence says anything
  // about the account that holds a slug — not who they are, not when they took it, not what state their
  // storefront is in — because that would be an enumeration oracle over accounts.
  SELLER_PROFILE_EXISTS: 'A seller profile already exists for this account.',
  SELLER_SLUG_TAKEN: 'That seller address is not available.',
  // Phase 6-D. One sentence for a suspended storefront and a closed one: the caller's own state is readable
  // through the seller identity, and the reason behind it is not theirs to read from an error.
  SELLER_PROFILE_NOT_EDITABLE: 'This seller profile cannot be edited in its current state.',
  // Phase 6-E. Says that the upload did not arrive, and nothing about storage: no bucket, no path, no
  // provider and no reason beyond the one the caller can act on.
  SELLER_MEDIA_OBJECT_MISSING: 'The uploaded file could not be found.',
  // Phase 6-F. Each says what the seller can act on and nothing else. The first is one sentence for a
  // storefront that cannot be used, a draft that has already been submitted and a listing that is not live:
  // it names no moderation state, no moderator and no reason, because a moderation decision is a conversation
  // with a human rather than an error code, and a listing that is not the caller's is a plain NOT_FOUND
  // indistinguishable from one that does not exist. The second says only that an address is unavailable,
  // never whether a listing ever lived there. The third is the approval rule read back a step early.
  SELLER_LISTING_NOT_EDITABLE: 'This listing cannot be changed in its current state.',
  SELLER_LISTING_SLUG_TAKEN: 'That listing address is not available.',
  SELLER_LISTING_INCOMPLETE: 'This listing is not yet complete enough to be submitted for review.',
  SELLER_LISTING_CURSOR_INVALID: 'The cursor could not be used.',
  // 6-I. Each says what the caller can do about their own account's state, and no more. None of them names
  // a reviewer, a decision, a reason, or which of several situations produced it.
  SELLER_VERIFICATION_EXISTS: 'A verification is already in progress.',
  SELLER_VERIFICATION_ALREADY_VERIFIED: 'This storefront is already verified.',
  SELLER_VERIFICATION_NOT_EDITABLE: 'This verification cannot be changed in its current state.',
  SELLER_VERIFICATION_DOCUMENT_PATH_TAKEN: 'That upload has already been recorded.',
  // Phase 7-E. Three sentences, each about the caller's own account and nothing else. The name conflict
  // is per account, so it names nobody; the shipping refusal states the rule and leaves the remedy to the
  // caller; the cursor sentence is one answer for a malformed position, an altered one, one of the wrong
  // kind and one from a retired version.
  SAVED_SEARCH_NAME_TAKEN: 'You already have a saved search with that name.',
  ADDRESS_COUNTRY_NOT_SHIPPABLE: 'That country is not available for shipping addresses.',
  ACCOUNT_CURSOR_INVALID: 'The list position could not be used.',
  // Phase 7-G. Each says what the reviewer can act on about the application in front of them and nothing
  // else: no reviewer is named, no applicant is named, and no reason is quoted. A caller who may not
  // review never reaches any of these — they get the ordinary not-found sentence above.
  VERIFICATION_NOT_DECIDABLE: 'This verification has already been decided.',
  VERIFICATION_CONTACTS_UNVERIFIED:
    'This application cannot be approved until both contact details are verified.',
  VERIFICATION_CURSOR_INVALID: 'The list position could not be used.',
  // Phase 7-H. Each sentence states the one fact the caller can act on. None names the other party, none
  // quotes an amount, and the blocked sentence never says who blocked whom.
  OFFER_ALREADY_OPEN: 'You already have an open offer on this listing.',
  OFFER_NOT_AVAILABLE: 'This listing is not available for offers.',
  OFFER_OWN_LISTING: 'You cannot make an offer on your own listing.',
  OFFER_BLOCKED: 'This offer is not available.',
  OFFER_NOT_ACTIONABLE: 'This offer has already been decided.',
  OFFER_LAPSED: 'This offer has passed its deadline.',
  OFFER_PAYMENT_POLICY_MISSING: 'The service is temporarily unavailable.',
  OFFERS_CURSOR_INVALID: 'The list position could not be used.',
  // Phase 7-I. Each sentence states the one fact the caller can act on, and none names the other party.
  SERVICE_REQUEST_NOT_AVAILABLE: 'This service is not available for requests.',
  SERVICE_REQUEST_NOT_CUSTOM: 'This service is bought directly rather than quoted.',
  SERVICE_REQUEST_OWN_LISTING: 'You cannot send a request for your own service.',
  SERVICE_REQUEST_BLOCKED: 'This request is not available.',
  SERVICE_REQUEST_NOT_ACTIONABLE: 'This has already been decided.',
  SERVICE_QUOTE_LAPSED: 'This quote has passed its deadline.',
  SERVICE_QUOTE_PAYMENT_POLICY_MISSING: 'The service is temporarily unavailable.',
  SERVICE_REQUEST_CURRENCY_UNAVAILABLE: 'The service is temporarily unavailable.',
  SERVICE_REQUESTS_CURSOR_INVALID: 'The list position could not be used.',
  // 7-K support, the requester side. A ticket, message or attachment that is not the caller's reaches a
  // browser as NOT_FOUND's own sentence, so none of these names one.
  SUPPORT_TICKET_NOT_ACTIONABLE: 'This ticket is closed.',
  SUPPORT_ATTACHMENT_OBJECT_MISSING: 'The uploaded file could not be found.',
  SUPPORT_TICKETS_CURSOR_INVALID: 'The list position could not be used.',
  // 7-L, the agent console. It names no ticket, no colleague and no permission.
  SUPPORT_TICKET_NOT_WORKABLE: 'This ticket can no longer be worked on.',
  // 7-M, the reporter side. A subject the public cannot see reaches a browser as NOT_FOUND's own sentence,
  // so neither of these names a listing, a storefront or a reason one could not be reported.
  REPORT_SUBJECT_NOT_REPORTABLE: 'That cannot be reported here.',
  REPORT_SUBJECT_IS_THE_REPORTER: 'A report cannot be about its own reporter.',
  REPORTS_CURSOR_INVALID: 'The list position could not be used.',
  // 7-N, the moderation console. None of these names a report, a listing, a reporter or a colleague: each
  // says what happened to the caller's own request and stops there.
  REPORT_ALREADY_FINAL: 'This report has already been decided.',
  REPORT_IS_OWN: 'Nobody rules on their own report.',
  LISTING_IS_OWN: 'Nobody moderates their own listing.',
  LISTING_MODERATION_NO_CHANGE: 'This listing is already in that state.',
  LISTING_MODERATION_NOT_APPLICABLE: 'This action cannot be applied to this listing.',
  RECOVERY_IS_OWN: 'Nobody acts on their own account recovery.',
  RECOVERY_NEEDS_ANOTHER_PERSON:
    'A recovery is decided by somebody other than the person who reviewed it.',
  RECOVERY_NOT_REVIEWABLE: 'This recovery request is no longer awaiting review.',
  RECOVERY_NOT_DECIDABLE: 'This recovery request is not awaiting a decision.',
  RECOVERY_NOT_COMPLETABLE: 'This recovery request is not ready to complete.',
  SELLER_STATUS_NOT_ALLOWED: 'This storefront cannot move to that status.',
  SELLER_STATUS_NO_CHANGE: 'This storefront already holds that status.',
  SELLER_STATUS_REASON_REQUIRED: 'A suspension is always recorded with its reason.',
  SELLER_STATUS_NOT_VERIFIED: 'This storefront is not verified.',
  SELLER_STATUS_ALREADY_VERIFIED: 'This storefront is verified.',
  REVIEW_IS_PARTY: 'Nobody moderates a review they are a party to.',
  REVIEW_REASON_REQUIRED: 'A moderation decision is always recorded with its reason.',
  DISPUTE_IS_PARTY: 'Nobody rules on a dispute they are a party to.',
  DISPUTE_THREAD_CLOSED: 'This dispute is closed and its thread takes no more messages.',
  DISPUTE_ALREADY_RESOLVED: 'This dispute has already been resolved.',
  DISPUTE_REASON_REQUIRED: 'A dispute is never resolved without a reason.',
  DISPUTE_AMOUNT_NOT_ALLOWED: 'An amount belongs only to a refund resolution.',
  CMS_PAGE_LOCALE_REQUIRED: 'The page must be written in at least one locale while it is live.',
  CMS_PAGE_TRANSITION_NOT_ALLOWED: 'That is not an allowed change for a page in its current state.',
  CMS_PAGE_SLUG_TAKEN: 'That address is already in use, or was previously used by another page.',
  SEO_REDIRECT_PATH_TAKEN: 'Another redirect already starts from that address.',
  SEO_REDIRECT_NOT_ALLOWED: 'That is not an allowed redirect.',
  CATEGORY_TREE_NOT_ALLOWED: 'That is not an allowed place for this category in the tree.',
  CATEGORY_SLUG_TAKEN: 'That address is already in use by another category.',
  CATEGORY_NAME_REQUIRED: 'The category must be named in at least one locale while it is shown.',
  CATEGORY_VALUE_NOT_ALLOWED: 'That value is longer or differently shaped than this field allows.',
  ATTRIBUTE_KEY_TAKEN: 'That name is already in use and cannot be changed once it has been given.',
  ATTRIBUTE_NOT_ANSWERABLE: 'That would leave a question sellers cannot answer, or an answer they cannot give.',
  ATTRIBUTE_VALUE_NOT_ALLOWED: 'That value is longer or differently shaped than this field allows.',
  LISTING_ATTRIBUTE_ANSWER_NOT_ALLOWED: 'One of those answers is not one this listing can carry.',
};

function codeForStatus(status: number): ProblemCode {
  switch (status) {
    case 400:
      return 'BAD_REQUEST';
    case 404:
      return 'NOT_FOUND';
    case 413:
      return 'PAYLOAD_TOO_LARGE';
    case 415:
      return 'UNSUPPORTED_MEDIA_TYPE';
    default:
      return status >= 500 ? 'INTERNAL_ERROR' : 'HTTP_ERROR';
  }
}

function statusOf(error: unknown): number | undefined {
  const candidate = (error as { statusCode?: unknown } | null)?.statusCode;
  return typeof candidate === 'number' && candidate >= 400 && candidate <= 599 ? candidate : undefined;
}

/** Maps any thrown value to a safe problem specification. Never uses the error message. */
export function classifyError(error: unknown): ProblemSpec {
  if (error instanceof RequestValidationException) {
    return { status: 400, code: 'VALIDATION_FAILED', errors: error.issues };
  }
  const declared = declaredProblem(error);
  if (declared !== undefined) return declared;
  if (error instanceof HttpException) {
    const status = error.getStatus();
    return { status, code: codeForStatus(status) };
  }
  const status = statusOf(error);
  if (status !== undefined && status < 500) {
    return { status, code: codeForStatus(status) };
  }
  return { status: 500, code: 'INTERNAL_ERROR' };
}

export function buildProblem(spec: ProblemSpec, instance: string): ProblemDetails {
  const problem: ProblemDetails = {
    type: 'about:blank',
    title: TITLES[spec.status] ?? (spec.status >= 500 ? 'Server Error' : 'Client Error'),
    status: spec.status,
    detail: DETAILS[spec.code],
    instance,
    code: spec.code,
  };
  return spec.errors === undefined ? problem : { ...problem, errors: [...spec.errors] };
}

/** The request path without its query string. */
export function instanceFromUrl(url: string | undefined): string {
  const path = (url ?? '/').split('?')[0] ?? '/';
  return path.length > 0 ? path : '/';
}
