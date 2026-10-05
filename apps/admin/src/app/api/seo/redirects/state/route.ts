import { handleSeoRedirectState } from '../../../../../server/bff';

/**
 * `PUT /api/seo/redirects/state` — switch one entry on or off.
 *
 * Its own route because it is its own decision. An entry that is off is stored, audited and readable and redirects
 * nobody; turning it on is the moment a visitor's address starts going somewhere else, and that deserves one
 * deliberate request rather than a field inside an edit.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function PUT(request: Request): Promise<Response> {
  return handleSeoRedirectState(request);
}
