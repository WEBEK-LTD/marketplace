import { handleHomepageSectionState } from '../../../../../server/bff';

/**
 * `POST /api/homepage/sections/state` — show or hide one section.
 *
 * Its own route, and the only one here that can put a section in front of the public. A `POST` on this origin and a
 * `PUT` upstream: the same-origin check reads a submitted body, and the browser form that drives this submits one.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<Response> {
  return handleHomepageSectionState(request);
}
