import 'server-only';
import {
  CreateNavigationItemRequestSchema,
  CreateNavigationItemResponseSchema,
  CreateNavigationMenuRequestSchema,
  CreateNavigationMenuResponseSchema,
  NavigationMenuDetailResponseSchema,
  NavigationMenusResponseSchema,
  NavigationStateRequestSchema,
  NavigationTargetInputSchema,
  NavigationWriteResponseSchema,
  PROBLEM_JSON_MEDIA_TYPE,
  ReorderNavigationItemsRequestSchema,
  SESSION_TOKEN_HEADER,
  UpdateNavigationItemRequestSchema,
  UpdateNavigationMenuRequestSchema,
  type NavigationMenuDetail,
  type NavigationMenusResponse,
} from '@repo/contracts';
import { addressedOrigin, checkSameOrigin } from './origin';
import { readBffConfig } from './env';
import { createInternalCredentialFetch } from './internal-credential';
import { readAdminAccessToken } from './staff-session';

/**
 * Navigation, on the admin origin (0094).
 *
 * **The session never leaves the server.** The caller's access token lives in `__Host-mp_admin_access`, which
 * JavaScript cannot read; it is presented to the API on one internal hop in the session-token header, and the
 * browser's own `Cookie` header is never forwarded.
 *
 * **Responses are validated, not forwarded.** A drifted body becomes a clean failure here instead of a
 * half-rendered screen.
 *
 * **Every write is same-origin and rebuilt** from the contract's own fields, so a field nobody declared cannot
 * ride along. A target is rebuilt as a unit, because it is one: 0030 allows exactly the column its kind owns.
 *
 * **Visibility has its own handler.** A menu's or an item's text is changed by one request and its visibility by
 * another, so a console that meant to fix a label cannot put a half-built menu in front of the public.
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

export interface NavigationOptions {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly fetch?: typeof fetch;
  /** The request's `Cookie` header. Server components pass the value they already hold. */
  readonly cookieHeader?: string | null;
}

/** What a read resolved to. `notFound` is the API's one neutral answer. */
export type NavigationResult<T> =
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
  options: NavigationOptions,
  parse: (body: unknown) => { success: true; data: T } | { success: false },
): Promise<NavigationResult<T>> {
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

/** Every menu, served placements first, with whether this caller may change any of it. */
export async function readNavigationMenus(
  options: NavigationOptions = {},
): Promise<NavigationResult<NavigationMenusResponse>> {
  return await read('/v1/admin/navigation/menus', options, (body) =>
    NavigationMenusResponseSchema.safeParse(body),
  );
}

/**
 * One menu with every entry it holds.
 *
 * A malformed id is `notFound` rather than a validation failure: the value came from the address somebody typed.
 */
export async function readNavigationMenu(
  menuId: string | undefined,
  locale: string,
  options: NavigationOptions = {},
): Promise<NavigationResult<NavigationMenuDetail>> {
  const id = identifier(menuId);
  if (id === null) return { kind: 'notFound' };
  const query = new URLSearchParams({ locale: locale === 'ar' ? 'ar' : 'en' });
  const result = await read(
    `/v1/admin/navigation/menus/${encodeURIComponent(id)}?${query.toString()}`,
    options,
    (body) => NavigationMenuDetailResponseSchema.safeParse(body),
  );
  return result.kind === 'ok' ? { kind: 'ok', data: result.data.menu } : result;
}

/* ------------------------------------------------------------------------------------------------ */
/* Writes                                                                                           */
/* ------------------------------------------------------------------------------------------------ */

async function acceptWrite(
  request: Request,
  options: NavigationOptions,
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
  options: NavigationOptions,
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

/**
 * The target a browser form described, rebuilt as the one value it is.
 *
 * A form posts four fields and a kind; only the field belonging to that kind is kept, so a stale hidden input
 * cannot send a page id along with a path. Null means the form sent no target at all, which for a change means
 * "leave it alone".
 */
function targetOf(body: Record<string, unknown>): unknown {
  const kind = body['targetKind'];
  if (typeof kind !== 'string' || kind === '') return null;
  switch (kind) {
    case 'page':
      return { kind, pageId: body['pageId'] };
    case 'blog_post':
      return { kind, blogPostId: body['blogPostId'] };
    case 'category':
      return { kind, categoryId: body['categoryId'] };
    case 'path':
      return { kind, path: body['path'] };
    default:
      // A kind nobody declared is handed on as it came and refused by the schema, rather than being guessed at.
      return { kind };
  }
}

/** `POST /api/navigation/menus` — create a menu. */
export async function handleNavigationMenuCreate(
  request: Request,
  options: NavigationOptions = {},
): Promise<Response> {
  const accepted = await acceptWrite(request, options);
  if ('refusal' in accepted) return accepted.refusal;

  const validated = CreateNavigationMenuRequestSchema.safeParse({
    menuKey: accepted.body['menuKey'],
    labelEn: accepted.body['labelEn'],
    ...('labelAr' in accepted.body ? { labelAr: accepted.body['labelAr'] } : {}),
  });
  if (!validated.success) return VALIDATION_FAILED();

  const upstream = await callWrite(
    'POST',
    '/v1/admin/navigation/menus',
    accepted.accessToken,
    validated.data,
    options,
  );
  return await writeOutcome(upstream, 201, (body) => CreateNavigationMenuResponseSchema.safeParse(body));
}

/** `PATCH /api/navigation/menus` — change a menu's key or labels. */
export async function handleNavigationMenuUpdate(
  request: Request,
  options: NavigationOptions = {},
): Promise<Response> {
  const accepted = await acceptWrite(request, options);
  if ('refusal' in accepted) return accepted.refusal;

  const menuId = identifier(accepted.body['menuId']);
  if (menuId === null) return VALIDATION_FAILED();

  const validated = UpdateNavigationMenuRequestSchema.safeParse({
    ...('menuKey' in accepted.body ? { menuKey: accepted.body['menuKey'] } : {}),
    ...('labelEn' in accepted.body ? { labelEn: accepted.body['labelEn'] } : {}),
    ...('labelAr' in accepted.body ? { labelAr: accepted.body['labelAr'] } : {}),
  });
  if (!validated.success) return VALIDATION_FAILED();

  const upstream = await callWrite(
    'PATCH',
    `/v1/admin/navigation/menus/${encodeURIComponent(menuId)}`,
    accepted.accessToken,
    validated.data,
    options,
  );
  return await writeOutcome(upstream, 200, (body) => NavigationWriteResponseSchema.safeParse(body));
}

/** `POST /api/navigation/menus/state` — show or hide one menu. */
export async function handleNavigationMenuState(
  request: Request,
  options: NavigationOptions = {},
): Promise<Response> {
  const accepted = await acceptWrite(request, options);
  if ('refusal' in accepted) return accepted.refusal;

  const menuId = identifier(accepted.body['menuId']);
  if (menuId === null) return VALIDATION_FAILED();

  const validated = NavigationStateRequestSchema.safeParse({ isActive: accepted.body['isActive'] });
  if (!validated.success) return VALIDATION_FAILED();

  const upstream = await callWrite(
    'PUT',
    `/v1/admin/navigation/menus/${encodeURIComponent(menuId)}/state`,
    accepted.accessToken,
    validated.data,
    options,
  );
  return await writeOutcome(upstream, 200, (body) => NavigationWriteResponseSchema.safeParse(body));
}

/** `POST /api/navigation/menus/remove` — remove one menu, and its entries with it. */
export async function handleNavigationMenuRemove(
  request: Request,
  options: NavigationOptions = {},
): Promise<Response> {
  const accepted = await acceptWrite(request, options);
  if ('refusal' in accepted) return accepted.refusal;

  const menuId = identifier(accepted.body['menuId']);
  if (menuId === null) return VALIDATION_FAILED();

  const upstream = await callWrite(
    'DELETE',
    `/v1/admin/navigation/menus/${encodeURIComponent(menuId)}`,
    accepted.accessToken,
    undefined,
    options,
  );
  return await writeOutcome(upstream, 200, (body) => NavigationWriteResponseSchema.safeParse(body));
}

/** `POST /api/navigation/items` — create one entry. */
export async function handleNavigationItemCreate(
  request: Request,
  options: NavigationOptions = {},
): Promise<Response> {
  const accepted = await acceptWrite(request, options);
  if ('refusal' in accepted) return accepted.refusal;

  const validated = CreateNavigationItemRequestSchema.safeParse({
    menuId: accepted.body['menuId'],
    labelEn: accepted.body['labelEn'],
    ...('labelAr' in accepted.body ? { labelAr: accepted.body['labelAr'] } : {}),
    target: targetOf(accepted.body),
    ...(typeof accepted.body['parentId'] === 'string' && accepted.body['parentId'] !== ''
      ? { parentId: accepted.body['parentId'] }
      : {}),
    ...('opensInNewTab' in accepted.body ? { opensInNewTab: accepted.body['opensInNewTab'] } : {}),
    ...('sortOrder' in accepted.body ? { sortOrder: accepted.body['sortOrder'] } : {}),
  });
  if (!validated.success) return VALIDATION_FAILED();

  const upstream = await callWrite(
    'POST',
    '/v1/admin/navigation/items',
    accepted.accessToken,
    validated.data,
    options,
  );
  return await writeOutcome(upstream, 201, (body) => CreateNavigationItemResponseSchema.safeParse(body));
}

/** `PATCH /api/navigation/items` — change one entry's labels, target, parent, tab preference or position. */
export async function handleNavigationItemUpdate(
  request: Request,
  options: NavigationOptions = {},
): Promise<Response> {
  const accepted = await acceptWrite(request, options);
  if ('refusal' in accepted) return accepted.refusal;

  const itemId = identifier(accepted.body['itemId']);
  if (itemId === null) return VALIDATION_FAILED();

  const target = targetOf(accepted.body);
  const validated = UpdateNavigationItemRequestSchema.safeParse({
    ...('labelEn' in accepted.body ? { labelEn: accepted.body['labelEn'] } : {}),
    ...('labelAr' in accepted.body ? { labelAr: accepted.body['labelAr'] } : {}),
    // A form that sent no kind leaves the target alone; one that sent a kind replaces it whole.
    ...(target === null ? {} : { target }),
    ...(typeof accepted.body['parentId'] === 'string' && accepted.body['parentId'] !== ''
      ? { parentId: accepted.body['parentId'] }
      : {}),
    ...('opensInNewTab' in accepted.body ? { opensInNewTab: accepted.body['opensInNewTab'] } : {}),
    ...('sortOrder' in accepted.body ? { sortOrder: accepted.body['sortOrder'] } : {}),
  });
  if (!validated.success) return VALIDATION_FAILED();

  const upstream = await callWrite(
    'PATCH',
    `/v1/admin/navigation/items/${encodeURIComponent(itemId)}`,
    accepted.accessToken,
    validated.data,
    options,
  );
  return await writeOutcome(upstream, 200, (body) => NavigationWriteResponseSchema.safeParse(body));
}

/** `POST /api/navigation/items/state` — show or hide one entry. */
export async function handleNavigationItemState(
  request: Request,
  options: NavigationOptions = {},
): Promise<Response> {
  const accepted = await acceptWrite(request, options);
  if ('refusal' in accepted) return accepted.refusal;

  const itemId = identifier(accepted.body['itemId']);
  if (itemId === null) return VALIDATION_FAILED();

  const validated = NavigationStateRequestSchema.safeParse({ isActive: accepted.body['isActive'] });
  if (!validated.success) return VALIDATION_FAILED();

  const upstream = await callWrite(
    'PUT',
    `/v1/admin/navigation/items/${encodeURIComponent(itemId)}/state`,
    accepted.accessToken,
    validated.data,
    options,
  );
  return await writeOutcome(upstream, 200, (body) => NavigationWriteResponseSchema.safeParse(body));
}

/** `POST /api/navigation/items/promote` — move one entry out from under its heading. */
export async function handleNavigationItemPromote(
  request: Request,
  options: NavigationOptions = {},
): Promise<Response> {
  const accepted = await acceptWrite(request, options);
  if ('refusal' in accepted) return accepted.refusal;

  const itemId = identifier(accepted.body['itemId']);
  if (itemId === null) return VALIDATION_FAILED();

  const upstream = await callWrite(
    'PUT',
    `/v1/admin/navigation/items/${encodeURIComponent(itemId)}/promote`,
    accepted.accessToken,
    undefined,
    options,
  );
  return await writeOutcome(upstream, 200, (body) => NavigationWriteResponseSchema.safeParse(body));
}

/** `POST /api/navigation/items/reorder` — set the order of one menu, whole. */
export async function handleNavigationItemsReorder(
  request: Request,
  options: NavigationOptions = {},
): Promise<Response> {
  const accepted = await acceptWrite(request, options);
  if ('refusal' in accepted) return accepted.refusal;

  const validated = ReorderNavigationItemsRequestSchema.safeParse({
    menuId: accepted.body['menuId'],
    itemIds: accepted.body['itemIds'],
  });
  if (!validated.success) return VALIDATION_FAILED();

  const upstream = await callWrite(
    'PUT',
    '/v1/admin/navigation/items/reorder',
    accepted.accessToken,
    validated.data,
    options,
  );
  return await writeOutcome(upstream, 200, (body) => NavigationWriteResponseSchema.safeParse(body));
}

/** `POST /api/navigation/items/remove` — remove one entry, and anything under it. */
export async function handleNavigationItemRemove(
  request: Request,
  options: NavigationOptions = {},
): Promise<Response> {
  const accepted = await acceptWrite(request, options);
  if ('refusal' in accepted) return accepted.refusal;

  const itemId = identifier(accepted.body['itemId']);
  if (itemId === null) return VALIDATION_FAILED();

  const upstream = await callWrite(
    'DELETE',
    `/v1/admin/navigation/items/${encodeURIComponent(itemId)}`,
    accepted.accessToken,
    undefined,
    options,
  );
  return await writeOutcome(upstream, 200, (body) => NavigationWriteResponseSchema.safeParse(body));
}

/** Re-exported so a form can check a target before it is posted, rather than after. */
export { NavigationTargetInputSchema };
