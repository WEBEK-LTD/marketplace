import 'server-only';
import {
  LISTING_SLUG_PATTERN,
  PROBLEM_JSON_MEDIA_TYPE,
  SESSION_TOKEN_HEADER,
  SaveSellerListingAttributesRequestSchema,
  SaveSellerListingTagsRequestSchema,
  SellerListingAttributesResponseSchema,
  SellerListingAttributesWriteResponseSchema,
  SellerListingTagsResponseSchema,
  type SellerListingAttribute,
  type SellerListingTagChoice,
} from '@repo/contracts';
import { readBffConfig } from './env';
import { createInternalCredentialFetch } from './internal-credential';
import { addressedOrigin, checkSameOrigin } from './origin';
import { readAccessToken } from './session-cookies';

/**
 * The BFF half of a seller's own attribute answers and tags (Phase 8-C).
 *
 * The same conventions 6-F established and this surface reuses unchanged:
 *
 *   * **The Origin check runs before the session cookie is read**, so a cross-site form post is refused
 *     without this module ever touching the caller's session.
 *   * **The token travels; the browser's `Cookie` header does not.**
 *   * **Both directions are validated against the shared contract, and what is forwarded is the validated
 *     value** — never the text a browser sent. So an attribute key this category does not ask about, an answer
 *     whose shape does not match its kind, or a field the contract does not name has no route through here.
 *   * **One exact success status per operation.**
 *   * **Nothing here logs.** An answer is seller-written prose.
 *
 * **The surface is the route's, not the request's.** Each function takes `product` or `service` from the route
 * that called it and puts it in the upstream path, so a request has no field that could claim to be the other.
 *
 * **The slug is never trusted and never used to authorize anything.** Its shape is checked so a malformed
 * address costs no upstream hop; ownership is resolved in the database from the caller's own account.
 */

const PROBLEM = {
  type: 'about:blank',
  status: 503,
  title: 'Service Unavailable',
  detail: 'The service is temporarily unavailable.',
  instance: '/sellers/me/listings',
  code: 'SERVICE_UNAVAILABLE',
} as const;

export interface SellerVocabularyHandlerOptions {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly fetch?: typeof fetch;
  /** The request's `Cookie` header, when a caller has it already. */
  readonly cookieHeader?: string | null;
}

/** Which of the seller's two surfaces a call is about. Named by the route, never by a request. */
export type SellerVocabularySurface = 'listings' | 'services';

function problemResponse(status: number, title: string, code: string, detail: string): Response {
  return new Response(JSON.stringify({ ...PROBLEM, status, title, code, detail }), {
    status,
    headers: { 'content-type': PROBLEM_JSON_MEDIA_TYPE, 'cache-control': 'no-store' },
  });
}

const unavailable = (): Response =>
  problemResponse(503, 'Service Unavailable', 'SERVICE_UNAVAILABLE', PROBLEM.detail);
const unauthenticated = (): Response =>
  problemResponse(401, 'Unauthorized', 'AUTHENTICATION_REQUIRED', 'Authentication is required.');
const forbidden = (): Response =>
  problemResponse(403, 'Forbidden', 'BAD_REQUEST', 'The request could not be processed.');
const invalid = (): Response =>
  problemResponse(400, 'Bad Request', 'VALIDATION_FAILED', 'The request is invalid.');
const notFound = (): Response =>
  problemResponse(404, 'Not Found', 'NOT_FOUND', 'The requested resource was not found.');

/** Every refusal these four operations declare. Anything else upstream is a 503 here. */
const VOCABULARY_PROBLEM_STATUSES = new Set([400, 401, 403, 404, 409, 429]);

/**
 * What a server-rendered seller surface learns about one listing's vocabulary.
 *
 * `not_found` covers a slug that names nothing and one belonging to somebody else, identically, because the
 * API deliberately does not tell them apart. `unavailable` is kept separate from both: a page that showed "no
 * questions" when a request timed out would be telling a seller their form had been emptied.
 */
export type SellerVocabularyLookup =
  | {
      readonly kind: 'ok';
      readonly attributes: readonly SellerListingAttribute[];
      readonly tags: readonly SellerListingTagChoice[];
      readonly isEditable: boolean;
    }
  | { readonly kind: 'not_found' }
  | { readonly kind: 'unauthenticated' }
  | { readonly kind: 'unavailable' };

/** A slug this layer is willing to put in a URL. Shape only; it authorizes nothing. */
function usableSlug(slug: string): string | null {
  return LISTING_SLUG_PATTERN.test(slug) ? encodeURIComponent(slug) : null;
}

/**
 * The questions one of the caller's own listings is asked, and the tags it may carry, read on the server.
 *
 * Both reads in one call because one form shows both, and a page that fetched them separately would have two
 * chances to half-render. Either failing is the whole answer failing, for the same reason.
 */
export async function readSellerListingVocabulary(
  surface: SellerVocabularySurface,
  slug: string,
  locale: 'en' | 'ar',
  options: SellerVocabularyHandlerOptions = {},
): Promise<SellerVocabularyLookup> {
  const safe = usableSlug(slug);
  if (safe === null) return { kind: 'not_found' };

  const accessToken = readAccessToken(options.cookieHeader ?? null);
  // No access cookie is no session: nothing is asked upstream, because there is nothing to ask about.
  if (accessToken === null) return { kind: 'unauthenticated' };

  const config = readBffConfig(options.env);
  const fetcher = createInternalCredentialFetch(config.internalBffCredential, options.fetch ?? fetch);
  const query = `?locale=${encodeURIComponent(locale)}`;
  const base = `${config.apiBaseUrl}/v1/sellers/me/${surface}/${safe}`;

  let attributesResponse: Response;
  let tagsResponse: Response;
  try {
    [attributesResponse, tagsResponse] = await Promise.all([
      fetcher(`${base}/attributes${query}`, {
        method: 'GET',
        headers: { [SESSION_TOKEN_HEADER]: accessToken },
      }),
      fetcher(`${base}/tags${query}`, { method: 'GET', headers: { [SESSION_TOKEN_HEADER]: accessToken } }),
    ]);
  } catch {
    return { kind: 'unavailable' };
  }

  const [attributesText, tagsText] = await Promise.all([
    attributesResponse.text().catch(() => ''),
    tagsResponse.text().catch(() => ''),
  ]);

  for (const status of [attributesResponse.status, tagsResponse.status]) {
    if (status === 401) return { kind: 'unauthenticated' };
    if (status === 404) return { kind: 'not_found' };
    if (status !== 200) return { kind: 'unavailable' };
  }

  try {
    const attributes = SellerListingAttributesResponseSchema.safeParse(JSON.parse(attributesText));
    const tags = SellerListingTagsResponseSchema.safeParse(JSON.parse(tagsText));
    if (!attributes.success || !tags.success) return { kind: 'unavailable' };
    // Rebuilt from the validated fields: a field the contract does not name has nowhere to go.
    return {
      kind: 'ok',
      attributes: attributes.data.attributes,
      tags: tags.data.tags,
      // Both answers carry it and both come from the same rule; they cannot disagree, and if they ever did,
      // the stricter answer is the safe one to render a form from.
      isEditable: attributes.data.isEditable && tags.data.isEditable,
    };
  } catch {
    return { kind: 'unavailable' };
  }
}

/** The shared body of the two writes. */
async function vocabularyWrite(
  request: Request,
  options: SellerVocabularyHandlerOptions,
  path: string,
  parseRequest: (payload: unknown) => unknown | null,
): Promise<Response> {
  // First, before anything reads a cookie.
  const origin = checkSameOrigin({
    method: request.method,
    url: addressedOrigin(request),
    headers: request.headers,
  });
  if (!origin.ok) return forbidden();

  const accessToken = readAccessToken(options.cookieHeader ?? request.headers.get('cookie'));
  if (accessToken === null) return unauthenticated();

  const raw = await request.text().catch(() => '');
  let body: unknown;
  try {
    body = JSON.parse(raw === '' ? 'null' : raw);
  } catch {
    return invalid();
  }
  const validatedRequest = parseRequest(body);
  if (validatedRequest === null) return invalid();

  const config = readBffConfig(options.env);
  const fetcher = createInternalCredentialFetch(config.internalBffCredential, options.fetch ?? fetch);

  let upstream: Response;
  try {
    upstream = await fetcher(`${config.apiBaseUrl}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', [SESSION_TOKEN_HEADER]: accessToken },
      body: JSON.stringify(validatedRequest),
    });
  } catch {
    return unavailable();
  }

  const text = await upstream.text().catch(() => '');
  if (upstream.status !== 200) {
    if (!VOCABULARY_PROBLEM_STATUSES.has(upstream.status)) return unavailable();
    // The API's own problem body, with its own status and code — including the one a screen must act on,
    // `LISTING_ATTRIBUTE_ANSWER_NOT_ALLOWED`, which no generic failure could stand in for.
    return new Response(text, {
      status: upstream.status,
      headers: { 'content-type': PROBLEM_JSON_MEDIA_TYPE, 'cache-control': 'no-store' },
    });
  }

  let validated: ReturnType<typeof SellerListingAttributesWriteResponseSchema.safeParse>;
  try {
    validated = SellerListingAttributesWriteResponseSchema.safeParse(JSON.parse(text));
  } catch {
    return unavailable();
  }
  if (!validated.success) return unavailable();

  return new Response(JSON.stringify(validated.data), {
    status: 200,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}

/** `POST /api/sellers/me/{listings,services}/:slug/attributes` — replace every answer. */
export async function handleSellerVocabularyAttributesSave(
  request: Request,
  surface: SellerVocabularySurface,
  slug: string,
  options: SellerVocabularyHandlerOptions = {},
): Promise<Response> {
  const safe = usableSlug(slug);
  if (safe === null) return notFound();
  return vocabularyWrite(
    request,
    options,
    `/v1/sellers/me/${surface}/${safe}/attributes`,
    (payload) => {
      const parsed = SaveSellerListingAttributesRequestSchema.safeParse(payload);
      return parsed.success ? parsed.data : null;
    },
  );
}

/** `POST /api/sellers/me/{listings,services}/:slug/tags` — replace the whole selection. */
export async function handleSellerVocabularyTagsSave(
  request: Request,
  surface: SellerVocabularySurface,
  slug: string,
  options: SellerVocabularyHandlerOptions = {},
): Promise<Response> {
  const safe = usableSlug(slug);
  if (safe === null) return notFound();
  return vocabularyWrite(request, options, `/v1/sellers/me/${surface}/${safe}/tags`, (payload) => {
    const parsed = SaveSellerListingTagsRequestSchema.safeParse(payload);
    return parsed.success ? parsed.data : null;
  });
}
