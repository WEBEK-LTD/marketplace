import { handleCategories } from '../../../server/bff';

/**
 * `GET /api/categories` — the public category tree, as the browser may ask for it.
 *
 * Three lines for the same reason every other BFF route is: the internal credential, the one hop to
 * `GET /v1/categories`, the contract validation and the RFC 9457 failure all live in `handleCategories`,
 * which the tests share. A route that re-implemented any of it would be a second place to get it wrong.
 *
 * `runtime = 'nodejs'` because the handler reads server-only configuration. `dynamic = 'force-dynamic'`
 * because the catalogue's published state can change at any time and C11 makes moderation-sensitive
 * responses non-cacheable; a cached tree could show a category that has since been withdrawn.
 *
 * There is no `POST`: an unsupported method gets Next.js's own 405, which discloses nothing.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<Response> {
  return handleCategories(request);
}
