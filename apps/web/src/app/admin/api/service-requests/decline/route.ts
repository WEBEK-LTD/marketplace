import { handleAdminServiceRequestDecline } from '../../../../../admin/server/bff';

/**
 * `POST /admin/api/service-requests/decline` — the approved staff closure (Phase 7-J).
 *
 * Three lines on purpose: the Origin check, the admin session cookie, the internal BFF credential, the
 * field-by-field body rebuild and the problem-details pass-through all live in the shared handler, which the
 * tests drive directly. The permission is the API's and the database's to enforce, not this file's.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<Response> {
  return handleAdminServiceRequestDecline(request);
}
