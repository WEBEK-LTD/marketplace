import { handleCategoryAttributeAttach } from '../../../../../admin/server/bff';

/**
 * `PUT /admin/api/categories/attributes` — ask a category for one attribute, or change how it asks.
 *
 * One route for both, because asking for an attribute the category already asks for is a change to *how* it asks —
 * required or not, filterable or not, in what order — rather than an error.
 *
 * This is governed by `catalog.category.manage` upstream, not by the attribute key: maintaining the vocabulary and
 * deciding which categories ask for it are separate authorities. `isRequired` is advisory in this increment — the
 * seller's form marks the field and nothing refuses a listing for want of an answer.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function PUT(request: Request): Promise<Response> {
  return handleCategoryAttributeAttach(request);
}
