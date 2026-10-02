import { readPublicWebOrigin } from '../../server/bff/env';
import { readSitemapCounts } from '../../server/bff/seo';
import { routeEntries, sitemapIndexDocument } from '../../server/seo-documents';

/**
 * `GET /sitemap.xml` — the sitemap index.
 *
 * **A route handler rather than Next.js's `sitemap.ts` metadata convention, because that convention cannot
 * express this document.** It returns a `urlset`: one flat list of addresses. What the specification's route map
 * asks for is an index — `sitemap.ts` with `sitemaps/[type]/[page]` beneath it — and an index is a
 * `sitemapindex` naming child documents, which is a different element with different contents. The companion
 * route only makes sense underneath an index, so an index is what this serves, at the address crawlers look for.
 *
 * The index names only the children that exist: a kind with no entries names none. That is why the API reports
 * zero for an empty kind rather than omitting it — "empty" and "unknown" have to be tellable apart here, or the
 * index would send crawlers to a series of empty documents.
 *
 * Read per request. A sitemap that lags behind the catalogue is a sitemap that advertises addresses which have
 * since stopped being indexable, and the read is one call.
 *
 * **Deferred until a production domain is configured.** Every `<loc>` in a sitemap must be an absolute URL, so
 * unlike `robots.txt` this document cannot be built without an origin, and there is no honest way to guess one —
 * the request `Host` header is a client's to set. So it answers 404 until `PUBLIC_WEB_ORIGIN` is set, which is
 * the truthful answer: there is no sitemap yet. Nothing points at it in the meantime, because `robots.txt`
 * announces a sitemap only when the origin exists. Setting the variable is the only step needed to turn it on.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(): Promise<Response> {
  const origin = readPublicWebOrigin();
  if (origin === null) {
    return new Response('Not Found\n', {
      status: 404,
      headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
    });
  }

  const counts = await readSitemapCounts();

  if (counts === null) {
    // Not an empty index: an empty index tells a crawler the site has no pages, and it may act on that.
    return new Response('Service Unavailable\n', {
      status: 503,
      headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
    });
  }

  const document = sitemapIndexDocument({
    origin,
    counts,
    routeEntryCount: routeEntries(new Date()).length,
  });

  return new Response(document, {
    status: 200,
    headers: {
      'content-type': 'application/xml; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
}
