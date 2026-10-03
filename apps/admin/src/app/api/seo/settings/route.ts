import { handleSeoSettingsSave } from '../../../../server/bff';

/**
 * `PUT /api/seo/settings` — write one locale's site-wide SEO defaults.
 *
 * A `PUT` because the upstream route is one: a locale has one row, and the request *is* that row, so creating and
 * replacing are the same operation and a screen never has to find out which it needs. The locale travels in the body
 * here and in the address upstream, because the browser form that drives this submits one body.
 *
 * The body is rebuilt from the contract's own fields, so anything else a browser sends is dropped here.
 *
 * Removal is at `/api/seo/settings/remove` rather than as a `DELETE` here, because the same-origin check reads a
 * submitted body and a browser form submits one; the upstream call is the `DELETE` the API actually has.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function PUT(request: Request): Promise<Response> {
  return handleSeoSettingsSave(request);
}
