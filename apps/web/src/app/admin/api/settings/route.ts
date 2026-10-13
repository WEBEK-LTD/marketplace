import { handleSiteSettingSave } from '../../../../admin/server/bff';

/**
 * `PUT /admin/api/settings` — write one site setting's value (0113).
 *
 * A `PUT` because the upstream route is one: a setting has one value, and the request *is* that value, so there
 * is nothing to create and nothing to merge.
 *
 * **The category and the key travel in the body here and in the address upstream**, because the browser form
 * that drives this submits a body and the same-origin check reads one. Both are checked against 0008's own
 * formats before any upstream request is made.
 *
 * There is no `POST` and no `DELETE`. A setting cannot be created or removed from the console: its key, its
 * category, its declared type and its `is_public` flag are decisions made in a migration where they can be
 * reviewed, and the database's own writer refuses an unknown key regardless of what this route does.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function PUT(request: Request): Promise<Response> {
  return handleSiteSettingSave(request);
}
