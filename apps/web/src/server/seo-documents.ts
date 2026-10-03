import 'server-only';
import {
  indexableExactRoutes,
  publicBlogPostPath,
  publicCategoryPath,
  publicCmsPagePath,
  publicListingPath,
  publicSellerPath,
  publicServicePath,
  type PublicLocale,
} from '@repo/config';
import {
  SITEMAP_ENTRY_TYPES,
  type RobotsSettingsResponse,
  type SitemapApiEntryType,
  type SitemapCountsResponse,
  type SitemapEntry,
  type SitemapEntryType,
} from '@repo/contracts';

/**
 * The two documents crawlers read, built as text.
 *
 * Kept out of the route files so that what they produce can be asserted directly, character by character, rather
 * than only over HTTP. A sitemap is parsed strictly by the things that read it, so "roughly right" is not a
 * state it can be in.
 *
 * **Absolute URLs, from configuration.** The sitemap protocol requires them and the `Sitemap:` directive in
 * `robots.txt` requires one. The origin is passed in by the caller, which reads it from `PUBLIC_WEB_ORIGIN`, and
 * never from the request `Host` header: a client controls that header, so a poisoned one would publish a sitemap
 * advertising somebody else's origin.
 *
 * **Both locales, with hreflang alternates (D6).** Every address appears once per locale it answers in, and each
 * entry lists all of its alternates including itself, which is what the protocol asks for. A CMS static page is
 * the one surface where an address can be missing in a language, so it carries the locales it resolves in;
 * everything else answers in both whatever language its content is written in.
 */

const SITEMAP_NAMESPACE = 'http://www.sitemaps.org/schemas/sitemap/0.9';
const XHTML_NAMESPACE = 'http://www.w3.org/1999/xhtml';

/** Both public locales, in the order they are presented. */
const LOCALES: readonly PublicLocale[] = ['en', 'ar'];

/**
 * XML text escaping.
 *
 * Every value that reaches here is already narrow — a slug matching a pattern, an ISO timestamp, an origin
 * validated as an origin — so this escapes nothing in practice today. It is here because that is true of the
 * inputs and not of the function: a document that is correct only while its inputs stay narrow is a document
 * that breaks the first time one of them widens.
 */
function xml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

/** The path a given kind of address occupies, in one locale. */
function pathFor(type: SitemapEntryType, locale: PublicLocale, slug: string): string {
  switch (type) {
    case 'route': {
      // Already a path, prefixed for Arabic the way every other public address is.
      const prefix = locale === 'ar' ? '/ar' : '';
      // The home page is the one fixed route whose path *is* the prefix, so concatenating would advertise `/ar/`
      // while the page's own canonical says `/ar` — a sitemap naming a non-canonical address is the one mistake a
      // sitemap must not make. `/` itself is already the English answer (0097, owner decision 3).
      if (slug === '/') return prefix === '' ? '/' : prefix;
      return `${prefix}${slug}`;
    }
    case 'blog_post':
      return publicBlogPostPath(locale, slug);
    case 'page':
      return publicCmsPagePath(locale, slug);
    case 'listing':
      return publicListingPath(locale, slug);
    case 'service':
      return publicServicePath(locale, slug);
    case 'category':
      return publicCategoryPath(locale, slug);
    case 'seller':
      return publicSellerPath(locale, slug);
  }
}

export interface SitemapDocumentInput {
  readonly origin: string;
  readonly type: SitemapEntryType;
  readonly entries: readonly SitemapEntry[];
}

/**
 * One child sitemap: a `urlset` with one `url` per address per locale.
 *
 * `lastmod` is the moment the thing behind the address last changed, as the database reported it. It is stated
 * because it is known; nothing here invents a `changefreq` or a `priority`, which are hints rather than facts
 * and which the major crawlers ignore.
 */
export function sitemapDocument({ origin, type, entries }: SitemapDocumentInput): string {
  const urls = entries.flatMap((entry) => {
    // The locales this address answers in. Only a CMS static page can answer in fewer than all of them.
    const locales = entry.locales === undefined ? LOCALES : LOCALES.filter((locale) => entry.locales?.includes(locale));
    return locales.map((locale) => {
      const alternates = locales
        .map(
          (other) =>
            `    <xhtml:link rel="alternate" hreflang="${xml(other)}" href="${xml(`${origin}${pathFor(type, other, entry.slug)}`)}"/>`,
        )
        .join('\n');
      return [
        '  <url>',
        `    <loc>${xml(`${origin}${pathFor(type, locale, entry.slug)}`)}</loc>`,
        `    <lastmod>${xml(entry.updatedAt)}</lastmod>`,
        alternates,
        '  </url>',
      ]
        .filter((line) => line !== '')
        .join('\n');
    });
  });

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<urlset xmlns="${SITEMAP_NAMESPACE}" xmlns:xhtml="${XHTML_NAMESPACE}">`,
    ...urls,
    '</urlset>',
    '',
  ].join('\n');
}

/** The fixed landing routes, as sitemap entries. They are code rather than rows, so they have no `lastmod`. */
export function routeEntries(now: Date): readonly SitemapEntry[] {
  return indexableExactRoutes.map((path) => ({ slug: path, updatedAt: now.toISOString() }));
}

export interface SitemapIndexInput {
  readonly origin: string;
  readonly counts: SitemapCountsResponse;
  /** How many entries the fixed-route child holds. One page, or none when there are no fixed routes. */
  readonly routeEntryCount: number;
}

/**
 * The sitemap index: the children that exist, and nothing else.
 *
 * A kind with no entries names no child. That is the difference between an index a crawler can trust and one
 * that sends it to a series of empty documents — and it is why the API reports a count of zero for an empty kind
 * rather than leaving the kind out, so this can tell "empty" from "unknown".
 */
export function sitemapIndexDocument({ origin, counts, routeEntryCount }: SitemapIndexInput): string {
  const pageSize = counts.pageSize;
  const entriesFor = (type: SitemapEntryType): number =>
    type === 'route' ? routeEntryCount : (counts.counts.find((count) => count.type === type)?.entries ?? 0);

  const children = SITEMAP_ENTRY_TYPES.flatMap((type) => {
    const total = entriesFor(type);
    const pages = Math.ceil(total / pageSize);
    return Array.from({ length: pages }, (_unused, index) => `${origin}/sitemaps/${type}/${index + 1}`);
  });

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<sitemapindex xmlns="${SITEMAP_NAMESPACE}">`,
    ...children.map((url) => ['  <sitemap>', `    <loc>${xml(url)}</loc>`, '  </sitemap>'].join('\n')),
    '</sitemapindex>',
    '',
  ].join('\n');
}

/**
 * `robots.txt`.
 *
 * The authored body is served **verbatim**, because it is an administrator's own crawl policy and this is not
 * the place to reinterpret it. The `Sitemap:` directive is appended when the body does not already name one: it
 * is group-independent, additive, and the one line that cannot be written by hand without knowing the origin.
 *
 * **This document does not need an absolute origin for its own content**, which is why it keeps working while the
 * production domain is undecided: crawl directives are paths, and only the `Sitemap:` line is a URL. With
 * `origin` null that line is simply absent, and everything an administrator authored is still served. There is
 * nothing to announce, because the sitemaps are unavailable until the origin is configured.
 *
 * With nothing authored and no origin the document is a single comment. A comment carries no directive, so it
 * states nothing that is not true — an empty file would say the same thing less clearly, and a `Disallow` list
 * would be inventing policy. What keeps the private surfaces out of an index is not this file but the
 * `X-Robots-Tag: noindex` the middleware already sends on every path outside the public catalogue — a response
 * header a crawler must obey, rather than a request it may ignore.
 */
export function robotsDocument(origin: string | null, settings: RobotsSettingsResponse | null): string {
  const sitemap = origin === null ? null : `Sitemap: ${origin}/sitemap.xml`;
  const authored = settings?.body ?? null;

  if (authored === null) {
    return sitemap === null ? '# No crawl directives are configured.\n' : `${sitemap}\n`;
  }

  const body = authored.replace(/\s+$/u, '');
  // A body that already names a sitemap is left exactly as it is: appending a second directive would be this
  // file arguing with the administrator about which one is right.
  if (sitemap === null || /^\s*sitemap\s*:/imu.test(body)) return `${body}\n`;
  return `${body}\n\n${sitemap}\n`;
}

/** The type a `sitemaps/[type]/[page]` path names, or `null` when it names nothing. */
export function sitemapTypeOf(value: string): SitemapEntryType | null {
  return SITEMAP_ENTRY_TYPES.find((type) => type === value) ?? null;
}

/** Whether a type is one the API enumerates, as opposed to the fixed routes the web app holds itself. */
export function isApiSitemapType(type: SitemapEntryType): type is SitemapApiEntryType {
  return type !== 'route';
}

/** A 1-based page number, or `null`. Checked rather than coerced, so `''` and `'3x'` name no page. */
export function sitemapPageOf(value: string): number | null {
  return /^[1-9][0-9]{0,6}$/.test(value) ? Number(value) : null;
}
