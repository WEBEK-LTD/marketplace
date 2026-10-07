import { handleCategoryCreate, handleCategoryUpdate } from '../../../../admin/server/bff';

/**
 * `POST /admin/api/categories` creates one category; `PATCH /admin/api/categories` changes its parent, surface or ordering.
 *
 * Both bodies are rebuilt from the shared contract, so anything else a browser sends is dropped before it leaves
 * this origin. **Neither can rename a category and neither can show or hide one.** The slug is the category's
 * public address and can never change (there is no slug history to redirect from), and the visible state lives at
 * `/admin/api/categories/state` so that a reordering can never publish a category by accident.
 *
 * There is no `DELETE`: the API has no route that removes a category, because listings, commission rules, tax
 * rules, coupons and promotion packages all reference one with `ON DELETE RESTRICT`. A category is hidden instead.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<Response> {
  return handleCategoryCreate(request);
}

export async function PATCH(request: Request): Promise<Response> {
  return handleCategoryUpdate(request);
}
