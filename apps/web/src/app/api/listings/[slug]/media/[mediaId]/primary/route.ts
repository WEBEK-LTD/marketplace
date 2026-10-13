import { handleListingMediaPrimary } from '../../../../../../../server/bff';

/**
 * `PUT /api/listings/:slug/media/:mediaId/primary` — the photograph the card shows (0116).
 *
 * One statement upstream sets this one and unsets the others, so a listing is never without a primary or
 * with two.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function PUT(
  request: Request,
  context: { params: Promise<{ slug: string; mediaId: string }> },
): Promise<Response> {
  const { slug, mediaId } = await context.params;
  return handleListingMediaPrimary(request, slug, mediaId);
}
