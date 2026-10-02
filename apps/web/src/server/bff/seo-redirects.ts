import 'server-only';
import {
  REDIRECT_FROM_PATH_PATTERN,
  REDIRECT_PATH_MAX,
  RedirectResolutionResponseSchema,
  type RedirectStatusCode,
} from '@repo/contracts';
import { readBffConfig } from './env';
import { createInternalCredentialFetch } from './internal-credential';

/**
 * The public half of the SEO redirect map (Phase 8-E).
 *
 * **It is asked one question, about one path, and only when the answer matters.** The approved precedence is LIVE
 * PAGE WINS: the middleware resolves the path against the app's own route tree and the catalogue's own readers
 * first, and reaches this only for a path that would otherwise answer 404. Nothing here could enforce that
 * ordering, and nothing here tries to — this module knows about the map and not about pages.
 *
 * **No session, and nothing about the caller.** The map is the same for everybody, so no cookie is read, none is
 * forwarded, and the answer is never varied by who asked. The one internal hop carries the BFF credential, like
 * every other.
 *
 * **The answer is validated, not forwarded.** A destination that is not a relative path, or a status code the table
 * could not have stored, is treated as no redirect at all: a value like that means something upstream is wrong, and
 * the safe reading is to leave the visitor with the 404 they were already getting rather than send them somewhere
 * nobody authored.
 *
 * **Nothing is cached.** A redirect that has just been switched off must stop redirecting; serving a stale one is
 * the failure mode an operator cannot see and cannot fix.
 */

/** Where the map sends a path, or that it names no redirect for it. */
export type RedirectLookup =
  | { readonly kind: 'redirect'; readonly toPath: string; readonly statusCode: RedirectStatusCode }
  | { readonly kind: 'none' };

export interface RedirectOptions {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly fetch?: typeof fetch;
}

/** The one answer for every way this can fail to produce a redirect. A failure must never become one. */
const NONE: RedirectLookup = { kind: 'none' };

/**
 * Where the redirect map sends one path.
 *
 * A path that could not be a row in the table is answered `none` without a hop: the table stores relative paths
 * that do not begin with a second slash, so anything else names nothing and asking would be pointless.
 */
export async function readRedirect(path: string, options: RedirectOptions = {}): Promise<RedirectLookup> {
  if (typeof path !== 'string' || path.length > REDIRECT_PATH_MAX) return NONE;
  if (!REDIRECT_FROM_PATH_PATTERN.test(path)) return NONE;

  const config = readBffConfig(options.env);
  const fetcher = createInternalCredentialFetch(config.internalBffCredential, options.fetch ?? fetch);
  const query = new URLSearchParams({ path });

  let upstream: Response;
  try {
    upstream = await fetcher(`${config.apiBaseUrl}/v1/seo/redirects/resolve?${query.toString()}`, {
      method: 'GET',
    });
  } catch {
    // The map could not be read. A visitor gets the 404 they were already getting, which is the honest answer:
    // a redirect we cannot confirm is not a redirect.
    return NONE;
  }

  if (!upstream.ok) return NONE;

  try {
    const parsed = RedirectResolutionResponseSchema.safeParse(JSON.parse(await upstream.text()));
    if (!parsed.success || parsed.data.outcome !== 'redirect') return NONE;
    // Never send a visitor to the address they just asked for. The database declines this and the API declines it
    // again; this is the third refusal, because the cost of being wrong is a browser looping forever.
    if (parsed.data.toPath === path) return NONE;
    return { kind: 'redirect', toPath: parsed.data.toPath, statusCode: parsed.data.statusCode };
  } catch {
    return NONE;
  }
}
