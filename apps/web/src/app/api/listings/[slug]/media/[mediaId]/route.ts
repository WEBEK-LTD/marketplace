import { handleListingMediaWithdraw } from '../../../../../../server/bff';

/**
 * `DELETE /api/listings/:slug/media/:mediaId` — withdraw one photograph (0116).
 *
 * Withdrawn rather than deleted: the object stays in a public bucket, so a row claiming the photograph is
 * gone would claim more than the platform did. When the primary is withdrawn the next one takes its place.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function DELETE(
  request: Request,
  context: { params: Promise<{ slug: string; mediaId: string }> },
): Promise<Response> {
  const { slug, mediaId } = await context.params;
  return handleListingMediaWithdraw(request, slug, mediaId);
}
