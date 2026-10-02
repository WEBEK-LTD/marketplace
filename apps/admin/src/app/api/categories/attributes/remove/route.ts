import { handleCategoryAttributeDetach } from '../../../../../server/bff';

/**
 * `POST /api/categories/attributes/remove` — stop a category asking for one attribute.
 *
 * A browser form cannot send a `DELETE`, so the removal is a `POST` here and a `DELETE` upstream.
 *
 * **No answer is deleted.** The attribute stops being asked of new listings and stops being editable on existing
 * ones; every answer already given stays exactly where it is, and re-attaching the attribute brings them all back.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<Response> {
  return handleCategoryAttributeDetach(request);
}
