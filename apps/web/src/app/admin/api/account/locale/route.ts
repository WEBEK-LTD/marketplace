import { handleLocaleChange } from '../../../../../admin/server/bff';

/**
 * `POST /admin/api/account/locale` — the console's language switch (Phase 7-F).
 *
 * Three lines on purpose: the Origin check, the session cookie, the internal BFF credential and the
 * single-field body rebuild all live in the shared handler, which the tests drive directly. The write
 * itself is the profile operation the API already has — v5.2 puts the admin's language in the person's
 * profile, and this is the operation that sets it.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<Response> {
  return handleLocaleChange(request);
}
