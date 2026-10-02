import 'server-only';
import {
  OpenSupportTicketSchema,
  PROBLEM_JSON_MEDIA_TYPE,
  PostSupportMessageSchema,
  SESSION_TOKEN_HEADER,
  SupportAttachmentLinkResponseSchema,
  SupportAttachmentRecordResponseSchema,
  SupportAttachmentRecordSchema,
  SupportAttachmentUploadRequestSchema,
  SupportAttachmentUploadResponseSchema,
  SupportMessageMutationResponseSchema,
  SupportMessagesResponseSchema,
  OpenSupportTicketResponseSchema,
  SupportTicketClosureResponseSchema,
  SupportTicketDetailResponseSchema,
  SupportTicketsResponseSchema,
  type SupportMessagesResponse,
  type SupportTicketDetailResponse,
  type SupportTicketsResponse,
} from '@repo/contracts';
import { readBffConfig } from './env';
import { createInternalCredentialFetch } from './internal-credential';
import { addressedOrigin, checkSameOrigin } from './origin';
import { readAccessToken } from './session-cookies';

/**
 * The BFF half of support — the requester side (Phase 7-K).
 *
 * Three reads a server component calls directly and five writes a browser posts to. The rules are 7-E's,
 * 7-H's and 7-I's, applied to a surface where the stakes are what somebody wrote down about a problem with
 * their own account, and the files they attached to prove it.
 *
 * **The session never leaves the server.** The access token lives in the `__Host-mp_access` cookie, which
 * JavaScript cannot see; it is presented to the API on one internal hop in `x-session-token`, and the
 * browser's own `Cookie` header is never forwarded.
 *
 * **Request bodies are rebuilt, never forwarded.** Each write parses what the page sent, validates it
 * against the shared contract, and sends a body assembled here from the fields that contract names. A page
 * that added a `priority`, a `status`, an `assignedTo`, an `authorRole` or a `requesterUserId` would have it
 * dropped before the request left this origin — and the API's strict schema would refuse it anyway. Two
 * independent walls, neither relying on the other.
 *
 * **A ticket, a message and an attachment are named in the route, never in a body.** Every write takes its
 * subject from the URL path, checked here for shape, and each attachment operation is addressed **through
 * its own ticket** — so there is no field a browser could use to point an upload or a link at somebody
 * else's ticket.
 *
 * **Only one path in this file, and it is the server's.** Confirming an upload sends back the `objectPath`
 * the API issued. Nothing here composes one, nothing derives one from a file name, and the database checks
 * it against the caller's own namespace again; a page that invented one would simply be refused.
 *
 * **Responses are validated, not forwarded.** A drifted body becomes a clean failure here instead of a
 * half-rendered page, and a field the contract does not name cannot reach a browser even if the API sent one
 * — which is the third wall in front of an internal note, an agent's identifier and a storage path.
 *
 * **Cursors stay opaque.** A cursor is passed along as text and never parsed or reconstructed here: the API
 * owns the format, and a second place that understood it would be a second place that has to agree.
 *
 * **Nothing here logs.** A ticket is somebody's problem in their own words; the way to keep it out of a log
 * is to have no log line that could take it.
 *
 * Nothing in this file is an agent operation. There is no assignment, no internal note, no status write, no
 * queue and no permission name anywhere in it: 7-L owns the console.
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
  instance: '/support',
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
 * The statuses the API is allowed to refuse a write with.
 *
 * 404 and 409 are here because this surface has refusals a form must act on: a ticket that is not the
 * caller's, one that is closed, and a file the storage provider does not have. Anything outside the set
 * becomes the generic 503, so an unexpected upstream status can never arrive as a success.
 */
const WRITE_PROBLEM_STATUSES = new Set([400, 401, 403, 404, 409, 429, 503]);

export interface SupportHandlerOptions {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly fetch?: typeof fetch;
  /** The request's `Cookie` header. Server components pass the value they already hold. */
  readonly cookieHeader?: string | null;
}

/**
 * What a support read resolved to.
 *
 * `unauthenticated` and `unavailable` are kept apart deliberately: a session that has ended is a different
 * thing from a service that could not answer. `notFound` is the API's one neutral answer for a ticket that
 * does not exist and for one that is not the caller's, which is why a page renders the same thing for both.
 * `invalid` is the API's cursor refusal, which a page recovers from by dropping the cursor rather than by
 * reporting an outage.
 */
export type SupportResult<T> =
  | { readonly kind: 'ok'; readonly data: T }
  | { readonly kind: 'unauthenticated' }
  | { readonly kind: 'notFound' }
  | { readonly kind: 'invalid' }
  | { readonly kind: 'unavailable' };

/** A path segment a browser or a route supplied. Checked here so nothing but an identifier reaches a URL. */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function identifier(value: string | undefined | null): string | null {
  return typeof value === 'string' && UUID_PATTERN.test(value) ? value.toLowerCase() : null;
}

async function callRead(
  path: string,
  accessToken: string,
  options: SupportHandlerOptions,
): Promise<Response | null> {
  const config = readBffConfig(options.env);
  const fetcher = createInternalCredentialFetch(config.internalBffCredential, options.fetch ?? fetch);
  try {
    return await fetcher(`${config.apiBaseUrl}${path}`, {
      method: 'GET',
      headers: { [SESSION_TOKEN_HEADER]: accessToken },
    });
  } catch {
    return null;
  }
}

/** One read, validated against the contract before any of it is returned. */
async function read<T>(
  path: string,
  schema: Validator<T>,
  options: SupportHandlerOptions,
): Promise<SupportResult<T>> {
  const accessToken = readAccessToken(options.cookieHeader ?? null);
  if (accessToken === null) return { kind: 'unauthenticated' };

  const upstream = await callRead(path, accessToken, options);
  if (upstream === null) return { kind: 'unavailable' };
  if (!upstream.ok) {
    await upstream.text().catch(() => '');
    if (upstream.status === 401) return { kind: 'unauthenticated' };
    if (upstream.status === 404) return { kind: 'notFound' };
    if (upstream.status === 400) return { kind: 'invalid' };
    return { kind: 'unavailable' };
  }

  try {
    const parsed = schema.safeParse(JSON.parse(await upstream.text()));
    return parsed.success ? { kind: 'ok', data: parsed.data } : { kind: 'unavailable' };
  } catch {
    return { kind: 'unavailable' };
  }
}

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
/* Reads                                                                                             */
/* ------------------------------------------------------------------------------------------------ */

/** The tickets the caller raised. */
export async function readSupportTickets(
  input: { limit?: string | null; cursor?: string | null } = {},
  options: SupportHandlerOptions = {},
): Promise<SupportResult<SupportTicketsResponse>> {
  return await read(`/v1/support/tickets${query(input)}`, SupportTicketsResponseSchema, options);
}

/**
 * One ticket.
 *
 * A malformed identifier is `notFound` here rather than a validation failure: the value came from the
 * address somebody typed, and the honest answer to a made-up address is that there is nothing at it.
 */
export async function readSupportTicket(
  ticketId: string | undefined,
  options: SupportHandlerOptions = {},
): Promise<SupportResult<SupportTicketDetailResponse>> {
  const id = identifier(ticketId);
  if (id === null) return { kind: 'notFound' };
  return await read(
    `/v1/support/tickets/${encodeURIComponent(id)}`,
    SupportTicketDetailResponseSchema,
    options,
  );
}

/** One page of a ticket's conversation, in reading order. */
export async function readSupportMessages(
  ticketId: string | undefined,
  input: { limit?: string | null; cursor?: string | null } = {},
  options: SupportHandlerOptions = {},
): Promise<SupportResult<SupportMessagesResponse>> {
  const id = identifier(ticketId);
  if (id === null) return { kind: 'notFound' };
  return await read(
    `/v1/support/tickets/${encodeURIComponent(id)}/messages${query(input)}`,
    SupportMessagesResponseSchema,
    options,
  );
}

/* ------------------------------------------------------------------------------------------------ */
/* Writes                                                                                            */
/* ------------------------------------------------------------------------------------------------ */

/** The Origin/CSRF check, the session and the parsed body, or the response that refuses the request. */
async function acceptWrite(
  request: Request,
  options: SupportHandlerOptions,
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

async function callWrite(
  path: string,
  accessToken: string,
  body: unknown,
  options: SupportHandlerOptions,
): Promise<Response | null> {
  const config = readBffConfig(options.env);
  const fetcher = createInternalCredentialFetch(config.internalBffCredential, options.fetch ?? fetch);
  try {
    return await fetcher(`${config.apiBaseUrl}${path}`, {
      method: 'POST',
      headers:
        body === undefined
          ? { [SESSION_TOKEN_HEADER]: accessToken }
          : { 'content-type': 'application/json', [SESSION_TOKEN_HEADER]: accessToken },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch {
    return null;
  }
}

/**
 * Turns one upstream write response into the browser's.
 *
 * A recognised refusal is forwarded with the API's own problem body, so a form can say "this ticket is
 * closed" rather than a generic failure. Anything else becomes the generic 503. Success is the expected
 * status exactly, and its body is re-validated before a single byte of it reaches a browser.
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
 * `POST /api/support/tickets` — open one ticket.
 *
 * Rebuilt from the contract, so exactly a subject, a category and a first message cross. A priority, a
 * status, an assignee, an order or anything that names an account is dropped here and would be refused
 * upstream as well.
 */
export async function handleOpenSupportTicket(
  request: Request,
  options: SupportHandlerOptions = {},
): Promise<Response> {
  const accepted = await acceptWrite(request, options);
  if ('refusal' in accepted) return accepted.refusal;

  const fields = (accepted.body ?? {}) as Record<string, unknown>;
  const validated = OpenSupportTicketSchema.safeParse({
    subject: fields['subject'],
    category: fields['category'],
    body: fields['body'],
  });
  if (!validated.success) return VALIDATION_FAILED();

  const upstream = await callWrite('/v1/support/tickets', accepted.accessToken, validated.data, options);
  return await writeOutcome(upstream, 201, OpenSupportTicketResponseSchema);
}

/**
 * `POST /api/support/tickets/{ticketId}/messages` — reply on one's own ticket.
 *
 * The ticket is the one in the route; the contract has no ticket field, so a reply cannot be pointed at a
 * different one. There is no author and no role in the body: the database decides both from the ticket.
 */
export async function handlePostSupportMessage(
  request: Request,
  ticketId: string | undefined,
  options: SupportHandlerOptions = {},
): Promise<Response> {
  const accepted = await acceptWrite(request, options);
  if ('refusal' in accepted) return accepted.refusal;

  const id = identifier(ticketId);
  if (id === null) return VALIDATION_FAILED();

  const fields = (accepted.body ?? {}) as Record<string, unknown>;
  const validated = PostSupportMessageSchema.safeParse({ body: fields['body'] });
  if (!validated.success) return VALIDATION_FAILED();

  const upstream = await callWrite(
    `/v1/support/tickets/${encodeURIComponent(id)}/messages`,
    accepted.accessToken,
    validated.data,
    options,
  );
  return await writeOutcome(upstream, 201, SupportMessageMutationResponseSchema);
}

/**
 * `POST /api/support/tickets/{ticketId}/close` — the requester ends their own ticket.
 *
 * It sends no body at all: whatever a page put in one is dropped here, and there is no status field
 * upstream either. `resolved` is the agent outcome and cannot be reached from this origin.
 */
export async function handleCloseSupportTicket(
  request: Request,
  ticketId: string | undefined,
  options: SupportHandlerOptions = {},
): Promise<Response> {
  const accepted = await acceptWrite(request, options);
  if ('refusal' in accepted) return accepted.refusal;

  const id = identifier(ticketId);
  if (id === null) return VALIDATION_FAILED();

  const upstream = await callWrite(
    `/v1/support/tickets/${encodeURIComponent(id)}/close`,
    accepted.accessToken,
    undefined,
    options,
  );
  return await writeOutcome(upstream, 200, SupportTicketClosureResponseSchema);
}

/**
 * `POST /api/support/tickets/{ticketId}/messages/{messageId}/attachments/uploads` — ask for a destination.
 *
 * Rebuilt to exactly the two fields the bucket has the final say on. **There is no path in what crosses**,
 * and the page has none to send: the destination comes back from this call.
 */
export async function handleAuthorizeSupportAttachment(
  request: Request,
  ticketId: string | undefined,
  messageId: string | undefined,
  options: SupportHandlerOptions = {},
): Promise<Response> {
  const accepted = await acceptWrite(request, options);
  if ('refusal' in accepted) return accepted.refusal;

  const ticket = identifier(ticketId);
  const message = identifier(messageId);
  if (ticket === null || message === null) return VALIDATION_FAILED();

  const fields = (accepted.body ?? {}) as Record<string, unknown>;
  const validated = SupportAttachmentUploadRequestSchema.safeParse({
    contentType: fields['contentType'],
    byteSize: fields['byteSize'],
  });
  if (!validated.success) return VALIDATION_FAILED();

  const upstream = await callWrite(
    `/v1/support/tickets/${encodeURIComponent(ticket)}/messages/${encodeURIComponent(message)}/attachments/uploads`,
    accepted.accessToken,
    validated.data,
    options,
  );
  return await writeOutcome(upstream, 201, SupportAttachmentUploadResponseSchema);
}

/**
 * `POST /api/support/tickets/{ticketId}/messages/{messageId}/attachments` — confirm one upload.
 *
 * The `objectPath` that crosses here is the one the previous call returned, sent back unchanged. This layer
 * does not build it, shorten it, normalise it or check it against a namespace — the database rebuilds the
 * expected prefix from the caller's own rows and refuses anything else, which is the only check that can be
 * right.
 */
export async function handleRecordSupportAttachment(
  request: Request,
  ticketId: string | undefined,
  messageId: string | undefined,
  options: SupportHandlerOptions = {},
): Promise<Response> {
  const accepted = await acceptWrite(request, options);
  if ('refusal' in accepted) return accepted.refusal;

  const ticket = identifier(ticketId);
  const message = identifier(messageId);
  if (ticket === null || message === null) return VALIDATION_FAILED();

  const fields = (accepted.body ?? {}) as Record<string, unknown>;
  const validated = SupportAttachmentRecordSchema.safeParse({
    objectPath: fields['objectPath'],
    originalFilename: fields['originalFilename'],
    contentType: fields['contentType'],
    byteSize: fields['byteSize'],
  });
  if (!validated.success) return VALIDATION_FAILED();

  const upstream = await callWrite(
    `/v1/support/tickets/${encodeURIComponent(ticket)}/messages/${encodeURIComponent(message)}/attachments`,
    accepted.accessToken,
    validated.data,
    options,
  );
  return await writeOutcome(upstream, 201, SupportAttachmentRecordResponseSchema);
}

/**
 * `GET /api/support/tickets/{ticketId}/attachments/{attachmentId}/link` — one short-lived link.
 *
 * A read behind a route rather than a server component call, because the page cannot hold a link: it
 * expires in minutes and a person clicks when they click. It is a `GET`, so there is no Origin check to
 * make — the session cookie is `SameSite` and the API decides — and it forwards the API's own problem for a
 * ticket that is not the caller's so the page can say so.
 */
export async function handleSupportAttachmentLink(
  request: Request,
  ticketId: string | undefined,
  attachmentId: string | undefined,
  options: SupportHandlerOptions = {},
): Promise<Response> {
  const accessToken = readAccessToken(options.cookieHeader ?? request.headers.get('cookie'));
  if (accessToken === null) return SESSION_REQUIRED();

  const ticket = identifier(ticketId);
  const attachment = identifier(attachmentId);
  if (ticket === null || attachment === null) return VALIDATION_FAILED();

  const upstream = await callRead(
    `/v1/support/tickets/${encodeURIComponent(ticket)}/attachments/${encodeURIComponent(attachment)}/link`,
    accessToken,
    options,
  );
  if (upstream === null) return UNAVAILABLE();

  const text = await upstream.text();
  if (upstream.status !== 200) {
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
  const validated = SupportAttachmentLinkResponseSchema.safeParse(parsed);
  if (!validated.success) return UNAVAILABLE();

  return new Response(JSON.stringify(validated.data), {
    status: 200,
    // A signed URL is a bearer credential for one object for a few minutes. Nothing caches it.
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}
