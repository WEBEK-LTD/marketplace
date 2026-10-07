import 'server-only';
import {
  CloseConversationResponseSchema,
  FileMessagingReportResponseSchema,
  ConversationMessagesResponseSchema,
  LeaveConversationResponseSchema,
  MarkReadResponseSchema,
  MessageAttachmentLinkResponseSchema,
  MessageAttachmentRecordRequestSchema,
  MessageAttachmentRecordResponseSchema,
  MessageAttachmentUploadRequestSchema,
  MessageAttachmentUploadResponseSchema,
  MessagingInboxResponseSchema,
  PROBLEM_JSON_MEDIA_TYPE,
  SESSION_TOKEN_HEADER,
  SendMessageResponseSchema,
  SetMutedResponseSchema,
  StartConversationResponseSchema,
  UnreadCountResponseSchema,
  type ConversationMessagesResponse,
  type MessagingInboxResponse,
} from '@repo/contracts';
import { readBffConfig } from './env';
import { createInternalCredentialFetch } from './internal-credential';
import { addressedOrigin, checkSameOrigin } from './origin';
import { readAccessToken } from './session-cookies';

/**
 * The BFF half of the messaging reads (Phase 5-D).
 *
 * Every read here is authenticated, and the session never leaves the server: the access token lives in
 * the `__Host-mp_access` cookie, which JavaScript cannot see, and this module is the only thing on this
 * origin that reads it — presenting it to the API on one internal hop in `x-session-token`, exactly as
 * the F4 contact change and the 5-A identity read do.
 *
 * What travels upstream is the token and the internal credential and nothing else. The browser's own
 * `Cookie` header is never forwarded: the BFF reads it and sends one value, so an upstream service can
 * never see a cookie it has no business seeing.
 *
 * Responses are **validated** against the shared 5-C contract rather than forwarded. That is the point
 * of the layer: a body that has drifted becomes a clean failure here instead of a half-rendered thread,
 * and a field the contract does not name cannot reach a browser even if the API somehow sent one.
 *
 * Nothing here logs. A message body is the most private thing this project carries, and the way to keep
 * it out of a log is to have no log line that could take it.
 *
 * **Cursors are opaque all the way through.** This module passes the `cursor` parameter along as text
 * and never parses, validates or reconstructs it — the API owns its format, and a BFF that understood it
 * would be a second place that has to agree about it.
 */

const PROBLEM = {
  type: 'about:blank',
  status: 503,
  title: 'Service Unavailable',
  detail: 'The service is temporarily unavailable.',
  instance: '/messaging',
  code: 'SERVICE_UNAVAILABLE',
} as const;

function problemResponse(status: number, title: string, code: string, detail: string): Response {
  return new Response(JSON.stringify({ ...PROBLEM, status, title, code, detail }), {
    status,
    headers: { 'content-type': PROBLEM_JSON_MEDIA_TYPE, 'cache-control': 'no-store' },
  });
}

const SESSION_REQUIRED = () =>
  problemResponse(401, 'Unauthorized', 'AUTHENTICATION_REQUIRED', 'Authentication is required.');

const UNAVAILABLE = () =>
  problemResponse(503, 'Service Unavailable', 'SERVICE_UNAVAILABLE', 'The service is temporarily unavailable.');

export interface MessagingHandlerOptions {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly fetch?: typeof fetch;
  /** The request's `Cookie` header. Server components pass the value they already hold. */
  readonly cookieHeader?: string | null;
}

/**
 * What a messaging read resolved to.
 *
 * `unauthenticated` and `unavailable` are kept apart deliberately: a session that has ended is a
 * different thing from a service that could not answer, and a page that conflated them would tell
 * somebody they had been signed out because a database was busy.
 *
 * `not_found` is the API's single indistinguishable refusal — a conversation that does not exist and one
 * the caller may not read arrive here identically, and this type keeps them identical.
 */
export type MessagingResult<T> =
  | { readonly kind: 'ok'; readonly data: T }
  | { readonly kind: 'unauthenticated' }
  | { readonly kind: 'not_found' }
  | { readonly kind: 'invalid' }
  | { readonly kind: 'unavailable' };

/** One credentialled internal call carrying the caller's own token, or null if the API was unreachable. */
async function call(
  path: string,
  accessToken: string,
  options: MessagingHandlerOptions,
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

/** Maps an upstream status onto the outcomes a page can render. Anything unexpected is unavailable. */
function outcomeOf(status: number): 'unauthenticated' | 'not_found' | 'invalid' | 'unavailable' {
  if (status === 401) return 'unauthenticated';
  if (status === 404) return 'not_found';
  if (status === 400) return 'invalid';
  return 'unavailable';
}

/** Builds the query string from whatever the caller passed, dropping what it did not. */
function query(input: { limit?: string | null; cursor?: string | null }): string {
  const params = new URLSearchParams();
  if (input.limit !== undefined && input.limit !== null && input.limit !== '') params.set('limit', input.limit);
  // Passed through verbatim. This layer does not know what a cursor contains and must not learn.
  if (input.cursor !== undefined && input.cursor !== null && input.cursor !== '') params.set('cursor', input.cursor);
  return params.size === 0 ? '' : `?${params.toString()}`;
}

/** One page of the caller's inbox. */
export async function readInbox(
  input: { limit?: string | null; cursor?: string | null } = {},
  options: MessagingHandlerOptions = {},
): Promise<MessagingResult<MessagingInboxResponse>> {
  const accessToken = readAccessToken(options.cookieHeader ?? null);
  if (accessToken === null) return { kind: 'unauthenticated' };

  const upstream = await call(`/v1/messaging/conversations${query(input)}`, accessToken, options);
  if (upstream === null) return { kind: 'unavailable' };
  if (!upstream.ok) {
    await upstream.text().catch(() => '');
    return { kind: outcomeOf(upstream.status) };
  }

  try {
    const parsed = MessagingInboxResponseSchema.safeParse(JSON.parse(await upstream.text()));
    return parsed.success ? { kind: 'ok', data: parsed.data } : { kind: 'unavailable' };
  } catch {
    return { kind: 'unavailable' };
  }
}

/** One page of one conversation. */
export async function readConversationMessages(
  conversationId: string,
  input: { limit?: string | null; cursor?: string | null } = {},
  options: MessagingHandlerOptions = {},
): Promise<MessagingResult<ConversationMessagesResponse>> {
  const accessToken = readAccessToken(options.cookieHeader ?? null);
  if (accessToken === null) return { kind: 'unauthenticated' };

  const upstream = await call(
    `/v1/messaging/conversations/${encodeURIComponent(conversationId)}/messages${query(input)}`,
    accessToken,
    options,
  );
  if (upstream === null) return { kind: 'unavailable' };
  if (!upstream.ok) {
    await upstream.text().catch(() => '');
    return { kind: outcomeOf(upstream.status) };
  }

  try {
    const parsed = ConversationMessagesResponseSchema.safeParse(JSON.parse(await upstream.text()));
    return parsed.success ? { kind: 'ok', data: parsed.data } : { kind: 'unavailable' };
  } catch {
    return { kind: 'unavailable' };
  }
}

/**
 * The caller's total unread count.
 *
 * Read separately from the inbox on purpose: the badge is allowed to fail on its own. A page that made
 * its conversation list depend on a counter would lose the list whenever the counter was unavailable.
 */
export async function readUnreadCount(
  options: MessagingHandlerOptions = {},
): Promise<MessagingResult<number>> {
  const accessToken = readAccessToken(options.cookieHeader ?? null);
  if (accessToken === null) return { kind: 'unauthenticated' };

  const upstream = await call('/v1/messaging/unread-count', accessToken, options);
  if (upstream === null) return { kind: 'unavailable' };
  if (!upstream.ok) {
    await upstream.text().catch(() => '');
    return { kind: outcomeOf(upstream.status) };
  }

  try {
    const parsed = UnreadCountResponseSchema.safeParse(JSON.parse(await upstream.text()));
    return parsed.success ? { kind: 'ok', data: parsed.data.unreadCount } : { kind: 'unavailable' };
  } catch {
    return { kind: 'unavailable' };
  }
}

/** Turns an outcome into the problem response the browser sees. Success is handled by each route. */
function refusal(kind: 'unauthenticated' | 'not_found' | 'invalid' | 'unavailable'): Response {
  if (kind === 'unauthenticated') return SESSION_REQUIRED();
  if (kind === 'not_found') {
    // The API's one indistinguishable refusal, kept indistinguishable: a conversation that does not
    // exist and one the caller may not read produce this identical body.
    return problemResponse(
      404,
      'Not Found',
      'MESSAGING_CONVERSATION_NOT_FOUND',
      'The conversation could not be found.',
    );
  }
  if (kind === 'invalid') {
    return problemResponse(400, 'Bad Request', 'VALIDATION_FAILED', 'The request is invalid.');
  }
  return UNAVAILABLE();
}

/** `GET /api/messaging/conversations`. */
export async function handleInbox(
  request: Request,
  options: MessagingHandlerOptions = {},
): Promise<Response> {
  const params = new URL(request.url).searchParams;
  const result = await readInbox(
    { limit: params.get('limit'), cursor: params.get('cursor') },
    { ...options, cookieHeader: options.cookieHeader ?? request.headers.get('cookie') },
  );
  if (result.kind !== 'ok') return refusal(result.kind);

  // Rebuilt from the validated fields rather than forwarded, so nothing the contract does not name can
  // travel onward.
  return new Response(JSON.stringify({ items: result.data.items, nextCursor: result.data.nextCursor }), {
    status: 200,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}

/** `GET /api/messaging/conversations/:conversationId/messages`. */
export async function handleConversationMessages(
  request: Request,
  conversationId: string,
  options: MessagingHandlerOptions = {},
): Promise<Response> {
  const params = new URL(request.url).searchParams;
  const result = await readConversationMessages(
    conversationId,
    { limit: params.get('limit'), cursor: params.get('cursor') },
    { ...options, cookieHeader: options.cookieHeader ?? request.headers.get('cookie') },
  );
  if (result.kind !== 'ok') return refusal(result.kind);

  return new Response(JSON.stringify({ items: result.data.items, nextCursor: result.data.nextCursor }), {
    status: 200,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}

/** `GET /api/messaging/unread-count`. */
export async function handleUnreadCount(
  request: Request,
  options: MessagingHandlerOptions = {},
): Promise<Response> {
  const result = await readUnreadCount({
    ...options,
    cookieHeader: options.cookieHeader ?? request.headers.get('cookie'),
  });
  if (result.kind !== 'ok') return refusal(result.kind);

  return new Response(JSON.stringify({ unreadCount: result.data }), {
    status: 200,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}

/**
 * The messaging write routes (Phase 5-E).
 *
 * Every one is state-changing, so every one applies the existing Origin/CSRF check before it reads a
 * cookie — the same rule login, recovery and the contact change use, not a second mechanism. The session
 * still travels as one header on one internal hop, the browser's own `Cookie` header is still never
 * forwarded, and nothing here logs: a message body is the most private thing this project carries.
 *
 * Responses are validated against the shared write contracts and rebuilt from the validated fields, so a
 * body that has drifted becomes a clean failure and a field the contract does not name cannot reach a
 * browser. An upstream refusal is passed through with its own status and code, because the API's wording
 * is the approved wording and a second copy here would be a second thing to keep in step.
 */

const WRITE_PROBLEM_STATUSES = new Set([400, 401, 403, 404, 409, 429]);

/** Applies the Origin check, reads the session, and parses the body — or returns the refusal. */
async function acceptWrite(
  request: Request,
  options: MessagingHandlerOptions,
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

  // A route that takes no body is called with none; an unparsable body on a route that needs one is a
  // validation failure rather than something forwarded.
  const raw = await request.text().catch(() => '');
  if (raw === '') return { accessToken, body: undefined };
  try {
    return { accessToken, body: JSON.parse(raw) };
  } catch {
    return {
      refusal: problemResponse(400, 'Bad Request', 'VALIDATION_FAILED', 'The request is invalid.'),
    };
  }
}

/** One credentialled write call carrying the caller's own token. */
async function callWrite(
  path: string,
  method: 'POST' | 'PUT' | 'DELETE',
  accessToken: string,
  body: unknown,
  options: MessagingHandlerOptions,
): Promise<Response | null> {
  const config = readBffConfig(options.env);
  const fetcher = createInternalCredentialFetch(config.internalBffCredential, options.fetch ?? fetch);
  try {
    return await fetcher(`${config.apiBaseUrl}${path}`, {
      method,
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
 * A recognised refusal status is forwarded with the API's own problem body; anything else becomes the
 * generic 503, so an unexpected upstream status can never arrive as a success.
 *
 * Success is **one** status per operation, named by the caller and compared exactly — not "any 2xx". An
 * operation that answers 200 where its contract says 201 has drifted from the contract as surely as one
 * whose body has, and a page that rendered it would be rendering a guess.
 */
async function writeOutcome(
  upstream: Response | null,
  expected: 200 | 201,
  validate: (payload: unknown) => unknown | null,
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
    parsed = validate(JSON.parse(text));
  } catch {
    return UNAVAILABLE();
  }
  if (parsed === null) return UNAVAILABLE();

  return new Response(JSON.stringify(parsed), {
    status: expected,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}

/** `POST /api/messaging/conversations` — start a conversation, or resolve to the open one. */
export async function handleStartConversation(
  request: Request,
  options: MessagingHandlerOptions = {},
): Promise<Response> {
  const accepted = await acceptWrite(request, options);
  if ('refusal' in accepted) return accepted.refusal;

  const upstream = await callWrite(
    '/v1/messaging/conversations',
    'POST',
    accepted.accessToken,
    accepted.body,
    options,
  );
  return await writeOutcome(upstream, 200, (payload) => {
    const parsed = StartConversationResponseSchema.safeParse(payload);
    return parsed.success ? parsed.data : null;
  });
}

/** `POST /api/messaging/conversations/:conversationId/messages` — send one text message. */
export async function handleSendMessage(
  request: Request,
  conversationId: string,
  options: MessagingHandlerOptions = {},
): Promise<Response> {
  const accepted = await acceptWrite(request, options);
  if ('refusal' in accepted) return accepted.refusal;

  const upstream = await callWrite(
    `/v1/messaging/conversations/${encodeURIComponent(conversationId)}/messages`,
    'POST',
    accepted.accessToken,
    accepted.body,
    options,
  );
  return await writeOutcome(upstream, 201, (payload) => {
    const parsed = SendMessageResponseSchema.safeParse(payload);
    return parsed.success ? parsed.data : null;
  });
}

/** `PUT /api/messaging/conversations/:conversationId/read` — move the caller's own marker. */
export async function handleMarkRead(
  request: Request,
  conversationId: string,
  options: MessagingHandlerOptions = {},
): Promise<Response> {
  const accepted = await acceptWrite(request, options);
  if ('refusal' in accepted) return accepted.refusal;

  const upstream = await callWrite(
    `/v1/messaging/conversations/${encodeURIComponent(conversationId)}/read`,
    'PUT',
    accepted.accessToken,
    accepted.body,
    options,
  );
  return await writeOutcome(upstream, 200, (payload) => {
    const parsed = MarkReadResponseSchema.safeParse(payload);
    return parsed.success ? parsed.data : null;
  });
}

/** `PUT /api/messaging/conversations/:conversationId/muted` — the caller's own mute flag. */
export async function handleSetMuted(
  request: Request,
  conversationId: string,
  options: MessagingHandlerOptions = {},
): Promise<Response> {
  const accepted = await acceptWrite(request, options);
  if ('refusal' in accepted) return accepted.refusal;

  const upstream = await callWrite(
    `/v1/messaging/conversations/${encodeURIComponent(conversationId)}/muted`,
    'PUT',
    accepted.accessToken,
    accepted.body,
    options,
  );
  return await writeOutcome(upstream, 200, (payload) => {
    const parsed = SetMutedResponseSchema.safeParse(payload);
    return parsed.success ? parsed.data : null;
  });
}

/** `DELETE /api/messaging/conversations/:conversationId/membership` — the caller leaves. */
export async function handleLeaveConversation(
  request: Request,
  conversationId: string,
  options: MessagingHandlerOptions = {},
): Promise<Response> {
  const accepted = await acceptWrite(request, options);
  if ('refusal' in accepted) return accepted.refusal;

  const upstream = await callWrite(
    `/v1/messaging/conversations/${encodeURIComponent(conversationId)}/membership`,
    'DELETE',
    accepted.accessToken,
    undefined,
    options,
  );
  return await writeOutcome(upstream, 200, (payload) => {
    const parsed = LeaveConversationResponseSchema.safeParse(payload);
    return parsed.success ? parsed.data : null;
  });
}

/** `PUT /api/messaging/conversations/:conversationId/closed` — close it. Idempotent. */
export async function handleCloseConversation(
  request: Request,
  conversationId: string,
  options: MessagingHandlerOptions = {},
): Promise<Response> {
  const accepted = await acceptWrite(request, options);
  if ('refusal' in accepted) return accepted.refusal;

  const upstream = await callWrite(
    `/v1/messaging/conversations/${encodeURIComponent(conversationId)}/closed`,
    'PUT',
    accepted.accessToken,
    undefined,
    options,
  );
  return await writeOutcome(upstream, 200, (payload) => {
    const parsed = CloseConversationResponseSchema.safeParse(payload);
    return parsed.success ? parsed.data : null;
  });
}

/**
 * `POST /api/messaging/reports` — report a message or a conversation (Phase 5-H).
 *
 * The same boundary as every other write here: the Origin check before any cookie is read, the session as
 * one header on one internal hop, the browser's own `Cookie` never forwarded, and the answer rebuilt from
 * the contract. The request body is passed through as the browser sent it — the API validates it, and a
 * second copy of that validation here would be a second thing to keep in step.
 */
export async function handleFileReport(
  request: Request,
  options: MessagingHandlerOptions = {},
): Promise<Response> {
  const accepted = await acceptWrite(request, options);
  if ('refusal' in accepted) return accepted.refusal;

  const upstream = await callWrite(
    '/v1/messaging/reports',
    'POST',
    accepted.accessToken,
    accepted.body,
    options,
  );
  return await writeOutcome(upstream, 200, (payload) => {
    const parsed = FileMessagingReportResponseSchema.safeParse(payload);
    return parsed.success ? parsed.data : null;
  });
}


/* ------------------------------------------------------------------------------------------------ */
/* Attachments (0104)                                                                                */
/* ------------------------------------------------------------------------------------------------ */

/** A route segment a browser supplied. Checked here so nothing but an identifier reaches a URL. */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function identifier(value: string | undefined): string | null {
  return typeof value === 'string' && UUID_PATTERN.test(value) ? value.toLowerCase() : null;
}

/**
 * `POST /api/messaging/conversations/:conversationId/messages/:messageId/attachments/uploads`
 *
 * **The body is rebuilt from exactly the two fields the contract names**, so a page that added an
 * `objectPath`, a `bucket` or a filename has them dropped before the request leaves this origin. The path is
 * the server's to compose and this layer never sees one on the way in.
 */
export async function handleAuthorizeMessageAttachment(
  request: Request,
  conversationId: string | undefined,
  messageId: string | undefined,
  options: MessagingHandlerOptions = {},
): Promise<Response> {
  const accepted = await acceptWrite(request, options);
  if ('refusal' in accepted) return accepted.refusal;

  const conversation = identifier(conversationId);
  const message = identifier(messageId);
  if (conversation === null || message === null) {
    return problemResponse(400, 'Bad Request', 'VALIDATION_FAILED', 'The request is invalid.');
  }

  const fields = (accepted.body ?? {}) as Record<string, unknown>;
  const validated = MessageAttachmentUploadRequestSchema.safeParse({
    contentType: fields['contentType'],
    byteSize: fields['byteSize'],
  });
  if (!validated.success) {
    return problemResponse(400, 'Bad Request', 'VALIDATION_FAILED', 'The request is invalid.');
  }

  const upstream = await callWrite(
    `/v1/messaging/conversations/${encodeURIComponent(conversation)}/messages/${encodeURIComponent(message)}/attachments/uploads`,
    'POST',
    accepted.accessToken,
    validated.data,
    options,
  );
  return await writeOutcome(upstream, 200, (payload) => {
    const parsed = MessageAttachmentUploadResponseSchema.safeParse(payload);
    return parsed.success ? parsed.data : null;
  });
}

/**
 * `POST /api/messaging/conversations/:conversationId/messages/:messageId/attachments`
 *
 * The `objectPath` that crosses here is the one the previous call returned, sent back unchanged. This layer
 * does not build it, shorten it, normalise it or check it against a namespace — the database rebuilds the
 * expected prefix from the caller's own rows and refuses anything else, which is the only check that can be
 * right. Validating its *shape* here would be a second, weaker copy of that.
 */
export async function handleRecordMessageAttachment(
  request: Request,
  conversationId: string | undefined,
  messageId: string | undefined,
  options: MessagingHandlerOptions = {},
): Promise<Response> {
  const accepted = await acceptWrite(request, options);
  if ('refusal' in accepted) return accepted.refusal;

  const conversation = identifier(conversationId);
  const message = identifier(messageId);
  if (conversation === null || message === null) {
    return problemResponse(400, 'Bad Request', 'VALIDATION_FAILED', 'The request is invalid.');
  }

  const fields = (accepted.body ?? {}) as Record<string, unknown>;
  const validated = MessageAttachmentRecordRequestSchema.safeParse({
    objectPath: fields['objectPath'],
    contentType: fields['contentType'],
    byteSize: fields['byteSize'],
  });
  if (!validated.success) {
    return problemResponse(400, 'Bad Request', 'VALIDATION_FAILED', 'The request is invalid.');
  }

  const upstream = await callWrite(
    `/v1/messaging/conversations/${encodeURIComponent(conversation)}/messages/${encodeURIComponent(message)}/attachments`,
    'POST',
    accepted.accessToken,
    validated.data,
    options,
  );
  return await writeOutcome(upstream, 201, (payload) => {
    const parsed = MessageAttachmentRecordResponseSchema.safeParse(payload);
    return parsed.success ? parsed.data : null;
  });
}

/**
 * `GET /api/messaging/conversations/:conversationId/attachments/:attachmentId/link`
 *
 * A read behind a route rather than a server component call, because a page cannot hold a link: it expires in
 * ten minutes and a person clicks when they click. It is a `GET`, so there is no Origin check to make — the
 * session cookie is `SameSite` and the API decides — and it forwards the API's own problem so a thread can say
 * a file is no longer there rather than silently doing nothing.
 */
export async function handleMessageAttachmentLink(
  request: Request,
  conversationId: string | undefined,
  attachmentId: string | undefined,
  options: MessagingHandlerOptions = {},
): Promise<Response> {
  const accessToken = readAccessToken(options.cookieHeader ?? request.headers.get('cookie'));
  if (accessToken === null) return SESSION_REQUIRED();

  const conversation = identifier(conversationId);
  const attachment = identifier(attachmentId);
  if (conversation === null || attachment === null) {
    return problemResponse(400, 'Bad Request', 'VALIDATION_FAILED', 'The request is invalid.');
  }

  const upstream = await call(
    `/v1/messaging/conversations/${encodeURIComponent(conversation)}/attachments/${encodeURIComponent(attachment)}/link`,
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
  const validated = MessageAttachmentLinkResponseSchema.safeParse(parsed);
  if (!validated.success) return UNAVAILABLE();

  // Never cached, anywhere: a signed URL is a short-lived authorization and a cache is a place it outlives
  // the page that asked for it.
  return new Response(JSON.stringify(validated.data), {
    status: 200,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}
