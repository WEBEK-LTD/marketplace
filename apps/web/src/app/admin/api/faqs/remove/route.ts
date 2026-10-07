import { handleFaqRemove } from '../../../../../admin/server/bff';

/**
 * `POST /admin/api/faqs/remove` — remove one entry.
 *
 * A `POST` on this origin and a `DELETE` upstream, for the reason every other remove route gives: the same-origin
 * check reads a submitted body and a browser form submits one.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<Response> {
  return handleFaqRemove(request);
}
