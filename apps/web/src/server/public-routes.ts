import 'server-only';

/**
 * Which addresses this app's own route tree serves (Phase 8-E).
 *
 * **Why this exists.** The approved precedence for the SEO redirect map is LIVE PAGE WINS: the map may be consulted
 * only for a path that would otherwise answer 404. Deciding that requires knowing whether the app serves the path
 * at all, and the only place that can be decided is the middleware — Next.js 16 commits the status line as soon as
 * a page starts awaiting, so by the time a route file could tell us it has nothing to render, the response has
 * already begun.
 *
 * **This is not a new routing rule and it owns nothing.** It is a restatement of the route tree under
 * `src/app/[locale]`, kept honest the same way `cmsPageSlugs` is kept honest: a test walks the directory, derives
 * the routes from the `page.tsx` files it finds, and asserts that this file and the tree are the same set in both
 * directions. A route added or removed without touching this file fails that test. Nothing here decides who may
 * open a page, whether a row exists, or what a page renders — the pages, the readers and the database keep all of
 * that, exactly as before.
 *
 * **Served means routed, not found.** `/listing/a-chair` is served whether or not that listing exists: a path the
 * catalogue owns is resolved by the catalogue's own reader in the middleware, and a missing row becomes the
 * existing 404 there. This answers only the narrower question — is there a route file for this shape — so the two
 * ways a path can 404 stay separate and both reach the map.
 */

/** The locale prefix the Arabic site carries. English is served at the root. */
const ARABIC_PREFIX = '/ar';

/**
 * Every fixed address the route tree serves, relative to the locale.
 *
 * Sorted, and exhaustive by test rather than by inspection.
 */
const SERVED_EXACT: ReadonlySet<string> = new Set([
  '/',
  '/about',
  '/accessibility',
  '/become-a-seller',
  '/buyer-terms',
  '/cancellation-policy',
  '/categories',
  '/commission',
  '/commission-policy',
  '/contact',
  '/content-policy',
  '/cookies',
  '/dashboard',
  '/dashboard/addresses',
  '/dashboard/favorites',
  '/dashboard/messages',
  '/dashboard/notifications',
  '/dashboard/offers',
  '/dashboard/profile',
  '/dashboard/reports',
  '/dashboard/saved-searches',
  '/dashboard/security',
  '/dashboard/seller',
  '/dashboard/seller/analytics',
  '/dashboard/seller/earnings',
  '/dashboard/seller/listings',
  '/dashboard/seller/offers',
  '/dashboard/seller/orders',
  '/dashboard/seller/profile',
  '/dashboard/seller/promotions',
  '/dashboard/seller/reviews',
  '/dashboard/seller/service-requests',
  '/dashboard/seller/services',
  '/dashboard/seller/verification',
  '/dashboard/service-requests',
  '/dashboard/settings',
  '/dashboard/support',
  '/faq',
  '/forgot-password',
  '/forgot-password/verify',
  '/fraud-prevention',
  '/help',
  '/intellectual-property',
  '/listings',
  '/login',
  '/marketplace',
  '/privacy',
  '/prohibited-items',
  '/refund-policy',
  '/register',
  '/register/verify',
  '/reset-password',
  '/safety',
  '/search',
  '/seller-guidelines',
  '/seller-policy',
  '/seller-terms',
  '/services',
  '/terms',
  '/verification',
]);

/**
 * Every address shape the route tree serves with one further segment.
 *
 * Each entry is a route file with exactly one dynamic segment at the end, so one segment is what it serves and two
 * are not: `/listing/a-chair` is a route and `/listing/a-chair/edit` is not. There is no catch-all anywhere in the
 * tree, which is what makes "not in these two sets" a complete answer.
 */
const SERVED_ONE_SEGMENT: readonly string[] = Object.freeze([
  '/category/',
  '/dashboard/messages/',
  '/dashboard/seller/listings/',
  '/dashboard/seller/service-requests/',
  '/dashboard/seller/services/',
  '/dashboard/service-requests/',
  '/dashboard/support/',
  '/listing/',
  '/seller/',
  '/service/',
]);

/** The two sets, exported so the test that walks the route tree can compare against them directly. */
export const PUBLIC_SERVED_EXACT_PATHS: readonly string[] = Object.freeze([...SERVED_EXACT].sort());
export const PUBLIC_SERVED_ONE_SEGMENT_PREFIXES = SERVED_ONE_SEGMENT;

/** The locale-relative part of a path, or null when the path is not one this app's tree could serve. */
function withoutLocale(pathname: string): string | null {
  if (pathname === ARABIC_PREFIX) return '/';
  const rest = pathname.startsWith(`${ARABIC_PREFIX}/`) ? pathname.slice(ARABIC_PREFIX.length) : pathname;
  return rest.startsWith('/') ? rest : null;
}

/**
 * Whether this app's route tree serves `pathname`.
 *
 * A trailing slash is tolerated on a fixed address, because that is the same address; it is not tolerated on a
 * dynamic one, because an empty final segment names no row.
 */
export function publicWebServes(pathname: string): boolean {
  const rest = withoutLocale(pathname);
  if (rest === null) return false;

  const trimmed = rest.length > 1 && rest.endsWith('/') ? rest.slice(0, -1) : rest;
  if (SERVED_EXACT.has(trimmed)) return true;

  for (const prefix of SERVED_ONE_SEGMENT) {
    if (!trimmed.startsWith(prefix)) continue;
    const segment = trimmed.slice(prefix.length);
    // Exactly one further segment, and not an empty one.
    if (segment !== '' && !segment.includes('/')) return true;
  }
  return false;
}
