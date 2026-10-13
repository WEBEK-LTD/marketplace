import 'server-only';
import {
  ListingMediaAttachRequestSchema,
  ListingMediaAttachResponseSchema,
  ListingMediaListResponseSchema,
  ListingMediaUploadRequestSchema,
  ListingMediaUploadResponseSchema,
  ListingSlugSchema,
  PROBLEM_JSON_MEDIA_TYPE,
  SESSION_TOKEN_HEADER,
  type ListingMediaItem,
} from '@repo/contracts';
import { readBffConfig } from './env';
import { createInternalCredentialFetch } from './internal-credential';
import { addressedOrigin, checkSameOrigin } from './origin';
import { readAccessToken } from './session-cookies';

/**
 * The BFF half of a listing's photographs (increment 0116).
 *
 * **One hop, the same five properties 6-E's media handlers established.** Same-origin checked before
 * anything reads a cookie — the project's CSRF rule, which passes a read and holds the four writes; the
 * session read from the `__Host-` cookie and sent on as `x-session-token`
 * alongside the internal credential; the browser's own `Cookie` never forwarded; the body parsed with the
 * strict contract and the *validated* value forwarded; the response parsed and rebuilt; one exact success
 * status per operation.
 *
 * **The signed URLs pass through and are kept nowhere.** The authorization's response carries four
 * short-lived credentials, one per object. Nothing here logs, nothing caches — every response is `no-store` —
 * and nothing inspects them beyond the contract check.
 *
 * **The bytes never come through this origin.** The browser PUTs each object straight to the storage provider
 * with the URL it was given. That is the point of the signed-upload design: a 25 MiB original does not travel
 * through a serverless function, and this origin is never a file proxy.
 *
 * **404 is a declared refusal, not a failure.** A listing the caller may not manage and a listing that does
 * not exist both answer 404, and neither becomes a 503 — that distinction is the whole reason the upstream
 * gives one answer for both.
 */

const PROBLEM = {
  type: 'about:blank',
  status: 503,
  title: 'Service Unavailable',
  detail: 'The service is temporarily unavailable.',
  instance: '/listings',
  code: 'SERVICE_UNAVAILABLE',
} as const;

function problemResponse(status: number, title: string, code: string, detail: string): Response {
  return new Response(JSON.stringify({ ...PROBLEM, status, title, code, detail }), {
    status,
    headers: { 'content-type': PROBLEM_JSON_MEDIA_TYPE, 'cache-control': 'no-store' },
  });
}

/** The statuses the upstream declares for these routes. Anything else is an outage, not an answer. */
const MEDIA_PROBLEM_STATUSES = new Set([400, 401, 403, 404, 409, 422, 429]);

export interface ListingMediaHandlerOptions {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly fetch?: typeof fetch;
  readonly cookieHeader?: string | null;
}

/**
 * The one hop, for all five operations.
 *
 * `parseRequest` is null for the two that have no body. `parseResponse` rebuilds from the validated fields,
 * so a field the contract does not name has nowhere to go even if the API somehow sent one.
 */
async function hop(input: {
  request: Request;
  options: ListingMediaHandlerOptions;
  slug: string;
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  path: (slug: string) => string;
  expected: 200 | 201;
  parseRequest?: (payload: unknown) => unknown | null;
  parseResponse: (payload: unknown) => unknown | null;
}): Promise<Response> {
  // First, before anything reads a cookie. `checkSameOrigin` is this project's CSRF rule and it passes a
  // GET by design: a cross-site page can cause a read but cannot see its answer, because no response here
  // carries a CORS header. What it stops is the writes, which is where a forged request would do damage.
  const origin = checkSameOrigin({
    method: input.request.method,
    url: addressedOrigin(input.request),
    headers: input.request.headers,
  });
  if (!origin.ok) {
    return problemResponse(403, 'Forbidden', 'BAD_REQUEST', 'The request could not be processed.');
  }

  // The slug, checked here as well as upstream. A slug that is not a slug has no listing behind it, so
  // there is nothing to ask about.
  const slug = ListingSlugSchema.safeParse(input.slug);
  if (!slug.success) {
    return problemResponse(404, 'Not Found', 'NOT_FOUND', 'The requested resource was not found.');
  }

  const accessToken = readAccessToken(input.options.cookieHeader ?? input.request.headers.get('cookie'));
  if (accessToken === null) {
    return problemResponse(401, 'Unauthorized', 'AUTHENTICATION_REQUIRED', 'Authentication is required.');
  }

  let validatedRequest: unknown;
  if (input.parseRequest !== undefined) {
    const raw = await input.request.text().catch(() => '');
    let body: unknown;
    try {
      body = JSON.parse(raw === '' ? 'null' : raw);
    } catch {
      return problemResponse(400, 'Bad Request', 'VALIDATION_FAILED', 'The request is invalid.');
    }
    validatedRequest = input.parseRequest(body);
    if (validatedRequest === null) {
      return problemResponse(400, 'Bad Request', 'VALIDATION_FAILED', 'The request is invalid.');
    }
  }

  const config = readBffConfig(input.options.env);
  const fetcher = createInternalCredentialFetch(config.internalBffCredential, input.options.fetch ?? fetch);

  let upstream: Response;
  try {
    upstream = await fetcher(`${config.apiBaseUrl}${input.path(slug.data)}`, {
      method: input.method,
      headers: {
        [SESSION_TOKEN_HEADER]: accessToken,
        ...(input.parseRequest === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(input.parseRequest === undefined ? {} : { body: JSON.stringify(validatedRequest) }),
    });
  } catch {
    return problemResponse(503, 'Service Unavailable', 'SERVICE_UNAVAILABLE', PROBLEM.detail);
  }

  const text = await upstream.text().catch(() => '');
  if (upstream.status !== input.expected) {
    if (!MEDIA_PROBLEM_STATUSES.has(upstream.status)) {
      return problemResponse(503, 'Service Unavailable', 'SERVICE_UNAVAILABLE', PROBLEM.detail);
    }
    return new Response(text, {
      status: upstream.status,
      headers: { 'content-type': PROBLEM_JSON_MEDIA_TYPE, 'cache-control': 'no-store' },
    });
  }

  let validated: unknown;
  try {
    validated = input.parseResponse(JSON.parse(text));
  } catch {
    return problemResponse(503, 'Service Unavailable', 'SERVICE_UNAVAILABLE', PROBLEM.detail);
  }
  if (validated === null) {
    return problemResponse(503, 'Service Unavailable', 'SERVICE_UNAVAILABLE', PROBLEM.detail);
  }

  return new Response(JSON.stringify(validated), {
    status: input.expected,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}

/** A photograph identifier shaped like one, checked before it reaches a path. */
function mediaId(value: string): string | null {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value) ? value : null;
}

const listResponse = (payload: unknown): unknown | null => {
  const parsed = ListingMediaListResponseSchema.safeParse(payload);
  return parsed.success ? { items: parsed.data.items } : null;
};

/** `GET /api/listings/:slug/media` — the photographs, as whoever manages them sees them. */
export async function handleListingMediaList(
  request: Request,
  slug: string,
  options: ListingMediaHandlerOptions = {},
): Promise<Response> {
  return hop({
    request,
    options,
    slug,
    method: 'GET',
    path: (value) => `/v1/listings/${encodeURIComponent(value)}/media`,
    expected: 200,
    parseResponse: listResponse,
  });
}

/** `POST /api/listings/:slug/media/uploads` — authorize the four objects of one photograph. */
export async function handleListingMediaUpload(
  request: Request,
  slug: string,
  options: ListingMediaHandlerOptions = {},
): Promise<Response> {
  return hop({
    request,
    options,
    slug,
    method: 'POST',
    path: (value) => `/v1/listings/${encodeURIComponent(value)}/media/uploads`,
    expected: 201,
    parseRequest: (payload) => {
      const parsed = ListingMediaUploadRequestSchema.safeParse(payload);
      return parsed.success ? parsed.data : null;
    },
    parseResponse: (payload) => {
      const parsed = ListingMediaUploadResponseSchema.safeParse(payload);
      // The four upload URLs reach the browser exactly as the API issued them, and nothing else does.
      return parsed.success ? { targets: parsed.data.targets } : null;
    },
  });
}

/** `POST /api/listings/:slug/media` — confirm the four uploads as one photograph. */
export async function handleListingMediaAttach(
  request: Request,
  slug: string,
  options: ListingMediaHandlerOptions = {},
): Promise<Response> {
  return hop({
    request,
    options,
    slug,
    method: 'POST',
    path: (value) => `/v1/listings/${encodeURIComponent(value)}/media`,
    expected: 200,
    parseRequest: (payload) => {
      const parsed = ListingMediaAttachRequestSchema.safeParse(payload);
      return parsed.success ? parsed.data : null;
    },
    parseResponse: (payload) => {
      const parsed = ListingMediaAttachResponseSchema.safeParse(payload);
      return parsed.success ? { attachedId: parsed.data.attachedId, items: parsed.data.items } : null;
    },
  });
}

/** `PUT /api/listings/:slug/media/:mediaId/primary` — make this one the photograph the card shows. */
export async function handleListingMediaPrimary(
  request: Request,
  slug: string,
  rawMediaId: string,
  options: ListingMediaHandlerOptions = {},
): Promise<Response> {
  const id = mediaId(rawMediaId);
  if (id === null) {
    return problemResponse(404, 'Not Found', 'NOT_FOUND', 'The requested resource was not found.');
  }
  return hop({
    request,
    options,
    slug,
    method: 'PUT',
    path: (value) => `/v1/listings/${encodeURIComponent(value)}/media/${id}/primary`,
    expected: 200,
    parseResponse: listResponse,
  });
}

/** `DELETE /api/listings/:slug/media/:mediaId` — withdraw one photograph. */
export async function handleListingMediaWithdraw(
  request: Request,
  slug: string,
  rawMediaId: string,
  options: ListingMediaHandlerOptions = {},
): Promise<Response> {
  const id = mediaId(rawMediaId);
  if (id === null) {
    return problemResponse(404, 'Not Found', 'NOT_FOUND', 'The requested resource was not found.');
  }
  return hop({
    request,
    options,
    slug,
    method: 'DELETE',
    path: (value) => `/v1/listings/${encodeURIComponent(value)}/media/${id}`,
    expected: 200,
    parseResponse: listResponse,
  });
}

/* ------------------------------------------------------------------------------------------------ */

/** What a server-side read of a listing's photographs resolved to. */
export type ListingMediaLookup =
  | { readonly kind: 'ok'; readonly items: readonly ListingMediaItem[] }
  | { readonly kind: 'unauthenticated' }
  | { readonly kind: 'not_found' }
  | { readonly kind: 'unavailable' };

/**
 * The photographs, read on the server for the screen that manages them.
 *
 * A reader rather than a route handler, because this is a page's own data: the screen renders the list it
 * already has and the client component takes over from there. The three refusals are kept apart for the
 * reason every other reader keeps them apart — "not yours or not there", "no session" and "we could not ask"
 * are three different sentences on a screen.
 */
export async function readListingMedia(
  slug: string,
  options: ListingMediaHandlerOptions = {},
): Promise<ListingMediaLookup> {
  const safe = ListingSlugSchema.safeParse(slug);
  if (!safe.success) return { kind: 'not_found' };

  const accessToken = readAccessToken(options.cookieHeader ?? null);
  // No access cookie is no session: nothing is asked upstream, because there is nothing to ask about.
  if (accessToken === null) return { kind: 'unauthenticated' };

  const config = readBffConfig(options.env);
  const fetcher = createInternalCredentialFetch(config.internalBffCredential, options.fetch ?? fetch);

  let response: Response;
  try {
    response = await fetcher(
      `${config.apiBaseUrl}/v1/listings/${encodeURIComponent(safe.data)}/media`,
      { method: 'GET', headers: { [SESSION_TOKEN_HEADER]: accessToken } },
    );
  } catch {
    return { kind: 'unavailable' };
  }

  const text = await response.text().catch(() => '');
  if (response.status === 401) return { kind: 'unauthenticated' };
  if (response.status === 404) return { kind: 'not_found' };
  if (response.status !== 200) return { kind: 'unavailable' };

  try {
    const parsed = ListingMediaListResponseSchema.safeParse(JSON.parse(text));
    return parsed.success ? { kind: 'ok', items: parsed.data.items } : { kind: 'unavailable' };
  } catch {
    return { kind: 'unavailable' };
  }
}
