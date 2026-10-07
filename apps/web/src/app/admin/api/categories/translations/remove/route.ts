import { handleCategoryTranslationRemove } from '../../../../../../admin/server/bff';

/**
 * `POST /admin/api/categories/translations/remove` — remove one locale of one category.
 *
 * A `POST` because a browser form cannot send a `DELETE`; upstream it is the API's own `DELETE`. Removing the last
 * locale of a category that is shown is refused there, and the refusal is forwarded so the screen can say so.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<Response> {
  return handleCategoryTranslationRemove(request);
}
