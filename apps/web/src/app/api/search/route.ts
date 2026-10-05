import { handleSearch } from '../../../server/bff';

/**
 * `GET /api/search` — one page of public search results.
 *
 * `dynamic = 'force-dynamic'` because a listing's published state can change at any moment and C11 makes
 * moderation-sensitive responses non-cacheable; a cached result page could offer a withdrawn listing.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<Response> {
  return handleSearch(request);
}
