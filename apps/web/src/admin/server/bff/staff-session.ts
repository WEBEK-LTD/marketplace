import 'server-only';
import {
  AdminSessionResponseSchema,
  PROBLEM_JSON_MEDIA_TYPE,
  SESSION_TOKEN_HEADER,
  UpdateBuyerProfileRequestSchema,
  type AdminSession,
} from '@repo/contracts';
import { readBffConfig } from './env';
import { createInternalCredentialFetch } from './internal-credential';
import { addressedOrigin, checkSameOrigin } from './origin';
import { SESSION_COOKIES } from './session-cookies';

/**
 * The staff console session, on the admin origin (Phase 7-F).
 *
 * One read that every protected page performs before it renders anything, and one write that changes
 * the reader's own interface language. Five rules shape both.
 *
 * **The session never leaves the server.** The caller's access token lives in `__Host-mp_admin_access`,
 * which JavaScript cannot read, and this module is the only thing on this origin besides the 7-B TOTP
 * handlers that reads it — presenting it to the API on one internal hop in the session-token header. The
 * browser's own `Cookie` header is never forwarded.
 *
 * **Permissions travel one way.** They come back from the API and are rendered; nothing in this module
 * accepts a permission, a role or an assurance level from a request. There is no shape in which a page
 * could tell the server what it is allowed to see, which is why {@link readStaffSession} takes no
 * argument beyond the cookie header it is given.
 *
 * **The answer is validated, not forwarded.** A body that has drifted becomes a clean failure rather
 * than a half-rendered console, and a field the contract does not name cannot reach a page even if the
 * API somehow sent one. That matters more here than on a list: the fields being validated are the ones
 * every authorization decision in the shell is made from.
 *
 * **A refusal is not a permission set.** `unauthenticated` and `unavailable` are kept apart, and neither
 * is ever rendered as "signed in with nothing": a console that showed an empty navigation because a
 * database was busy would tell a moderator they had been demoted.
 *
 * **Nothing here logs.** A console session names a person and everything they are trusted to do; the way
 * to keep that out of a log is to have no log line that could take it.
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

export interface StaffSessionOptions {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly fetch?: typeof fetch;
  /** The request's `Cookie` header. Server components pass the value they already hold. */
  readonly cookieHeader?: string | null;
}

/**
 * What a console session read resolved to.
 *
 * `unauthenticated` is no usable session at all. `unavailable` is a service that could not answer —
 * deliberately distinct, because the shell must not treat an outage as a demotion.
 */
export type StaffSessionResult =
  | { readonly kind: 'ok'; readonly session: AdminSession }
  | { readonly kind: 'unauthenticated' }
  | { readonly kind: 'unavailable' };

/** Reads the caller's access token from the admin session cookie, or null when there is no session. */
export function readAdminAccessToken(cookieHeader: string | null): string | null {
  if (cookieHeader === null) return null;
  for (const part of cookieHeader.split(';')) {
    const separator = part.indexOf('=');
    if (separator === -1) continue;
    if (part.slice(0, separator).trim() !== SESSION_COOKIES.access.name) continue;
    const value = part.slice(separator + 1).trim();
    return value === '' ? null : value;
  }
  return null;
}

/**
 * The caller's own console session.
 *
 * Every protected page calls this and decides from the answer. It takes nothing but the cookie header:
 * no page name, no permission, no role and no account, so there is no argument a page could get wrong
 * in a way that widened what it is shown.
 */
export async function readStaffSession(options: StaffSessionOptions = {}): Promise<StaffSessionResult> {
  const accessToken = readAdminAccessToken(options.cookieHeader ?? null);
  if (accessToken === null) return { kind: 'unauthenticated' };

  const config = readBffConfig(options.env);
  const fetcher = createInternalCredentialFetch(config.internalBffCredential, options.fetch ?? fetch);

  let upstream: Response;
  try {
    upstream = await fetcher(`${config.apiBaseUrl}/v1/admin/session`, {
      method: 'GET',
      headers: { [SESSION_TOKEN_HEADER]: accessToken },
    });
  } catch {
    return { kind: 'unavailable' };
  }

  if (!upstream.ok) {
    await upstream.text().catch(() => '');
    return { kind: upstream.status === 401 ? 'unauthenticated' : 'unavailable' };
  }

  try {
    const parsed = AdminSessionResponseSchema.safeParse(JSON.parse(await upstream.text()));
    return parsed.success ? { kind: 'ok', session: parsed.data.session } : { kind: 'unavailable' };
  } catch {
    return { kind: 'unavailable' };
  }
}

/**
 * `POST /api/account/locale` — the language switch in the console header.
 *
 * It reuses the profile write the API already has, because v5.2 says the admin's language comes from
 * the person's profile and that operation is the one that sets it. **Only `localeCode` is sent**: the
 * body is rebuilt here from a single field, so a page that added a name, a phone number or anything
 * else would have it dropped before the request left this origin — and the API's strict schema would
 * refuse the rest anyway.
 *
 * The two values it accepts are the two interface locales. Anything else is refused here rather than
 * forwarded, so the console never asks the API to store a language it cannot render.
 */
const ADMIN_LOCALES = new Set(['en', 'ar']);

export async function handleLocaleChange(
  request: Request,
  options: StaffSessionOptions = {},
): Promise<Response> {
  const origin = checkSameOrigin({
    method: request.method,
    url: addressedOrigin(request),
    headers: request.headers,
  });
  if (!origin.ok) {
    return problemResponse(403, 'Forbidden', 'BAD_REQUEST', 'The request could not be processed.');
  }

  const accessToken = readAdminAccessToken(options.cookieHeader ?? request.headers.get('cookie'));
  if (accessToken === null) {
    return problemResponse(401, 'Unauthorized', 'AUTHENTICATION_REQUIRED', 'Authentication is required.');
  }

  let body: unknown;
  try {
    const raw = await request.text();
    body = raw === '' ? {} : JSON.parse(raw);
  } catch {
    return problemResponse(400, 'Bad Request', 'VALIDATION_FAILED', 'The request is invalid.');
  }

  const locale = (body as { localeCode?: unknown } | null)?.localeCode;
  if (typeof locale !== 'string' || !ADMIN_LOCALES.has(locale)) {
    return problemResponse(400, 'Bad Request', 'VALIDATION_FAILED', 'The request is invalid.');
  }
  // Rebuilt from the contract, so exactly one field crosses.
  const validated = UpdateBuyerProfileRequestSchema.safeParse({ localeCode: locale });
  if (!validated.success) {
    return problemResponse(400, 'Bad Request', 'VALIDATION_FAILED', 'The request is invalid.');
  }

  const config = readBffConfig(options.env);
  const fetcher = createInternalCredentialFetch(config.internalBffCredential, options.fetch ?? fetch);

  let upstream: Response;
  try {
    upstream = await fetcher(`${config.apiBaseUrl}/v1/users/me/profile`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', [SESSION_TOKEN_HEADER]: accessToken },
      body: JSON.stringify({ localeCode: locale }),
    });
  } catch {
    return problemResponse(503, 'Service Unavailable', 'SERVICE_UNAVAILABLE', 'The service is temporarily unavailable.');
  }

  const text = await upstream.text().catch(() => '');
  if (upstream.status !== 200) {
    if (upstream.status === 401) {
      return problemResponse(401, 'Unauthorized', 'AUTHENTICATION_REQUIRED', 'Authentication is required.');
    }
    return problemResponse(503, 'Service Unavailable', 'SERVICE_UNAVAILABLE', 'The service is temporarily unavailable.');
  }
  // The API's answer is a change flag and nothing else; the console re-reads the session rather than
  // trusting a body, so nothing from upstream is passed on.
  void text;

  return new Response(JSON.stringify({ changed: true }), {
    status: 200,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}
