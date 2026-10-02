import 'server-only';
import {
  AddFavoriteRequestSchema,
  AddressCreatedResponseSchema,
  AddressInputSchema,
  AddressMutationResponseSchema,
  AddressesResponseSchema,
  BuyerProfileMutationResponseSchema,
  BuyerProfileResponseSchema,
  BuyerSettingsMutationResponseSchema,
  BuyerSettingsResponseSchema,
  CountriesResponseSchema,
  FavoriteMutationResponseSchema,
  FavoritesResponseSchema,
  PROBLEM_JSON_MEDIA_TYPE,
  SESSION_TOKEN_HEADER,
  SavedSearchCreatedResponseSchema,
  SavedSearchInputSchema,
  SavedSearchMutationResponseSchema,
  SavedSearchesResponseSchema,
  UpdateBuyerProfileRequestSchema,
  UpdateBuyerSettingsRequestSchema,
  type AddressInput,
  type AddressesResponse,
  type BuyerProfileResponse,
  type BuyerSettingsResponse,
  type CountriesResponse,
  type FavoritesResponse,
  type SavedSearchesResponse,
} from '@repo/contracts';
import { readBffConfig } from './env';
import { createInternalCredentialFetch } from './internal-credential';
import { addressedOrigin, checkSameOrigin } from './origin';
import { readAccessToken } from './session-cookies';

/**
 * The BFF half of the buyer account surfaces (Phase 7-E).
 *
 * Six reads a server component calls directly, and ten writes a browser posts to. The same five rules
 * shape all of them as shape the 7-C notification handlers, and each is the reason a piece of this looks
 * the way it does.
 *
 * **The session never leaves the server.** The access token lives in the `__Host-mp_access` cookie,
 * which JavaScript cannot see, and this module is the only thing on this origin that reads it —
 * presenting it to the API on one internal hop in `x-session-token`. The browser's own `Cookie` header
 * is never forwarded.
 *
 * **Request bodies are rebuilt, never forwarded.** Every write parses what the page sent, validates it
 * against the shared contract, and sends a body assembled here from the fields that contract names. A
 * page that added a `userId` would have it dropped before the request left this origin — and the API's
 * strict schema would refuse it anyway, which is the point: two independent walls, neither relying on
 * the other.
 *
 * **Responses are validated, not forwarded.** A body that has drifted becomes a clean failure here
 * instead of a half-rendered list, and a field the contract does not name cannot reach a browser even if
 * the API somehow sent one.
 *
 * **Cursors stay opaque.** A `cursor` parameter is passed along as text and never parsed, validated or
 * reconstructed here. The API owns the format, and a BFF that understood it would be a second place that
 * has to agree about it.
 *
 * **Nothing here logs.** An address is where somebody lives and a saved search is what they are looking
 * for; the way to keep those out of a log is to have no log line that could take them.
 */

/**
 * The one thing this module needs from a contract schema.
 *
 * Structural rather than imported: the BFF has no direct dependency on the validation library, and the
 * shared contracts are the only place a schema is written. Anything that can answer `safeParse` is
 * enough to validate a response here.
 */
interface Validator<T> {
  safeParse(value: unknown): { success: true; data: T } | { success: false };
}

const PROBLEM = {
  type: 'about:blank',
  status: 503,
  title: 'Service Unavailable',
  detail: 'The service is temporarily unavailable.',
  instance: '/account',
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
 * 404 and 409 are here because these surfaces have refusals a form can act on: a row that is not there,
 * a name already taken, a country that cannot be shipped to. Anything outside the set becomes the
 * generic 503, so an unexpected upstream status can never arrive as a success.
 */
const WRITE_PROBLEM_STATUSES = new Set([400, 401, 403, 404, 409, 429]);

export interface AccountHandlerOptions {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly fetch?: typeof fetch;
  /** The request's `Cookie` header. Server components pass the value they already hold. */
  readonly cookieHeader?: string | null;
}

/**
 * What an account read resolved to.
 *
 * `unauthenticated` and `unavailable` are kept apart deliberately: a session that has ended is a
 * different thing from a service that could not answer, and a page that conflated them would tell
 * somebody they had been signed out because a database was busy. `invalid` is the API's cursor refusal,
 * which a page recovers from by dropping the cursor rather than by reporting an outage. `missing` is a
 * row or a profile that is not there.
 */
export type AccountResult<T> =
  | { readonly kind: 'ok'; readonly data: T }
  | { readonly kind: 'unauthenticated' }
  | { readonly kind: 'invalid' }
  | { readonly kind: 'missing' }
  | { readonly kind: 'unavailable' };

/** One credentialled internal read carrying the caller's own token. */
async function call(
  path: string,
  accessToken: string,
  options: AccountHandlerOptions,
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
function outcomeOf(status: number): 'unauthenticated' | 'invalid' | 'missing' | 'unavailable' {
  if (status === 401) return 'unauthenticated';
  if (status === 400) return 'invalid';
  if (status === 404) return 'missing';
  return 'unavailable';
}

/** One read, validated against the contract before any of it is returned. */
async function read<T>(
  path: string,
  schema: Validator<T>,
  options: AccountHandlerOptions,
): Promise<AccountResult<T>> {
  const accessToken = readAccessToken(options.cookieHeader ?? null);
  if (accessToken === null) return { kind: 'unauthenticated' };

  const upstream = await call(path, accessToken, options);
  if (upstream === null) return { kind: 'unavailable' };
  if (!upstream.ok) {
    await upstream.text().catch(() => '');
    return { kind: outcomeOf(upstream.status) };
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

export async function readFavorites(
  input: { limit?: string | null; cursor?: string | null } = {},
  options: AccountHandlerOptions = {},
): Promise<AccountResult<FavoritesResponse>> {
  return await read(`/v1/users/me/favorites${query(input)}`, FavoritesResponseSchema, options);
}

export async function readSavedSearches(
  input: { limit?: string | null; cursor?: string | null } = {},
  options: AccountHandlerOptions = {},
): Promise<AccountResult<SavedSearchesResponse>> {
  return await read(`/v1/users/me/saved-searches${query(input)}`, SavedSearchesResponseSchema, options);
}

export async function readAddresses(
  options: AccountHandlerOptions = {},
): Promise<AccountResult<AddressesResponse>> {
  return await read('/v1/users/me/addresses', AddressesResponseSchema, options);
}

export async function readBuyerProfile(
  options: AccountHandlerOptions = {},
): Promise<AccountResult<BuyerProfileResponse>> {
  return await read('/v1/users/me/profile', BuyerProfileResponseSchema, options);
}

export async function readBuyerSettings(
  options: AccountHandlerOptions = {},
): Promise<AccountResult<BuyerSettingsResponse>> {
  return await read('/v1/users/me/settings', BuyerSettingsResponseSchema, options);
}

export async function readCountries(
  options: AccountHandlerOptions = {},
): Promise<AccountResult<CountriesResponse>> {
  return await read('/v1/reference/countries', CountriesResponseSchema, options);
}

/* ------------------------------------------------------------------------------------------------ */
/* Writes                                                                                            */
/* ------------------------------------------------------------------------------------------------ */

/** The Origin/CSRF check, the session and the parsed body, or the response that refuses the request. */
async function acceptWrite(
  request: Request,
  options: AccountHandlerOptions,
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
  method: 'POST' | 'PATCH' | 'PUT' | 'DELETE',
  path: string,
  accessToken: string,
  body: unknown,
  options: AccountHandlerOptions,
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
 * A recognised refusal status is forwarded with the API's own problem body, so a form can show "you
 * already have a saved search with that name" rather than a generic failure; anything else becomes the
 * generic 503. Success is the expected status exactly, and its body is re-validated before a single byte
 * of it reaches a browser.
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

/** A path segment a browser supplied. Checked here so nothing but an identifier reaches a URL. */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function identifier(value: string | undefined): string | null {
  return typeof value === 'string' && UUID_PATTERN.test(value) ? value.toLowerCase() : null;
}

/** `POST /api/account/favorites` — save a listing. */
export async function handleAddFavorite(
  request: Request,
  options: AccountHandlerOptions = {},
): Promise<Response> {
  const accepted = await acceptWrite(request, options);
  if ('refusal' in accepted) return accepted.refusal;

  const validated = AddFavoriteRequestSchema.safeParse(accepted.body);
  if (!validated.success) return VALIDATION_FAILED();

  return await writeOutcome(
    await callWrite('POST', '/v1/users/me/favorites', accepted.accessToken, { listingId: validated.data.listingId }, options),
    200,
    FavoriteMutationResponseSchema,
  );
}

/** `DELETE /api/account/favorites/[listingId]` — remove a saved listing. */
export async function handleRemoveFavorite(
  request: Request,
  listingId: string | undefined,
  options: AccountHandlerOptions = {},
): Promise<Response> {
  const accepted = await acceptWrite(request, options);
  if ('refusal' in accepted) return accepted.refusal;

  const id = identifier(listingId);
  if (id === null) return VALIDATION_FAILED();

  return await writeOutcome(
    await callWrite('DELETE', `/v1/users/me/favorites/${id}`, accepted.accessToken, undefined, options),
    200,
    FavoriteMutationResponseSchema,
  );
}

/** `POST /api/account/saved-searches` — store a search. Schedules nothing. */
export async function handleCreateSavedSearch(
  request: Request,
  options: AccountHandlerOptions = {},
): Promise<Response> {
  const accepted = await acceptWrite(request, options);
  if ('refusal' in accepted) return accepted.refusal;

  const validated = SavedSearchInputSchema.safeParse(accepted.body);
  if (!validated.success) return VALIDATION_FAILED();

  return await writeOutcome(
    await callWrite(
      'POST',
      '/v1/users/me/saved-searches',
      accepted.accessToken,
      { name: validated.data.name, query: validated.data.query, notify: validated.data.notify ?? false },
      options,
    ),
    201,
    SavedSearchCreatedResponseSchema,
  );
}

/** `PATCH /api/account/saved-searches/[savedSearchId]`. */
export async function handleUpdateSavedSearch(
  request: Request,
  savedSearchId: string | undefined,
  options: AccountHandlerOptions = {},
): Promise<Response> {
  const accepted = await acceptWrite(request, options);
  if ('refusal' in accepted) return accepted.refusal;

  const id = identifier(savedSearchId);
  if (id === null) return VALIDATION_FAILED();
  const validated = SavedSearchInputSchema.safeParse(accepted.body);
  if (!validated.success) return VALIDATION_FAILED();

  return await writeOutcome(
    await callWrite(
      'PATCH',
      `/v1/users/me/saved-searches/${id}`,
      accepted.accessToken,
      { name: validated.data.name, query: validated.data.query, notify: validated.data.notify ?? false },
      options,
    ),
    200,
    SavedSearchMutationResponseSchema,
  );
}

/** `DELETE /api/account/saved-searches/[savedSearchId]`. */
export async function handleDeleteSavedSearch(
  request: Request,
  savedSearchId: string | undefined,
  options: AccountHandlerOptions = {},
): Promise<Response> {
  const accepted = await acceptWrite(request, options);
  if ('refusal' in accepted) return accepted.refusal;

  const id = identifier(savedSearchId);
  if (id === null) return VALIDATION_FAILED();

  return await writeOutcome(
    await callWrite('DELETE', `/v1/users/me/saved-searches/${id}`, accepted.accessToken, undefined, options),
    200,
    SavedSearchMutationResponseSchema,
  );
}

/** The address body, rebuilt field by field from the contract. */
function addressBody(value: AddressInput): Record<string, unknown> {
  return {
    label: value.label ?? null,
    purpose: value.purpose,
    recipientName: value.recipientName,
    phoneE164: value.phoneE164,
    countryCode: value.countryCode,
    governorate: value.governorate,
    city: value.city,
    district: value.district ?? null,
    streetAddress: value.streetAddress,
    building: value.building ?? null,
    apartment: value.apartment ?? null,
    postalCode: value.postalCode ?? null,
    landmark: value.landmark ?? null,
    isDefaultShipping: value.isDefaultShipping ?? false,
    isDefaultBilling: value.isDefaultBilling ?? false,
  };
}

/** `POST /api/account/addresses`. */
export async function handleCreateAddress(
  request: Request,
  options: AccountHandlerOptions = {},
): Promise<Response> {
  const accepted = await acceptWrite(request, options);
  if ('refusal' in accepted) return accepted.refusal;

  const validated = AddressInputSchema.safeParse(accepted.body);
  if (!validated.success) return VALIDATION_FAILED();

  return await writeOutcome(
    await callWrite('POST', '/v1/users/me/addresses', accepted.accessToken, addressBody(validated.data), options),
    201,
    AddressCreatedResponseSchema,
  );
}

/** `PATCH /api/account/addresses/[addressId]`. */
export async function handleUpdateAddress(
  request: Request,
  addressId: string | undefined,
  options: AccountHandlerOptions = {},
): Promise<Response> {
  const accepted = await acceptWrite(request, options);
  if ('refusal' in accepted) return accepted.refusal;

  const id = identifier(addressId);
  if (id === null) return VALIDATION_FAILED();
  const validated = AddressInputSchema.safeParse(accepted.body);
  if (!validated.success) return VALIDATION_FAILED();

  return await writeOutcome(
    await callWrite('PATCH', `/v1/users/me/addresses/${id}`, accepted.accessToken, addressBody(validated.data), options),
    200,
    AddressMutationResponseSchema,
  );
}

/** `DELETE /api/account/addresses/[addressId]`. */
export async function handleDeleteAddress(
  request: Request,
  addressId: string | undefined,
  options: AccountHandlerOptions = {},
): Promise<Response> {
  const accepted = await acceptWrite(request, options);
  if ('refusal' in accepted) return accepted.refusal;

  const id = identifier(addressId);
  if (id === null) return VALIDATION_FAILED();

  return await writeOutcome(
    await callWrite('DELETE', `/v1/users/me/addresses/${id}`, accepted.accessToken, undefined, options),
    200,
    AddressMutationResponseSchema,
  );
}

/**
 * `PATCH /api/account/profile`.
 *
 * The body is rebuilt from the four fields the contract names. A page that sent a phone number, a
 * status or a role would have it dropped here, before the request left this origin.
 */
export async function handleUpdateProfile(
  request: Request,
  options: AccountHandlerOptions = {},
): Promise<Response> {
  const accepted = await acceptWrite(request, options);
  if ('refusal' in accepted) return accepted.refusal;

  const validated = UpdateBuyerProfileRequestSchema.safeParse(accepted.body);
  if (!validated.success) return VALIDATION_FAILED();

  const body: Record<string, unknown> = {};
  if (validated.data.displayName !== undefined) body['displayName'] = validated.data.displayName;
  if (validated.data.fullName !== undefined) body['fullName'] = validated.data.fullName;
  if (validated.data.localeCode !== undefined) body['localeCode'] = validated.data.localeCode;
  if (validated.data.timezone !== undefined) body['timezone'] = validated.data.timezone;

  return await writeOutcome(
    await callWrite('PATCH', '/v1/users/me/profile', accepted.accessToken, body, options),
    200,
    BuyerProfileMutationResponseSchema,
  );
}

/** `PUT /api/account/settings` — a whole-state write. */
export async function handleUpdateSettings(
  request: Request,
  options: AccountHandlerOptions = {},
): Promise<Response> {
  const accepted = await acceptWrite(request, options);
  if ('refusal' in accepted) return accepted.refusal;

  const validated = UpdateBuyerSettingsRequestSchema.safeParse(accepted.body);
  if (!validated.success) return VALIDATION_FAILED();

  return await writeOutcome(
    await callWrite(
      'PUT',
      '/v1/users/me/settings',
      accepted.accessToken,
      {
        notifyEmail: validated.data.notifyEmail,
        notifySms: validated.data.notifySms,
        notifyWhatsapp: validated.data.notifyWhatsapp,
        notifyInApp: validated.data.notifyInApp,
        marketingOptIn: validated.data.marketingOptIn,
        digitStyle: validated.data.digitStyle,
      },
      options,
    ),
    200,
    BuyerSettingsMutationResponseSchema,
  );
}
