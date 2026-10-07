import { handleSeoRedirectCreate, handleSeoRedirectUpdate } from '../../../../../admin/server/bff';

/**
 * `POST /admin/api/seo/redirects` adds an entry; `PATCH /admin/api/seo/redirects` changes one.
 *
 * Both bodies are rebuilt field by field by the shared handlers from the contract's own fields, so anything else a
 * browser sends is dropped before it leaves this origin. **Neither can switch an entry on or off**: that lives at
 * `/admin/api/seo/redirects/state`, so correcting a destination cannot start a redirect nobody meant to start.
 *
 * Removal is at `/admin/api/seo/redirects/remove` rather than as a `DELETE` here, because the same-origin check reads a
 * submitted body and a browser form submits one; the upstream call is the `DELETE` the API actually has.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<Response> {
  return handleSeoRedirectCreate(request);
}

export async function PATCH(request: Request): Promise<Response> {
  return handleSeoRedirectUpdate(request);
}
