import { handleAddFavorite } from '../../../../server/bff';

/**
 * `POST /api/account/favorites` — the browser's only entry to saving a listing (Phase 7-E).
 *
 * Three lines on purpose: the Origin check, the session cookie, the internal BFF credential, the body
 * rebuild and the problem-details pass-through all live in the shared handler, which the tests drive
 * directly.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<Response> {
  return handleAddFavorite(request);
}
