import { handleSeoMetadataSave } from '../../../../../admin/server/bff';

/**
 * `PUT /admin/api/seo/metadata` — write one surface's metadata for one locale.
 *
 * A `PUT` on the collection because the upstream route is one: a surface and a locale have one row, and the request
 * *is* that row, so creating and replacing are the same operation and a screen never has to find out which it needs.
 * The body is rebuilt from the contract's own fields, so anything else a browser sends is dropped here.
 *
 * Removal is at `/admin/api/seo/metadata/remove` rather than as a `DELETE` here, because the same-origin check reads a
 * submitted body and a browser form submits one; the upstream call is the `DELETE` the API actually has.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function PUT(request: Request): Promise<Response> {
  return handleSeoMetadataSave(request);
}
