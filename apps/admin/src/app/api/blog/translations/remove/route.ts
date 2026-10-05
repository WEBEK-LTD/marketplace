import { handleBlogTranslationRemove } from '../../../../../server/bff';

/**
 * `POST /api/blog/translations/remove` — remove one locale of a post.
 *
 * A `POST` on this origin and a `DELETE` upstream, for the reason the other remove routes give: the same-origin check
 * reads a submitted body and a browser form submits one.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<Response> {
  return handleBlogTranslationRemove(request);
}
