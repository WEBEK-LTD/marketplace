import { handleBlogTranslationSave } from '../../../../../admin/server/bff';

/**
 * `PUT /admin/api/blog/translations` — write one locale of a post.
 *
 * Creating and replacing are the same request, because a post and a locale have one row and the body *is* that row,
 * so a screen never has to find out which operation it needs.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function PUT(request: Request): Promise<Response> {
  return handleBlogTranslationSave(request);
}
