import { handleCategoryState } from '../../../../../admin/server/bff';

/**
 * `PUT /admin/api/categories/state` — show or hide one category.
 *
 * Its own path, because this is the one edit a visitor sees: it must never happen as a side effect of reordering
 * or re-parenting. Showing a category that has been named in no locale is refused upstream, and the refusal is
 * forwarded so the screen can say which rule turned.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function PUT(request: Request): Promise<Response> {
  return handleCategoryState(request);
}
