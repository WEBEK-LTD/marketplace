import { handleTagState } from '../../../../server/bff';

/**
 * `PUT /api/tags/state` — show or hide one tag.
 *
 * Its own path, for the same reason the other two state routes are: hiding is what a seller and a visitor both see,
 * and it must never happen as a side effect of a rename. The listings already carrying the tag keep it.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function PUT(request: Request): Promise<Response> {
  return handleTagState(request);
}
