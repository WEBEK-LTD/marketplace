import { handleSellerListingArchive } from '../../../../../../../server/bff';

/**
 * `POST /api/sellers/me/listings/:slug/archive` — withdraw one live listing from sale (Phase 6-F).
 *
 * Archival, not deletion: the listing's public page stays reachable and reports that it is no longer
 * available, which is the listing schema's own behaviour. No body is read.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(
  request: Request,
  context: { params: Promise<{ slug: string }> },
): Promise<Response> {
  const { slug } = await context.params;
  return handleSellerListingArchive(request, slug);
}
