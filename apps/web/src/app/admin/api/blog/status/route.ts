import { handleBlogPostStatus } from '../../../../../admin/server/bff';

/**
 * `POST /admin/api/blog/status` — move a post through its lifecycle.
 *
 * Its own route, and the only one here that can publish anything. A `POST` on this origin and a `PUT` upstream: the
 * same-origin check reads a submitted body, and the browser form that drives this submits one.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<Response> {
  return handleBlogPostStatus(request);
}
