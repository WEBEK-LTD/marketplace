import { handleSellerListingUpdate } from '../../../../../../server/bff';

/**
 * `PATCH /api/sellers/me/listings/:slug` — edit one of the caller's own drafts (Phase 6-F).
 *
 * The slug is a route parameter and nothing more: it is checked for shape and percent-encoded by the shared
 * handler, and ownership is resolved in the database from the caller's own account. There is no DELETE here,
 * and none anywhere on this surface — a seller archives, and nobody deletes.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function PATCH(
  request: Request,
  context: { params: Promise<{ slug: string }> },
): Promise<Response> {
  const { slug } = await context.params;
  return handleSellerListingUpdate(request, slug);
}
