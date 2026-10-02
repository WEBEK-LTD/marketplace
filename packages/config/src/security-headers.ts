/**
 * Approved browser security policy for the Next.js apps (Phase 1 Step 5).
 * Turnstile and Realtime sources are added in their later phases.
 */
export type AppKind = 'web' | 'admin';

export interface HeaderEntry {
  readonly key: string;
  readonly value: string;
}

const NONCE_PATTERN = /^[A-Za-z0-9+/]{16,}={0,2}$/;

/** 128 random bits, base64-encoded, for one response. */
export function createNonce(): string {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function buildContentSecurityPolicy(nonce: string): string {
  if (!NONCE_PATTERN.test(nonce)) {
    throw new TypeError('Invalid CSP nonce.');
  }
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'`,
    `style-src 'self' 'nonce-${nonce}'`,
    "img-src 'self' blob: data:",
    "font-src 'self'",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    'upgrade-insecure-requests',
  ].join('; ');
}

/**
 * Headers sent on every response (the CSP itself is set per request with its nonce).
 *
 * `X-Robots-Tag` is **not** here for the public web app. Step 5 made the whole site `noindex` with one
 * blanket header, which was right while nothing public existed; now that the catalogue does, a blanket
 * header would silently override the page-level SEO metadata that Phase 4-A and Phase 4-B render, because
 * a header and a `<meta name="robots">` combine to the most restrictive of the two. The web app therefore
 * decides the header per request from {@link robotsHeaderFor}, the way it already decides the CSP.
 *
 * The admin app keeps the blanket header: it is `noindex` permanently, with no route-level exception.
 */
export function staticSecurityHeaders(app: AppKind): readonly HeaderEntry[] {
  return Object.freeze([
    { key: 'Strict-Transport-Security', value: 'max-age=31536000; includeSubDomains' },
    { key: 'X-Content-Type-Options', value: 'nosniff' },
    { key: 'Referrer-Policy', value: app === 'admin' ? 'no-referrer' : 'strict-origin-when-cross-origin' },
    { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
    { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
    ...(app === 'admin' ? [{ key: 'X-Robots-Tag', value: 'noindex' }] : []),
  ]);
}

/** Locale prefixes the public web serves. English sits at the root, Arabic under `/ar`. */
const LOCALE_PREFIXES = Object.freeze(['ar', 'en']);

/**
 * The public catalogue: the only routes whose own page metadata is allowed to decide indexing.
 *
 * Membership here does **not** make a page indexable. It withholds the blanket `noindex` header so that
 * the page's own `robots` metadata is the one that answers — which is how a sold listing stays `noindex`,
 * a cursor page stays `noindex, follow`, and a listing nobody may see stays a 404.
 */
const INDEXABLE_EXACT = Object.freeze(['/categories', '/listings', '/marketplace', '/services']);

/**
 * The fixed public paths that are indexable in their own right, locale prefix aside.
 *
 * These are landing surfaces rather than rows in a table, so they exist in code and a sitemap has to be told
 * about them from here rather than from the API. The home page is deliberately **not** among them: it keeps the
 * blanket `noindex`, so advertising it in a sitemap would be advertising an address we ask not to be indexed.
 *
 * Exported as the same list the robots policy reads, so the sitemap cannot come to list a path that the policy
 * still denies, or miss one it allows.
 */
export const indexableExactRoutes: readonly string[] = INDEXABLE_EXACT;

/** The category landing and seller profile surfaces: public catalogue routes, not listing detail ones. */
const CATEGORY_PREFIX = '/category/';
const SELLER_PREFIX = '/seller/';

/**
 * The public addresses served from the CMS static pages, exactly as the specification's route map fixes them.
 *
 * Every one of these is a single path segment the specification names, and the set is closed: the public web
 * has one route file per entry, so this list and the route tree are two views of the same decision and a test
 * holds them to each other. An authored page whose slug is not here has no public address — which the admin
 * console says out loud rather than leaving an operator to discover it.
 *
 * `become-a-seller` is in the specification's route map among these but is deliberately **absent** here: it is
 * a built page of its own with its own content and tests, not a CMS page, and listing it would have the CMS
 * silently shadow it.
 *
 * Why a fixed list rather than one parametric route. Next.js 16 commits the status line as soon as a page
 * starts awaiting, so a `notFound()` inside a page arrives as a `200` with the right body — measured, not
 * assumed. The status therefore has to be chosen in the middleware, which can only happen for a path shape
 * known before any read. A route matching *any* single segment would additionally have to answer for every
 * unknown URL on the site, which is what the localized 404 already does.
 */
const CMS_PAGE_SLUGS = Object.freeze([
  'about',
  'accessibility',
  'buyer-terms',
  'cancellation-policy',
  'commission',
  'commission-policy',
  'content-policy',
  'contact',
  'cookies',
  'faq',
  'fraud-prevention',
  'help',
  'intellectual-property',
  'privacy',
  'prohibited-items',
  'refund-policy',
  'safety',
  'seller-guidelines',
  'seller-policy',
  'seller-terms',
  'terms',
  'verification',
] as const);

/** One of the public addresses served from the CMS static pages. */
export type CmsPageSlug = (typeof CMS_PAGE_SLUGS)[number];

/** The public addresses served from the CMS static pages, in a stable order. */
export const cmsPageSlugs: readonly CmsPageSlug[] = CMS_PAGE_SLUGS;

/** Whether `slug` is one of the addresses the public web serves from the CMS. */
export function isCmsPageSlug(slug: string): slug is CmsPageSlug {
  return (CMS_PAGE_SLUGS as readonly string[]).includes(slug);
}

/** The two public detail surfaces, and the path prefix each one owns. */
const DETAIL_PREFIXES = Object.freeze([
  { prefix: '/listing/', surface: 'product' },
  { prefix: '/service/', surface: 'service' },
] as const);

/**
 * The slug shape the database enforces (`listings_slug_format`), narrowed to what may appear in a path.
 * Anything with a dot, a percent-escape or a slash in it is not a slug, so it is not a catalogue route —
 * which keeps a crafted path from claiming the exemption on the strength of its prefix alone.
 */
const SLUG_SEGMENT = /^[a-z0-9][a-z0-9-]*$/;

/** A public path split into the locale it names and what follows it. */
interface SplitPath {
  readonly locale: PublicLocale;
  readonly rest: string;
}

/** The locales the public web serves. English is the default and sits at the root. */
export type PublicLocale = 'en' | 'ar';

function splitLocale(pathname: string): SplitPath | null {
  if (typeof pathname !== 'string' || !pathname.startsWith('/')) return null;

  // Query and fragment never reach a pathname, but a trailing slash can.
  const path = pathname.length > 1 && pathname.endsWith('/') ? pathname.slice(0, -1) : pathname;

  const firstSlash = path.indexOf('/', 1);
  const head = firstSlash === -1 ? path.slice(1) : path.slice(1, firstSlash);
  const prefixed = LOCALE_PREFIXES.includes(head);
  const rest = prefixed ? path.slice(head.length + 1) : path;
  if (rest === '') return null;

  return { locale: prefixed && head === 'ar' ? 'ar' : 'en', rest };
}

/** Which public surface a detail path belongs to. */
export type PublicSurface = 'product' | 'service';

export interface PublicDetailPath {
  readonly locale: PublicLocale;
  readonly slug: string;
  readonly surface: PublicSurface;
}

/**
 * The listing or service named by a public detail path, or `null` when the path is not one.
 *
 * This is the single definition of what a detail URL looks like. The robots policy and the status
 * routing both read it, so neither can drift from the other about which paths are detail pages — and a
 * path that fails the slug shape is not a detail page for either of them.
 */
export function parsePublicDetailPath(pathname: string): PublicDetailPath | null {
  const split = splitLocale(pathname);
  if (split === null) return null;

  for (const { prefix, surface } of DETAIL_PREFIXES) {
    if (!split.rest.startsWith(prefix)) continue;
    const slug = split.rest.slice(prefix.length);
    return SLUG_SEGMENT.test(slug) ? { locale: split.locale, slug, surface } : null;
  }
  return null;
}

/** The listing named by a public listing path, or `null`. A service path is not a listing path. */
export function parsePublicListingPath(pathname: string): { locale: PublicLocale; slug: string } | null {
  const found = parsePublicDetailPath(pathname);
  return found?.surface === 'product' ? { locale: found.locale, slug: found.slug } : null;
}

/**
 * The category named by a public category landing path, or `null`.
 *
 * Kept apart from {@link parsePublicDetailPath}, which answers for the two *listing* surfaces and whose
 * result decides cross-surface redirects. A category is neither a product nor a service, so folding it
 * into that union would make it a candidate for a redirect it can never take.
 */
export function parsePublicCategoryPath(pathname: string): { locale: PublicLocale; slug: string } | null {
  const split = splitLocale(pathname);
  if (split === null || !split.rest.startsWith(CATEGORY_PREFIX)) return null;

  const slug = split.rest.slice(CATEGORY_PREFIX.length);
  return SLUG_SEGMENT.test(slug) ? { locale: split.locale, slug } : null;
}

/** The public path of a category landing page, in the locale given. */
export function publicCategoryPath(locale: PublicLocale, slug: string): string {
  return `${locale === 'ar' ? '/ar' : ''}${CATEGORY_PREFIX}${encodeURIComponent(slug)}`;
}

/**
 * The seller named by a public profile path, or `null`.
 *
 * Kept apart from {@link parsePublicDetailPath} for the same reason a category is: a seller is neither a
 * product nor a service, so it must not become a candidate for a cross-surface redirect it can never
 * take. The slug shape is the database's own (`seller_profiles_slug_format`), narrowed to a path segment.
 */
export function parsePublicSellerPath(pathname: string): { locale: PublicLocale; slug: string } | null {
  const split = splitLocale(pathname);
  if (split === null || !split.rest.startsWith(SELLER_PREFIX)) return null;

  const slug = split.rest.slice(SELLER_PREFIX.length);
  return SLUG_SEGMENT.test(slug) ? { locale: split.locale, slug } : null;
}

/** The public path of a seller profile, in the locale given. */
export function publicSellerPath(locale: PublicLocale, slug: string): string {
  return `${locale === 'ar' ? '/ar' : ''}${SELLER_PREFIX}${encodeURIComponent(slug)}`;
}

/**
 * The CMS static page named by a public path, or `null` when the path is not one.
 *
 * Kept apart from the catalogue parsers for the same reason a category is kept apart from a listing: a static
 * page is on no detail surface and can never be the target of a cross-surface redirect.
 *
 * The match is against the closed list, not a slug shape, so `/nope` is not a static page and keeps the
 * localized 404 that every unknown address gets. A path with anything after the segment is not one either.
 */
export function parsePublicCmsPagePath(pathname: string): { locale: PublicLocale; slug: CmsPageSlug } | null {
  const split = splitLocale(pathname);
  if (split === null) return null;

  const slug = split.rest.slice(1);
  return isCmsPageSlug(slug) ? { locale: split.locale, slug } : null;
}

/** The public path of a CMS static page, in the locale given. */
export function publicCmsPagePath(locale: PublicLocale, slug: string): string {
  return `${locale === 'ar' ? '/ar' : ''}/${encodeURIComponent(slug)}`;
}

/** The service named by a public service path, or `null`. A listing path is not a service path. */
export function parsePublicServicePath(pathname: string): { locale: PublicLocale; slug: string } | null {
  const found = parsePublicDetailPath(pathname);
  return found?.surface === 'service' ? { locale: found.locale, slug: found.slug } : null;
}

/** The public path of a listing or a service, on the surface that owns it. */
export function publicDetailPath(locale: PublicLocale, surface: PublicSurface, slug: string): string {
  const prefix = surface === 'service' ? '/service/' : '/listing/';
  return `${locale === 'ar' ? '/ar' : ''}${prefix}${encodeURIComponent(slug)}`;
}

/** The public path of a listing, in the locale given. English has no prefix (`localePrefix: 'as-needed'`). */
export function publicListingPath(locale: PublicLocale, slug: string): string {
  return publicDetailPath(locale, 'product', slug);
}

/** The public path of a service, in the locale given. */
export function publicServicePath(locale: PublicLocale, slug: string): string {
  return publicDetailPath(locale, 'service', slug);
}

/**
 * Whether `pathname` is a public catalogue route.
 *
 * Deny by default: anything this function does not recognise keeps the blanket `noindex`. Adding a public
 * surface is therefore a deliberate edit here, and forgetting to make one indexable is a missing page in
 * a search index — not an admin console that leaked into one.
 */
export function isPublicCatalogRoute(pathname: string): boolean {
  const split = splitLocale(pathname);
  if (split === null) return false;
  if (INDEXABLE_EXACT.includes(split.rest)) return true;
  // One slug-shaped segment only: `/listing/a-chair` is a listing, `/listing/a-chair/edit` is not.
  return (
    parsePublicDetailPath(pathname) !== null ||
    parsePublicCategoryPath(pathname) !== null ||
    parsePublicSellerPath(pathname) !== null ||
    // A static page carries no blanket header, because whether it may be indexed is the administrator's own
    // decision, stored on the page. A blanket header is the most restrictive directive on the response and
    // would silently override it — the same trap the catalogue surfaces were pulled out of.
    parsePublicCmsPagePath(pathname) !== null
  );
}

/**
 * The `X-Robots-Tag` value for a request, or `null` when the route's own metadata decides instead.
 *
 * The admin app never reaches the `null` branch.
 */
export function robotsHeaderFor(app: AppKind, pathname: string): string | null {
  if (app === 'admin') return 'noindex';
  return isPublicCatalogRoute(pathname) ? null : 'noindex';
}
