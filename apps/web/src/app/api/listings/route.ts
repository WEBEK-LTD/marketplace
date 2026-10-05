import { handleListings } from '../../../server/bff';

/**
 * `GET /api/listings` — one page of the public browse list.
 *
 * `dynamic = 'force-dynamic'` because a listing's published state can change at any moment and C11
 * makes moderation-sensitive responses non-cacheable; a cached page could offer a withdrawn listing.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<Response> {
  return handleListings(request);
}
