import { readPublicWebOrigin } from '../../../../server/bff/env';
import { readSitemapPage } from '../../../../server/bff/seo';
import {
  isApiSitemapType,
  routeEntries,
  sitemapDocument,
  sitemapPageOf,
  sitemapTypeOf,
} from '../../../../server/seo-documents';

/**
 * `GET /sitemaps/:type/:page` — one child sitemap, exactly as the specification's route map names it.
 *
 * Every address this lists is one a crawler may index: what belongs in a sitemap is decided by the named readers
 * of migration 0086, which call the same predicates the public pages resolve through. A sold, expired or archived
 * listing stays reachable at its own address and is absent from here; a category needs every ancestor active; a
 * page must be published, indexable and written in some language.
 *
 * **`route` is served without touching the API.** The fixed landing surfaces — `/listings`, `/services`,
 * `/categories`, `/marketplace` — exist in code rather than in a table, and the list comes from the same place the
 * robots policy reads, so the sitemap cannot list a fixed path the policy still denies.
 *
 * An unknown type or a page number that is not one is a 404: there is no such sitemap. A page past the end of a
 * real set is an empty `urlset` under a 200, because the index a crawler is following may be minutes old and
 * finding nothing there is both true and harmless.
 *
 * **Deferred until a production domain is configured**, for the same reason the index is: every `<loc>` must be
 * an absolute URL and nothing here will guess an origin from a request header. Until `PUBLIC_WEB_ORIGIN` is set
 * these answer 404, which is also what the index above answers, so there is no state in which an index names a
 * child that is not there.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function unavailable(): Response {
  return new Response('Service Unavailable\n', {
    status: 503,
    headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
  });
}

function notFound(): Response {
  return new Response('Not Found\n', {
    status: 404,
    headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
  });
}

export async function GET(
  _request: Request,
  context: { params: Promise<{ type: string; page: string }> },
): Promise<Response> {
  const { type: rawType, page: rawPage } = await context.params;
  const type = sitemapTypeOf(rawType);
  const page = sitemapPageOf(rawPage);
  if (type === null || page === null) return notFound();

  const origin = readPublicWebOrigin();
  // No production domain yet: the same 404 as a sitemap that does not exist, which is what this is.
  if (origin === null) return notFound();

  if (!isApiSitemapType(type)) {
    // The fixed routes: one page, held in code. A page beyond the first is empty rather than absent, for the
    // same reason it is on every other kind.
    const entries = page === 1 ? routeEntries(new Date()) : [];
    return xmlResponse(sitemapDocument({ origin, type, entries }));
  }

  const found = await readSitemapPage(type, page);
  if (found === null) return unavailable();

  return xmlResponse(sitemapDocument({ origin, type, entries: found.entries }));
}

function xmlResponse(document: string): Response {
  return new Response(document, {
    status: 200,
    headers: {
      'content-type': 'application/xml; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
}
