import 'server-only';
import {
  ListingModerationHistoryResponseSchema,
  ModerateListingRequestSchema,
  ModerateListingResponseSchema,
  ModerationActionsResponseSchema,
  ModerationListingDetailResponseSchema,
  ModerationListingQueueResponseSchema,
  ModerationReportDetailResponseSchema,
  ModerationReportQueueResponseSchema,
  PROBLEM_JSON_MEDIA_TYPE,
  REPORT_STATUSES,
  ResolveReportRequestSchema,
  ResolveReportResponseSchema,
  SESSION_TOKEN_HEADER,
  type ListingModerationHistoryResponse,
  type ModerationActionsResponse,
  type ModerationListingDetail,
  type ModerationListingQueueResponse,
  type ModerationReportDetail,
  type ModerationReportQueueResponse,
} from '@repo/contracts';
import { readBffConfig } from './env';
import { createInternalCredentialFetch } from './internal-credential';
import { addressedOrigin, checkSameOrigin } from './origin';
import { readAdminAccessToken } from './staff-session';

/**
 * Listing moderation and report management, on the admin origin (Phase 7-N).
 *
 * Six reads a page performs before it renders, and two writes a colleague posts to. The rules are 7-F's,
 * 7-G's, 7-J's and 7-L's, applied to a surface where a write withdraws somebody's listing from sale or closes
 * an accusation against them.
 *
 * **The session never leaves the server.** The caller's access token lives in `__Host-mp_admin_access`, which
 * JavaScript cannot read; it is presented to the API on one internal hop in the session-token header, and the
 * browser's own `Cookie` header is never forwarded.
 *
 * **Nothing about the caller crosses in a request.** No account, no role, no permission and no assurance
 * level appears in anything built here. The API resolves all of it from the session, and the database
 * re-applies the permission test with the key as a literal.
 *
 * **Bodies are rebuilt, never forwarded.** A report decision sends a status, a note and — only for a
 * duplicate — the report it duplicates. A listing decision sends an action, a reason and optionally the report
 * that prompted it. A screen that added a `moderatorUserId`, a `status`, a `priority`, an `expiresAt` or a
 * `reversesActionId` would have it dropped before the request left this origin, and the API's strict schema
 * would refuse it anyway. Two independent walls, neither relying on the other.
 *
 * **A report and a listing are named by their own ids, in the route, never in a body.** Each write takes its
 * subject from the URL path, checked here for shape. There is no storage path and no bucket anywhere in this
 * module, because moderating a listing touches no storage at all.
 *
 * **Responses are validated, not forwarded.** A drifted body becomes a clean failure here instead of a
 * half-rendered page, and a field the contract does not name cannot reach a browser even if the API sent one
 * — which is the third wall in front of a reporter's account, a seller's account and a colleague moderator's.
 *
 * **Cursors stay opaque.** A cursor is passed along as text and never parsed or reconstructed here.
 *
 * **Nothing here logs.** A report is an accusation and a moderation reason is a decision about somebody's
 * livelihood; the way to keep them out of a log is to have no log line that could take one.
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

const UNAVAILABLE = (): Response =>
  problemResponse(503, 'Service Unavailable', 'SERVICE_UNAVAILABLE', 'The service is temporarily unavailable.');
const SESSION_REQUIRED = (): Response =>
  problemResponse(401, 'Unauthorized', 'AUTHENTICATION_REQUIRED', 'Authentication is required.');
const VALIDATION_FAILED = (): Response =>
  problemResponse(400, 'Bad Request', 'VALIDATION_FAILED', 'The request is invalid.');

/** The statuses the API may refuse a write with. Anything else becomes the generic outage. */
const WRITE_PROBLEM_STATUSES = new Set([400, 401, 403, 404, 409, 429, 503]);

export interface ModerationOptions {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly fetch?: typeof fetch;
  /** The request's `Cookie` header. Server components pass the value they already hold. */
  readonly cookieHeader?: string | null;
}

/**
 * What a read resolved to.
 *
 * `notFound` is the API's one neutral answer: no such report or listing, or a caller without the key the
 * operation needs. The console does not try to tell those apart, because the API deliberately does not.
 */
export type ModerationResult<T> =
  | { readonly kind: 'ok'; readonly data: T }
  | { readonly kind: 'unauthenticated' }
  | { readonly kind: 'notFound' }
  | { readonly kind: 'invalid' }
  | { readonly kind: 'unavailable' };

/** base64url, which is the whole of what a cursor can be. Refused here rather than forwarded. */
const CURSOR_PATTERN = /^[A-Za-z0-9_-]{1,512}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function identifier(value: string | undefined | null): string | null {
  return typeof value === 'string' && UUID_PATTERN.test(value) ? value.toLowerCase() : null;
}

/**
 * Builds the query string from what the caller passed, dropping what it did not.
 *
 * The status filter is checked against the five the database has rather than forwarded as free text: an
 * unknown value would match nothing upstream anyway, and dropping it here keeps a mistyped bookmark showing
 * the whole queue instead of an empty one.
 */
function query(input: {
  readonly cursor?: string | null;
  readonly limit?: string | null;
  readonly status?: string | null;
}): string {
  const params = new URLSearchParams();
  if (typeof input.limit === 'string' && /^\d{1,3}$/.test(input.limit)) params.set('limit', input.limit);
  if (typeof input.status === 'string' && (REPORT_STATUSES as readonly string[]).includes(input.status)) {
    params.set('status', input.status);
  }
  if (typeof input.cursor === 'string' && CURSOR_PATTERN.test(input.cursor)) {
    // Passed along as text. This layer does not know what a cursor contains and must not learn.
    params.set('cursor', input.cursor);
  }
  return params.size === 0 ? '' : `?${params.toString()}`;
}

async function read<T>(
  path: string,
  options: ModerationOptions,
  parse: (body: unknown) => { success: true; data: T } | { success: false },
): Promise<ModerationResult<T>> {
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
    if (upstream.status === 400) return { kind: 'invalid' };
    return { kind: 'unavailable' };
  }

  try {
    const parsed = parse(JSON.parse(await upstream.text()));
    return parsed.success ? { kind: 'ok', data: parsed.data } : { kind: 'unavailable' };
  } catch {
    return { kind: 'unavailable' };
  }
}

/* ------------------------------------------------------------------------------------------------ */
/* Reads                                                                                             */
/* ------------------------------------------------------------------------------------------------ */

/** The report queue, oldest first, optionally narrowed to one existing status. */
export async function readModerationReports(
  input: { readonly cursor?: string | null; readonly limit?: string | null; readonly status?: string | null } = {},
  options: ModerationOptions = {},
): Promise<ModerationResult<ModerationReportQueueResponse>> {
  return await read(`/v1/admin/moderation/reports${query(input)}`, options, (body) =>
    ModerationReportQueueResponseSchema.safeParse(body),
  );
}

/**
 * One report.
 *
 * A malformed identifier is `notFound` here rather than a validation failure: the value came from the address
 * somebody typed, and the honest answer to a made-up address is that there is nothing at it.
 */
export async function readModerationReport(
  reportId: string | undefined,
  options: ModerationOptions = {},
): Promise<ModerationResult<ModerationReportDetail>> {
  const id = identifier(reportId);
  if (id === null) return { kind: 'notFound' };
  return await read(
    `/v1/admin/moderation/reports/${encodeURIComponent(id)}`,
    options,
    (body) => {
      const parsed = ModerationReportDetailResponseSchema.safeParse(body);
      return parsed.success ? { success: true, data: parsed.data.report } : { success: false };
    },
  );
}

/** The moderation actions citing one report. A separate read, on a different permission. */
export async function readModerationReportActions(
  reportId: string | undefined,
  options: ModerationOptions = {},
): Promise<ModerationResult<ModerationActionsResponse>> {
  const id = identifier(reportId);
  if (id === null) return { kind: 'notFound' };
  return await read(
    `/v1/admin/moderation/reports/${encodeURIComponent(id)}/actions`,
    options,
    (body) => ModerationActionsResponseSchema.safeParse(body),
  );
}

/** The listings awaiting review, oldest first. */
export async function readModerationListings(
  input: { readonly cursor?: string | null; readonly limit?: string | null } = {},
  options: ModerationOptions = {},
): Promise<ModerationResult<ModerationListingQueueResponse>> {
  return await read(`/v1/admin/moderation/listings${query(input)}`, options, (body) =>
    ModerationListingQueueResponseSchema.safeParse(body),
  );
}

/** One listing, with what a decision needs. */
export async function readModerationListing(
  listingId: string | undefined,
  options: ModerationOptions = {},
): Promise<ModerationResult<ModerationListingDetail>> {
  const id = identifier(listingId);
  if (id === null) return { kind: 'notFound' };
  return await read(
    `/v1/admin/moderation/listings/${encodeURIComponent(id)}`,
    options,
    (body) => {
      const parsed = ModerationListingDetailResponseSchema.safeParse(body);
      return parsed.success ? { success: true, data: parsed.data.listing } : { success: false };
    },
  );
}

/** One listing's moderation trail. A separate read, on the action permission. */
export async function readListingModerationHistory(
  listingId: string | undefined,
  options: ModerationOptions = {},
): Promise<ModerationResult<ListingModerationHistoryResponse>> {
  const id = identifier(listingId);
  if (id === null) return { kind: 'notFound' };
  return await read(
    `/v1/admin/moderation/listings/${encodeURIComponent(id)}/history`,
    options,
    (body) => ListingModerationHistoryResponseSchema.safeParse(body),
  );
}

/* ------------------------------------------------------------------------------------------------ */
/* Writes                                                                                            */
/* ------------------------------------------------------------------------------------------------ */

/** The Origin/CSRF check, the session and the parsed body, or the response that refuses the request. */
async function acceptWrite(
  request: Request,
  options: ModerationOptions,
): Promise<{ accessToken: string; body: Record<string, unknown> } | { refusal: Response }> {
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

  const accessToken = readAdminAccessToken(options.cookieHeader ?? request.headers.get('cookie'));
  if (accessToken === null) return { refusal: SESSION_REQUIRED() };

  let body: unknown;
  try {
    const raw = await request.text();
    body = raw === '' ? {} : JSON.parse(raw);
  } catch {
    return { refusal: VALIDATION_FAILED() };
  }
  if (typeof body !== 'object' || body === null) return { refusal: VALIDATION_FAILED() };
  return { accessToken, body: body as Record<string, unknown> };
}

async function callWrite(
  path: string,
  accessToken: string,
  body: unknown,
  options: ModerationOptions,
): Promise<Response | null> {
  const config = readBffConfig(options.env);
  const fetcher = createInternalCredentialFetch(config.internalBffCredential, options.fetch ?? fetch);
  try {
    return await fetcher(`${config.apiBaseUrl}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', [SESSION_TOKEN_HEADER]: accessToken },
      body: JSON.stringify(body),
    });
  } catch {
    return null;
  }
}

/**
 * Turns one upstream write response into the browser's.
 *
 * A recognised refusal is forwarded with the API's own problem body, so a screen can say "somebody already
 * did this" rather than a generic failure — which is exactly what the loser of two colleagues acting at once
 * needs to be told. Anything else becomes the generic 503, and success is the expected status exactly,
 * re-validated before a byte of it reaches a browser.
 */
async function writeOutcome<T>(
  upstream: Response | null,
  expected: number,
  parse: (body: unknown) => { success: true; data: T } | { success: false },
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
  const validated = parse(parsed);
  if (!validated.success) return UNAVAILABLE();

  return new Response(JSON.stringify(validated.data), {
    status: expected,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}

/**
 * `POST /api/moderation/reports/resolution` — record a decision on one report.
 *
 * The body is rebuilt from the contract's three fields: the status, the note, and — only for a duplicate —
 * the report it duplicates. A `moderatorUserId`, a `priority`, an `assignedTo` or a `resolvedBy` is dropped
 * here and would be refused upstream as well. The status is not validated against a list in this file: the
 * contract owns which four the writer accepts, and `open` is not one of them.
 */
export async function handleModerationReportResolution(
  request: Request,
  options: ModerationOptions = {},
): Promise<Response> {
  const accepted = await acceptWrite(request, options);
  if ('refusal' in accepted) return accepted.refusal;

  const reportId = identifier(
    typeof accepted.body['reportId'] === 'string' ? accepted.body['reportId'] : null,
  );
  if (reportId === null) return VALIDATION_FAILED();

  const note = accepted.body['resolutionNote'];
  const duplicateOf = accepted.body['duplicateOfReportId'];
  const validated = ResolveReportRequestSchema.safeParse({
    status: accepted.body['status'],
    ...(typeof note === 'string' && note.trim() !== '' ? { resolutionNote: note.trim() } : {}),
    ...(typeof duplicateOf === 'string' && duplicateOf !== ''
      ? { duplicateOfReportId: duplicateOf.toLowerCase() }
      : {}),
  });
  if (!validated.success) return VALIDATION_FAILED();

  const upstream = await callWrite(
    `/v1/admin/moderation/reports/${encodeURIComponent(reportId)}/resolution`,
    accepted.accessToken,
    validated.data,
    options,
  );
  return await writeOutcome(upstream, 200, (body) => ResolveReportResponseSchema.safeParse(body));
}

/**
 * `POST /api/moderation/listings/action` — moderate one listing.
 *
 * The body is rebuilt from the contract's three fields: the action, the reason, and optionally the report
 * that prompted it. There is no status field — the status the listing lands on is the writer's own mapping —
 * and no expiry and no reversal, because no writer in this repository sets either.
 */
export async function handleModerationListingAction(
  request: Request,
  options: ModerationOptions = {},
): Promise<Response> {
  const accepted = await acceptWrite(request, options);
  if ('refusal' in accepted) return accepted.refusal;

  const listingId = identifier(
    typeof accepted.body['listingId'] === 'string' ? accepted.body['listingId'] : null,
  );
  if (listingId === null) return VALIDATION_FAILED();

  const reason = accepted.body['reason'];
  const reportId = accepted.body['reportId'];
  const validated = ModerateListingRequestSchema.safeParse({
    action: accepted.body['action'],
    reason: typeof reason === 'string' ? reason.trim() : reason,
    ...(typeof reportId === 'string' && reportId !== ''
      ? { reportId: reportId.toLowerCase() }
      : {}),
  });
  if (!validated.success) return VALIDATION_FAILED();

  const upstream = await callWrite(
    `/v1/admin/moderation/listings/${encodeURIComponent(listingId)}/actions`,
    accepted.accessToken,
    validated.data,
    options,
  );
  return await writeOutcome(upstream, 200, (body) => ModerateListingResponseSchema.safeParse(body));
}
