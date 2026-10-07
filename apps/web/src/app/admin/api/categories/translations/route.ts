import { handleCategoryTranslationSave } from '../../../../../admin/server/bff';

/**
 * `PUT /admin/api/categories/translations` — write one locale of one category.
 *
 * An upsert: writing a locale for the first time and correcting it later are the same request. A field submitted
 * blank clears the stored value, which is why the handler sends an empty string rather than omitting it.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function PUT(request: Request): Promise<Response> {
  return handleCategoryTranslationSave(request);
}
