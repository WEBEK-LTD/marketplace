import {
  SELLER_VERIFICATION_DOCUMENT_CONTENT_TYPES,
  SELLER_VERIFICATION_DOCUMENT_MAX_BYTES,
  SELLER_VERIFICATION_DOCUMENT_TYPES,
  SellerVerificationDocumentCountResponseSchema,
  SellerVerificationStateResponseSchema,
  SellerVerificationUploadResponseSchema,
  type SellerVerification,
  type SellerVerificationDocumentType,
  type SellerVerificationState,
} from '@repo/contracts';

/**
 * The verification surface's logic, with no React and no DOM in it (Phase 6-I).
 *
 * Every decision this page makes is a function here — which actions the current state permits, whether a
 * chosen file can be uploaded at all, what is sent, which sentence a refusal becomes — so every one of them
 * is testable exactly, without a browser, as a pure function over an injected `fetch`.
 *
 * **The permission functions are the page's whole safety argument.** The server asks {@link verificationActions}
 * what this attempt permits and ships *only* the labels for what it returns; a button whose label is not in
 * the payload cannot be rendered, and no client-side condition decides what a seller may attempt. That is why
 * they are total functions over the six states rather than a scatter of inline conditions.
 *
 * **A seller reaches no decision.** There is no function below that sends a status, and the two writes that
 * change the attempt's state send no body at all. `approved`, `rejected`, `under_review` and `expired` appear
 * here only as states to *read*: each one permits nothing.
 *
 * **The browser chooses nothing about the destination.** {@link authorizeDocumentUpload} sends a type, a
 * content type and a size; the path and the URL come back. {@link putBytes} uploads to the URL it was given.
 * {@link recordDocument} sends back the path the server issued. Nothing here builds a path, a bucket name or
 * a file name, and there is no parameter through which a caller could.
 *
 * **The client-side checks are a courtesy.** The type list and the size ceiling are the contract's, which are
 * the bucket's; the database applies them again. They exist so somebody choosing a 40 MB photograph is told
 * before it is uploaded, not after.
 */

/** The three types the bucket allows, as a browser's `accept` attribute wants them. */
export const DOCUMENT_ACCEPT = SELLER_VERIFICATION_DOCUMENT_CONTENT_TYPES.join(',');

/** The six document types, for a select. The order is the schema's. */
export const DOCUMENT_TYPES = SELLER_VERIFICATION_DOCUMENT_TYPES;

/**
 * What the current attempt permits.
 *
 * Total over the six states and the two situations that are not an attempt at all, and deliberately
 * conservative: a state this function does not recognise permits nothing.
 */
export interface VerificationActions {
  /** Opening an attempt. Never true when one exists, and never true for a verified storefront. */
  readonly canStart: boolean;
  /** Adding and removing documents. The verification schema's own `draft`-or-`submitted` window. */
  readonly canAddDocuments: boolean;
  readonly canRemoveDocuments: boolean;
  /** Submitting. A draft only — and with no document requirement, by owner decision 1. */
  readonly canSubmit: boolean;
  /** Whether the attempt is with a reviewer now, which is a thing to say rather than a thing to do. */
  readonly awaitingReview: boolean;
}

/**
 * What this seller may do, given their storefront's verification status and their current attempt.
 *
 * `verificationStatus` is the storefront's own, from the seller identity the dashboard already reads;
 * `verification` is the attempt, or `null` when there is none.
 *
 * **Owner decision 2 lives here**: a `verified` storefront permits nothing at all — no start, and therefore
 * no form, no "verify again" and no copy suggesting either. **Owner decision 3 lives here too**: removal is
 * permitted exactly while the attempt is `draft` or `submitted`, mirroring the writer that enforces it.
 */
export function verificationActions(
  verificationStatus: string,
  verification: SellerVerification | null,
): VerificationActions {
  const none: VerificationActions = {
    canStart: false,
    canAddDocuments: false,
    canRemoveDocuments: false,
    canSubmit: false,
    awaitingReview: false,
  };

  // Owner decision 2, checked before anything else: a verified storefront is offered nothing.
  if (verificationStatus === 'verified') return none;

  if (verification === null) return { ...none, canStart: true };

  switch (verification.status) {
    case 'draft':
      return { ...none, canAddDocuments: true, canRemoveDocuments: true, canSubmit: true };
    case 'submitted':
      // Still the applicant's to amend — the verification schema's own rule — but not to submit again.
      return { ...none, canAddDocuments: true, canRemoveDocuments: true, awaitingReview: true };
    case 'under_review':
      return { ...none, awaitingReview: true };
    case 'approved':
    case 'rejected':
    case 'expired':
      // A decided attempt permits nothing here. Whether a *new* attempt may be started is the storefront's
      // status to say, which the branch above already answered: a rejected or expired application leaves the
      // storefront unverified, so the page offers a fresh start only once this attempt is no longer the open
      // one — which is the database's ordering, not this function's to guess.
      return none;
    default:
      return none;
  }
}

/** What a seller picked, reduced to the two things that decide whether it can be uploaded. */
export interface ChosenDocument {
  readonly type: string;
  readonly size: number;
}

export type DocumentCheck =
  | {
      readonly ok: true;
      readonly contentType: (typeof SELLER_VERIFICATION_DOCUMENT_CONTENT_TYPES)[number];
    }
  | { readonly ok: false; readonly reason: 'missing' | 'type' | 'size' };

/** Whether this file could be uploaded at all, and why not when it could not. */
export function checkChosenDocument(file: ChosenDocument | null): DocumentCheck {
  if (file === null) return { ok: false, reason: 'missing' };
  const allowed = SELLER_VERIFICATION_DOCUMENT_CONTENT_TYPES.find((type) => type === file.type);
  if (allowed === undefined) return { ok: false, reason: 'type' };
  if (
    !Number.isInteger(file.size) ||
    file.size <= 0 ||
    file.size > SELLER_VERIFICATION_DOCUMENT_MAX_BYTES
  ) {
    return { ok: false, reason: 'size' };
  }
  return { ok: true, contentType: allowed };
}

/** The authorized target, narrowed to what the next two steps need. Never stored, never rendered. */
export interface DocumentTarget {
  readonly uploadUrl: string;
  readonly objectPath: string;
}

export type VerificationOutcome =
  | { readonly kind: 'ok'; readonly documentCount: number }
  | { readonly kind: 'state'; readonly status: SellerVerificationState }
  | { readonly kind: 'exists' }
  | { readonly kind: 'already_verified' }
  | { readonly kind: 'not_editable' }
  | { readonly kind: 'path_taken' }
  | { readonly kind: 'missing_object' }
  | { readonly kind: 'invalid' }
  | { readonly kind: 'not_found' }
  | { readonly kind: 'unauthenticated' }
  | { readonly kind: 'unavailable' };

/** The problem code, if the body is a problem document. Anything else reads as no code at all. */
function problemCode(text: string): string | null {
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const code = (parsed as { code?: unknown }).code;
    return typeof code === 'string' ? code : null;
  } catch {
    return null;
  }
}

/**
 * Maps a refused response onto the outcomes the page can render.
 *
 * Every branch here becomes a sentence about the seller's own account. None of them becomes a sentence about
 * a reviewer, a decision or a reason, because no code the API sends carries one.
 */
export function refusal(status: number, text: string): VerificationOutcome {
  if (status === 401) return { kind: 'unauthenticated' };
  if (status === 409) {
    switch (problemCode(text)) {
      case 'SELLER_VERIFICATION_EXISTS':
        return { kind: 'exists' };
      case 'SELLER_VERIFICATION_ALREADY_VERIFIED':
        return { kind: 'already_verified' };
      case 'SELLER_VERIFICATION_NOT_EDITABLE':
      case 'SELLER_PROFILE_NOT_EDITABLE':
        return { kind: 'not_editable' };
      case 'SELLER_VERIFICATION_DOCUMENT_PATH_TAKEN':
        return { kind: 'path_taken' };
      default:
        return { kind: 'unavailable' };
    }
  }
  if (status === 404) {
    return problemCode(text) === 'SELLER_MEDIA_OBJECT_MISSING'
      ? { kind: 'missing_object' }
      : { kind: 'not_found' };
  }
  if (status === 400) return { kind: 'invalid' };
  // 429 and anything else: nothing the person can fix by changing a field.
  return { kind: 'unavailable' };
}

async function post(
  path: string,
  body: unknown | undefined,
  fetcher: typeof fetch,
): Promise<{ readonly status: number; readonly text: string } | null> {
  try {
    const response = await fetcher(path, {
      method: 'POST',
      credentials: 'same-origin',
      ...(body === undefined
        ? {}
        : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
    });
    return { status: response.status, text: await response.text().catch(() => '') };
  } catch {
    return null;
  }
}

/** Opens an attempt. Sends no body: a status in one would be a status the browser chose. */
export async function startVerification(
  fetcher: typeof fetch = fetch,
  path = '/api/sellers/me/verification',
): Promise<VerificationOutcome> {
  const response = await post(path, undefined, fetcher);
  if (response === null) return { kind: 'unavailable' };
  if (response.status !== 201) return refusal(response.status, response.text);

  try {
    const parsed = SellerVerificationStateResponseSchema.safeParse(JSON.parse(response.text));
    return parsed.success ? { kind: 'state', status: parsed.data.status } : { kind: 'unavailable' };
  } catch {
    return { kind: 'unavailable' };
  }
}

/** Submits for review. Sends no body, and requires no document (owner decision 1). */
export async function submitVerification(
  fetcher: typeof fetch = fetch,
  path = '/api/sellers/me/verification/submission',
): Promise<VerificationOutcome> {
  const response = await post(path, undefined, fetcher);
  if (response === null) return { kind: 'unavailable' };
  if (response.status !== 200) return refusal(response.status, response.text);

  try {
    const parsed = SellerVerificationStateResponseSchema.safeParse(JSON.parse(response.text));
    return parsed.success ? { kind: 'state', status: parsed.data.status } : { kind: 'unavailable' };
  } catch {
    return { kind: 'unavailable' };
  }
}

/** Step one: ask this origin for a target. Returns the target, or the outcome to render instead. */
export async function authorizeDocumentUpload(
  documentType: SellerVerificationDocumentType,
  file: ChosenDocument,
  fetcher: typeof fetch = fetch,
  path = '/api/sellers/me/verification/documents/uploads',
): Promise<
  | { readonly ok: true; readonly target: DocumentTarget }
  | { readonly ok: false; readonly outcome: VerificationOutcome }
> {
  const checked = checkChosenDocument(file);
  if (!checked.ok) return { ok: false, outcome: { kind: 'invalid' } };

  const response = await post(
    path,
    { documentType, contentType: checked.contentType, byteSize: file.size },
    fetcher,
  );
  if (response === null) return { ok: false, outcome: { kind: 'unavailable' } };
  if (response.status !== 201) {
    return { ok: false, outcome: refusal(response.status, response.text) };
  }

  try {
    const parsed = SellerVerificationUploadResponseSchema.safeParse(JSON.parse(response.text));
    if (!parsed.success) return { ok: false, outcome: { kind: 'unavailable' } };
    // Projected field by field: the two values the next steps need, and nothing else the contract carries.
    return {
      ok: true,
      target: {
        uploadUrl: parsed.data.upload.uploadUrl,
        objectPath: parsed.data.upload.objectPath,
      },
    };
  } catch {
    return { ok: false, outcome: { kind: 'unavailable' } };
  }
}

/**
 * Step two: the bytes, straight to the signed URL.
 *
 * `credentials: 'omit'`, so no cookie of this site's is ever attached to a storage request — the URL is the
 * authorization, and it is the only one this request carries.
 */
export async function putBytes(
  uploadUrl: string,
  body: Blob | ArrayBuffer,
  contentType: string,
  fetcher: typeof fetch = fetch,
): Promise<boolean> {
  try {
    const response = await fetcher(uploadUrl, {
      method: 'PUT',
      credentials: 'omit',
      headers: { 'content-type': contentType },
      body: body as BodyInit,
    });
    return response.ok;
  } catch {
    return false;
  }
}

/** Step three: tell this origin where the file went. */
export async function recordDocument(
  documentType: SellerVerificationDocumentType,
  objectPath: string,
  originalFilename: string,
  contentType: string,
  byteSize: number,
  fetcher: typeof fetch = fetch,
  path = '/api/sellers/me/verification/documents',
): Promise<VerificationOutcome> {
  const response = await post(
    path,
    { documentType, objectPath, originalFilename, contentType, byteSize },
    fetcher,
  );
  if (response === null) return { kind: 'unavailable' };
  if (response.status !== 201) return refusal(response.status, response.text);

  try {
    const parsed = SellerVerificationDocumentCountResponseSchema.safeParse(JSON.parse(response.text));
    return parsed.success
      ? { kind: 'ok', documentCount: parsed.data.documentCount }
      : { kind: 'unavailable' };
  } catch {
    return { kind: 'unavailable' };
  }
}

/** Removes one document the seller uploaded. */
export async function removeDocument(
  documentId: string,
  fetcher: typeof fetch = fetch,
  prefix = '/api/sellers/me/verification/documents',
): Promise<VerificationOutcome> {
  let response: Response;
  try {
    response = await fetcher(`${prefix}/${encodeURIComponent(documentId)}`, {
      method: 'DELETE',
      credentials: 'same-origin',
    });
  } catch {
    return { kind: 'unavailable' };
  }

  const text = await response.text().catch(() => '');
  if (response.status !== 200) return refusal(response.status, text);

  try {
    const parsed = SellerVerificationDocumentCountResponseSchema.safeParse(JSON.parse(text));
    return parsed.success
      ? { kind: 'ok', documentCount: parsed.data.documentCount }
      : { kind: 'unavailable' };
  } catch {
    return { kind: 'unavailable' };
  }
}

/**
 * All three upload steps, in order, with the signed URL confined to this call.
 *
 * Nothing is reported as recorded until the server has confirmed it: a failed PUT answers `unavailable` and
 * the confirmation is never attempted, so the displayed count can only ever come from the server.
 */
export async function runDocumentUpload(
  documentType: SellerVerificationDocumentType,
  file: ChosenDocument & { readonly body: Blob | ArrayBuffer; readonly name: string },
  fetchers: { readonly origin?: typeof fetch; readonly storage?: typeof fetch } = {},
): Promise<VerificationOutcome> {
  const authorized = await authorizeDocumentUpload(documentType, file, fetchers.origin);
  if (!authorized.ok) return authorized.outcome;

  const checked = checkChosenDocument(file);
  if (!checked.ok) return { kind: 'invalid' };

  const uploaded = await putBytes(
    authorized.target.uploadUrl,
    file.body,
    checked.contentType,
    fetchers.storage,
  );
  if (!uploaded) return { kind: 'unavailable' };

  return recordDocument(
    documentType,
    authorized.target.objectPath,
    file.name,
    checked.contentType,
    file.size,
    fetchers.origin,
  );
}
