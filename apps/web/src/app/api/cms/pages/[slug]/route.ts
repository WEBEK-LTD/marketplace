import { handleCmsPage } from '../../../../../server/bff';

/**
 * `GET /api/cms/pages/:slug` — one public page, or the slug it moved to.
 *
 * The moved answer stays data here rather than becoming a 301, exactly as it is one layer up: a client that
 * followed a redirect it did not expect would end up rendering a different page than it asked for without
 * knowing, which is the hazard the outcome field exists to remove.
 *
 * `runtime = 'nodejs'` because the handler reads server-only configuration. `dynamic = 'force-dynamic'`
 * because a page can be unpublished at any moment and a cached copy would outlive the decision.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(
  request: Request,
  context: { params: Promise<{ slug: string }> },
): Promise<Response> {
  const { slug } = await context.params;
  return handleCmsPage(request, slug);
}
