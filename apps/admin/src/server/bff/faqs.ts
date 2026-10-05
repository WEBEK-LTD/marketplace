import 'server-only';
import {
  CreateFaqRequestSchema,
  CreateFaqResponseSchema,
  FaqDetailResponseSchema,
  FaqPageResponseSchema,
  FaqStateRequestSchema,
  FaqTopicSchema,
  FaqTopicsResponseSchema,
  FaqWriteResponseSchema,
  PROBLEM_JSON_MEDIA_TYPE,
  ReorderFaqsRequestSchema,
  SESSION_TOKEN_HEADER,
  UpdateFaqRequestSchema,
  type FaqDetail,
  type FaqPageResponse,
  type FaqTopicsResponse,
} from '@repo/contracts';
import { addressedOrigin, checkSameOrigin } from './origin';
import { readBffConfig } from './env';
import { createInternalCredentialFetch } from './internal-credential';
import { readAdminAccessToken } from './staff-session';

/**
 * The help centre, on the admin origin (0095).
 *
 * **The session never leaves the server.** The caller's access token lives in `__Host-mp_admin_access`, which
 * JavaScript cannot read; it is presented to the API on one internal hop in the session-token header, and the
 * browser's own `Cookie` header is never forwarded.
 *
 * **Responses are validated, not forwarded.** A drifted body becomes a clean failure here instead of a
 * half-rendered screen.
 *
 * **Every write is same-origin and rebuilt** from the contract's own fields, so a field nobody declared cannot ride
 * along — `isPublished` above all: publishing has its own handler, so editing an answer cannot put it on a public
 * page (owner decision 6).
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

export interface FaqOptions {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly fetch?: typeof fetch;
  /** The request's `Cookie` header. Server components pass the value they already hold. */
  readonly cookieHeader?: string | null;
}

/** What a read resolved to. `notFound` is the API's one neutral answer. */
export type FaqResult<T> =
  | { readonly kind: 'ok'; readonly data: T }
  | { readonly kind: 'unauthenticated' }
  | { readonly kind: 'notFound' }
  | { readonly kind: 'invalid' }
  | { readonly kind: 'unavailable' };

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function identifier(value: unknown): string | null {
  return typeof value === 'string' && UUID_PATTERN.test(value) ? value.toLowerCase() : null;
}

async function read<T>(
  path: string,
  options: FaqOptions,
  parse: (body: unknown) => { success: true; data: T } | { success: false },
): Promise<FaqResult<T>> {
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

/** Every topic in use, mapped ones first. */
export async function readFaqTopics(options: FaqOptions = {}): Promise<FaqResult<FaqTopicsResponse>> {
  return await read('/v1/admin/faqs/topics', options, (body) => FaqTopicsResponseSchema.safeParse(body));
}

/**
 * One page of entries, optionally narrowed to one topic.
 *
 * A topic or a cursor that could not be one is dropped rather than forwarded: both come from a query string
 * somebody may have typed, and the remedy for either is the same first page.
 */
export async function readFaqs(
  input: { topic?: string | null; cursor?: string | null } = {},
  options: FaqOptions = {},
): Promise<FaqResult<FaqPageResponse>> {
  const query = new URLSearchParams();
  const topic = FaqTopicSchema.safeParse(input.topic ?? undefined);
  if (topic.success) query.set('topic', topic.data);
  if (typeof input.cursor === 'string' && /^[A-Za-z0-9_-]+$/.test(input.cursor)) {
    query.set('cursor', input.cursor);
  }

  const suffix = query.toString() === '' ? '' : `?${query.toString()}`;
  return await read(`/v1/admin/faqs${suffix}`, options, (body) => FaqPageResponseSchema.safeParse(body));
}

/**
 * One entry.
 *
 * A malformed id is `notFound` rather than a validation failure: the value came from the address somebody typed.
 */
export async function readFaq(
  faqId: string | undefined,
  options: FaqOptions = {},
): Promise<FaqResult<FaqDetail>> {
  const id = identifier(faqId);
  if (id === null) return { kind: 'notFound' };
  const result = await read(`/v1/admin/faqs/${encodeURIComponent(id)}`, options, (body) =>
    FaqDetailResponseSchema.safeParse(body),
  );
  return result.kind === 'ok' ? { kind: 'ok', data: result.data.faq } : result;
}

/* ------------------------------------------------------------------------------------------------ */
/* Writes                                                                                           */
/* ------------------------------------------------------------------------------------------------ */

async function acceptWrite(
  request: Request,
  options: FaqOptions,
): Promise<{ refusal: Response } | { accessToken: string; body: Record<string, unknown> }> {
  const origin = checkSameOrigin({
    method: request.method,
    url: addressedOrigin(request),
    headers: request.headers,
  });
  if (!origin.ok) {
    return { refusal: problemResponse(403, 'Forbidden', 'BAD_REQUEST', 'The request could not be processed.') };
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
  method: 'POST' | 'PATCH' | 'PUT' | 'DELETE',
  path: string,
  accessToken: string,
  body: unknown,
  options: FaqOptions,
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

/** `POST /api/faqs` — create an unpublished entry. */
export async function handleFaqCreate(request: Request, options: FaqOptions = {}): Promise<Response> {
  const accepted = await acceptWrite(request, options);
  if ('refusal' in accepted) return accepted.refusal;

  const validated = CreateFaqRequestSchema.safeParse({
    topic: accepted.body['topic'],
    questionEn: accepted.body['questionEn'],
    ...('questionAr' in accepted.body ? { questionAr: accepted.body['questionAr'] } : {}),
    answerEn: accepted.body['answerEn'],
    ...('answerAr' in accepted.body ? { answerAr: accepted.body['answerAr'] } : {}),
    ...('sortOrder' in accepted.body ? { sortOrder: accepted.body['sortOrder'] } : {}),
  });
  if (!validated.success) return VALIDATION_FAILED();

  const upstream = await callWrite('POST', '/v1/admin/faqs', accepted.accessToken, validated.data, options);
  return await writeOutcome(upstream, 201, (body) => CreateFaqResponseSchema.safeParse(body));
}

/**
 * `PATCH /api/faqs` — change a topic, a wording or a position.
 *
 * **Absence is preserved exactly**: a field the browser did not send is not rebuilt, because for an Arabic wording
 * absent means "leave it" and null means "clear it". `isPublished` is not among the fields forwarded, so editing an
 * entry can never publish it however the body is shaped.
 */
export async function handleFaqUpdate(request: Request, options: FaqOptions = {}): Promise<Response> {
  const accepted = await acceptWrite(request, options);
  if ('refusal' in accepted) return accepted.refusal;

  const faqId = identifier(accepted.body['faqId']);
  if (faqId === null) return VALIDATION_FAILED();

  const validated = UpdateFaqRequestSchema.safeParse({
    ...('topic' in accepted.body ? { topic: accepted.body['topic'] } : {}),
    ...('questionEn' in accepted.body ? { questionEn: accepted.body['questionEn'] } : {}),
    ...('questionAr' in accepted.body ? { questionAr: accepted.body['questionAr'] } : {}),
    ...('answerEn' in accepted.body ? { answerEn: accepted.body['answerEn'] } : {}),
    ...('answerAr' in accepted.body ? { answerAr: accepted.body['answerAr'] } : {}),
    ...('sortOrder' in accepted.body ? { sortOrder: accepted.body['sortOrder'] } : {}),
  });
  if (!validated.success) return VALIDATION_FAILED();

  const upstream = await callWrite(
    'PATCH',
    `/v1/admin/faqs/${encodeURIComponent(faqId)}`,
    accepted.accessToken,
    validated.data,
    options,
  );
  return await writeOutcome(upstream, 200, (body) => FaqWriteResponseSchema.safeParse(body));
}

/** `POST /api/faqs/state` — publish or unpublish one entry. The only route that can. */
export async function handleFaqState(request: Request, options: FaqOptions = {}): Promise<Response> {
  const accepted = await acceptWrite(request, options);
  if ('refusal' in accepted) return accepted.refusal;

  const faqId = identifier(accepted.body['faqId']);
  if (faqId === null) return VALIDATION_FAILED();

  const validated = FaqStateRequestSchema.safeParse({ isPublished: accepted.body['isPublished'] });
  if (!validated.success) return VALIDATION_FAILED();

  const upstream = await callWrite(
    'PUT',
    `/v1/admin/faqs/${encodeURIComponent(faqId)}/state`,
    accepted.accessToken,
    validated.data,
    options,
  );
  return await writeOutcome(upstream, 200, (body) => FaqWriteResponseSchema.safeParse(body));
}

/** `POST /api/faqs/reorder` — set the order of one topic, whole. */
export async function handleFaqsReorder(request: Request, options: FaqOptions = {}): Promise<Response> {
  const accepted = await acceptWrite(request, options);
  if ('refusal' in accepted) return accepted.refusal;

  const validated = ReorderFaqsRequestSchema.safeParse({
    topic: accepted.body['topic'],
    faqIds: accepted.body['faqIds'],
  });
  if (!validated.success) return VALIDATION_FAILED();

  const upstream = await callWrite(
    'PUT',
    '/v1/admin/faqs/reorder',
    accepted.accessToken,
    validated.data,
    options,
  );
  return await writeOutcome(upstream, 200, (body) => FaqWriteResponseSchema.safeParse(body));
}

/**
 * `POST /api/faqs/remove` — remove one entry.
 *
 * A `POST` on this origin and a `DELETE` upstream, for the reason the other remove routes give: the same-origin
 * check reads a submitted body and a browser form submits one.
 */
export async function handleFaqRemove(request: Request, options: FaqOptions = {}): Promise<Response> {
  const accepted = await acceptWrite(request, options);
  if ('refusal' in accepted) return accepted.refusal;

  const faqId = identifier(accepted.body['faqId']);
  if (faqId === null) return VALIDATION_FAILED();

  const upstream = await callWrite(
    'DELETE',
    `/v1/admin/faqs/${encodeURIComponent(faqId)}`,
    accepted.accessToken,
    undefined,
    options,
  );
  return await writeOutcome(upstream, 200, (body) => FaqWriteResponseSchema.safeParse(body));
}
