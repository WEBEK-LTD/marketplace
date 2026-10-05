import 'server-only';
import {
  PROBLEM_JSON_MEDIA_TYPE,
  SESSION_TOKEN_HEADER,
  VERIFICATION_DECISIONS,
  VERIFICATION_QUEUE_FILTERS,
  VERIFICATION_REASON_MAX_LENGTH,
  VerificationDecisionRequestSchema,
  VerificationDecisionResponseSchema,
  VerificationDocumentLinkResponseSchema,
  VerificationQueueResponseSchema,
  VerificationReviewResponseSchema,
  type VerificationQueueItem,
  type VerificationQueueResponse,
  type VerificationReview,
} from '@repo/contracts';
import { readBffConfig } from './env';
import { createInternalCredentialFetch } from './internal-credential';
import { addressedOrigin, checkSameOrigin } from './origin';
import { readAdminAccessToken } from './staff-session';

/**
 * The seller verification review surface, on the admin origin (Phase 7-G).
 *
 * Two reads a page performs before it renders, and two writes a reviewer makes. The rules are 7-F's,
 * applied to a surface that carries identity documents rather than a navigation.
 *
 * **The session never leaves the server.** The caller's access token lives in `__Host-mp_admin_access`,
 * which JavaScript cannot read; it is presented to the API on one internal hop in the session-token
 * header, and the browser's own `Cookie` header is never forwarded.
 *
 * **Nothing about the caller crosses in a request.** No reviewer, no permission, no assurance level and
 * no seller appears in anything built here. The only values that cross are the ones a reviewer is
 * looking at: a verification, a document, a decision and a sentence.
 *
 * **Bodies are rebuilt field by field.** A page that tried to send a status, a reviewer, a timestamp or
 * a storage path would have all four dropped before the request left this origin — and the API's strict
 * schema would refuse them anyway. Nothing is forwarded; everything is reconstructed.
 *
 * **Answers are validated, not forwarded.** A drifted body becomes a clean failure rather than a
 * half-rendered review screen, and a field the contract does not name — an object path, an account id —
 * cannot reach a page even if the API somehow sent one.
 *
 * **A refusal is not an outage, and an outage is not a refusal.** They stay distinct, because a console
 * that rendered "no such application" during a database hiccup would send a reviewer looking for a case
 * that is sitting there waiting.
 *
 * **Nothing here logs.** A verification names a person's identity documents; the way to keep that out of
 * a log is to have no log line that could take it.
 */

const PROBLEM = {
  type: 'about:blank',
  status: 503,
  title: 'Service Unavailable',
  detail: 'The service is temporarily unavailable.',
  instance: '/admin',
  code: 'SERVICE_UNAVAILABLE',
} as const;

function problemResponse(status: number, title: string, code: string, detail: string): Response {
  return new Response(JSON.stringify({ ...PROBLEM, status, title, code, detail }), {
    status,
    headers: { 'content-type': PROBLEM_JSON_MEDIA_TYPE, 'cache-control': 'no-store' },
  });
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}

export interface ReviewOptions {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly fetch?: typeof fetch;
  /** The request's `Cookie` header. Server components pass the value they already hold. */
  readonly cookieHeader?: string | null;
}

/**
 * What a review read resolved to.
 *
 * `notFound` is the API's neutral answer: no such application, a draft, or a caller who may not review.
 * The console does not try to tell those apart, because the API deliberately does not.
 */
export type ReviewResult<T> =
  | { readonly kind: 'ok'; readonly data: T }
  | { readonly kind: 'unauthenticated' }
  | { readonly kind: 'notFound' }
  | { readonly kind: 'unavailable' };

const QUEUE_FILTERS = new Set<string>(VERIFICATION_QUEUE_FILTERS);
const DECISIONS = new Set<string>(VERIFICATION_DECISIONS);

/** base64url, which is the whole of what a cursor can be. Refused here rather than forwarded. */
const CURSOR_PATTERN = /^[A-Za-z0-9_-]{1,512}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function read<T>(
  path: string,
  options: ReviewOptions,
  parse: (body: unknown) => { success: true; data: T } | { success: false },
): Promise<ReviewResult<T>> {
  const accessToken = readAdminAccessToken(options.cookieHeader ?? null);
  if (accessToken === null) return { kind: 'unauthenticated' };

  const config = readBffConfig(options.env);
  const fetcher = createInternalCredentialFetch(config.internalBffCredential, options.fetch ?? fetch);

  let upstream: Response;
  try {
    upstream = await fetcher(`${config.apiBaseUrl}${path}`, {
      method: 'GET',
      headers: { [SESSION_TOKEN_HEADER]: accessToken },
    });
  } catch {
    return { kind: 'unavailable' };
  }

  if (!upstream.ok) {
    await upstream.text().catch(() => '');
    if (upstream.status === 401) return { kind: 'unauthenticated' };
    if (upstream.status === 404) return { kind: 'notFound' };
    return { kind: 'unavailable' };
  }

  try {
    const parsed = parse(JSON.parse(await upstream.text()));
    return parsed.success ? { kind: 'ok', data: parsed.data } : { kind: 'unavailable' };
  } catch {
    return { kind: 'unavailable' };
  }
}

/**
 * One page of the queue.
 *
 * The two inputs are checked here rather than forwarded: a status the console does not offer and a
 * cursor that is not a cursor never reach the API, so a mistyped address is a clean empty page instead
 * of a round trip that ends in a problem document.
 */
export async function readVerificationQueue(
  input: { readonly status?: string | null; readonly cursor?: string | null } = {},
  options: ReviewOptions = {},
): Promise<ReviewResult<VerificationQueueResponse>> {
  const query = new URLSearchParams();
  if (typeof input.status === 'string' && QUEUE_FILTERS.has(input.status)) {
    query.set('status', input.status);
  }
  if (typeof input.cursor === 'string' && CURSOR_PATTERN.test(input.cursor)) {
    query.set('cursor', input.cursor);
  }
  const suffix = query.toString() === '' ? '' : `?${query.toString()}`;

  return await read<VerificationQueueResponse>(
    `/v1/admin/seller-verifications${suffix}`,
    options,
    (body) => VerificationQueueResponseSchema.safeParse(body),
  );
}

/** One submission, in full. */
export async function readVerificationDetail(
  verificationId: string,
  options: ReviewOptions = {},
): Promise<ReviewResult<VerificationReview>> {
  if (!UUID_PATTERN.test(verificationId)) return { kind: 'notFound' };

  const result = await read(
    `/v1/admin/seller-verifications/${encodeURIComponent(verificationId.toLowerCase())}`,
    options,
    (body) => VerificationReviewResponseSchema.safeParse(body),
  );
  return result.kind === 'ok' ? { kind: 'ok', data: result.data.verification } : result;
}

/**
 * `POST /api/sellers/verification/decision` — approve or reject.
 *
 * The body is rebuilt from exactly two fields. A verification identifier is a value the reviewer is
 * already looking at, not an authorization: the API resolves the reviewer from their own session and
 * the database refuses the write for anybody who may not make it.
 */
export async function handleVerificationDecision(
  request: Request,
  options: ReviewOptions = {},
): Promise<Response> {
  const origin = checkSameOrigin({
    method: request.method,
    url: addressedOrigin(request),
    headers: request.headers,
  });
  if (!origin.ok) {
    return problemResponse(403, 'Forbidden', 'BAD_REQUEST', 'The request could not be processed.');
  }

  const accessToken = readAdminAccessToken(options.cookieHeader ?? request.headers.get('cookie'));
  if (accessToken === null) {
    return problemResponse(401, 'Unauthorized', 'AUTHENTICATION_REQUIRED', 'Authentication is required.');
  }

  let body: unknown;
  try {
    const raw = await request.text();
    body = raw === '' ? {} : JSON.parse(raw);
  } catch {
    return problemResponse(400, 'Bad Request', 'VALIDATION_FAILED', 'The request is invalid.');
  }

  const fields = (body ?? {}) as Record<string, unknown>;
  const verificationId = fields['verificationId'];
  const decision = fields['decision'];
  const reason = fields['reason'];

  if (typeof verificationId !== 'string' || !UUID_PATTERN.test(verificationId)) {
    return problemResponse(400, 'Bad Request', 'VALIDATION_FAILED', 'The request is invalid.');
  }
  if (typeof decision !== 'string' || !DECISIONS.has(decision)) {
    return problemResponse(400, 'Bad Request', 'VALIDATION_FAILED', 'The request is invalid.');
  }

  const trimmed = typeof reason === 'string' ? reason.trim() : '';
  if (trimmed.length > VERIFICATION_REASON_MAX_LENGTH) {
    return problemResponse(400, 'Bad Request', 'VALIDATION_FAILED', 'The request is invalid.');
  }
  // 0009's own rule, stated once here so the console can answer without a round trip. The API applies it
  // again and so does the database; this is the copy that keeps a reviewer from losing what they typed.
  if (decision === 'rejected' && trimmed === '') {
    return problemResponse(400, 'Bad Request', 'VALIDATION_FAILED', 'The request is invalid.');
  }

  // Rebuilt from the contract, so exactly the two fields cross and nothing a page added survives.
  const payload = trimmed === '' ? { decision } : { decision, reason: trimmed };
  const validated = VerificationDecisionRequestSchema.safeParse(payload);
  if (!validated.success) {
    return problemResponse(400, 'Bad Request', 'VALIDATION_FAILED', 'The request is invalid.');
  }

  const config = readBffConfig(options.env);
  const fetcher = createInternalCredentialFetch(config.internalBffCredential, options.fetch ?? fetch);

  let upstream: Response;
  try {
    upstream = await fetcher(
      `${config.apiBaseUrl}/v1/admin/seller-verifications/${encodeURIComponent(verificationId.toLowerCase())}/decision`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', [SESSION_TOKEN_HEADER]: accessToken },
        body: JSON.stringify(validated.data),
      },
    );
  } catch {
    return problemResponse(503, 'Service Unavailable', 'SERVICE_UNAVAILABLE', 'The service is temporarily unavailable.');
  }

  const text = await upstream.text().catch(() => '');

  if (upstream.status === 200) {
    let parsed;
    try {
      parsed = VerificationDecisionResponseSchema.safeParse(JSON.parse(text));
    } catch {
      return problemResponse(503, 'Service Unavailable', 'SERVICE_UNAVAILABLE', 'The service is temporarily unavailable.');
    }
    if (!parsed.success) {
      return problemResponse(503, 'Service Unavailable', 'SERVICE_UNAVAILABLE', 'The service is temporarily unavailable.');
    }
    // Only the status crosses back. Whatever else the API said is not repeated to the browser.
    return jsonResponse(200, { status: parsed.data.status });
  }

  if (upstream.status === 401) {
    return problemResponse(401, 'Unauthorized', 'AUTHENTICATION_REQUIRED', 'Authentication is required.');
  }
  if (upstream.status === 404) {
    return problemResponse(404, 'Not Found', 'NOT_FOUND', 'The requested resource was not found.');
  }
  if (upstream.status === 409) {
    // The two conflicts are kept apart by code alone, and the codes are the contract's. The sentence the
    // reviewer reads is the console's own, in their own language, not a string from upstream.
    const code = readProblemCode(text);
    return problemResponse(
      409,
      'Conflict',
      code === 'VERIFICATION_CONTACTS_UNVERIFIED' ? code : 'VERIFICATION_NOT_DECIDABLE',
      'The request could not be completed.',
    );
  }
  if (upstream.status === 400) {
    return problemResponse(400, 'Bad Request', 'VALIDATION_FAILED', 'The request is invalid.');
  }
  return problemResponse(503, 'Service Unavailable', 'SERVICE_UNAVAILABLE', 'The service is temporarily unavailable.');
}

/**
 * `POST /api/sellers/verification/document` — one short-lived look at one document.
 *
 * **Nothing in this handler can carry a storage path.** It accepts two identifiers, both of which name
 * rows; the API looks the location up from the document's own row and the object stays in a private
 * bucket. What comes back is a URL and the moment it stops working, and neither the bucket name nor any
 * credential is in it.
 */
export async function handleVerificationDocumentLink(
  request: Request,
  options: ReviewOptions = {},
): Promise<Response> {
  const origin = checkSameOrigin({
    method: request.method,
    url: addressedOrigin(request),
    headers: request.headers,
  });
  if (!origin.ok) {
    return problemResponse(403, 'Forbidden', 'BAD_REQUEST', 'The request could not be processed.');
  }

  const accessToken = readAdminAccessToken(options.cookieHeader ?? request.headers.get('cookie'));
  if (accessToken === null) {
    return problemResponse(401, 'Unauthorized', 'AUTHENTICATION_REQUIRED', 'Authentication is required.');
  }

  let body: unknown;
  try {
    const raw = await request.text();
    body = raw === '' ? {} : JSON.parse(raw);
  } catch {
    return problemResponse(400, 'Bad Request', 'VALIDATION_FAILED', 'The request is invalid.');
  }

  const fields = (body ?? {}) as Record<string, unknown>;
  const verificationId = fields['verificationId'];
  const documentId = fields['documentId'];
  if (
    typeof verificationId !== 'string' ||
    !UUID_PATTERN.test(verificationId) ||
    typeof documentId !== 'string' ||
    !UUID_PATTERN.test(documentId)
  ) {
    return problemResponse(400, 'Bad Request', 'VALIDATION_FAILED', 'The request is invalid.');
  }

  const config = readBffConfig(options.env);
  const fetcher = createInternalCredentialFetch(config.internalBffCredential, options.fetch ?? fetch);

  let upstream: Response;
  try {
    upstream = await fetcher(
      `${config.apiBaseUrl}/v1/admin/seller-verifications/${encodeURIComponent(verificationId.toLowerCase())}` +
        `/documents/${encodeURIComponent(documentId.toLowerCase())}/link`,
      { method: 'POST', headers: { [SESSION_TOKEN_HEADER]: accessToken } },
    );
  } catch {
    return problemResponse(503, 'Service Unavailable', 'SERVICE_UNAVAILABLE', 'The service is temporarily unavailable.');
  }

  const text = await upstream.text().catch(() => '');

  if (upstream.status === 200) {
    let parsed;
    try {
      parsed = VerificationDocumentLinkResponseSchema.safeParse(JSON.parse(text));
    } catch {
      return problemResponse(503, 'Service Unavailable', 'SERVICE_UNAVAILABLE', 'The service is temporarily unavailable.');
    }
    if (!parsed.success) {
      return problemResponse(503, 'Service Unavailable', 'SERVICE_UNAVAILABLE', 'The service is temporarily unavailable.');
    }
    return jsonResponse(200, { url: parsed.data.url, expiresAt: parsed.data.expiresAt });
  }

  if (upstream.status === 401) {
    return problemResponse(401, 'Unauthorized', 'AUTHENTICATION_REQUIRED', 'Authentication is required.');
  }
  if (upstream.status === 404) {
    return problemResponse(404, 'Not Found', 'NOT_FOUND', 'The requested resource was not found.');
  }
  if (upstream.status === 400) {
    return problemResponse(400, 'Bad Request', 'VALIDATION_FAILED', 'The request is invalid.');
  }
  return problemResponse(503, 'Service Unavailable', 'SERVICE_UNAVAILABLE', 'The service is temporarily unavailable.');
}

/** The problem code from an upstream body, or null. Nothing else in that body is ever read. */
function readProblemCode(text: string): string | null {
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const code = (parsed as Record<string, unknown>)['code'];
    return typeof code === 'string' ? code : null;
  } catch {
    return null;
  }
}

export type { VerificationQueueItem };
