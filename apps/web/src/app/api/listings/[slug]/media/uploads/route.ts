import { handleListingMediaUpload } from '../../../../../../server/bff';

/**
 * `POST /api/listings/:slug/media/uploads` — authorize the four objects of one photograph (0116).
 *
 * The response carries four short-lived signed upload URLs, one per object. They are passed to the browser
 * that asked for them and kept nowhere: not in a log, not in a cache — the handler sets `no-store`. The bytes
 * themselves never come through this origin; the browser PUTs each object straight to the provider.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(
  request: Request,
  context: { params: Promise<{ slug: string }> },
): Promise<Response> {
  const { slug } = await context.params;
  return handleListingMediaUpload(request, slug);
}
