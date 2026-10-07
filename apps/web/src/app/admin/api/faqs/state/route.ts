import { handleFaqState } from '../../../../../admin/server/bff';

/**
 * `POST /admin/api/faqs/state` — publish or unpublish one entry.
 *
 * Its own route, and the only one here that can put an answer on a public page. A `POST` on this origin and a `PUT`
 * upstream: the same-origin check reads a submitted body, and the form that drives this submits one.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<Response> {
  return handleFaqState(request);
}
