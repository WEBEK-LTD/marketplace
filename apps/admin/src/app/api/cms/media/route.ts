import { handleCmsMediaConfirm } from '../../../../server/bff';

/**
 * `POST /api/cms/media` — confirm an upload and record the library entry.
 *
 * The second half of the two-step flow. The body carries the path the authorization returned and what was stored at
 * it; the API asks storage whether the object is actually there before anything is written, so a confirmation for a
 * file nobody uploaded never becomes a row.
 *
 * Removal is at `/api/cms/media/remove` rather than as a `DELETE` here, because the same-origin check reads a
 * submitted body and a browser form submits one; the upstream call is the `DELETE` the API actually has.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<Response> {
  return handleCmsMediaConfirm(request);
}
