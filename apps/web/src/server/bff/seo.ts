import 'server-only';
import {
  RobotsSettingsResponseSchema,
  SitemapCountsResponseSchema,
  SitemapPageResponseSchema,
  type RobotsSettingsResponse,
  type SitemapApiEntryType,
  type SitemapCountsResponse,
  type SitemapPageResponse,
} from '@repo/contracts';
import { readBffConfig } from './env';
import { createInternalCredentialFetch } from './internal-credential';

/**
 * The BFF half of public SEO delivery.
 *
 * One credentialled internal call per read, and whatever comes back checked against the shared contract before
 * a document is built from it. No session: a crawler-facing document is the same for everyone.
 *
 * **A failure is `null`, and the caller turns that into a 503.** This is the one place where serving an empty
 * document would be actively harmful: an empty sitemap under a 200 tells a crawler that the site has no pages,
 * and that is a statement it may act on. "Nothing authored" is a different thing and arrives as a value — nulls
 * in the robots response — which is why the two cannot be confused here.
 *
 * **The answer is validated rather than forwarded.** A drifted upstream body would otherwise become malformed
 * XML in a document crawlers parse strictly, and a slug that is not slug-shaped would become a URL nobody
 * should be following. The shared schemas refuse both.
 */

export interface SeoFetchOptions {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly fetch?: typeof fetch;
}

async function read<T>(path: string, parse: (value: unknown) => T | null, options: SeoFetchOptions): Promise<T | null> {
  const { apiBaseUrl, internalBffCredential } = readBffConfig(options.env);
  const call = createInternalCredentialFetch(internalBffCredential, options.fetch ?? fetch);

  let upstream: Response;
  try {
    upstream = await call(`${apiBaseUrl}${path}`, { method: 'GET' });
  } catch {
    return null;
  }

  if (!upstream.ok) return null;

  try {
    return parse(JSON.parse(await upstream.text()));
  } catch {
    return null;
  }
}

/** The authored robots body, or `null` when the API could not be read. Nothing authored is nulls inside it. */
export async function readRobotsSettings(options: SeoFetchOptions = {}): Promise<RobotsSettingsResponse | null> {
  return read(
    '/v1/seo/robots',
    (value) => {
      const result = RobotsSettingsResponseSchema.safeParse(value);
      return result.success ? result.data : null;
    },
    options,
  );
}

/** How many entries each kind of address has, for the sitemap index. */
export async function readSitemapCounts(options: SeoFetchOptions = {}): Promise<SitemapCountsResponse | null> {
  return read(
    '/v1/seo/sitemap',
    (value) => {
      const result = SitemapCountsResponseSchema.safeParse(value);
      return result.success ? result.data : null;
    },
    options,
  );
}

/**
 * One page of entries of one kind.
 *
 * The type is one of the contract's own values and the page is a positive integer, so neither is interpolated
 * from anything a visitor can shape; they are still encoded, because building a path by concatenation is how a
 * value one day stops being one of those things without anybody noticing.
 */
export async function readSitemapPage(
  type: SitemapApiEntryType,
  page: number,
  options: SeoFetchOptions = {},
): Promise<SitemapPageResponse | null> {
  const path = `/v1/seo/sitemap/${encodeURIComponent(type)}/${encodeURIComponent(String(page))}`;
  return read(
    path,
    (value) => {
      const result = SitemapPageResponseSchema.safeParse(value);
      if (!result.success) return null;
      // The API echoes both back. If either disagrees with what was asked for, something is serving the wrong
      // document, and a sitemap with the wrong contents is worse than no sitemap.
      if (result.data.type !== type || result.data.page !== page) return null;
      return result.data;
    },
    options,
  );
}
