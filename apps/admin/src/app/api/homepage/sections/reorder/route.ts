import { handleHomepageSectionsReorder } from '../../../../../server/bff';

/**
 * `POST /api/homepage/sections/reorder` — set the order of the homepage.
 *
 * The whole order in one request, so the write cannot leave a half-applied arrangement. A `POST` here and a `PUT`
 * upstream, for the reason the other write routes on this origin give.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<Response> {
  return handleHomepageSectionsReorder(request);
}
