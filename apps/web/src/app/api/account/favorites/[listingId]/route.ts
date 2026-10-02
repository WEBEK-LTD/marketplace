import { handleRemoveFavorite } from '../../../../../server/bff';

/**
 * `DELETE /api/account/favorites/:listingId` — remove a saved listing (Phase 7-E).
 *
 * The identifier is a route parameter and nothing more: it is checked for shape by the shared handler,
 * and ownership is resolved in the database from the caller's own account.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function DELETE(
  request: Request,
  context: { params: Promise<{ listingId: string }> },
): Promise<Response> {
  const { listingId } = await context.params;
  return handleRemoveFavorite(request, listingId);
}
