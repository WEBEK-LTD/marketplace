import 'server-only';
import {
  DisputeDetailResponseSchema,
  DisputeMessagesResponseSchema,
  DisputeQueueResponseSchema,
  PROBLEM_JSON_MEDIA_TYPE,
  PostDisputeMessageRequestSchema,
  PostDisputeMessageResponseSchema,
  ResolveDisputeRequestSchema,
  ResolveDisputeResponseSchema,
  SELECTABLE_DISPUTE_STATUSES,
  SESSION_TOKEN_HEADER,
  type DisputeDetail,
  type DisputeMessagesResponse,
  type DisputeQueueResponse,
} from '@repo/contracts';
import { readBffConfig } from './env';
import { createInternalCredentialFetch } from './internal-credential';
import { addressedOrigin, checkSameOrigin } from './origin';
import { readAdminAccessToken } from './staff-session';

/**
 * Dispute management, on the admin origin (Phase 7-R).
 *
 * What matters at this boundary:
 *
 *   * the caller's token comes from `__Host-mp_admin_access` and never from a body, and the browser's own
 *     `Cookie` header is never forwarded upstream;
 *   * **bodies are rebuilt, never forwarded** — a `resolvedBy`, a `resolvedAt`, an `orderStatus`, a
 *     `refundId`, a `paymentId` or anything naming a ledger never crosses;
 *   * a dispute is named by its id in the **route**, from a value checked for shape here;
 *   * responses are validated against the contract before a byte reaches a browser, so a drifted API that sent
 *     the buyer's account, the seller's account or the colleague who ruled would produce a clean failure
 *     rather than a leak;
 *   * **amounts are passed through as strings and never parsed** — not on the way in, not on the way out. A
 *     `Number()` at this layer would silently round a large decision;
 *   * the refusals a screen must act on are forwarded with the API's own problem body, and anything else
 *     becomes one 503.
 *
 * ---------------------------------------------------------------------------------------------------
 * **NEITHER WRITE IN THIS MODULE MOVES MONEY, AND THERE IS NO THIRD WRITE.**
 *
 * `handleDisputeMessage` adds a message. `handleDisputeResolution` records a decision. There is no refund
 * handler, no reversal handler, no payout handler and no route for one — a request arriving at this origin
 * asking to pay a refund has nothing here to reach, and no writer upstream to call if it did.
 * ---------------------------------------------------------------------------------------------------
 *
 * **Nothing here logs.** A dispute is two people's account of what went wrong with an order, and an internal
 * note is what a colleague said about them; the way to keep either out of a log is to have no log line that
 * could take one.
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
  problemResponse(
    503,
    'Service Unavailable',
    'SERVICE_UNAVAILABLE',
    'The service is temporarily unavailable.',
  );
const SESSION_REQUIRED = (): Response =>
  problemResponse(401, 'Unauthorized', 'AUTHENTICATION_REQUIRED', 'Authentication is required.');
const VALIDATION_FAILED = (): Response =>
  problemResponse(400, 'Bad Request', 'VALIDATION_FAILED', 'The request is invalid.');

/** The statuses the API may refuse a write with. Anything else becomes the generic outage. */
const WRITE_PROBLEM_STATUSES = new Set([400, 401, 403, 404, 409, 429, 503]);

export interface DisputeManagementOptions {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly fetch?: typeof fetch;
  /** The request's `Cookie` header. Server components pass the value they already hold. */
  readonly cookieHeader?: string | null;
}

/**
 * What a read resolved to.
 *
 * `notFound` is the API's one neutral answer: no such dispute, or a caller without the key. The console does
 * not try to tell those apart, because the API deliberately does not — and on a key a Moderator is
 * deliberately not granted, a distinguishable refusal would tell them this section has something in it.
 */
export type DisputeManagementResult<T> =
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
 * Builds a query string from what the caller passed, dropping what it did not.
 *
 * The status filter is checked against the two states a writer can produce. An unreachable one is dropped here
 * rather than forwarded, so a stale bookmark shows the whole queue; the API refuses it outright, which is the
 * stricter answer for a request that got past this layer another way.
 */
function query(input: {
  readonly cursor?: string | null;
  readonly limit?: string | null;
  readonly status?: string | null;
}): string {
  const params = new URLSearchParams();
  if (typeof input.limit === 'string' && /^\d{1,3}$/.test(input.limit)) params.set('limit', input.limit);
  if (
    typeof input.status === 'string' &&
    (SELECTABLE_DISPUTE_STATUSES as readonly string[]).includes(input.status)
  ) {
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
  options: DisputeManagementOptions,
  parse: (body: unknown) => { success: true; data: T } | { success: false },
): Promise<DisputeManagementResult<T>> {
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
/* The three reads                                                                                   */
/* ------------------------------------------------------------------------------------------------ */

/** One page of the queue, oldest first. */
export async function readDisputes(
  input: {
    readonly cursor?: string | null;
    readonly limit?: string | null;
    readonly status?: string | null;
  } = {},
  options: DisputeManagementOptions = {},
): Promise<DisputeManagementResult<DisputeQueueResponse>> {
  return await read(`/v1/admin/disputes${query(input)}`, options, (body) =>
    DisputeQueueResponseSchema.safeParse(body),
  );
}

/**
 * One dispute.
 *
 * A malformed id is `notFound` here rather than a validation failure: the value came from the address somebody
 * typed, and the honest answer to a made-up address is that there is nothing at it.
 */
export async function readDispute(
  disputeId: string | undefined,
  options: DisputeManagementOptions = {},
): Promise<DisputeManagementResult<DisputeDetail>> {
  const id = identifier(disputeId ?? null);
  if (id === null) return { kind: 'notFound' };
  const result = await read(`/v1/admin/disputes/${encodeURIComponent(id)}`, options, (body) =>
    DisputeDetailResponseSchema.safeParse(body),
  );
  return result.kind === 'ok' ? { kind: 'ok', data: result.data.dispute } : result;
}

/** The thread on one dispute, including the internal staff notes. */
export async function readDisputeMessages(
  disputeId: string | undefined,
  options: DisputeManagementOptions = {},
): Promise<DisputeManagementResult<DisputeMessagesResponse>> {
  const id = identifier(disputeId ?? null);
  if (id === null) return { kind: 'notFound' };
  return await read(`/v1/admin/disputes/${encodeURIComponent(id)}/messages`, options, (body) =>
    DisputeMessagesResponseSchema.safeParse(body),
  );
}

/* ------------------------------------------------------------------------------------------------ */
/* The two non-financial writes                                                                      */
/* ------------------------------------------------------------------------------------------------ */

async function acceptWrite(
  request: Request,
  options: DisputeManagementOptions,
): Promise<{ refusal: Response } | { accessToken: string; body: Record<string, unknown> }> {
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
  options: DisputeManagementOptions,
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
 * A recognised refusal is forwarded with the API's own problem body, so a screen can say "a colleague who is
 * not a party has to take this one" rather than a generic failure. Anything else becomes the generic 503, and
 * success is the expected status exactly, re-validated before a byte of it reaches a browser.
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
 * `POST /api/disputes/messages` — add a staff message or an internal note.
 *
 * The body is rebuilt from the contract's two fields. An author, a role, a timestamp or anything naming the
 * order is dropped here and would be refused upstream as well; the writer fixes the author from the caller's
 * own session and works their role out of the dispute.
 */
export async function handleDisputeMessage(
  request: Request,
  options: DisputeManagementOptions = {},
): Promise<Response> {
  const accepted = await acceptWrite(request, options);
  if ('refusal' in accepted) return accepted.refusal;

  const id = identifier(
    typeof accepted.body['disputeId'] === 'string' ? accepted.body['disputeId'] : null,
  );
  if (id === null) return VALIDATION_FAILED();

  const body = accepted.body['body'];
  const validated = PostDisputeMessageRequestSchema.safeParse({
    body: typeof body === 'string' ? body.trim() : body,
    isInternal: accepted.body['isInternal'] === true,
  });
  if (!validated.success) return VALIDATION_FAILED();

  const upstream = await callWrite(
    `/v1/admin/disputes/${encodeURIComponent(id)}/messages`,
    accepted.accessToken,
    validated.data,
    options,
  );
  return await writeOutcome(upstream, 200, (body_) =>
    PostDisputeMessageResponseSchema.safeParse(body_),
  );
}

/**
 * `POST /api/disputes/resolution` — record a decision on one dispute.
 *
 * ---------------------------------------------------------------------------------------------------
 * **THIS RECORDS A DECISION AND MOVES NO MONEY.**
 *
 * A `refund_buyer` or `partial_refund` decision creates no refund, reverses no payment and touches no ledger,
 * balance, payout or provider. Issuing the refund is a separate, later operation that does not exist yet.
 * ---------------------------------------------------------------------------------------------------
 *
 * The body is rebuilt from the contract's three fields. A `resolvedBy`, a `resolvedAt`, a `status`, an
 * `orderStatus`, a `refundId` or a `paymentId` is dropped here and refused upstream.
 *
 * **The amount is passed through as the string it arrived as.** It is never parsed: a `Number()` here would
 * round a large decision, and the whole point of the string is that it cannot.
 */
export async function handleDisputeResolution(
  request: Request,
  options: DisputeManagementOptions = {},
): Promise<Response> {
  const accepted = await acceptWrite(request, options);
  if ('refusal' in accepted) return accepted.refusal;

  const id = identifier(
    typeof accepted.body['disputeId'] === 'string' ? accepted.body['disputeId'] : null,
  );
  if (id === null) return VALIDATION_FAILED();

  const note = accepted.body['resolutionNote'];
  const amount = accepted.body['resolutionAmountMinor'];

  /*
   * The amount is the one field this layer must not drop silently.
   *
   * Every other field the contract does not name is dropped, which is the right behaviour for a stray
   * `resolvedBy` or `refundId`: the request meant nothing by it. An amount is different. Dropping an
   * unusable one would record the decision **without** the amount a colleague typed, and a money field
   * that quietly goes missing is exactly the kind of difference nobody notices until it matters.
   *
   * So: absent or an empty string means no amount — a form's untouched field submits `""`, and that is not
   * a request for an amount of zero. Anything else present, including a JSON number, is refused.
   */
  let amountField: { resolutionAmountMinor?: string } = {};
  if (amount !== undefined && amount !== null) {
    if (typeof amount !== 'string') return VALIDATION_FAILED();
    const trimmed = amount.trim();
    if (trimmed !== '') amountField = { resolutionAmountMinor: trimmed };
  }

  const validated = ResolveDisputeRequestSchema.safeParse({
    resolution: accepted.body['resolution'],
    resolutionNote: typeof note === 'string' ? note.trim() : note,
    ...amountField,
  });
  if (!validated.success) return VALIDATION_FAILED();

  const upstream = await callWrite(
    `/v1/admin/disputes/${encodeURIComponent(id)}/resolution`,
    accepted.accessToken,
    validated.data,
    options,
  );
  return await writeOutcome(upstream, 200, (body_) => ResolveDisputeResponseSchema.safeParse(body_));
}
