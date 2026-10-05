import { handleSellerVocabularyAttributesSave } from '../../../../../../../server/bff';

/**
 * `POST /api/sellers/me/services/:slug/attributes` — replace every answer on one of the caller's own drafts (Phase 8-C).
 *
 * A `POST` rather than a `PUT`, because nothing under the seller's own namespace replaces a resource wholesale
 * with one — the save does replace the whole set, and the method the API offers is the one that is used.
 *
 * The surface is this route's, not the request's: `'services'` is passed to the handler and there is no field a
 * body could use to claim the other one. The slug is checked for shape and percent-encoded by the shared handler;
 * ownership is resolved in the database from the caller's own account.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(
  request: Request,
  context: { params: Promise<{ slug: string }> },
): Promise<Response> {
  const { slug } = await context.params;
  return handleSellerVocabularyAttributesSave(request, 'services', slug);
}
