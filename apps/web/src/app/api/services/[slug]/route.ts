import { handleService } from '../../../../server/bff';

/**
 * `GET /api/services/:slug` — one public service, a 301 to the URL that owns it, or a 404.
 *
 * The slug is a route parameter rather than a query field, so the browser's URL matches the API's and
 * a redirect can name the new one directly.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(
  request: Request,
  context: { params: Promise<{ slug: string }> },
): Promise<Response> {
  const { slug } = await context.params;
  return handleService(request, slug);
}
