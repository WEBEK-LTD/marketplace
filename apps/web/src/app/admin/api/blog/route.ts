import { handleBlogPostCreate, handleBlogPostUpdate } from '../../../../admin/server/bff';

/**
 * `POST /admin/api/blog` — create a draft. `PATCH /admin/api/blog` — change a post's address or presentation.
 *
 * Both on the collection, with the post's identifier in the body rather than the path, because the same-origin check
 * reads a submitted body and the browser forms that drive these submit one.
 *
 * **Neither handler forwards a status.** Publishing is `/admin/api/blog/status`, so a rename cannot publish a post however
 * the body is shaped.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<Response> {
  return handleBlogPostCreate(request);
}

export async function PATCH(request: Request): Promise<Response> {
  return handleBlogPostUpdate(request);
}
