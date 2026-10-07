import { handleBlogPostTags } from '../../../../../admin/server/bff';

/**
 * `PUT /admin/api/blog/tags` — replace a post's whole tag set.
 *
 * A replace rather than an add and a remove: a set cannot leave a half-applied result, and the checkbox form that
 * drives this already knows the whole set it means.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function PUT(request: Request): Promise<Response> {
  return handleBlogPostTags(request);
}
