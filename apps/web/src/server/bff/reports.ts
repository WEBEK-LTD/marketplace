import 'server-only';
import {
  FileReportRequestSchema,
  FileReportResponseSchema,
  PROBLEM_JSON_MEDIA_TYPE,
  ReporterReportsResponseSchema,
  SESSION_TOKEN_HEADER,
  type ReporterReportsResponse,
} from '@repo/contracts';
import { readBffConfig } from './env';
import { createInternalCredentialFetch } from './internal-credential';
import { addressedOrigin, checkSameOrigin } from './origin';
import { readAccessToken } from './session-cookies';

/**
 * The BFF half of reporting — the reporter side (Phase 7-M).
 *
 * One read a server component calls directly and one write a browser posts to. The rules are 7-E's, 7-H's,
 * 7-I's and 7-K's, applied to a surface where what somebody sends is an accusation about somebody else.
 *
 * **The session never leaves the server.** The access token lives in the `__Host-mp_access` cookie, which
 * JavaScript cannot see; it is presented to the API on one internal hop in `x-session-token`, and the
 * browser's own `Cookie` header is never forwarded.
 *
 * **The body is rebuilt, never forwarded.** The write parses what the page sent, validates it against the
 * shared contract, and sends a body assembled here from the four fields that contract names. A page that
 * added a `reporterUserId`, a `status`, a `priority`, an `assignedTo` or a `subjectId` would have it dropped
 * before the request left this origin — and the API's strict schema would refuse it anyway. Two independent
 * walls, neither relying on the other.
 *
 * **A subject is named by its public slug, and there is no id anywhere in this file.** 0050's public seller
 * projection never publishes a seller's account id, so a page has none to send; the slug is what the page is
 * addressed by and the database resolves it. That is why there is no identifier helper here, unlike every
 * other write module on this surface — there is no identifier to check.
 *
 * **Responses are validated, not forwarded.** A drifted body becomes a clean failure here instead of a
 * half-rendered page, and a field the contract does not name cannot reach a browser even if the API sent one
 * — which is the third wall in front of a priority, an assignee, a resolution note and the report's subject
 * id.
 *
 * **Cursors stay opaque.** A cursor is passed along as text and never parsed or reconstructed here.
 *
 * **Nothing here logs.** A report is what one person said about another; the way to keep it out of a log is
 * to have no log line that could take it.
 *
 * Nothing in this file is a moderation operation. There is no queue, no triage, no assignment, no resolution
 * and no permission name anywhere in it: 7-N owns report management.
 */

/**
 * The one thing this module needs from a contract schema.
 *
 * Structural rather than imported: this app has no dependency on the validation library, and the shared
 * contracts are the only place a schema is written.
 */
interface Validator<T> {
  safeParse(value: unknown): { success: true; data: T } | { success: false };
}

const PROBLEM = {
  type: 'about:blank',
  status: 503,
  title: 'Service Unavailable',
  detail: 'The service is temporarily unavailable.',
  instance: '/reports',
  code: 'SERVICE_UNAVAILABLE',
} as const;

function problemResponse(status: number, title: string, code: string, detail: string): Response {
  return new Response(JSON.stringify({ ...PROBLEM, status, title, code, detail }), {
    status,
    headers: { 'content-type': PROBLEM_JSON_MEDIA_TYPE, 'cache-control': 'no-store' },
  });
}

const SESSION_REQUIRED = (): Response =>
  problemResponse(401, 'Unauthorized', 'AUTHENTICATION_REQUIRED', 'Authentication is required.');

const UNAVAILABLE = (): Response =>
  problemResponse(503, 'Service Unavailable', 'SERVICE_UNAVAILABLE', 'The service is temporarily unavailable.');

const VALIDATION_FAILED = (): Response =>
  problemResponse(400, 'Bad Request', 'VALIDATION_FAILED', 'The request is invalid.');

/**
 * The statuses the API is allowed to refuse this write with.
 *
 * 404 and 409 are here because a form must act on them: nothing reportable at that address, a subject type
 * this surface does not file, and reporting oneself. Anything outside the set becomes the generic 503, so an
 * unexpected upstream status can never arrive as a success.
 */
const WRITE_PROBLEM_STATUSES = new Set([400, 401, 403, 404, 409, 429, 503]);

export interface ReportsHandlerOptions {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly fetch?: typeof fetch;
  /** The request's `Cookie` header. Server components pass the value they already hold. */
  readonly cookieHeader?: string | null;
}

/**
 * What a reports read resolved to.
 *
 * `unauthenticated` and `unavailable` are kept apart deliberately: a session that has ended is a different
 * thing from a service that could not answer. `invalid` is the API's cursor refusal, which a page recovers
 * from by dropping the cursor rather than by reporting an outage.
 */
export type ReportsResult<T> =
  | { readonly kind: 'ok'; readonly data: T }
  | { readonly kind: 'unauthenticated' }
  | { readonly kind: 'invalid' }
  | { readonly kind: 'unavailable' };

/** Builds the query string from what the caller passed, dropping what it did not. */
function query(input: { limit?: string | null; cursor?: string | null }): string {
  const params = new URLSearchParams();
  if (input.limit !== undefined && input.limit !== null && input.limit !== '') {
    params.set('limit', input.limit);
  }
  // Passed through verbatim. This layer does not know what a cursor contains and must not learn.
  if (input.cursor !== undefined && input.cursor !== null && input.cursor !== '') {
    params.set('cursor', input.cursor);
  }
  return params.size === 0 ? '' : `?${params.toString()}`;
}

/* ------------------------------------------------------------------------------------------------ */
/* The read                                                                                          */
/* ------------------------------------------------------------------------------------------------ */

/** One page of the caller's own reports, newest first. */
export async function readOwnReports(
  input: { limit?: string | null; cursor?: string | null } = {},
  options: ReportsHandlerOptions = {},
): Promise<ReportsResult<ReporterReportsResponse>> {
  const accessToken = readAccessToken(options.cookieHeader ?? null);
  if (accessToken === null) return { kind: 'unauthenticated' };

  const config = readBffConfig(options.env);
  const fetcher = createInternalCredentialFetch(config.internalBffCredential, options.fetch ?? fetch);

  let upstream: Response;
  try {
    upstream = await fetcher(`${config.apiBaseUrl}/v1/reports${query(input)}`, {
      method: 'GET',
      headers: { [SESSION_TOKEN_HEADER]: accessToken },
    });
  } catch {
    return { kind: 'unavailable' };
  }

  if (!upstream.ok) {
    await upstream.text().catch(() => '');
    if (upstream.status === 401) return { kind: 'unauthenticated' };
    if (upstream.status === 400) return { kind: 'invalid' };
    return { kind: 'unavailable' };
  }

  try {
    const parsed = ReporterReportsResponseSchema.safeParse(JSON.parse(await upstream.text()));
    return parsed.success ? { kind: 'ok', data: parsed.data } : { kind: 'unavailable' };
  } catch {
    return { kind: 'unavailable' };
  }
}

/* ------------------------------------------------------------------------------------------------ */
/* The write                                                                                         */
/* ------------------------------------------------------------------------------------------------ */

/** The Origin/CSRF check, the session and the parsed body, or the response that refuses the request. */
async function acceptWrite(
  request: Request,
  options: ReportsHandlerOptions,
): Promise<{ accessToken: string; body: unknown } | { refusal: Response }> {
  const origin = checkSameOrigin({
    method: request.method,
    url: addressedOrigin(request),
    headers: request.headers,
  });
  if (!origin.ok) {
    return {
      refusal: problemResponse(403, 'Forbidden', 'BAD_REQUEST', 'The request could not be processed.'),
    };
  }

  const accessToken = readAccessToken(options.cookieHeader ?? request.headers.get('cookie'));
  if (accessToken === null) return { refusal: SESSION_REQUIRED() };

  const raw = await request.text().catch(() => '');
  if (raw === '') return { accessToken, body: {} };
  try {
    return { accessToken, body: JSON.parse(raw) };
  } catch {
    return { refusal: VALIDATION_FAILED() };
  }
}

/**
 * Turns one upstream write response into the browser's.
 *
 * A recognised refusal is forwarded with the API's own problem body, so a form can say "there is nothing
 * there to report" rather than a generic failure. Anything else becomes the generic 503. Success is the
 * expected status exactly, and its body is re-validated before a single byte of it reaches a browser.
 */
async function writeOutcome<T>(
  upstream: Response | null,
  expected: number,
  schema: Validator<T>,
): Promise<Response> {
  if (upstream === null) return UNAVAILABLE();

  const text = await upstream.text();
  if (upstream.status !== expected) {
    if (!WRITE_PROBLEM_STATUSES.has(upstream.status)) return UNAVAILABLE();
    return new Response(text, {
      status: upstream.status,
      headers: { 'content-type': PROBLEM_JSON_MEDIA_TYPE, 'cache-control': 'no-store' },
    });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return UNAVAILABLE();
  }
  const validated = schema.safeParse(parsed);
  if (!validated.success) return UNAVAILABLE();

  return new Response(JSON.stringify(validated.data), {
    status: expected,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}

/**
 * `POST /api/reports` — file one report.
 *
 * Named `handleFileSubjectReport` rather than `handleFileReport` because 5-H already owns that name for the
 * messaging surface's own report handler. Two exports with one name would be a collision; two surfaces
 * filing reports about different kinds of subject is the repository as it stands.
 *
 * Rebuilt from the contract, so exactly a subject type, a public slug, a reason code and — if the reporter
 * wrote one — their own words cross. A reporter field, a subject id, a status, a priority, an assignee or a
 * resolution is dropped here and would be refused upstream as well.
 *
 * `details` is read as a field that may be absent rather than as one that may be empty: an untouched box is
 * no details, which is what the column's own length rule measures.
 */
export async function handleFileSubjectReport(
  request: Request,
  options: ReportsHandlerOptions = {},
): Promise<Response> {
  const accepted = await acceptWrite(request, options);
  if ('refusal' in accepted) return accepted.refusal;

  const fields = (accepted.body ?? {}) as Record<string, unknown>;
  const details = fields['details'];
  const validated = FileReportRequestSchema.safeParse({
    subjectType: fields['subjectType'],
    subjectSlug: fields['subjectSlug'],
    reasonCode: fields['reasonCode'],
    ...(typeof details === 'string' && details.trim() !== '' ? { details: details.trim() } : {}),
  });
  if (!validated.success) return VALIDATION_FAILED();

  const config = readBffConfig(options.env);
  const fetcher = createInternalCredentialFetch(config.internalBffCredential, options.fetch ?? fetch);

  let upstream: Response | null;
  try {
    upstream = await fetcher(`${config.apiBaseUrl}/v1/reports`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', [SESSION_TOKEN_HEADER]: accepted.accessToken },
      body: JSON.stringify(validated.data),
    });
  } catch {
    upstream = null;
  }

  return await writeOutcome(upstream, 201, FileReportResponseSchema);
}
