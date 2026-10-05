import { handleHomepageSectionRemove } from '../../../../../server/bff';

/**
 * `POST /api/homepage/sections/remove` — remove one section.
 *
 * A `POST` on this origin and a `DELETE` upstream, for the reason the other remove routes give: the same-origin
 * check reads a submitted body and a browser form submits one. The rows the section referred to are untouched — a
 * section names them and never owns them.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<Response> {
  return handleHomepageSectionRemove(request);
}
