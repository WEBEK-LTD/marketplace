import 'server-only';
import { CurrentUserResponseSchema, SESSION_TOKEN_HEADER, type CurrentUser } from '@repo/contracts';
import { readBffConfig } from './env';
import { createInternalCredentialFetch } from './internal-credential';
import { readAccessToken } from './session-cookies';

/**
 * Who the caller is, for a server-rendered signed-in surface (Phase 5-A).
 *
 * The token is read from the `__Host-mp_access` cookie here, on the server, and presented to the API on
 * one internal hop. A page never receives it, never sees it and has no way to ask for another account:
 * the API route accepts no identifier at all.
 *
 * The response is **validated** against the shared contract rather than trusted, so a body that has
 * drifted becomes a clean failure rather than a half-rendered header — and a field the contract does not
 * allow cannot reach a page even if the API somehow sent one.
 *
 * Three outcomes, and the difference between the last two decides what a protected page does:
 * `authenticated` renders it; `unauthenticated` means the session is over and the page renders a
 * signed-out view instead; `unavailable` means this service could not answer, which is an error page
 * rather than a sign-out — a failing API must not read as "you have been logged out".
 */
export type CurrentUserLookup =
  | { readonly kind: 'authenticated'; readonly user: CurrentUser }
  | { readonly kind: 'unauthenticated' }
  | { readonly kind: 'unavailable' };

export interface CurrentUserOptions {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly fetch?: typeof fetch;
  /** The request's `Cookie` header. Server components pass the value they already hold. */
  readonly cookieHeader?: string | null;
}

export async function readCurrentUser(options: CurrentUserOptions = {}): Promise<CurrentUserLookup> {
  const accessToken = readAccessToken(options.cookieHeader ?? null);
  // No access cookie is no session: nothing is asked upstream, because there is nothing to ask about.
  if (accessToken === null) return { kind: 'unauthenticated' };

  const config = readBffConfig(options.env);
  const fetcher = createInternalCredentialFetch(config.internalBffCredential, options.fetch ?? fetch);

  let upstream: Response;
  try {
    upstream = await fetcher(`${config.apiBaseUrl}/v1/users/me`, {
      method: 'GET',
      headers: { [SESSION_TOKEN_HEADER]: accessToken },
    });
  } catch {
    return { kind: 'unavailable' };
  }

  if (upstream.status === 401) {
    await upstream.text().catch(() => '');
    return { kind: 'unauthenticated' };
  }
  if (!upstream.ok) {
    await upstream.text().catch(() => '');
    return { kind: 'unavailable' };
  }

  let payload: unknown;
  try {
    payload = await upstream.json();
  } catch {
    return { kind: 'unavailable' };
  }

  const parsed = CurrentUserResponseSchema.safeParse(payload);
  if (!parsed.success) return { kind: 'unavailable' };
  return { kind: 'authenticated', user: parsed.data.user };
}
