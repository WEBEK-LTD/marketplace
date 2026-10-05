import { readPublicWebOrigin } from '../../server/bff/env';
import { readRobotsSettings } from '../../server/bff/seo';
import { robotsDocument } from '../../server/seo-documents';

/**
 * `GET /robots.txt`.
 *
 * **A route handler rather than Next.js's `robots.ts` metadata convention, and for a reason.** That convention
 * takes a structured object — user agents, allow and disallow lists — and renders it. The body here is text an
 * administrator authored in `seo_settings`, and it has to reach a crawler exactly as it was written; passing it
 * through a structured representation would mean parsing somebody's crawl policy in order to re-emit it, and
 * every parse is a chance to change what they meant. So the document is built as text and served as text.
 *
 * Read per request, never cached: a change to the authored body should take effect without a deployment, which
 * is the whole point of its being authored. The document is small and read once by each crawler visit.
 *
 * **It is served whether or not a production domain is configured.** This document needs no absolute URL of its
 * own — crawl directives are paths — so only the `Sitemap:` line depends on the origin, and that line is absent
 * while the origin is. Everything an administrator authored is served either way.
 *
 * A failure to read the authored body is a 503, not an empty document, and the direction matters: serving an
 * empty `robots.txt` means "no restrictions", so a transient failure would quietly open whatever an administrator
 * had disallowed. "Come back later" claims nothing.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(): Promise<Response> {
  const origin = readPublicWebOrigin();
  const settings = await readRobotsSettings();

  if (settings === null) {
    return new Response('Service Unavailable\n', {
      status: 503,
      headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
    });
  }

  return new Response(robotsDocument(origin, settings), {
    status: 200,
    headers: {
      'content-type': 'text/plain; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
}
