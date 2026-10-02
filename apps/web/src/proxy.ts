import {
  buildContentSecurityPolicy,
  createNonce,
  parsePublicCategoryPath,
  parsePublicCmsPagePath,
  parsePublicDetailPath,
  parsePublicSellerPath,
  publicCmsPagePath,
  publicDetailPath,
  robotsHeaderFor,
} from '@repo/config';
import createMiddleware from 'next-intl/middleware';
import { NextResponse, type NextRequest } from 'next/server';
import { routing } from './i18n/routing';
import { readCategory } from './server/bff/categories';
import { readCmsPage } from './server/bff/cms-pages';
import { readListing } from './server/bff/listings';
import { readRedirect } from './server/bff/seo-redirects';
import { readSeller } from './server/bff/sellers';
import { readService } from './server/bff/services';
import { SESSION_COOKIES } from './server/bff/session-cookies';
import { publicWebServes } from './server/public-routes';

const handleLocale = createMiddleware(routing);

/**
 * How a catalogue detail page learns that the slug it was asked for names nothing public.
 *
 * Shared by the listing, service, category and seller pages, and by the CMS static pages: each is resolved
 * here before anything renders, and each needs to know that the 404 has already been issued so it can render
 * its own not-found view without asking the API a second time. Set here and nowhere else, and deleted from
 * every inbound request first, so a browser cannot supply it.
 */
export const CATALOG_OUTCOME_HEADER = 'x-catalog-outcome';

/**
 * The crawler-facing documents. Like the BFF handlers, they have no locale and must reach their own path
 * unrewritten: next-intl would otherwise send `/robots.txt` to `/en/robots.txt`, which no handler serves.
 *
 * They are listed apart from the BFF routes because they are not BFF routes — they are documents a crawler asks
 * for by a fixed address, and a crawler sends no credential. `/sitemaps/` is matched by prefix because the child
 * sitemaps are addressed by type and page.
 */
const SEO_ROUTES = new Set(['/robots.txt', '/sitemap.xml']);
const SEO_PREFIX = '/sitemaps/';

/** Server-side BFF route handlers. They have no locale and must reach their own path unrewritten. */
const BFF_ROUTES = new Set([
  '/api/categories',
  '/api/listings',
  '/api/search',
  '/api/sellers',
  '/api/services',
  '/api/auth/login',
  '/api/auth/logout',
  '/api/auth/refresh',
  '/api/auth/recovery/start',
  '/api/auth/recovery/verify',
  '/api/auth/recovery/reset',
  '/api/auth/contact/phone/start',
  '/api/auth/contact/phone/verify',
  '/api/messaging/conversations',
  '/api/messaging/unread-count',
]);

/**
 * Where a signed-out visitor is stopped, and the only authorization-shaped thing in this file.
 *
 * It is a routing decision, not an authorization decision, and the distinction is exact: this checks
 * whether the browser presents a session cookie *at all*. It does not read a token, verify one, ask the
 * API anything or decide what the holder may do — every one of those stays server-side in the page that
 * needs it, which asks `GET /v1/users/me` and renders a signed-out view when the answer is no. Someone
 * who forges a cookie value gets past this line and no further.
 *
 * The check is on the **refresh** cookie rather than the access cookie, because the access cookie is the
 * short-lived one: fifteen minutes after signing in it is simply gone from the browser while the session
 * is still perfectly alive, and redirecting on its absence would sign people out every quarter of an
 * hour. No refresh cookie means no session to renew, which is the state worth redirecting on.
 */
const PROTECTED_PREFIX = '/dashboard';

function protectedPath(pathname: string): { readonly locale: 'en' | 'ar' } | null {
  if (pathname === PROTECTED_PREFIX || pathname.startsWith(`${PROTECTED_PREFIX}/`)) {
    return { locale: 'en' };
  }
  const arabic = `/ar${PROTECTED_PREFIX}`;
  if (pathname === arabic || pathname.startsWith(`${arabic}/`)) return { locale: 'ar' };
  return null;
}

/** Whether the browser presents a refresh cookie at all. Its value is not read, parsed or trusted. */
function hasRefreshCookie(request: NextRequest): boolean {
  const value = request.cookies.get(SESSION_COOKIES.refresh.name)?.value;
  return typeof value === 'string' && value !== '';
}

/**
 * Locale routing, a per-request CSP nonce, and the per-request robots policy. Never authorization (v5.2).
 * Runs for every path except Next.js build assets, so every HTML response carries both headers.
 *
 * BFF route handlers are the one exception to locale routing: next-intl rewrites an unprefixed path to
 * `/en/…`, which would send `POST /api/auth/login` to a path no route handler serves. Only the handlers
 * this app actually defines are exempted, by exact path, so every other unknown URL — `/api/anything`
 * included — still goes through locale routing and gets the localized, nonce-protected 404.
 *
 * **Robots.** Everything is `noindex` unless the path is a public catalogue route, in which case no header
 * is sent at all and the page's own `robots` metadata decides. That is the whole point of doing this per
 * request: a blanket header is the most restrictive directive on the response, so while it was set on
 * every path it silently overrode the metadata the catalogue pages were already rendering. Login,
 * dashboard, settings, recovery and every unknown URL keep the header, because the rule denies by default.
 *
 * **Listing status.** A listing detail path is resolved here, before anything renders, because this is the
 * last moment at which the response status can still be chosen. Next.js 16 streams: once the page
 * component starts awaiting, the shell and its status line are already on the wire, so a `301` or a `404`
 * decided inside the page arrives as a `200` with the right body — a soft redirect and a soft 404. The
 * resolution itself is not re-implemented here; it is the same `readListing` call, against the same
 * internal API, behind the same internal credential, that the BFF route uses.
 *
 * **The redirect map (8-E), and why it is last.** The approved precedence is LIVE PAGE WINS, and it is enforced by
 * position rather than by a flag: the map is consulted only after every live surface above has had its say, so a
 * path that resolves to a page, a listing, a service, a category, a seller or a CMS page is served and the map is
 * never asked about it. What is left when that is done is a 404 — either a recognised surface with no row, or an
 * address this app's route tree does not serve — and only then may an active entry send the visitor somewhere. An
 * entry can therefore never shadow a live URL, and the slug-history 301s above stay the only authority over the
 * addresses the catalogue itself owns.
 */
export default async function proxy(request: NextRequest) {
  const nonce = createNonce();
  const csp = buildContentSecurityPolicy(nonce);
  // Never trust an inbound copy: this header is ours to set, so any value the client sent is dropped.
  request.headers.delete(CATALOG_OUTCOME_HEADER);
  // Next.js reads the nonce from the request's CSP header while rendering.
  request.headers.set('x-nonce', nonce);
  request.headers.set('content-security-policy', csp);
  // `/api/listings/<slug>` is dynamic, so it is matched by prefix rather than by exact path.
  const path = request.nextUrl.pathname;
  // A crawler-facing document: no locale rewrite, no catalogue resolution, and the robots header below still
  // applies, because none of these three addresses is a public catalogue route.
  const isSeo = SEO_ROUTES.has(path) || path.startsWith(SEO_PREFIX);
  const isBff =
    isSeo ||
    BFF_ROUTES.has(path) ||
    path.startsWith('/api/listings/') ||
    path.startsWith('/api/services/') ||
    path.startsWith('/api/categories/') ||
    path.startsWith('/api/sellers/') ||
    // Phase 5-D: `/api/messaging/conversations/<id>/messages` is dynamic, so the family is matched by
    // prefix exactly as the catalogue's dynamic routes are.
    path.startsWith('/api/messaging/');

  // A signed-out visitor never reaches a protected page (Phase 5-A). Decided here because this is the
  // last moment at which the response can still be a redirect rather than a streamed page: Next.js 16
  // commits the status line as soon as a page starts awaiting, so a redirect chosen inside the page
  // would arrive as a 200 — the same reason catalogue statuses are resolved below rather than in a page.
  const protectedSurface = isBff ? null : protectedPath(path);
  if (protectedSurface !== null && !hasRefreshCookie(request)) {
    const login = new URL(protectedSurface.locale === 'ar' ? '/ar/login' : '/login', request.url);
    const redirect = NextResponse.redirect(login, 307);
    redirect.headers.set('content-security-policy', csp);
    redirect.headers.set('x-robots-tag', 'noindex');
    return redirect;
  }

  // Every catalogue detail surface resolves here, through the reader that owns it. A category has no
  // slug history, so it can only be found or not; the two listing surfaces can also be a redirect.
  const detail = isBff ? null : parsePublicDetailPath(path);
  const category = isBff || detail !== null ? null : parsePublicCategoryPath(path);
  const seller = isBff || detail !== null || category !== null ? null : parsePublicSellerPath(path);
  // A CMS static page is resolved here for the same reason, and only when no catalogue surface owns the path.
  // Its address is one of a closed list, so an unknown URL never reaches this read.
  const staticPage =
    isBff || detail !== null || category !== null || seller !== null ? null : parsePublicCmsPagePath(path);
  // Resolved into its own variable rather than folded in with the catalogue: a static page's `moved` names
  // the address it moved to, while a listing's names the surface that now owns it, and one variable holding
  // both would be a union nothing downstream could narrow.
  const pageOutcome = staticPage === null ? null : await readCmsPage(staticPage.slug, staticPage.locale);
  const outcome =
    detail !== null
      ? detail.surface === 'service'
        ? await readService(detail.slug, detail.locale)
        : await readListing(detail.slug, detail.locale)
      : category !== null
        ? await readCategory(category.slug, category.locale)
        : seller !== null
          ? await readSeller(seller.slug)
          : null;

  if (pageOutcome?.kind === 'moved' && staticPage !== null) {
    // A previous address of a page that has since been renamed. The slug history is kept forever and can
    // never be reassigned to another page, so this is safe to make permanent — and it stays in the locale it
    // arrived in, so an Arabic reader following an old Arabic address is not moved to the English site.
    const target = new URL(publicCmsPagePath(staticPage.locale, pageOutcome.movedTo), request.url);
    const redirect = NextResponse.redirect(target, 301);
    redirect.headers.set('content-security-policy', csp);
    return redirect;
  }

  if (outcome?.kind === 'moved' && detail !== null) {
    // A previous slug, or a slug this surface does not own, is a permanent move. Issued here it is a
    // real 301 with a real Location — and `canonicalType` decides which surface that Location is on, so
    // one listing never ends up with two public addresses.
    const target = new URL(
      publicDetailPath(detail.locale, outcome.canonicalType, outcome.canonicalSlug),
      request.url,
    );
    const redirect = NextResponse.redirect(target, 301);
    redirect.headers.set('content-security-policy', csp);
    return redirect;
  }

  // ------------------------------------------------------------------------------------------------
  // The SEO redirect map (Phase 8-E) — LIVE PAGE WINS, enforced by where this sits
  // ------------------------------------------------------------------------------------------------
  // Everything above has already run: the catalogue's own readers, the CMS page reader, and the slug-history
  // 301s those produce. So by this line the path is known to be one of exactly two things — a recognised public
  // surface whose row is absent, or an address this app's route tree does not serve at all — and both of them
  // answer 404 today. **A live page has already been served and never reaches here**, which is the whole of the
  // approved precedence and the reason it is a question of position rather than of a flag.
  //
  // The two 404s are deliberately treated alike. An operator retiring `/old-campaign` and an operator retiring
  // `/listing/a-discontinued-chair` are doing the same thing, and the map would be hard to explain if it worked
  // for one and not the other.
  //
  // The lookup uses the path **exactly as it arrived**, locale prefix included and nothing stripped. That is the
  // least surprising rule for the person maintaining the map: the address they paste from a report is the address
  // that matches. It also invents no locale behaviour — if an Arabic address needs a redirect, somebody writes
  // one for it.
  const unservedPath =
    !isBff &&
    detail === null &&
    category === null &&
    seller === null &&
    staticPage === null &&
    !publicWebServes(path);
  if (outcome?.kind === 'not_found' || pageOutcome?.kind === 'not_found' || unservedPath) {
    const mapped = await readRedirect(path);
    if (mapped.kind === 'redirect') {
      // The destination is relative by constraint, so it can only ever be an address on this site. The status
      // code is the one the operator stored; this issues it and chooses nothing.
      const target = new URL(mapped.toPath, request.url);
      const redirect = NextResponse.redirect(target, mapped.statusCode);
      redirect.headers.set('content-security-policy', csp);
      return redirect;
    }
  }

  if (outcome?.kind === 'not_found' || pageOutcome?.kind === 'not_found') {
    // Locale routing still decides the rewrite and the language, so the not-found view renders in the
    // language that was asked for; the status and the outcome header are the only things changed. The
    // page reads that header and renders its own not-found view without asking the API a second time.
    request.headers.set(CATALOG_OUTCOME_HEADER, 'not_found');
    const localized = handleLocale(request);
    const missing = new NextResponse(null, { status: 404, headers: localized.headers });
    missing.headers.set('content-security-policy', csp);
    missing.headers.set('x-robots-tag', 'noindex');
    return missing;
  }

  const response = isBff
    ? NextResponse.next({ request: { headers: request.headers } })
    : handleLocale(request);
  response.headers.set('content-security-policy', csp);
  const robots = robotsHeaderFor('web', path);
  if (robots !== null) response.headers.set('x-robots-tag', robots);
  return response;
}

export const config = {
  matcher: ['/((?!_next/|_vercel/).*)'],
};
