import 'server-only';
import {
  PROBLEM_JSON_MEDIA_TYPE,
  SESSION_TOKEN_HEADER,
  SellerVerificationDocumentCountResponseSchema,
  SellerVerificationDocumentRequestSchema,
  SellerVerificationResponseSchema,
  SellerVerificationStateResponseSchema,
  SellerVerificationUploadRequestSchema,
  SellerVerificationUploadResponseSchema,
  type SellerVerification,
} from '@repo/contracts';
import { readBffConfig } from './env';
import { createInternalCredentialFetch } from './internal-credential';
import { addressedOrigin, checkSameOrigin } from './origin';
import { readAccessToken } from './session-cookies';

/**
 * The BFF half of the seller's own verification submission (Phase 6-I).
 *
 * The same write conventions 5-E established and 6-C, 6-D, 6-E, 6-F and 6-G reuse, and for the same reasons:
 * the Origin check before the session cookie is read; the token upstream in `x-session-token` beside the
 * internal credential and the browser's own `Cookie` never forwarded; both directions validated against the
 * shared contract with the *validated* value forwarded; one exact success status per operation; nothing
 * logged.
 *
 * **Nothing here decides a verification.** There is no handler that approves, rejects or sets a status, and
 * the two bodyless writes send no body upstream at all, so nothing a browser could put in one would arrive.
 *
 * **A signed upload URL is a short-lived credential**, so the authorization handler's response — like 6-E's —
 * is `no-store` and is never logged, cached or kept. The object path travels with it because the client must
 * send it straight back; it appears in no other response on this origin.
 *
 * **The document id is never trusted and never used to authorize anything.** Its shape is checked so an
 * obviously malformed id costs no upstream hop, and it is percent-encoded into the internal URL. Ownership,
 * and whether the document is still removable at all, is resolved in the database from the caller's own
 * account, and every refusal comes back as the same 404.
 */

const PROBLEM = {
  type: 'about:blank',
  status: 503,
  title: 'Service Unavailable',
  detail: 'The service is temporarily unavailable.',
  instance: '/sellers/me/verification',
  code: 'SERVICE_UNAVAILABLE',
} as const;

export interface SellerVerificationHandlerOptions {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly fetch?: typeof fetch;
  /** The request's `Cookie` header, when a caller has it already. */
  readonly cookieHeader?: string | null;
}

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

/** Every refusal the six verification operations declare. Anything else upstream is a 503 here. */
const VERIFICATION_PROBLEM_STATUSES = new Set([400, 401, 403, 404, 409, 429]);

/** A document id this layer is willing to put in a URL. Shape only; it authorizes nothing. */
const DOCUMENT_ID_PATTERN =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/**
 * What a server-rendered verification surface learns.
 *
 * The same outcomes 6-B's identity reader and 6-F's listings reader use, plus `none` — which is not an error
 * and must never be rendered as one: a storefront that has not applied yet is the ordinary starting state,
 * and `unavailable` must never read as "you have never applied", which would be a page telling somebody their
 * application had vanished because a request timed out.
 */
export type SellerVerificationLookup =
  | { readonly kind: 'ok'; readonly verification: SellerVerification }
  | { readonly kind: 'none' }
  | { readonly kind: 'not_a_seller' }
  | { readonly kind: 'unauthenticated' }
  | { readonly kind: 'unavailable' };

/**
 * The caller's own verification attempt, read on the server (Phase 6-I).
 *
 * A page-side reader rather than a client fetch, so the token never reaches a browser and the attempt is
 * rendered by a server component. A page cannot ask about another seller: the API accepts no identifier.
 */
export async function readSellerVerification(
  options: SellerVerificationHandlerOptions = {},
): Promise<SellerVerificationLookup> {
  const accessToken = readAccessToken(options.cookieHeader ?? null);
  // No access cookie is no session: nothing is asked upstream, because there is nothing to ask about.
  if (accessToken === null) return { kind: 'unauthenticated' };

  const config = readBffConfig(options.env);
  const fetcher = createInternalCredentialFetch(
    config.internalBffCredential,
    options.fetch ?? fetch,
  );

  let upstream: Response;
  try {
    upstream = await fetcher(`${config.apiBaseUrl}/v1/sellers/me/verification`, {
      method: 'GET',
      headers: { [SESSION_TOKEN_HEADER]: accessToken },
    });
  } catch {
    return { kind: 'unavailable' };
  }

  const text = await upstream.text().catch(() => '');
  if (upstream.status === 401) return { kind: 'unauthenticated' };
  if (upstream.status === 404) return { kind: 'not_a_seller' };
  if (upstream.status !== 200) return { kind: 'unavailable' };

  let parsed: ReturnType<typeof SellerVerificationResponseSchema.safeParse>;
  try {
    parsed = SellerVerificationResponseSchema.safeParse(JSON.parse(text));
  } catch {
    return { kind: 'unavailable' };
  }
  if (!parsed.success) return { kind: 'unavailable' };
  // Rebuilt from the validated fields: a field the contract does not name has nowhere to go.
  return parsed.data.verification === null
    ? { kind: 'none' }
    : { kind: 'ok', verification: parsed.data.verification };
}

/**
 * `GET /api/sellers/me/verification`.
 *
 * A read, so no Origin check — there is nothing to forge across origins when a request changes no state, and
 * the session cookie decides whose attempt this is. `no-store`, so an identity document's filename is not
 * cached for the next visitor of a shared machine.
 */
export async function handleSellerVerification(
  request: Request,
  options: SellerVerificationHandlerOptions = {},
): Promise<Response> {
  const accessToken = readAccessToken(options.cookieHeader ?? request.headers.get('cookie'));
  if (accessToken === null) return unauthenticated();

  const config = readBffConfig(options.env);
  const fetcher = createInternalCredentialFetch(
    config.internalBffCredential,
    options.fetch ?? fetch,
  );

  let upstream: Response;
  try {
    upstream = await fetcher(`${config.apiBaseUrl}/v1/sellers/me/verification`, {
      method: 'GET',
      headers: { [SESSION_TOKEN_HEADER]: accessToken },
    });
  } catch {
    return unavailable();
  }

  const text = await upstream.text().catch(() => '');
  if (upstream.status !== 200) {
    if (!VERIFICATION_PROBLEM_STATUSES.has(upstream.status)) return unavailable();
    // The API's own problem body, with its own status and code. One sentence, written once.
    return new Response(text, {
      status: upstream.status,
      headers: { 'content-type': PROBLEM_JSON_MEDIA_TYPE, 'cache-control': 'no-store' },
    });
  }

  let validated: ReturnType<typeof SellerVerificationResponseSchema.safeParse>;
  try {
    validated = SellerVerificationResponseSchema.safeParse(JSON.parse(text));
  } catch {
    return unavailable();
  }
  if (!validated.success) return unavailable();

  return new Response(JSON.stringify({ verification: validated.data.verification }), {
    status: 200,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}

/**
 * The shared body of the five writes.
 *
 * `parseRequest` returns `undefined` for the two bodyless operations, and then **no body is sent upstream at
 * all** — not `{}`, not the browser's own bytes. A status a browser put in a body therefore cannot arrive
 * even as something to be ignored.
 */
async function verificationWrite<T>(
  request: Request,
  options: SellerVerificationHandlerOptions,
  method: 'POST' | 'DELETE',
  path: string,
  expected: 200 | 201,
  parseRequest: ((payload: unknown) => unknown | null) | null,
  parseResponse: (payload: unknown) => T | null,
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

  let validatedRequest: unknown;
  if (parseRequest !== null) {
    const raw = await request.text().catch(() => '');
    let body: unknown;
    try {
      body = JSON.parse(raw === '' ? 'null' : raw);
    } catch {
      return invalid();
    }
    const parsed = parseRequest(body);
    if (parsed === null) return invalid();
    validatedRequest = parsed;
  }

  const config = readBffConfig(options.env);
  const fetcher = createInternalCredentialFetch(
    config.internalBffCredential,
    options.fetch ?? fetch,
  );

  let upstream: Response;
  try {
    upstream = await fetcher(`${config.apiBaseUrl}${path}`, {
      method,
      headers:
        parseRequest === null
          ? { [SESSION_TOKEN_HEADER]: accessToken }
          : { 'content-type': 'application/json', [SESSION_TOKEN_HEADER]: accessToken },
      ...(parseRequest === null ? {} : { body: JSON.stringify(validatedRequest) }),
    });
  } catch {
    return unavailable();
  }

  const text = await upstream.text().catch(() => '');
  if (upstream.status !== expected) {
    if (!VERIFICATION_PROBLEM_STATUSES.has(upstream.status)) return unavailable();
    return new Response(text, {
      status: upstream.status,
      headers: { 'content-type': PROBLEM_JSON_MEDIA_TYPE, 'cache-control': 'no-store' },
    });
  }

  let parsedResponse: T | null;
  try {
    parsedResponse = parseResponse(JSON.parse(text));
  } catch {
    return unavailable();
  }
  if (parsedResponse === null) return unavailable();

  // Rebuilt from the validated fields: a field the contract does not name has nowhere to go.
  return new Response(JSON.stringify(parsedResponse), {
    status: expected,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}

/** `POST /api/sellers/me/verification` — open one attempt. Sends no body upstream. */
export async function handleSellerVerificationStart(
  request: Request,
  options: SellerVerificationHandlerOptions = {},
): Promise<Response> {
  return verificationWrite(
    request,
    options,
    'POST',
    '/v1/sellers/me/verification',
    201,
    null,
    (payload) => {
      const parsed = SellerVerificationStateResponseSchema.safeParse(payload);
      return parsed.success ? { status: parsed.data.status } : null;
    },
  );
}

/**
 * `POST /api/sellers/me/verification/documents/uploads` — authorize one document upload.
 *
 * The response carries a short-lived signed upload URL and the path it was issued for. It is passed to the
 * browser that asked for it and kept nowhere: not in a log, not in a cache — the handler sets `no-store`.
 */
export async function handleSellerVerificationUpload(
  request: Request,
  options: SellerVerificationHandlerOptions = {},
): Promise<Response> {
  return verificationWrite(
    request,
    options,
    'POST',
    '/v1/sellers/me/verification/documents/uploads',
    201,
    (payload) => {
      const parsed = SellerVerificationUploadRequestSchema.safeParse(payload);
      return parsed.success ? parsed.data : null;
    },
    (payload) => {
      const parsed = SellerVerificationUploadResponseSchema.safeParse(payload);
      return parsed.success ? { upload: parsed.data.upload } : null;
    },
  );
}

/** `POST /api/sellers/me/verification/documents` — record one uploaded document. */
export async function handleSellerVerificationDocument(
  request: Request,
  options: SellerVerificationHandlerOptions = {},
): Promise<Response> {
  return verificationWrite(
    request,
    options,
    'POST',
    '/v1/sellers/me/verification/documents',
    201,
    (payload) => {
      const parsed = SellerVerificationDocumentRequestSchema.safeParse(payload);
      return parsed.success ? parsed.data : null;
    },
    (payload) => {
      const parsed = SellerVerificationDocumentCountResponseSchema.safeParse(payload);
      return parsed.success ? { documentCount: parsed.data.documentCount } : null;
    },
  );
}

/**
 * `DELETE /api/sellers/me/verification/documents/:documentId` — remove one document.
 *
 * Permitted only while the attempt is `draft` or `submitted` (owner decision 3). This layer does not know
 * which state the attempt is in and does not try to: the database decides, and a document that is no longer
 * removable is refused exactly as one that does not exist.
 */
export async function handleSellerVerificationDocumentRemove(
  request: Request,
  documentId: string,
  options: SellerVerificationHandlerOptions = {},
): Promise<Response> {
  if (!DOCUMENT_ID_PATTERN.test(documentId)) return notFound();
  return verificationWrite(
    request,
    options,
    'DELETE',
    `/v1/sellers/me/verification/documents/${encodeURIComponent(documentId)}`,
    200,
    null,
    (payload) => {
      const parsed = SellerVerificationDocumentCountResponseSchema.safeParse(payload);
      return parsed.success ? { documentCount: parsed.data.documentCount } : null;
    },
  );
}

/** `POST /api/sellers/me/verification/submission` — submit for review. Sends no body upstream. */
export async function handleSellerVerificationSubmit(
  request: Request,
  options: SellerVerificationHandlerOptions = {},
): Promise<Response> {
  return verificationWrite(
    request,
    options,
    'POST',
    '/v1/sellers/me/verification/submission',
    200,
    null,
    (payload) => {
      const parsed = SellerVerificationStateResponseSchema.safeParse(payload);
      return parsed.success ? { status: parsed.data.status } : null;
    },
  );
}
