import 'server-only';
import {
  PublicSeoMetadataResponseSchema,
  SEO_PATH_MAX,
  SEO_ROUTE_PATH_PATTERN,
  publicLocaleOf,
  type PublicSeoMetadata,
} from '@repo/contracts';
import { readBffConfig } from './env';
import { createInternalCredentialFetch } from './internal-credential';

/**
 * The public half of per-entity SEO metadata (Phase 8-F).
 *
 * **No session, and nothing about the caller.** An override is as public as the thing it describes, so no cookie is
 * read, none is forwarded, and the answer is never varied by who asked.
 *
 * **Addressed by slug or by route path, never by an identifier.** Two public contracts carry no id, and widening them
 * to save a lookup would put an internal identifier into a browser for no reason.
 *
 * **A failure is never an override.** An outage, a refusal and a drifted body all answer `null`, so a surface whose
 * override could not be read renders exactly the head it rendered before this existed. That is the only safe
 * direction: the alternative is a page that fails to render because its optional metadata was unavailable.
 *
 * **Nothing is cached here.** A title an administrator has just corrected must take effect; the per-request memo in
 * `public-metadata.ts` is what stops one surface asking twice.
 */

/** Which surface is being asked about. A route has its own shape, because it has no row behind it. */
export type SeoMetadataTarget =
  | { readonly entityType: 'page' | 'category' | 'listing' | 'seller'; readonly slug: string; readonly locale: string }
  | { readonly routePath: string; readonly locale: string };

export interface SeoMetadataFetchOptions {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly fetch?: typeof fetch;
}

/** The slug shape every public surface uses. Anything else names no row, so it is not asked about. */
const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,158}[a-z0-9])?$/;

/**
 * One surface's override, or null.
 *
 * A target that could not name anything is answered `null` without a hop: there is no point asking about a slug the
 * catalogue could not hold or a path the table could not store.
 */
export async function readSeoMetadata(
  target: SeoMetadataTarget,
  options: SeoMetadataFetchOptions = {},
): Promise<PublicSeoMetadata | null> {
  const query = new URLSearchParams({ locale: publicLocaleOf(target.locale) });

  if ('routePath' in target) {
    if (target.routePath.length > SEO_PATH_MAX || !SEO_ROUTE_PATH_PATTERN.test(target.routePath)) return null;
    query.set('routePath', target.routePath);
  } else {
    if (!SLUG_PATTERN.test(target.slug)) return null;
    query.set('entityType', target.entityType);
    query.set('slug', target.slug);
  }

  const config = readBffConfig(options.env);
  const fetcher = createInternalCredentialFetch(config.internalBffCredential, options.fetch ?? fetch);

  let upstream: Response;
  try {
    upstream = await fetcher(`${config.apiBaseUrl}/v1/seo/metadata?${query.toString()}`, { method: 'GET' });
  } catch {
    // The override could not be read. The surface keeps what it derives, which is what it would have shown anyway.
    return null;
  }

  if (!upstream.ok) return null;

  try {
    const parsed = PublicSeoMetadataResponseSchema.safeParse(JSON.parse(await upstream.text()));
    return parsed.success ? parsed.data.override : null;
  } catch {
    return null;
  }
}
