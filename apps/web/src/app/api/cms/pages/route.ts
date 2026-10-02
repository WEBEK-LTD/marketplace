import { handleCmsPages } from '../../../../server/bff';

/**
 * `GET /api/cms/pages` — every page the public may see, as the browser may ask for it.
 *
 * Three lines for the same reason every other BFF route is: the internal credential, the one hop to
 * `GET /v1/cms/pages`, the contract validation and the RFC 9457 failure all live in `handleCmsPages`, which
 * the tests share. A route that re-implemented any of it would be a second place to get it wrong.
 *
 * `runtime = 'nodejs'` because the handler reads server-only configuration. `dynamic = 'force-dynamic'`
 * because a page's published state changes whenever somebody publishes, schedules or archives one, and a
 * cached index could offer a link to a page that has since been withdrawn.
 *
 * There is no `POST`: authoring happens in the admin console, against its own origin and its own session.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<Response> {
  return handleCmsPages(request);
}
