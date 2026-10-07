import { handleCmsPageStatus } from '../../../../../../admin/server/bff';

/**
 * `PUT /admin/api/cms/pages/status` — the only route on this origin that can publish, schedule, archive or
 * unpublish a page.
 *
 * Separate from the page's own route deliberately. Which transitions exist, and that a page cannot be
 * published before it has been written in a locale, are decided in the database; this route carries the
 * request and forwards the refusal.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function PUT(request: Request): Promise<Response> {
  return handleCmsPageStatus(request);
}
