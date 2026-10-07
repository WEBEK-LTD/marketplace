/**
 * Approved browser security policy for the Next.js app (Phase 1 Step 5).
 * Turnstile and Realtime sources are added in their later phases.
 */

/**
 * Which **surface** of the single application a response belongs to.
 *
 * It was a choice of application until 0108, when the console moved from its own origin to `/admin` on the public
 * one. The name is kept because renaming it would churn twenty call sites for no behavioural gain, but it now
 * names a surface: `web` is the public marketplace at `/`, `admin` is the staff console at `/admin`, and both are
 * served by one Next.js runtime.
 */
export type AppKind = 'web' | 'admin';

/**
 * Where the staff console is mounted on the public origin (0108, owner-approved topology revision).
 *
 * `www.example.com` → marketplace, `www.example.com/admin` → console. There is no `admin.` hostname.
 *
 * **This is the single definition of the mount point.** The proxy, the robots policy, the navigation policy and the
 * served-route reservation all read it, so none of them can come to disagree with the others about which paths
 * belong to the console — and moving the console would be one edit here rather than four that must be kept in step.
 */
export const ADMIN_SURFACE_PREFIX = '/admin';

/**
 * Whether `pathname` belongs to the staff console.
 *
 * Whole-segment matching, exactly as every other path predicate in this file: `/administrator` is not the console,
 * and neither is `/ar/admin` — the console has no locale prefix, because its language comes from the reader's own
 * profile rather than from the URL.
 */
export function isAdminSurfacePath(pathname: string): boolean {
  if (typeof pathname !== 'string') return false;
  return pathname === ADMIN_SURFACE_PREFIX || pathname.startsWith(`${ADMIN_SURFACE_PREFIX}/`);
}

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
    ...sharedSecurityHeaders(),
    referrerPolicyFor(app),
    ...(app === 'admin' ? [{ key: 'X-Robots-Tag', value: 'noindex' }] : []),
  ]);
}

/**
 * The headers whose value is identical on every surface, and which may therefore be declared once for the whole
 * origin in `next.config.ts` (0108).
 *
 * The split exists because the two surfaces now share an origin. `Referrer-Policy` and `X-Robots-Tag` differ
 * between them, and a Next.js `headers()` entry scoped to `/admin/:path*` would be applied *in addition to* the
 * site-wide one rather than instead of it — leaving two conflicting values of the same key on every console
 * response. Those two are emitted from the proxy, which decides per request; these four are emitted from the
 * config, which cannot get them wrong because there is nothing to decide.
 *
 * `Strict-Transport-Security` is deliberately among them: it is a property of the host, and the host is now one.
 */
export function sharedSecurityHeaders(): readonly HeaderEntry[] {
  return Object.freeze([
    { key: 'Strict-Transport-Security', value: 'max-age=31536000; includeSubDomains' },
    { key: 'X-Content-Type-Options', value: 'nosniff' },
    { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
    { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
  ]);
}

/**
 * The `Referrer-Policy` for one surface — `no-referrer` for the console, the approved public value otherwise.
 *
 * Both values are the specification's own (Phase 1 Step 5). What 0108 changes is only where they are emitted.
 */
export function referrerPolicyFor(app: AppKind): HeaderEntry {
  return Object.freeze({
    key: 'Referrer-Policy',
    value: app === 'admin' ? 'no-referrer' : 'strict-origin-when-cross-origin',
  });
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
const INDEXABLE_EXACT = Object.freeze([
  // 0097, owner decision 1. The blog index decides its own robots value through its own metadata, exactly as the
  // catalogue landings and a CMS static page do — it already states `index` at its canonical address and
  // `noindex, follow` once `?category=`, `?tag=` or `?cursor=` narrows it, which is 8-D's rule for every filtered
  // view. Until this entry existed the blanket header denied both answers, and `blog_posts.is_indexable` was a
  // column no crawler could ever see the effect of.
  '/blog',
  '/categories',
  '/listings',
  '/marketplace',
  '/services',
]);

/**
 * The fixed public paths that are indexable in their own right **and listed in a sitemap**, locale prefix aside.
 *
 * These are landing surfaces rather than rows in a table, so they exist in code and a sitemap has to be told about
 * them from here rather than from the API.
 *
 * **The home page is now among them** (0097, owner decision 3). 0093 made `/` decide its own robots value and left
 * sitemap membership as a separate owner decision; that decision has now been made, so `/` is advertised. It is
 * added here rather than to `INDEXABLE_EXACT` because the robots policy already answers for it earlier — before
 * `splitLocale`, which refuses a path with nothing after the locale prefix — and widening that list would also
 * change the answer for paths that merely normalise to `/`, such as `//`, which is not part of this decision.
 *
 * The invariant the two lists used to share by being one list is kept as an assertion instead: every path here is
 * one the robots policy lets the page decide for, so the sitemap cannot come to list an address the policy still
 * denies.
 */
export const indexableExactRoutes: readonly string[] = Object.freeze(['/', ...INDEXABLE_EXACT]);

/** The category landing and seller profile surfaces: public catalogue routes, not listing detail ones. */
const CATEGORY_PREFIX = '/category/';
const SELLER_PREFIX = '/seller/';
const BLOG_PREFIX = '/blog/';

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

/**
 * The blog post named by a public path, or `null` when the path is not one (0092).
 *
 * Kept apart from the catalogue parsers for the same reason a CMS page is: a post is on no detail surface and can
 * never be the target of a cross-surface redirect. The slug shape is the database's own
 * (`blog_posts_slug_format`), narrowed to a single path segment — so `/blog` itself is not a post, and neither is
 * a path with anything after the segment.
 */
export function parsePublicBlogPostPath(pathname: string): { locale: PublicLocale; slug: string } | null {
  const split = splitLocale(pathname);
  if (split === null || !split.rest.startsWith(BLOG_PREFIX)) return null;

  const slug = split.rest.slice(BLOG_PREFIX.length);
  return SLUG_SEGMENT.test(slug) ? { locale: split.locale, slug } : null;
}

/** The public path of one blog post, in the locale given. */
export function publicBlogPostPath(locale: PublicLocale, slug: string): string {
  return `${locale === 'ar' ? '/ar' : ''}${BLOG_PREFIX}${encodeURIComponent(slug)}`;
}

/** The public path of the blog index, in the locale given. */
export function publicBlogIndexPath(locale: PublicLocale): string {
  return `${locale === 'ar' ? '/ar' : ''}/blog`;
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
  // The staff console is never a public catalogue route (0108). It already was not one — `/admin` is not a CMS slug
  // and `/admin/users` matches no parser — but the answer arrived by omission, and an administrator authoring a CMS
  // page whose slug happened to be `admin` would have flipped it. Stated outright, it cannot be flipped: the console
  // keeps its blanket `noindex` whatever else is ever added below.
  if (isAdminSurfacePath(pathname)) return false;

  // The home page (0093, owner decision E). Its own metadata decides whether it may be indexed, exactly as a CMS
  // static page's does, so it must not carry the blanket header — a blanket `noindex` is the most restrictive
  // directive on the response and would silently override the page's own answer.
  //
  // Checked before `splitLocale`, because that helper refuses a path with nothing after the locale prefix: `/ar`
  // leaves an empty remainder and would never reach a check below it. `withoutLocale` in the web app's served-route
  // module makes the same allowance for the same reason.
  //
  // Checked here rather than added to INDEXABLE_EXACT because `splitLocale` refuses `/ar`, and because widening
  // that list would also change the answer for paths that merely normalise to `/`. `indexableExactRoutes` carries
  // `/` for the sitemap instead (0097, owner decision 3).
  if (pathname === '/' || pathname === '/ar' || pathname === '/ar/') return true;

  const split = splitLocale(pathname);
  if (split === null) return false;
  if (INDEXABLE_EXACT.includes(split.rest)) return true;
  // One slug-shaped segment only: `/listing/a-chair` is a listing, `/listing/a-chair/edit` is not.
  return (
    parsePublicDetailPath(pathname) !== null ||
    parsePublicCategoryPath(pathname) !== null ||
    parsePublicSellerPath(pathname) !== null ||
    // A blog post carries no blanket header, for the same reason a static page does not: whether it may be indexed
    // is the administrator's own decision, stored on the post as `is_indexable`, and the post page already carries
    // it through. A blanket header is the most restrictive directive on the response, so while this check was
    // missing the column could be set either way and no crawler would ever see the difference (0097).
    parsePublicBlogPostPath(pathname) !== null ||
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

/* ------------------------------------------------------------------------------------------------ */
/* Which surfaces carry the site's own navigation (0094)                                             */
/* ------------------------------------------------------------------------------------------------ */

/**
 * The account and authentication surfaces, which keep the plain chrome (owner decision 2).
 *
 * Signing in, registering, recovering an account and everything under the dashboard are the authenticated area's
 * own surfaces. A composed header there would put editorial links across somebody's account pages, which is not
 * what the navigation is for — so those paths keep the header and footer the application has always rendered.
 *
 * Matched as whole segments, exactly as every other list in this file is: `/loginsomething` is not `/login`.
 */
export const ACCOUNT_AREA_PREFIXES = Object.freeze([
  '/dashboard',
  '/login',
  '/register',
  '/forgot-password',
  '/reset-password',
] as const);

/**
 * Whether the composed navigation belongs on this path (0094, owner decision 2).
 *
 * True for the public site — the home page, the catalogue, the CMS pages, the blog, search and the 404 — and false
 * for the account and authentication surfaces above.
 *
 * The locale prefix is stripped by hand rather than with {@link splitLocale}, because that helper refuses a path
 * with nothing after the prefix: `/ar` leaves an empty remainder and would be judged as if it were not localized.
 */
export function rendersSiteNavigation(pathname: string): boolean {
  if (typeof pathname !== 'string' || !pathname.startsWith('/')) return false;

  // The staff console carries its own chrome and never the marketplace's (0108). Stated here rather than added to
  // ACCOUNT_AREA_PREFIXES, which is about the account and authentication area and would be the wrong home for it:
  // the console is not an account surface, it is a different surface of the application altogether. Without this the
  // deny-by-default below would answer `true` and put editorial header and footer links across the console.
  if (isAdminSurfacePath(pathname)) return false;

  const trimmed = pathname.length > 1 && pathname.endsWith('/') ? pathname.slice(0, -1) : pathname;
  const rest = trimmed === '/ar' ? '/' : trimmed.startsWith('/ar/') ? trimmed.slice(3) : trimmed;

  return !ACCOUNT_AREA_PREFIXES.some((prefix) => rest === prefix || rest.startsWith(`${prefix}/`));
}
