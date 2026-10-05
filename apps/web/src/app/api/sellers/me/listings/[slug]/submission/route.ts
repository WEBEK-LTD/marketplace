import { handleSellerListingSubmit } from '../../../../../../../server/bff';

/**
 * `POST /api/sellers/me/listings/:slug/submission` — submit one draft for review (Phase 6-F).
 *
 * Its own sub-resource rather than a status field on the PATCH, and it reads no body at all: a status a
 * caller could send would be a status a caller could choose.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(
  request: Request,
  context: { params: Promise<{ slug: string }> },
): Promise<Response> {
  const { slug } = await context.params;
  return handleSellerListingSubmit(request, slug);
}
