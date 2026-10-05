import 'server-only';
import {
  ArchiveNotificationsRequestSchema,
  MarkNotificationsReadRequestSchema,
  NotificationsMutationResponseSchema,
  NotificationsResponseSchema,
  NotificationsUnreadCountResponseSchema,
  PROBLEM_JSON_MEDIA_TYPE,
  SESSION_TOKEN_HEADER,
  type NotificationsResponse,
} from '@repo/contracts';
import { readBffConfig } from './env';
import { createInternalCredentialFetch } from './internal-credential';
import { addressedOrigin, checkSameOrigin } from './origin';
import { readAccessToken } from './session-cookies';

/**
 * The BFF half of the in-app notification surface (Phase 7-C).
 *
 * Two reads a server component calls directly, and two writes a browser posts to. Five rules shape all of
 * them, and each is the reason a piece of this looks the way it does.
 *
 * **The session never leaves the server.** The access token lives in the `__Host-mp_access` cookie, which
 * JavaScript cannot see, and this module is the only thing on this origin that reads it — presenting it to
 * the API on one internal hop in `x-session-token`, exactly as the 5-D messaging reads do. The browser's
 * own `Cookie` header is never forwarded.
 *
 * **Request bodies are rebuilt, never forwarded.** Both writes parse what the page sent, validate it
 * against the shared contract, and send a body assembled here from the fields that contract names. A page
 * that added a `userId` would have it dropped before the request left this origin — and the API's strict
 * schema would refuse it anyway, which is the point: two independent walls, neither relying on the other.
 *
 * **Responses are validated, not forwarded.** A body that has drifted becomes a clean failure here
 * instead of a half-rendered list, and a field the contract does not name cannot reach a browser even if
 * the API somehow sent one.
 *
 * **Cursors stay opaque.** The `cursor` parameter is passed along as text and never parsed, validated or
 * reconstructed here. The API owns the format, and a BFF that understood it would be a second place that
 * has to agree about it.
 *
 * **Nothing here logs.** A notification says what happened to somebody and where to look; the way to keep
 * that out of a log is to have no log line that could take it.
 */

const PROBLEM = {
  type: 'about:blank',
  status: 503,
  title: 'Service Unavailable',
  detail: 'The service is temporarily unavailable.',
  instance: '/notifications',
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

/** The statuses the API is allowed to refuse a write with. Anything else becomes the generic 503. */
const WRITE_PROBLEM_STATUSES = new Set([400, 401, 403, 429]);

export interface NotificationsHandlerOptions {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly fetch?: typeof fetch;
  /** The request's `Cookie` header. Server components pass the value they already hold. */
  readonly cookieHeader?: string | null;
}

/**
 * What a notification read resolved to.
 *
 * `unauthenticated` and `unavailable` are kept apart deliberately: a session that has ended is a
 * different thing from a service that could not answer, and a page that conflated them would tell
 * somebody they had been signed out because a database was busy. `invalid` is the API's cursor refusal,
 * which a page recovers from by dropping the cursor rather than by reporting an outage.
 */
export type NotificationsResult<T> =
  | { readonly kind: 'ok'; readonly data: T }
  | { readonly kind: 'unauthenticated' }
  | { readonly kind: 'invalid' }
  | { readonly kind: 'unavailable' };

/** One credentialled internal read carrying the caller's own token. */
async function call(
  path: string,
  accessToken: string,
  options: NotificationsHandlerOptions,
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
function outcomeOf(status: number): 'unauthenticated' | 'invalid' | 'unavailable' {
  if (status === 401) return 'unauthenticated';
  if (status === 400) return 'invalid';
  return 'unavailable';
}

/**
 * Builds the query string from what the caller passed, dropping what it did not.
 *
 * `view` is checked against the two values this surface has rather than passed through: an unrecognised
 * view is a page's mistake and reading the inbox is the right recovery, whereas forwarding it would spend
 * a round trip to be told the same thing.
 */
function query(input: { view?: string | null; limit?: string | null; cursor?: string | null }): string {
  const params = new URLSearchParams();
  if (input.view === 'archived') params.set('view', 'archived');
  if (input.limit !== undefined && input.limit !== null && input.limit !== '') {
    params.set('limit', input.limit);
  }
  // Passed through verbatim. This layer does not know what a cursor contains and must not learn.
  if (input.cursor !== undefined && input.cursor !== null && input.cursor !== '') {
    params.set('cursor', input.cursor);
  }
  return params.size === 0 ? '' : `?${params.toString()}`;
}

/** One page of the caller's notifications, in the inbox or the archived view. */
export async function readNotifications(
  input: { view?: string | null; limit?: string | null; cursor?: string | null } = {},
  options: NotificationsHandlerOptions = {},
): Promise<NotificationsResult<NotificationsResponse>> {
  const accessToken = readAccessToken(options.cookieHeader ?? null);
  if (accessToken === null) return { kind: 'unauthenticated' };

  const upstream = await call(`/v1/notifications${query(input)}`, accessToken, options);
  if (upstream === null) return { kind: 'unavailable' };
  if (!upstream.ok) {
    await upstream.text().catch(() => '');
    return { kind: outcomeOf(upstream.status) };
  }

  try {
    const parsed = NotificationsResponseSchema.safeParse(JSON.parse(await upstream.text()));
    return parsed.success ? { kind: 'ok', data: parsed.data } : { kind: 'unavailable' };
  } catch {
    return { kind: 'unavailable' };
  }
}

/**
 * The caller's unread notification count.
 *
 * Read separately from the list on purpose: the badge is allowed to fail on its own. A page that made its
 * notification list depend on a counter would lose the list whenever the counter was unavailable.
 */
export async function readNotificationsUnreadCount(
  options: NotificationsHandlerOptions = {},
): Promise<NotificationsResult<number>> {
  const accessToken = readAccessToken(options.cookieHeader ?? null);
  if (accessToken === null) return { kind: 'unauthenticated' };

  const upstream = await call('/v1/notifications/unread-count', accessToken, options);
  if (upstream === null) return { kind: 'unavailable' };
  if (!upstream.ok) {
    await upstream.text().catch(() => '');
    return { kind: outcomeOf(upstream.status) };
  }

  try {
    const parsed = NotificationsUnreadCountResponseSchema.safeParse(JSON.parse(await upstream.text()));
    return parsed.success ? { kind: 'ok', data: parsed.data.unreadCount } : { kind: 'unavailable' };
  } catch {
    return { kind: 'unavailable' };
  }
}

/** The Origin/CSRF check, the session and the parsed body, or the response that refuses the request. */
async function acceptWrite(
  request: Request,
  options: NotificationsHandlerOptions,
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

/** One credentialled write call carrying the caller's own token and a body assembled here. */
async function callWrite(
  path: string,
  accessToken: string,
  body: unknown,
  options: NotificationsHandlerOptions,
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
 * A recognised refusal status is forwarded with the API's own problem body; anything else becomes the
 * generic 503, so an unexpected upstream status can never arrive as a success. Success is 200 exactly,
 * and its body is re-validated before a single byte of it reaches a browser.
 */
async function writeOutcome(upstream: Response | null): Promise<Response> {
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
  const validated = NotificationsMutationResponseSchema.safeParse(parsed);
  if (!validated.success) return UNAVAILABLE();

  return new Response(JSON.stringify(validated.data), {
    status: 200,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}

/**
 * `POST /api/notifications/read` — mark notifications read, or all of them.
 *
 * The body is rebuilt from the contract rather than forwarded: an absent `ids` means "all of them" and is
 * sent as an absent field, and anything else the page put in the body is dropped here.
 */
export async function handleMarkNotificationsRead(
  request: Request,
  options: NotificationsHandlerOptions = {},
): Promise<Response> {
  const accepted = await acceptWrite(request, options);
  if ('refusal' in accepted) return accepted.refusal;

  const validated = MarkNotificationsReadRequestSchema.safeParse(accepted.body);
  if (!validated.success) return VALIDATION_FAILED();

  const body = validated.data.ids === undefined ? {} : { ids: validated.data.ids };
  return await writeOutcome(await callWrite('/v1/notifications/read', accepted.accessToken, body, options));
}

/**
 * `POST /api/notifications/archive` — archive named notifications.
 *
 * Identifiers are required by the contract, so a request that names none is refused here without a round
 * trip. There is no form of this that empties an inbox.
 */
export async function handleArchiveNotifications(
  request: Request,
  options: NotificationsHandlerOptions = {},
): Promise<Response> {
  const accepted = await acceptWrite(request, options);
  if ('refusal' in accepted) return accepted.refusal;

  const validated = ArchiveNotificationsRequestSchema.safeParse(accepted.body);
  if (!validated.success) return VALIDATION_FAILED();

  return await writeOutcome(
    await callWrite('/v1/notifications/archive', accepted.accessToken, { ids: validated.data.ids }, options),
  );
}
