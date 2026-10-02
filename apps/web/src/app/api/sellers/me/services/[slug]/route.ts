import { handleSellerServiceUpdate } from '../../../../../../server/bff';

/**
 * `PATCH /api/sellers/me/services/:slug` — edit one of the caller's own service drafts (Phase 6-G).
 *
 * The slug is a route parameter and nothing more: it is checked for shape and percent-encoded by the shared
 * handler, and ownership — and whether the listing at that address is a service at all — is resolved in the
 * database from the caller's own account. There is no DELETE here, and none anywhere on this surface.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function PATCH(
  request: Request,
  context: { params: Promise<{ slug: string }> },
): Promise<Response> {
  const { slug } = await context.params;
  return handleSellerServiceUpdate(request, slug);
}
