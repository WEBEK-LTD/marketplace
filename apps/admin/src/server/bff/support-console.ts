import 'server-only';
import {
  AddSupportInternalNoteSchema,
  PROBLEM_JSON_MEDIA_TYPE,
  PostSupportAgentMessageSchema,
  SESSION_TOKEN_HEADER,
  SupportAgentDecisionRequestSchema,
  SupportAgentDecisionResponseSchema,
  SupportAssignedResponseSchema,
  SupportAssignmentResponseSchema,
  SupportConsoleAttachmentLinkResponseSchema,
  SupportConsoleMessageMutationResponseSchema,
  SupportConsoleMessagesResponseSchema,
  SupportConsoleTicketResponseSchema,
  SupportInternalNoteMutationResponseSchema,
  SupportInternalNotesResponseSchema,
  SupportQueueResponseSchema,
  type SupportAssignedResponse,
  type SupportConsoleMessagesResponse,
  type SupportConsoleTicket,
  type SupportInternalNotesResponse,
  type SupportQueueResponse,
} from '@repo/contracts';
import { readBffConfig } from './env';
import { createInternalCredentialFetch } from './internal-credential';
import { addressedOrigin, checkSameOrigin } from './origin';
import { readAdminAccessToken } from './staff-session';

/**
 * The support agent console, on the admin origin (Phase 7-L).
 *
 * Five reads a page performs before it renders, and five writes a colleague posts to. The rules are 7-F's,
 * 7-G's and 7-J's, applied to a surface that carries somebody's problem in their own words, a colleague's
 * private assessment of it, and the files attached to it.
 *
 * **The session never leaves the server.** The caller's access token lives in `__Host-mp_admin_access`, which
 * JavaScript cannot read; it is presented to the API on one internal hop in the session-token header, and the
 * browser's own `Cookie` header is never forwarded.
 *
 * **Nothing about the caller crosses in a request.** No account, no role, no permission, no assurance level
 * and **no assignee** appears in anything built here. Claiming and releasing send no body at all, so there is
 * no field through which one colleague could be assigned by another.
 *
 * **Bodies are rebuilt, never forwarded.** A reply and a note each send exactly one field, and the decision
 * sends exactly one status out of two. A screen that added an `authorRole`, an `assignedTo`, a `priority` or a
 * `reason` would have it dropped before the request left this origin, and the API's strict schema would refuse
 * it anyway.
 *
 * **Internal notes live here and on no other origin.** The requester's application has no route, no contract
 * and no reader that can reach the table they are in; this module's two note functions are the only way one is
 * read or written anywhere above the database.
 *
 * **Answers are validated, not forwarded.** A drifted body becomes a clean failure rather than a half-rendered
 * screen — which is the third wall in front of a colleague's account identifier, an assignee and a storage
 * path, none of which any response contract here can carry.
 *
 * **A refusal is not an outage, and an outage is not a refusal.** They stay distinct, because a console that
 * rendered "no such ticket" during a database hiccup would send somebody looking for work that is waiting.
 *
 * **Nothing here logs.** A ticket is somebody's problem, a note is a colleague's judgement of it, and a link
 * is a bearer credential; the way to keep them out of a log is to have no log line that could take one.
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

export interface SupportConsoleOptions {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly fetch?: typeof fetch;
  /** The request's `Cookie` header. Server components pass the value they already hold. */
  readonly cookieHeader?: string | null;
}

/**
 * What a read resolved to.
 *
 * `notFound` is the API's one neutral answer: no such ticket, a ticket a colleague holds, or a caller without
 * the key the operation needs. The console does not try to tell those apart, because the API deliberately
 * does not.
 */
export type SupportConsoleResult<T> =
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

/** Builds the query string from what the caller passed, dropping what it did not. */
function query(input: { readonly cursor?: string | null; readonly limit?: string | null }): string {
  const params = new URLSearchParams();
  if (typeof input.limit === 'string' && /^\d{1,3}$/.test(input.limit)) params.set('limit', input.limit);
  if (typeof input.cursor === 'string' && CURSOR_PATTERN.test(input.cursor)) {
    // Passed along as text. This layer does not know what a cursor contains and must not learn.
    params.set('cursor', input.cursor);
  }
  return params.size === 0 ? '' : `?${params.toString()}`;
}

async function read<T>(
  path: string,
  options: SupportConsoleOptions,
  parse: (body: unknown) => { success: true; data: T } | { success: false },
): Promise<SupportConsoleResult<T>> {
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

/** The shared queue: the tickets nobody has claimed, oldest first. */
export async function readSupportQueue(
  input: { readonly cursor?: string | null; readonly limit?: string | null } = {},
  options: SupportConsoleOptions = {},
): Promise<SupportConsoleResult<SupportQueueResponse>> {
  return await read(`/v1/admin/support/queue${query(input)}`, options, (body) =>
    SupportQueueResponseSchema.safeParse(body),
  );
}

/** The caller's own tickets. A separate operation, so neither list can show the other's rows. */
export async function readSupportAssigned(
  input: { readonly cursor?: string | null; readonly limit?: string | null } = {},
  options: SupportConsoleOptions = {},
): Promise<SupportConsoleResult<SupportAssignedResponse>> {
  return await read(`/v1/admin/support/assigned${query(input)}`, options, (body) =>
    SupportAssignedResponseSchema.safeParse(body),
  );
}

/** One ticket the caller may work on. A malformed identifier is nothing at that address. */
export async function readSupportConsoleTicket(
  ticketId: string | undefined,
  options: SupportConsoleOptions = {},
): Promise<SupportConsoleResult<SupportConsoleTicket>> {
  const id = identifier(ticketId);
  if (id === null) return { kind: 'notFound' };

  const result = await read(
    `/v1/admin/support/tickets/${encodeURIComponent(id)}`,
    options,
    (body) => SupportConsoleTicketResponseSchema.safeParse(body),
  );
  return result.kind === 'ok' ? { kind: 'ok', data: result.data.ticket } : result;
}

/** One page of the conversation, in reading order. */
export async function readSupportConsoleMessages(
  ticketId: string | undefined,
  input: { readonly cursor?: string | null; readonly limit?: string | null } = {},
  options: SupportConsoleOptions = {},
): Promise<SupportConsoleResult<SupportConsoleMessagesResponse>> {
  const id = identifier(ticketId);
  if (id === null) return { kind: 'notFound' };
  return await read(
    `/v1/admin/support/tickets/${encodeURIComponent(id)}/messages${query(input)}`,
    options,
    (body) => SupportConsoleMessagesResponseSchema.safeParse(body),
  );
}

/**
 * One page of the ticket's internal notes.
 *
 * A **separate read**, so the section it feeds is either rendered or not rendered at all: a caller the API
 * refuses gets `notFound` and the console renders no notes section, rather than an empty heading that would
 * tell a colleague there was something they could not see.
 */
export async function readSupportInternalNotes(
  ticketId: string | undefined,
  input: { readonly cursor?: string | null; readonly limit?: string | null } = {},
  options: SupportConsoleOptions = {},
): Promise<SupportConsoleResult<SupportInternalNotesResponse>> {
  const id = identifier(ticketId);
  if (id === null) return { kind: 'notFound' };
  return await read(
    `/v1/admin/support/tickets/${encodeURIComponent(id)}/notes${query(input)}`,
    options,
    (body) => SupportInternalNotesResponseSchema.safeParse(body),
  );
}

/* ------------------------------------------------------------------------------------------------ */
/* Writes                                                                                            */
/* ------------------------------------------------------------------------------------------------ */

/** The Origin/CSRF check, the session and the parsed body, or the response that refuses the request. */
async function acceptWrite(
  request: Request,
  options: SupportConsoleOptions,
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
  options: SupportConsoleOptions,
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
 * A recognised refusal is forwarded with the API's own problem body, so a screen can say "this ticket can no
 * longer be worked on" rather than a generic failure. Anything else becomes the generic 503, and success is
 * the expected status exactly, re-validated before a byte of it reaches a browser.
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

/** The ticket a write is about: one identifier, taken from the body and checked for shape. */
function ticketFrom(body: Record<string, unknown>): string | null {
  return identifier(typeof body['ticketId'] === 'string' ? body['ticketId'] : null);
}

/**
 * `POST /api/support/claim` — take a ticket from the queue.
 *
 * The body carries one identifier and nothing else is read from it. **No agent field crosses**, because the
 * API assigns the caller's own account: an `agentUserId` in the body would be ignored here and refused there.
 */
export async function handleSupportClaim(
  request: Request,
  options: SupportConsoleOptions = {},
): Promise<Response> {
  const accepted = await acceptWrite(request, options);
  if ('refusal' in accepted) return accepted.refusal;

  const ticketId = ticketFrom(accepted.body);
  if (ticketId === null) return VALIDATION_FAILED();

  const upstream = await callWrite(
    `/v1/admin/support/tickets/${encodeURIComponent(ticketId)}/claim`,
    accepted.accessToken,
    undefined,
    options,
  );
  return await writeOutcome(upstream, 200, (body) => SupportAssignmentResponseSchema.safeParse(body));
}

/** `POST /api/support/release` — return a ticket to the queue. It changes no status. */
export async function handleSupportRelease(
  request: Request,
  options: SupportConsoleOptions = {},
): Promise<Response> {
  const accepted = await acceptWrite(request, options);
  if ('refusal' in accepted) return accepted.refusal;

  const ticketId = ticketFrom(accepted.body);
  if (ticketId === null) return VALIDATION_FAILED();

  const upstream = await callWrite(
    `/v1/admin/support/tickets/${encodeURIComponent(ticketId)}/release`,
    accepted.accessToken,
    undefined,
    options,
  );
  return await writeOutcome(upstream, 200, (body) => SupportAssignmentResponseSchema.safeParse(body));
}

/**
 * `POST /api/support/reply` — answer the requester.
 *
 * Rebuilt from the contract, so exactly one message crosses. There is no author and no role in it: the
 * database works the role out from the ticket rather than trusting anybody.
 */
export async function handleSupportReply(
  request: Request,
  options: SupportConsoleOptions = {},
): Promise<Response> {
  const accepted = await acceptWrite(request, options);
  if ('refusal' in accepted) return accepted.refusal;

  const ticketId = ticketFrom(accepted.body);
  if (ticketId === null) return VALIDATION_FAILED();

  const validated = PostSupportAgentMessageSchema.safeParse({ body: accepted.body['body'] });
  if (!validated.success) return VALIDATION_FAILED();

  const upstream = await callWrite(
    `/v1/admin/support/tickets/${encodeURIComponent(ticketId)}/messages`,
    accepted.accessToken,
    validated.data,
    options,
  );
  return await writeOutcome(upstream, 201, (body) =>
    SupportConsoleMessageMutationResponseSchema.safeParse(body),
  );
}

/**
 * `POST /api/support/note` — write an internal note.
 *
 * The same shape as a reply and a different destination: the note goes to the staff-only table, which no
 * requester surface in this repository can read.
 */
export async function handleSupportNote(
  request: Request,
  options: SupportConsoleOptions = {},
): Promise<Response> {
  const accepted = await acceptWrite(request, options);
  if ('refusal' in accepted) return accepted.refusal;

  const ticketId = ticketFrom(accepted.body);
  if (ticketId === null) return VALIDATION_FAILED();

  const validated = AddSupportInternalNoteSchema.safeParse({ body: accepted.body['body'] });
  if (!validated.success) return VALIDATION_FAILED();

  const upstream = await callWrite(
    `/v1/admin/support/tickets/${encodeURIComponent(ticketId)}/notes`,
    accepted.accessToken,
    validated.data,
    options,
  );
  return await writeOutcome(upstream, 201, (body) =>
    SupportInternalNoteMutationResponseSchema.safeParse(body),
  );
}

/**
 * `POST /api/support/decision` — record the agent outcome.
 *
 * The one write on this origin that carries a status, and the contract admits `resolved` or `closed`. Anything
 * else is refused here before the request leaves, and refused again upstream, and a third time in the
 * database. There is no reason field, because nothing stores one.
 */
export async function handleSupportDecision(
  request: Request,
  options: SupportConsoleOptions = {},
): Promise<Response> {
  const accepted = await acceptWrite(request, options);
  if ('refusal' in accepted) return accepted.refusal;

  const ticketId = ticketFrom(accepted.body);
  if (ticketId === null) return VALIDATION_FAILED();

  const validated = SupportAgentDecisionRequestSchema.safeParse({ status: accepted.body['status'] });
  if (!validated.success) return VALIDATION_FAILED();

  const upstream = await callWrite(
    `/v1/admin/support/tickets/${encodeURIComponent(ticketId)}/decision`,
    accepted.accessToken,
    validated.data,
    options,
  );
  return await writeOutcome(upstream, 200, (body) => SupportAgentDecisionResponseSchema.safeParse(body));
}

/**
 * `GET /api/support/attachment` — one short-lived link.
 *
 * A read behind a route rather than a server component call, because a page cannot hold a link: it expires in
 * minutes and a colleague clicks when they click. Both identifiers travel in the query, both are checked for
 * shape here, and **no path or bucket is accepted from anywhere** — the API resolves the object from the
 * attachment's own row.
 */
export async function handleSupportAttachmentLink(
  request: Request,
  options: SupportConsoleOptions = {},
): Promise<Response> {
  const accessToken = readAdminAccessToken(options.cookieHeader ?? request.headers.get('cookie'));
  if (accessToken === null) return SESSION_REQUIRED();

  let url: URL;
  try {
    url = new URL(request.url);
  } catch {
    return VALIDATION_FAILED();
  }
  const ticketId = identifier(url.searchParams.get('ticketId'));
  const attachmentId = identifier(url.searchParams.get('attachmentId'));
  if (ticketId === null || attachmentId === null) return VALIDATION_FAILED();

  const config = readBffConfig(options.env);
  const fetcher = createInternalCredentialFetch(config.internalBffCredential, options.fetch ?? fetch);

  let upstream: Response;
  try {
    upstream = await fetcher(
      `${config.apiBaseUrl}/v1/admin/support/tickets/${encodeURIComponent(ticketId)}/attachments/${encodeURIComponent(attachmentId)}/link`,
      { method: 'GET', headers: { [SESSION_TOKEN_HEADER]: accessToken } },
    );
  } catch {
    return UNAVAILABLE();
  }

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
  const validated = SupportConsoleAttachmentLinkResponseSchema.safeParse(parsed);
  if (!validated.success) return UNAVAILABLE();

  return new Response(JSON.stringify(validated.data), {
    status: 200,
    // A signed URL is a bearer credential for one object for a few minutes. Nothing caches it.
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}
